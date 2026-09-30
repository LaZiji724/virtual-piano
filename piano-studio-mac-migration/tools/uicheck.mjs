// 快速 UI 验证：音源下拉是否列出全部本地库，选中 accurate 后状态行是否正确
import puppeteer from 'puppeteer-core';
import { resolveBrowserPath } from './_browser.mjs';

const CHROME = resolveBrowserPath();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on('console', (m) => { if (m.type() === 'error') console.log('[页面错误]', m.text()); });
await page.goto('http://127.0.0.1:8137/', { waitUntil: 'networkidle2' });
// 音频上下文需要一次用户手势，先模拟点击解锁
await page.click('body');
await new Promise((r) => setTimeout(r, 1500));

const info = await page.evaluate(() => {
  const sel = document.getElementById('srcPick');
  return {
    libs: window.__piano().sampleLibs.map((l) => `${l.id} / ${l.piano}`),
    options: sel ? [...sel.options].map((o) => o.textContent) : null,
    stat: document.getElementById('srcStat')?.textContent ?? null,
    credit: document.getElementById('srcCredit')?.textContent?.slice(0, 60) ?? null,
  };
});
console.log('探测到的本地音源:', JSON.stringify(info.libs));
console.log('下拉选项:', JSON.stringify(info.options));
console.log('状态行:', info.stat);
console.log('署名:', info.credit);

// 切到 accurate，确认加载成功
const r = await page.evaluate(async () => {
  await window.useSource('accurate');
  const p = window.__piano();
  return {
    mode: p.audio.mode,
    stat: document.getElementById('srcStat')?.textContent ?? null,
    saved: localStorage.getItem('piano.source'),
    stats: p.sampler.stats(),
  };
});
console.log('切到 accurate:', JSON.stringify(r));
await browser.close();
