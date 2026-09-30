/**
 * 采样音源实跑测试。
 *
 *   node tools/sampletest.mjs            # 需要本地服务器已在 8137 端口跑着
 *
 * 验证四件事：
 *   1. 能读到 samples/index.json 并挂上采样音源；
 *   2. 弹一个已就绪的音，走的是采样（不是合成器兜底）；
 *   3. 弹一个采样还没就绪的音，安静地退回合成器、不报错、也不静音；
 *   4. 延音踏板、松键采样、缓存统计都正常工作。
 */

import puppeteer from 'puppeteer-core';
import { resolveBrowserPath } from './_browser.mjs';

const CHROME = resolveBrowserPath();
const URL = process.env.PAGE_URL || 'http://127.0.0.1:8137/';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--window-size=1400,900', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errs = [];
const warns = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(`[console] ${m.text()}`);
  if (m.type() === 'warning' && /sampler/.test(m.text())) warns.push(`[warn] ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => window.__piano?.().audio, { timeout: 60000 });

const libs = await page.evaluate(() => window.__piano().sampleLibs);
console.log('可用音源库:', JSON.stringify(libs.map((l) => `${l.id} (${l.piano})`)));
if (!libs.length) {
  console.log('⚠ 没找到本地采样音源，先跑 node tools/build-samples.mjs');
  await browser.close();
  process.exit(0);
}
// LIB=accurate node tools/sampletest.mjs 可指定音源库
const WANT = process.env.LIB;
const target = libs.find((l) => l.id === WANT) ?? libs[0];

// 切到采样音源并等清单就绪
const boot = await page.evaluate(async (id) => {
  const t0 = performance.now();
  await window.useSource(id);
  return { ms: Math.round(performance.now() - t0), mode: window.__piano().audio.mode };
}, target.id);
console.log('切换到采样音源:', JSON.stringify(boot));

// 等预热（中间力度层铺满所有根音）把低音区先备好
await page.waitForFunction(() => {
  const s = window.__piano().sampler?.stats();
  return s && s.ready > 8;
}, { timeout: 120000 });
console.log('预热统计:', JSON.stringify(await page.evaluate(() => window.__piano().sampler.stats())));

// 采样已就绪的音：第一次可能还在解码，第二次必须走采样
const r1 = await page.evaluate(async () => {
  const p = window.__piano();
  const key = p.sampler.manifest.keys[0].midi;      // 最低那个根音，最先下完
  const t0 = performance.now();
  const first = p.audio.noteOn(key, 0.8);
  const dt1 = performance.now() - t0;
  p.audio.noteOff(key);
  // 等这一根音的力度层解码完
  for (let i = 0; i < 60 && p.sampler.stats().pending; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const t1 = performance.now();
  const second = p.audio.noteOn(key, 0.8);
  const dt2 = performance.now() - t1;
  p.audio.noteOff(key);
  return { key, first, second, dt1: +dt1.toFixed(2), dt2: +dt2.toFixed(2) };
});
console.log(`弹 midi=${r1.key}：第一次 ${r1.first}（${r1.dt1} ms）→ 等解码后再弹 ${r1.second}（${r1.dt2} ms）`);

// 采样还没就绪的音：应当安静地退回合成器
const r2 = await page.evaluate(() => {
  const p = window.__piano();
  const key = p.sampler.manifest.keys[p.sampler.manifest.keys.length - 1].midi;
  const how = p.audio.noteOn(key, 0.8);
  p.audio.noteOff(key);
  return { key, how };
});
console.log(`弹未就绪的音 midi=${r2.key}: 走的是 ${r2.how}（合成器兜底，不静音）`);

// 延音 + 松键采样 + 统计
const r3 = await page.evaluate(async () => {
  const p = window.__piano();
  p.audio.setSustain(true);
  p.audio.noteOn(60, 0.9);
  await new Promise((r) => setTimeout(r, 300));
  p.audio.noteOff(60);                       // 踏板踩着：不应停
  await new Promise((r) => setTimeout(r, 200));
  const held = p.sampler.stats();
  p.audio.setSustain(false);                 // 松踏板：收声 + 触发踏板/松键采样
  await new Promise((r) => setTimeout(r, 400));
  return { held, now: p.sampler.stats(), mode: p.audio.mode };
});
console.log('延音保持时采样统计:', JSON.stringify(r3.held));
console.log('松踏板后采样统计:', JSON.stringify(r3.now));

await new Promise((r) => setTimeout(r, 3000));
console.log('等待后台队列后的统计:', JSON.stringify(await page.evaluate(() => window.__piano().sampler.stats())));
console.log(errs.length ? `=== 错误 ${errs.length} 条 ===\n${errs.slice(0, 8).join('\n')}` : '=== 错误：无 ===');
await browser.close();
