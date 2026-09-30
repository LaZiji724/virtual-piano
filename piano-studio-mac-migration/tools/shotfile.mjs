import puppeteer from 'puppeteer-core';
import { resolveBrowserPath } from './_browser.mjs';

const CHROME = resolveBrowserPath();
const PAGE_URL = process.env.PAGE_URL
  || new globalThis.URL('../index.html', import.meta.url).href;
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--window-size=1500,940'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 940 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done'), { timeout: 120000, polling: 400 });
await page.evaluate(() => window.__piano().setTier('high'));
await new Promise(r => setTimeout(r, 3000));
await page.screenshot({ path: 'shots/play-hero.png' });
console.log('已保存 shots/play-hero.png');
// 按几个键，截一张"正在弹"的图
await page.evaluate(() => {
  ['KeyZ','KeyC','KeyG','KeyB'].forEach(c => window.dispatchEvent(new KeyboardEvent('keydown', { code: c })));
  const btn = document.querySelector('#views button[data-view="keyboard"]');
  btn?.click();
});
await new Promise(r => setTimeout(r, 2600));
await page.screenshot({ path: 'shots/play-keys.png' });
console.log('已保存 shots/play-keys.png');
await browser.close();
