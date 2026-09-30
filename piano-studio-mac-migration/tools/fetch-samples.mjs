/**
 * 按清单下载采样文件（可续传）。
 *
 *   node tools/fetch-samples.mjs                     # 默认走 jsdelivr CDN
 *   node tools/fetch-samples.mjs --lib=salamander
 *
 * 为什么不用官方 tar 包：官方 freepats 单流只有 100–300 KB/s，741 MB 要一个多小时，
 * 而且断了要从头再来。这里按 strip 出来的 595 个文件清单逐个下载、跳过已存在的，
 * 断点续传只重下缺的那几个。
 *
 * 采样只在本机使用，不下发到线上站点（vibedrop 那份仍然只有 index.html + piano.js）。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');

const CDN = process.env.SAMPLE_CDN
  || 'https://cdn.jsdelivr.net/gh/sfzinstruments/SalamanderGrandPiano@master';
const CONCURRENCY = Number(process.env.SAMPLE_CONCURRENCY || 4);
const RETRIES = 4;

const libId = process.argv.find((a) => a.startsWith('--lib='))?.slice(6) || 'salamander';
const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, `${libId}.json`), 'utf8'));
const dest = path.join(SAMPLES, manifest.base.replace(/\/$/, ''));

/** 清单里引用到的全部文件（去掉 "Samples/" 前缀，保留相对结构） */
function allFiles(m) {
  const s = new Set();
  for (const k of m.keys) for (const l of k.layers) s.add(l.file);
  for (const r of m.release ?? []) s.add(r.file);
  for (const r of m.resonance ?? []) s.add(r.file);
  for (const kind of ['down', 'up']) for (const p of m.pedal?.[kind] ?? []) s.add(p.file);
  return [...s];
}

const files = allFiles(manifest);
const todo = files.filter((f) => !fs.existsSync(path.join(dest, f)));
console.log(`${manifest.name}: 共 ${files.length} 个文件，缺 ${todo.length} 个待下载`);
if (!todo.length) process.exit(0);

let done = 0;
let bytes = 0;
let failed = [];
const t0 = Date.now();

async function grab(file) {
  const out = path.join(dest, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const url = `${CDN}/${file.split('/').map(encodeURIComponent).join('/')}`;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 128) throw new Error(`内容过短 (${buf.length} B)`);
      fs.writeFileSync(out, buf);
      done++;
      bytes += buf.length;
      if (done % 20 === 0 || done === todo.length) {
        const mb = bytes / 1048576;
        const rate = mb / ((Date.now() - t0) / 1000);
        const left = (todo.length - done) * (bytes / done) / 1048576 / Math.max(rate, 0.01);
        console.log(`  ${done}/${todo.length}  ${mb.toFixed(1)} MB  ${rate.toFixed(2)} MB/s  预计剩余 ${left.toFixed(0)} 分`);
      }
      return;
    } catch (e) {
      if (attempt === RETRIES) { failed.push(`${file}: ${e.message}`); return; }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

// 简单的并发池
const queue = [...todo];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) await grab(queue.shift());
}));

console.log(`完成 ${done}/${todo.length}，${(bytes / 1048576).toFixed(0)} MB，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分`);
if (failed.length) {
  console.log(`失败 ${failed.length} 个（重跑本脚本会自动续传）:`);
  for (const f of failed.slice(0, 10)) console.log('  ✗', f);
  process.exit(1);
}
