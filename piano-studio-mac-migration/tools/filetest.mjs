import puppeteer from 'puppeteer-core';
import { resolveBrowserPath } from './_browser.mjs';

const CHROME = resolveBrowserPath();
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--window-size=1400,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const logs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', r => logs.push(`[reqfail] ${r.url().slice(0,90)} ${r.failure()?.errorText}`));

const url = new globalThis.URL('../index.html', import.meta.url).href;
console.log('打开', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
try {
  await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done'), { timeout: 120000, polling: 400 });
  console.log('✓ 加载完成');
} catch {
  console.log('✗ 加载未完成：', await page.$eval('#loadText', e => e.textContent).catch(()=>'?'));
}
await new Promise(r => setTimeout(r, 8000));
const st = await page.evaluate(() => {
  const p = window.__piano?.();
  return p ? { tier: p.tier, ...p.stats() } : null;
});
console.log('状态：', st);
await page.screenshot({ path: 'shots/file-protocol.png' });
console.log('\n=== 错误/警告 ===');
console.log(logs.length ? logs.slice(0, 15).join('\n') : '（无）');
await browser.close();
