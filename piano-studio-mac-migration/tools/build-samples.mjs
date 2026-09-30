/**
 * 把 SFZ 音源库编译成浏览器能直接用的清单 JSON。
 *
 *   node tools/build-samples.mjs
 *
 * 为什么不直接在浏览器里跑 SFZ：SFZ 要靠 #define / #include / 多个 header 层级
 * （control → global → master → group → region）拼出最终参数，还要处理 CC 控制的
 * 力度跟踪、offset、维吉尼亚式变体……在浏览器里实现一整套 SFZ 引擎是另一场工程。
 * 这里在构建期只做一次：把真正发声需要的字段（哪个音、哪一层力度、哪个文件、
 * 音量修正、起始偏移、松键衰减）压成一份扁平 JSON，运行时零解析成本。
 *
 * 输出：
 *   samples/<id>.json    单个音源库的清单
 *   samples/index.json   可用音源库列表（浏览器先读它，读不到就退回合成器）
 *
 * 支持解析的 SFZ 子集：<control> <global> <master> <group> <region>、
 * #define / #include、以及 sample/lokey/hikey/key/pitch_keycenter/lovel/hivel/
 * volume/tune/offset/ampeg_release/amp_veltrack/group/trigger 这些 opcode。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');

/* ── 已知音源库登记表 ─────────────────────────────────────
   sfzRoot / sampleRoot 分开写：构建期我可能只有 SFZ 映射文件（采样还在下载），
   这时仍能生成清单，只是会警告缺文件。 */
const LIBS = [
  {
    id: 'salamander',
    name: 'Salamander Grand Piano V3',
    piano: 'Yamaha C5',
    credit: '采样 Alexander Holm（CC-BY 3.0）；SFZ 映射 kinwie / Markus Fiedler',
    license: 'CC-BY 3.0',
    home: 'https://archive.org/details/SalamanderGrandPianoV3',
    sfzRoot: 'SalamanderGrandPianoV3',
    sampleRoot: 'SalamanderGrandPianoV3',
    main: 'Salamander Grand Piano V3.sfz',
  },
  {
    id: 'piano162',
    name: 'Piano in 162',
    piano: 'Steinway Model B',
    credit: 'Ivy Audio（免费授权，仅本地使用）；SFZ 映射 kinwie',
    license: 'Freeware (Ivy Audio)',
    home: 'https://ivyaudio.com/freebies',
    sfzRoot: '_map162',
    sampleRoot: 'PianoIn162',      // 解压后确认
    mics: ['Close', 'Ambient'],
    micNames: { Close: '近距离麦克风', Ambient: '厅堂麦克风' },
  },
  {
    id: 'vsco-modelb',
    name: 'VCSL · S Model B Grand',
    piano: 'Steinway Model B',
    credit: 'Versilian Studios（CC0 1.0）',
    license: 'CC0 1.0',
    home: 'https://versilian-studios.com/vcsl/',
    sfzRoot: 'VCSL_Keys',
    sampleRoot: 'VCSL_Keys',
    main: null,        // 打包结构与乐器数量都待定，见 buildVsco
  },
];

const num = (v, d = 0) => {
  if (v === undefined) return d;
  const n = Number(String(v).replace(/[a-z%]+$/i, ''));
  return Number.isFinite(n) ? n : d;
};

