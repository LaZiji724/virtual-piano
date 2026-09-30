/**
 * 弹奏功能实跑测试（file:// 协议）。
 *
 * 光看截图看不出声音有没有出来、琴键有没有动，所以这里：
 *   1. 在页面里给 AudioContext 打桩，统计真正创建的振荡器数量与基频；
 *   2. 直接派发 pointerdown 到琴键上，验证 raycast 拾取和按键下沉；
 *   3. 驱动帧，确认琴键矩阵真的被改写。
 *
 * 用法： node tools/playtest.mjs
 */

import puppeteer from 'puppeteer-core';
import { resolveBrowserPath } from './_browser.mjs';

const CHROME = resolveBrowserPath();
const PAGE_URL = process.env.PAGE_URL
  || new globalThis.URL('../index.html', import.meta.url).href;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--window-size=1400,900', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`[console] ${m.text()}`); });

await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(
  () => document.getElementById('loading')?.classList.contains('done'),
  { timeout: 120000, polling: 400 },
);
console.log('✓ 页面加载完成');

// ── 给 Web Audio 打桩：记录每个振荡器的频率 ──────────────
await page.evaluate(() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  const OrigOsc = AC.prototype.createOscillator;
  window.__osc = [];
  AC.prototype.createOscillator = function () {
    const o = OrigOsc.call(this);
    const origStart = o.start.bind(o);
    o.start = (...a) => { window.__osc.push(o.frequency.value); return origStart(...a); };
    return o;
  };
  const OrigBuf = AC.prototype.createBufferSource;
  window.__noise = 0;
  AC.prototype.createBufferSource = function () {
    const s = OrigBuf.call(this);
    const origStart = s.start.bind(s);
    s.start = (...a) => { window.__noise++; return origStart(...a); };
    return s;
  };
});

// ── 用电脑键盘触发一个和弦 ──────────────────────────────
await page.evaluate(() => {
  for (const code of ['KeyZ', 'KeyC', 'KeyG']) {          // C4 E4 G4
    window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
  }
});
await new Promise((r) => setTimeout(r, 700));
const chord = await page.evaluate(() => {
  const p = window.__piano();
  return {
    oscillators: window.__osc.length,
    noiseBursts: window.__noise,
    voices: p.audio.activeVoices,
    audioReady: p.audio.isReady,
    // 基频应该能对上 C4/E4/G4
    fundamentals: [...new Set(window.__osc.map((f) => Math.round(f)))].filter(
      (f) => [262, 330, 392].some((t) => Math.abs(f - t) < 3),
    ),
  };
});
console.log('键盘和弦 C4+E4+G4 →', JSON.stringify(chord));
console.log(`  振荡器 ${chord.oscillators} 个，琴槌噪声 ${chord.noiseBursts} 段，同时发声 ${chord.voices} 个音`);
console.log(`  基频命中 ${chord.fundamentals.join(' / ')} Hz（期望含 262/330/392）`);

// ── 松开，确认声音收掉 ──────────────────────────────────
await page.evaluate(() => {
  for (const code of ['KeyZ', 'KeyC', 'KeyG']) {
    window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
  }
});
await new Promise((r) => setTimeout(r, 600));
const after = await page.evaluate(() => window.__piano().audio.activeVoices);
console.log(`  松键后仍在发声的音：${after}（衰减中，正常应逐步归零）`);

// ── 鼠标点击琴键：验证 raycast 拾取 + 按键下沉 ──────────
const click = await page.evaluate(async () => {
  const p = window.__piano();
  const canvas = p.renderer.domElement;
  const before = window.__osc.length;

  // 把相机切到键盘特写，保证琴键在画面里
  const btn = document.querySelector('#views button[data-view="keyboard"]');
  btn?.click();
  await new Promise((r) => setTimeout(r, 1400));

  // 扫一整片网格找琴键——只扫一条线很容易整条都落在琴身上
  const rect = canvas.getBoundingClientRect();
  let hitAt = null;
  const tried = [];
  outer:
  for (let gy = 0; gy <= 8; gy++) {
    for (let gx = 0; gx <= 12; gx++) {
      const x = rect.left + rect.width * (0.18 + gx * 0.055);
      const y = rect.top + rect.height * (0.25 + gy * 0.075);
      canvas.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, bubbles: true,
      }));
      await new Promise((r) => setTimeout(r, 25));
      canvas.dispatchEvent(new PointerEvent('pointerup', {
        clientX: x, clientY: y, button: 0, buttons: 0, pointerId: 1, bubbles: true,
      }));
      tried.push([Math.round(x), Math.round(y)]);
      if (window.__osc.length > before) { hitAt = { x: Math.round(x), y: Math.round(y) }; break outer; }
    }
  }
  return { hitAt, newOsc: window.__osc.length - before, tried: tried.length };
});
console.log('鼠标点键 →', click.hitAt ? `在 (${click.hitAt.x},${click.hitAt.y}) 命中，新起 ${click.newOsc} 个振荡器` : '未命中任何琴键');

// ── 按键动画：驱动帧，看实例矩阵有没有真的被改写 ────────
const anim = await page.evaluate(async () => {
  const p = window.__piano();
  const kb = p.keyboardRig;
  // 读的必须是 midi 60 对应的那个实例（实例 0 是 A0，按它当然看不到变化）
  const slot = kb.slotOf ? kb.slotOf(60) : null;
  const mesh = slot ? slot.mesh : kb.hitMeshes[0];
  const idx = slot ? slot.index : 0;
  const read = () => Array.from(mesh.instanceMatrix.array.slice(idx * 16, idx * 16 + 16));
  const before = read();
  kb.press(60, 1);                       // 按下 C4
  for (let i = 0; i < 40; i++) {         // 手动驱动，headless 里 rAF 会被节流
    kb.update(0.016);
    await new Promise((r) => requestAnimationFrame(r));
  }
  const during = read();
  const moved = before.some((v, i) => Math.abs(v - during[i]) > 1e-5);
  kb.press(60, 0);
  for (let i = 0; i < 90; i++) { kb.update(0.016); await new Promise((r) => requestAnimationFrame(r)); }
  const after = read();
  const back = during.some((v, i) => Math.abs(v - after[i]) > 1e-5);
  return { moved, back };
});
console.log(`按键动画：按下时矩阵变化 ${anim.moved ? '✓' : '✗'}，松开后回位 ${anim.back ? '✓' : '✗'}`);

const st = await page.evaluate(() => {
  const p = window.__piano();
  return { tier: p.tier, ...p.stats() };
});
console.log('画质档位：', JSON.stringify(st));

console.log('\n=== 错误 ===');
console.log(errs.length ? errs.slice(0, 10).join('\n') : '（无）');
await browser.close();
