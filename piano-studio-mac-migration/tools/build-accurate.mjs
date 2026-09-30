/**
 * Accurate-Salamander（Drive 精修版）清单生成器 —— 独立脚本，避免与 build-samples.mjs 互相牵动。
 *
 *   node tools/build-accurate.mjs
 *
 * 输入：samples/AccurateSalamander/sfz_live/Accurate-SalamanderGrandPiano_flat.Recommended.sfz
 * 输出：samples/accurate.json（合并进 samples/index.json）
 *
 * SFZ 结构（sfz_live 版）：
 *   · 主采样：30 根音（小三度网格）× 16 力度，<group> tune=0 offset=768，
 *     每个 region 自带 lovel/hivel 边界与 volume 微调；
 *   · relN.wav：88 个逐键松键采样（HammerNoise master，group volume=-37 + oncc -12）；
 *   · harmL/harmS/harmVN：踏板/释放共鸣族（CC20/CC23 门控），挑 harmL 长共鸣族；
 *   · 混响/踏板噪声等的 CC 门控机制不搬进运行时——运行时只认清单 JSON。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const LIB_DIR = 'AccurateSalamander';
const SFZ = path.join(SAMPLES, LIB_DIR, 'sfz_live', 'Accurate-SalamanderGrandPiano_flat.Recommended.sfz');

const s = fs.readFileSync(SFZ, 'utf8');

/* 去注释，按行扫 header/opcode，跟踪 master→group→region 归属 */
const lines = s.split(/\r?\n/)
  .map((l) => l.replace(/\/\/.*$/, '').trim())
  .filter((l) => l && !l.startsWith('#'));          // #define 不用（这套 SFZ 没用宏拼文件名）

let master = null;      // 当前 master 的 opcode 集
let masterSeq = -1;     // master 序号：0 = 主采样（默认释音长度），1/2 = 释音长度变体
let group = null;       // 当前 group 的 opcode 集
let region = null;      // 当前 region（SFZ 允许参数写在 header 的续行上）
const regions = [];     // { masterOps, groupOps, ops, masterSeq }
for (const line of lines) {
  const h = /^<(\w+)>/.exec(line);
  if (h) {
    const kind = h[1];
    const rest = line.slice(h[0].length).trim();
    const ops = Object.fromEntries(rest.split(/\s+/).filter((t) => t.includes('='))
      .map((t) => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)]));
    if (kind === 'master') { master = { ops }; masterSeq++; group = region = null; }
    else if (kind === 'group') { group = { ops, master }; region = null; }
    else if (kind === 'region') {
      region = { ops };
      regions.push({ master: master?.ops ?? {}, group: group?.ops ?? {}, ops, masterSeq });
    } else if (kind === 'global' || kind === 'control' || kind === 'curve') {
      if (kind !== 'curve') { master = null; group = region = null; }
    }
    continue;
  }
  // 续行 opcode：并入最近的 header（region 优先——v16 的 hivel=127 就写在续行上）
  const t = line.includes('=') ? line : '';
  if (!t) continue;
  const k = t.slice(0, t.indexOf('='));
  const v = t.slice(t.indexOf('=') + 1);
  const target = region?.ops ?? group?.ops ?? master?.ops;
  if (target) target[k] = v;
}

const dB = (v) => Number(String(v ?? 0).replace('+', ''));
const fileOf = (p) => p.replaceAll('..\\', '').replaceAll('\\', '/');

/* ── 1) 主采样：master 0-2 按音区切分三种释音长度，采样完全相同 ──
    跨 master 收集并按 (音, 力度) 去重。 */
const keysMap = new Map();     // midi -> { midi, layers: [] }
const seenNL = new Set();      // "midi:vel"
for (const r of regions) {
  if (r.masterSeq > 2) continue;
  const val = r.ops.sample ?? '';
  if (!/v\d\d\.wav$/.test(val)) continue;
  const vel = Number(r.ops.hivel ?? 127);   // SFZ 默认 hivel=127（v16 不写）
  const file = fileOf(val);
  const midi = Number(r.ops.pitch_keycenter);
  const dk = `${midi}:${vel}`;
  if (seenNL.has(dk)) continue;
  seenNL.add(dk);
  const gain = dB(r.ops.volume) + dB(r.group.volume);
  if (!keysMap.has(midi)) keysMap.set(midi, { midi, layers: [] });
  keysMap.get(midi).layers.push({ file, vel, gain, offset: Number(r.group.offset ?? 0) });
}
const keys = [...keysMap.values()].map((k) => {
  k.layers.sort((a, b) => a.vel - b.vel);
  return k;
}).sort((a, b) => a.midi - b.midi);
if (keys.length !== 30) throw new Error(`主采样根音数 ${keys.length} ≠ 30`);
if (keys.some((k) => k.layers.length < 14)) throw new Error('有的根音力度层不足');

