/**
 * 射线拾取探针：把屏幕上若干点对应的物体打出来。
 * 排查"这块奇怪的面到底是谁"的时候比对着截图猜快得多。
 * 用法： node tools/probe.mjs [视角key] nx,ny nx,ny ...
 */

import puppeteer from 'puppeteer-core';
import { resolveBrowserPath } from './_browser.mjs';

const CHROME = resolveBrowserPath();
const URL = process.env.PIANO_URL || 'http://127.0.0.1:8137/';

const args = process.argv.slice(2);
const view = args[0] || 'top';
const points = args.slice(1).length
  ? args.slice(1).map((s) => s.split(',').map(Number))
  : [[-0.35, 0.10], [-0.15, -0.05], [-0.55, 0.25], [-0.30, -0.35]];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--window-size=1600,1000'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(
  () => document.getElementById('loading')?.classList.contains('done'),
  { timeout: 180000, polling: 400 },
);

if (view !== 'hero') {
  await page.evaluate((v) => document.querySelector(`#views button[data-view="${v}"]`)?.click(), view);
  await new Promise((r) => setTimeout(r, 2600));
}

console.log(`视角 ${view}`);
for (const [nx, ny] of points) {
  const hits = await page.evaluate((a, b) => window.__pick(a, b), nx, ny);
  console.log(`\n屏幕 (${nx}, ${ny})`);
  if (!hits?.length) { console.log('   （没有命中）'); continue; }
  hits.forEach((h) => console.log('   ', JSON.stringify(h)));
}

const bbox = await page.evaluate(() => {
  const out = [];
  window.__piano().scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const g = o.geometry;
    g.computeBoundingBox();
    const b = g.boundingBox;
    const name = o.name || o.parent?.name || '?';
    if (!out.find((x) => x.name === name)) {
      out.push({
        name,
        min: [+b.min.x.toFixed(3), +b.min.y.toFixed(3), +b.min.z.toFixed(3)],
        max: [+b.max.x.toFixed(3), +b.max.y.toFixed(3), +b.max.z.toFixed(3)],
        mat: o.material?.color?.getHexString?.(),
      });
    }
  });
  return out;
});
console.log('\n各部件包围盒：');
bbox.forEach((b) => console.log('  ', JSON.stringify(b)));

await browser.close();
