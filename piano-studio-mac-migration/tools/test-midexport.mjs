/**
 * buildMidiFile 纯函数自校验：
 *   · 头部 MThd / format 0 / 1 轨 / 480 PPQ
 *   · 逐字节解析 delta-time 事件流，音符数、CC 数、tick 换算全对上
 *   · 用 tools/wftest.mjs 落地的真实事件流（shots/wf-events.json）跑更佳
 *
 * 用法： node tools/test-midexport.mjs [shots/wf-events.json]
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { buildMidiFile } from '../src/record/recorder.js';

let events, durationMs;
const real = process.argv[2];
if (real && existsSync(real)) {
  const j = JSON.parse(readFileSync(real, 'utf8'));
  events = j.events ?? j;
  durationMs = events.at(-1)?.t + 500;
  console.log(`用真实录制流：${events.length} 条事件`);
} else {
  // 合成用例：C4-E4-G4 长和弦 1600ms → 三个短音 → 中途踩/抬踏板
  durationMs = 4200;
  events = [
    { t: 0, type: 'on', midi: 60, vel: 0.9 },
    { t: 0, type: 'on', midi: 64, vel: 0.8 },
    { t: 0, type: 'on', midi: 67, vel: 0.7 },
    { t: 1600, type: 'off', midi: 60 },
    { t: 1600, type: 'off', midi: 64 },
    { t: 1600, type: 'off', midi: 67 },
    { t: 1720, type: 'on', midi: 72, vel: 0.85 },
    { t: 2020, type: 'off', midi: 72 },
    { t: 2120, type: 'on', midi: 76, vel: 0.7 },
    { t: 2420, type: 'off', midi: 76 },
    { t: 2500, type: 'cc64', midi: 64, vel: 127 },
    { t: 2520, type: 'on', midi: 79, vel: 0.75 },
    { t: 3020, type: 'off', midi: 79 },
    { t: 3100, type: 'cc64', midi: 64, vel: 0 },
  ];
  console.log('用合成用例：14 条事件');
}

const bytes = buildMidiFile(events, durationMs);
mkdirSync('shots', { recursive: true });
writeFileSync('shots/test-export.mid', bytes);

let ok = true;
const expect = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) ok = false;
};

/* ── 头部 ── */
const u32 = (o) => (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
const u16 = (o) => (bytes[o] << 8) | bytes[o + 1];
expect(String.fromCharCode(...bytes.slice(0, 4)) === 'MThd', 'MThd 魔数');
expect(u32(4) === 6, '头长 6');
expect(u16(8) === 0, 'format 0');
expect(u16(10) === 1, '1 条轨道');
expect(u16(12) === 480, '480 PPQ');
expect(String.fromCharCode(...bytes.slice(14, 18)) === 'MTrk', 'MTrk 魔数');
const trkLen = u32(18);
expect(bytes.length === 22 + trkLen, `轨道长度自洽（${trkLen} 字节）`);

/* ── 逐事件解析 ── */
let p = 22;
const readVLQ = () => {
  let v = 0;
  for (;;) {
    const b = bytes[p++];
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) return v;
  }
};
const parsed = [];
let tick = 0;
while (p < 22 + trkLen) {
  tick += readVLQ();
  const st = bytes[p++];
  if (st === 0xff) {
    const type = bytes[p++];
    const len = readVLQ();
    parsed.push({ tick, meta: type, len });
    p += len;
  } else if (st === 0x90 || st === 0x80 || st === 0xb0) {
    parsed.push({ tick, st, d1: bytes[p++], d2: bytes[p++] });
  } else {
    expect(false, `未知状态字节 0x${st.toString(16)}`);
    break;
  }
}

const ons = parsed.filter((e) => e.st === 0x90);
const offs = parsed.filter((e) => e.st === 0x80);
const ccs = parsed.filter((e) => e.st === 0xb0);
expect(ons.length === events.filter((e) => e.type === 'on').length,
  `note-on 数 ${ons.length} = 源 ${events.filter((e) => e.type === 'on').length}`);
expect(offs.length === events.filter((e) => e.type === 'off').length,
  `note-off 数 ${offs.length} = 源`);
expect(ccs.length === events.filter((e) => e.type === 'cc64').length,
  `CC64 数 ${ccs.length} = 源`);
expect(ons.every((e) => e.d2 >= 1 && e.d2 <= 127), 'note-on 力度都在 1..127');
expect(ccs.every((e) => e.d1 === 64), 'CC 全是 64 号（延音）');

// tick 换算：480 PPQ / 500ms per quarter → 0.96 tick/ms
const first = events.find((e) => e.type === 'on');
const firstTick = ons[0].tick;
expect(firstTick === Math.round((first.t / 500) * 480),
  `首音 tick ${firstTick} = ms→tick 换算`);
const lastEv = parsed.at(-1);
expect(lastEv.meta === 0x2f, '轨末是 End of Track');

console.log(`\n${ok ? '全部通过 ✓' : '有失败项 ✗'}（已写出 shots/test-export.mid）`);
process.exit(ok ? 0 : 1);