/* ── 2) 松键采样：relN.wav（HammerNoise master，trigger=release_key）── */
const release = [];
for (const r of regions) {
  const val = r.ops.sample ?? '';
  if (!/rel\d+\.wav$/.test(val)) continue;
  const midi = Number(r.ops.lokey ?? r.ops.key);
  const gain = dB(r.group.volume) + dB(r.master.volume_oncc21 ?? -12);
  release.push({ midi, file: fileOf(val), gain });
}
release.sort((a, b) => a.midi - b.midi);

/* ── 3) 共鸣采样：harmL*（Pedal Resonance / Sampled Release 里的长共鸣族）── */
const resonance = [];
const seenRes = new Set();
for (const r of regions) {
  const val = r.ops.sample ?? '';
  if (!/harmL[^\\/]*\.wav$/.test(val)) continue;
  const midi = Number(r.ops.pitch_keycenter);
  const file = fileOf(val);
  if (seenRes.has(file)) continue;
  seenRes.add(file);
  const gain = dB(r.group.volume) + dB(r.master.volume_oncc23 ?? r.master.volume_oncc20 ?? -12);
  resonance.push({ midi, file, gain });
}
resonance.sort((a, b) => a.midi - b.midi);

/* ── 4) 文件清点 ── */
const allFiles = new Set();
for (const k of keys) for (const l of k.layers) allFiles.add(l.file);
for (const r of release) allFiles.add(r.file);
for (const r of resonance) allFiles.add(r.file);
let bytes = 0;
let missing = 0;
for (const f of allFiles) {
  const abs = path.join(SAMPLES, LIB_DIR, f);
  if (fs.existsSync(abs)) bytes += fs.statSync(abs).size;
  else missing++;
}

const manifest = {
  id: 'accurate',
  name: 'Accurate Salamander（精修版）',
  piano: 'Yamaha C5 · 精修',
  credit: '原采样 Alexander Holm（CC-BY 3.0）；重制 Accurate-Salamander Project (cyamauch)',
  license: 'CC-BY 3.0',
  home: 'https://www.ir.isas.jaxa.jp/~cyamauch/AccurateSalamander/',
  base: `${LIB_DIR}/`,
  keys,
  release,
  resonance,
  stats: { files: allFiles.size, bytes, missing },
};
fs.writeFileSync(path.join(SAMPLES, 'accurate.json'), JSON.stringify(manifest));

console.log(`✓ accurate  主采样 ${keys.length} 根音 × ${keys[0].layers.length} 层，` +
  `release ${release.length}，resonance ${resonance.length}，` +
  `共 ${allFiles.size} 文件 ${(bytes / 1048576).toFixed(0)} MB` +
  (missing ? `  ⚠ 缺 ${missing}` : ''));

/* ── 5) 重建 index.json（salamander + piano162 ×2 + accurate）── */
const index = [];
const add = (id, name, piano, credit, license, manifestFile, files, bytes) =>
  index.push({ id, name, piano, credit, license, manifest: manifestFile, files, bytes });
{
  const m = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'salamander.json'), 'utf8'));
  add(m.id, m.name, m.piano, m.credit, m.license, 'salamander.json', m.stats.files, m.stats.bytes);
}
for (const id of ['piano162', 'piano162-ambient']) {
  const p = path.join(SAMPLES, `${id}.json`);
  if (!fs.existsSync(p)) continue;
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  add(m.id, m.name, m.piano, m.credit, m.license, `${id}.json`, m.stats.files, m.stats.bytes);
}
add(manifest.id, manifest.name, manifest.piano, manifest.credit, manifest.license,
  'accurate.json', allFiles.size, bytes);
fs.writeFileSync(path.join(SAMPLES, 'index.json'), JSON.stringify({ libraries: index }, null, 2));
console.log(`→ samples/index.json  ${index.length} 个音源库: ${index.map((l) => l.id).join(', ')}`);