/* ── Salamander 清单 ───────────────────────────────────── */
function buildSalamander(lib) {
  const sfzDir = path.join(SAMPLES, lib.sfzRoot);
  const main = path.join(sfzDir, lib.main);
  if (!fs.existsSync(main)) throw new Error(`找不到主 SFZ: ${main}`);

  // 1) 主采样：notes.txt 里的 16 个力度组，每组 30 个根音
  //    直接解析 Data/region.txt 一次拿到音符网格，再按 vel_NN 组装文件名
  const regionFile = path.join(sfzDir, 'Data', 'region.txt');
  const notesFile = path.join(sfzDir, 'Data', 'notes.txt');
  const notesTxt = fs.readFileSync(notesFile, 'utf8');

  const layers = [];       // { vel, velTag, offsets: {01:..} }
  for (const line of notesTxt.split(/\r?\n/)) {
    const m = /<group>\s*#include\s+"Data\/(vel_\d+\.txt)"\s+lovel=(\d+)\s+hivel=(\d+)/.exec(line);
    if (!m) continue;
    const velFile = path.join(sfzDir, 'Data', m[1]);
    const txt = fs.readFileSync(velFile, 'utf8');
    const velTag = /#define\s+\$VEL\s+(\S+)/.exec(txt)?.[1];
    const offsets = {};
    for (const dm of txt.matchAll(/#define\s+\$OFF(\d+)\s+(\d+)/g)) offsets[dm[1]] = Number(dm[2]);
    layers.push({ vel: Number(m[3]), velTag, offsets });
  }
  if (!layers.length) throw new Error('没能从 notes.txt 里解析出力度层');

  // 2) 每个根音的 lokey/hikey/pitch_keycenter + 采样名模板 + 松键衰减
  const regTxt = fs.readFileSync(regionFile, 'utf8');
  const keys = [];
  for (const line of regTxt.split(/\r?\n/)) {
    if (!line.includes('<region>')) continue;
    const g = (k) => new RegExp(`${k}=(\\S+)`).exec(line)?.[1];
    const sample = g('sample');
    const center = num(g('pitch_keycenter'));
    keys.push({
      midi: center,
      lo: num(g('lokey'), center),
      hi: num(g('hikey'), center),
      rel: num(g('ampeg_release'), 0),
      layers: layers.map((L, i) => ({
        file: `Samples/${sample.replace('$VEL', L.velTag).replace('$EXT', 'flac')}`,
        vel: L.vel,
        offset: L.offsets[String(i + 1).padStart(2, '0')] ?? 0,
      })),
    });
  }
  keys.sort((a, b) => a.midi - b.midi);

  // 3) 松键噪声（hammer）：逐键一个文件，88 个音正好对齐
  const release = [];
  {
    const txt = fs.readFileSync(path.join(sfzDir, 'Data', 'hammer.txt'), 'utf8');
    const vol = num(/^volume=(-?[\d.]+)/m.exec(txt)?.[1], 0);
    for (const m of txt.matchAll(/<region>[^\n]*key=(\d+)[^\n]*sample=(\S+)/g)) {
      release.push({ midi: Number(m[1]), file: `Samples/${m[2].replace('$EXT', 'flac')}`, gain: vol });
    }
  }

  // 4) 弦共振释放层：三组变体里取第一组（harmL），每小三度一个
  const resonance = [];
  {
    const p = path.join(sfzDir, 'Data', 'str_res.txt');
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, 'utf8');
      let vol = -4;
      for (const line of txt.split(/\r?\n/)) {
        const gv = /^volume=(-?[\d.]+)/.exec(line.trim());
        if (gv) vol = Number(gv[1]);
        const m = /<region>[^\n]*lokey=(\d+)[^\n]*pitch_keycenter=(\d+)[^\n]*sample=(\S+)/.exec(line);
        if (m && /harmL/.test(m[3])) {
          resonance.push({ midi: Number(m[2]), file: `Samples/${m[3].replace('$EXT', 'flac')}`, gain: vol });
        }
      }
    }
  }

  // 5) 踏板噪声：踩下 pedalD1/D2，松开 pedalU1/U2
  const pedal = { down: [], up: [] };
  {
    const txt = fs.readFileSync(path.join(sfzDir, 'Data', 'pedal.txt'), 'utf8');
    let vol = 0;
    for (const line of txt.split(/\r?\n/)) {
      const gv = /^volume=(-?[\d.]+)/.exec(line.trim());
      if (gv) vol = Number(gv[1]);
      const m = /<region>[^\n]*sample=(\S+)/.exec(line);
      if (!m) continue;
      const kind = /pedalD/i.test(m[1]) ? 'down' : 'up';
      pedal[kind].push({ file: `Samples/${m[1].replace('$EXT', 'flac')}`, gain: vol });
    }
  }

  // 6) 统计文件数与体积（采样还没下载完时只警告，清单照样生成）
  const files = new Set();
  for (const k of keys) for (const l of k.layers) files.add(l.file);
  for (const r of release) files.add(r.file);
  for (const r of resonance) files.add(r.file);
  for (const kind of ['down', 'up']) for (const p of pedal[kind]) files.add(p.file);

  let bytes = 0;
  let missing = 0;
  for (const f of files) {
    const abs = path.join(SAMPLES, lib.sampleRoot, f);
    if (fs.existsSync(abs)) bytes += fs.statSync(abs).size;
    else missing++;
  }

  return {
    manifest: {
      id: lib.id,
      name: lib.name,
      piano: lib.piano,
      credit: lib.credit,
      license: lib.license,
      home: lib.home,
      base: `${lib.sampleRoot}/`,
      keys,
      release,
      resonance,
      pedal,
      stats: { files: files.size, bytes, missing },
    },
    missing,
    files: files.size,
    bytes,
  };
}


