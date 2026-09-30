/** 一次性探针：验证 MediaRecorder 琴声 Blob 在 onstop 异步落地后存在 */
import puppeteer from 'puppeteer-core';
import { resolveBrowserPath } from './_browser.mjs';

const CHROME = resolveBrowserPath();
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1600,1000'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
page.on('console', (m) => console.log('[pg]', m.text()));
await page.goto('http://127.0.0.1:8137/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => document.getElementById('loading')?.classList.contains('done'),
  { timeout: 120000, polling: 400 },
);
const r = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const P = window.__piano();
  P.setWfMode(true);
  P.recorder.start();
  P.interaction.playNote(60, 0.9);
  await sleep(1200);
  P.interaction.silenceNote(60);
  P.recorder.stop();
  await sleep(1500);   // 等 MediaRecorder onstop 异步封装 Blob
  return {
    hasAudio: !!P.recorder.audioBlob,
    size: P.recorder.audioBlob?.size ?? 0,
    ctxState: P.engine.ctx?.state,
  };
});
console.log('结果:', JSON.stringify(r));
await browser.close();
