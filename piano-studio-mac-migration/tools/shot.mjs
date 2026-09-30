/**
 * 无头浏览器实跑：抓加载错误 + 各视角出图。
 *
 * 比在浏览器里手点快得多，而且能拿到 console / pageerror，
 * 之前的渲染问题基本都是靠它定位的。
 *
 * 用法： node tools/shot.mjs [视角key...]
 * 依赖： npm i（puppeteer-core）；Chrome 路径可用 CHROME_PATH 覆盖
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { resolveBrowserPath } from './_browser.mjs';

const CHROME = resolveBrowserPath();
const URL = process.env.PIANO_URL || 'http://127.0.0.1:8137/';
const OUT = 'shots';
const views = process.argv.slice(2).length ? process.argv.slice(2) : ['hero'];

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--window-size=1600,1000',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

console.log(`打开 ${URL}`);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

// 等加载页消失
try {
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('done'),
    { timeout: 180000, polling: 400 },
  );
  console.log('加载完成');
} catch {
  const txt = await page.$eval('#loadText', (e) => e.textContent).catch(() => '（读不到）');
  console.log(`!! 加载未完成，页面上写着：${txt}`);
}

// 让后处理链和阴影跑几帧稳定下来
await new Promise((r) => setTimeout(r, 6000));

for (const v of views) {
  if (v !== 'hero') {
    await page.evaluate((key) => {
      const btn = document.querySelector(`#views button[data-view="${key}"]`);
      btn?.click();
    }, v);
    await new Promise((r) => setTimeout(r, 2600));
  }
  const file = `${OUT}/${v}.png`;
  await page.screenshot({ path: file });
  console.log(`已保存 ${file}`);
}

const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0;
  const t0 = performance.now();
  const tick = () => { if (++n < 60) requestAnimationFrame(tick); else res(60000 / (performance.now() - t0)); };
  requestAnimationFrame(tick);
})).catch(() => -1);
console.log(`帧率（无头软件渲染，仅供参考）：${fps.toFixed?.(1) ?? fps} fps`);

const summary = await page.evaluate(() => {
  const p = window.__piano?.();
  if (!p) return null;
  let meshes = 0, tris = 0;
  p.scene.traverse((o) => {
    if (o.isMesh || o.isInstancedMesh) {
      meshes++;
      const g = o.geometry;
      const c = g.index ? g.index.count : g.attributes.position.count;
      tris += (c / 3) * (o.isInstancedMesh ? o.count : 1);
    }
  });
  return {
    meshes, tris: Math.round(tris),
    drawCalls: p.renderer.info.render.calls,
    gtao: !!p.postfx?.gtao,
    bloom: !!p.postfx?.bloom,
    shadowMap: p.renderer.shadowMap.enabled,
    passes: p.postfx?.composer?.passes?.length,
  };
});
console.log('场景统计：', summary);

console.log('\n=== 控制台输出 ===');
if (!logs.length) console.log('（无）');
else logs.slice(0, 60).forEach((l) => console.log(l));

writeFileSync(`${OUT}/console.log`, logs.join('\n'));
await browser.close();