/* ── Piano in 162（Steinway Model B）清单 ────────────────
   映射来自 sfzinstruments/mappings（kinwie 重建版，抓在 samples/_map162/）。
   文件名模板：$MIC/$PED$MIC/$NUM-$PED$DYN$RR$MIC.flac
   结构：2 麦克风 × 踏板踩/放两套采样 × 5 力度 × 2 round-robin × 88 键。
   <control> 里 note_offset=20：region 的 $NUM 01..88 对应 MIDI 21..108。 */
function buildPiano162(lib) {
  const sfzDir = path.join(SAMPLES, lib.sfzRoot);
  const read = (f) => fs.readFileSync(path.join(sfzDir, f), 'utf8');

  // 1) 力度分组：group.txt 里每个 <group> 的 lovel/hivel/group_volume/$DYN 分行出现
  const dyns = [];
  {
    let cur = null;
    for (const line of read('Data/group.txt').split(/\r?\n/)) {
      const s = line.trim();
      if (s.startsWith('<group>')) { cur = {}; continue; }
      if (!cur) continue;
      let m;
      if ((m = /^lovel=(\d+)/.exec(s))) cur.lo = Number(m[1]);
      else if ((m = /^hivel=(\d+)/.exec(s))) cur.hi = Number(m[1]);
      else if ((m = /^group_volume=(-?[\d.]+)/.exec(s))) cur.gain = Number(m[1]);
      else if ((m = /^#define\s+\$DYN\s+(\S+)/.exec(s))) cur.name = m[1];
      else if (s.startsWith('#include') && cur.name && cur.hi) {
        dyns.push({ lo: cur.lo ?? 1, hi: cur.hi, gain: cur.gain ?? 0, name: cur.name });
        cur = null;
      }
    }
  }
  if (!dyns.length) throw new Error('group.txt 里没解析出力度分组');

  // 2) round-robin 标签（master.txt 的 $RR 1/2）
  const rrs = [...read('Data/master.txt').matchAll(/#define\s+\$RR\s+(\d+)/g)].map((m) => m[1]);
  if (!rrs.length) rrs.push('1');

  // 3) 音符：region.txt 里 $NUM 01..88（按 note_offset 平移到 MIDI）
  const nums = [...read('Data/region.txt').matchAll(/#define\s+\$NUM\s+(\d+)/g)].map((m) => m[1]);
  if (!nums.length) throw new Error('region.txt 里没解析出音符');
  const noteOffset = 20;      // <control> 的 note_offset=20

  // 4) 文件名模板来自 Data/sample.txt
  const tpl = /sample=(\S+)/.exec(read('Data/sample.txt'))?.[1];
  if (!tpl) throw new Error('sample.txt 里没找到文件名模板');

  function keySet(mic) {
    return nums.map((num) => {
      const midi = Number(num) + noteOffset;
      const mk = (ped) => dyns.map((d) => ({
        vel: d.hi,
        gain: d.gain,
        rr: rrs.map((rr) => tpl
          .replaceAll('$MIC', mic)
          .replaceAll('$PED', ped)
          .replace('$NUM', num.padStart(2, '0'))
          .replace('$DYN', d.name)
          .replace('$RR', rr)
          .replace('$EXT', 'flac')),
      }));
      return { midi, layersOff: mk('PedalOff'), layersOn: mk('PedalOn') };
    });
  }

  // 5) 两个麦克风位各出一份清单（面板里是两个可选项）
  const results = [];
  for (const mic of lib.mics) {
    const keys = keySet(mic);
    const files = new Set();
    for (const k of keys) {
      for (const ls of [k.layersOff, k.layersOn]) {
        for (const l of ls) for (const f of l.rr) files.add(f);
      }
    }
    let bytes = 0;
    let missing = 0;
    for (const f of files) {
      const abs = path.join(SAMPLES, lib.sampleRoot, f);
      if (fs.existsSync(abs)) bytes += fs.statSync(abs).size;
      else missing++;
    }
    const manifest = {
      id: mic === lib.mics[0] ? lib.id : `${lib.id}-${mic.toLowerCase()}`,
      name: `${lib.name}（${lib.micNames[mic]}）`,
      piano: lib.piano,
      credit: lib.credit,
      license: lib.license,
      home: lib.home,
      base: `${lib.sampleRoot}/`,
      keys,
      stats: { files: files.size, bytes, missing },
    };
    fs.writeFileSync(path.join(SAMPLES, `${manifest.id}.json`), JSON.stringify(manifest));
    results.push({
      id: manifest.id, name: manifest.name, piano: lib.piano, credit: lib.credit,
      license: lib.license, files: files.size, bytes, missing,
    });
  }
  return results;
}

/* ── 主流程 ─────────────────────────────────────────────── */
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const index = [];

for (const lib of LIBS) {
  if (only && !lib.id.startsWith(only)) continue;
  try {
    let entries;
    if (lib.id === 'salamander') {
      const { manifest, missing, files, bytes } = buildSalamander(lib);
      fs.writeFileSync(path.join(SAMPLES, `${lib.id}.json`), JSON.stringify(manifest));
      entries = [{ id: lib.id, name: lib.name, piano: lib.piano, credit: lib.credit,
        license: lib.license, files, bytes, missing }];
    } else if (lib.id === 'piano162') {
      if (!fs.existsSync(path.join(SAMPLES, lib.sfzRoot))) {
        console.log(`- ${lib.id}  未找到 ${lib.sfzRoot}/（Piano in 162 未下载），跳过`);
        continue;
      }
      entries = buildPiano162(lib);
    } else {
      continue;      // 其它库在各自的 buildXxx 实现后启用
    }
    for (const en of entries) {
      index.push({ id: en.id, name: en.name, piano: en.piano, credit: en.credit,
        license: en.license, manifest: `${en.id}.json`, files: en.files, bytes: en.bytes });
      console.log(`✓ ${en.id}  ${en.files} 个采样  ${(en.bytes / 1048576).toFixed(0)} MB` +
        (en.missing ? `  ⚠ 缺 ${en.missing} 个文件（采样未下载完？）` : ''));
    }
  } catch (e) {
    console.log(`✗ ${lib.id}: ${e.message}`);
  }
}

// 合并写入：保留其它构建器（如 build-accurate.mjs）已注册、但本脚本不产出的条目
const idxPath = path.join(SAMPLES, 'index.json');
const prev = fs.existsSync(idxPath)
  ? (JSON.parse(fs.readFileSync(idxPath, 'utf8')).libraries ?? []) : [];
const own = new Set(index.map((l) => l.id));
const merged = [...index, ...prev.filter((l) => !own.has(l.id))];
fs.writeFileSync(idxPath, JSON.stringify({ libraries: merged }, null, 2));
console.log(`→ samples/index.json  ${merged.length} 个音源库`);
