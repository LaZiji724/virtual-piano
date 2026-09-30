/**
 * 逐项排除：地板上那几块椭圆斑是谁干的。
 * 一次加载，逐组开关后处理 / 灯光 / 环境，各截一张。
 *
 * 用法： node tools/tune.mjs
 */

import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { resolveBrowserPath } from './_browser.mjs';


const CHROME = resolveBrowserPath();
const URL = 'http://127.0.0.1:8137/';

mkdirSync('shots/tune', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--window-size=1200,760'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 760 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(
  () => document.getElementById('loading')?.classList.contains('done'),
  { timeout: 180000, polling: 400 },
);

const steps = [
  { tag: '00-baseline', js: `/* 原样 */` },
  {
    tag: '01-gtao-off',
    js: `window.__piano().postfx.gtao.blendIntensity = 0;`,
  },
  {
    tag: '02-floor-noEnv',
    js: `window.__piano().postfx.gtao.blendIntensity = 0.92;
         window.__piano().scene.traverse(o => {
           if (o.isMesh && o.geometry?.parameters?.width > 10) o.material.envMapIntensity = 0;
         });`,
  },
  {
    tag: '03-env-only-noshadow',
    js: `window.__piano().scene.traverse(o => {
           if (o.isMesh && o.geometry?.parameters?.width > 10) o.material.envMapIntensity = 0.55;
           if (o.isDirectionalLight && o.castShadow) o.castShadow = false;
         });`,
  },
  {
    tag: '04-key-only',
    js: `const p = window.__piano();
         p.__env = p.scene.environment; p.scene.environment = null;
         p.scene.traverse(o => { if (o.isDirectionalLight && !o.castShadow) o.intensity = 0; });`,
  },
];

for (const s of steps) {
  await page.evaluate((code) => { eval(code); }, s.js);
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `shots/tune/${s.tag}.png` });
  console.log(`已保存 shots/tune/${s.tag}.png`);
}

await browser.close();
