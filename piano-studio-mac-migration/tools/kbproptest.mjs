/**
 * 瀑布流键盘键形比例实测（像素级，不看代码只看画出来的东西）。
 *
 * 标尺是**真实毫米**：屏幕宽 = 琴身宽 1490 mm，所以
 *   白键中心距 : 键床深 = 23.5 : 150      黑键宽 : 白键面宽 = 13.9 : 22.3
 *   黑键露长 : 键床深 = 95 : 150          键盘总宽 : 琴身宽 = 1222 : 1490（= 82%）
 * 顺带验：52 白键 / 36 黑键都在、键盘居中、两侧露出键侧木、黑键落在白键缝上。
 * 最后换一个又宽又扁的窗口再量一遍——真实尺寸画出来的东西不该因为窗口变形，
 * 也不该出现"塞不下就压缩"那类二次拟合。
 *
 * 用法： node tools/kbproptest.mjs      （需先 npm start）
 */
import puppeteer from 'puppeteer-core';
import { resolveBrowserPath } from './_browser.mjs';

const CHROME = resolveBrowserPath();
const URL = process.env.PIANO_URL || 'http://127.0.0.1:8137/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${msg}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* 真琴尺寸（mm，与 spec.js 同源） */
const MM = { pitch: 23.5, keyLen: 150, gap: 1.2, blackW: 13.9, blackLen: 95, bodyW: 1490 };
const STD = {
  lenPitch: MM.keyLen / MM.pitch,                        // 6.383
  facePitch: (MM.pitch - MM.gap) / MM.pitch,             // 0.949
  blackFace: MM.blackW / (MM.pitch - MM.gap),            // 0.623
  blackLen: MM.blackLen / MM.keyLen,                     // 0.633
  kbBody: (52 * MM.pitch) / MM.bodyW,                    // 0.820
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => document.getElementById('loading')?.classList.contains('done'),
  { timeout: 120000, polling: 400 },
);
await page.click('body');
await page.evaluate(() => window.__piano().setWfMode(true));
await sleep(500);

async function measure(label) {
  const m = await page.evaluate(() => {
    const P = window.__piano();
    const cv = document.getElementById('wf');
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height;            // deviceScaleFactor=1 → 设备像素 = CSS 像素
    const geo = P.wf.metrics;

    // 行扫描：返回连续"亮块"（白键）或"暗块"（黑键）的 x 与宽度
    const runs = (y, wantBright, x0 = 0, x1 = W) => {
      const d = g.getImageData(0, Math.round(y), W, 1).data;
      const out = [];
      let start = -1;
      for (let x = x0; x < x1; x++) {
        const bright = (d[x * 4] + d[x * 4 + 1] + d[x * 4 + 2]) / 3 > 120;
        if (bright === wantBright && start < 0) start = x;
        else if (bright !== wantBright && start >= 0) { out.push({ x: start, w: x - start }); start = -1; }
      }
      if (start >= 0) out.push({ x: start, w: x1 - start });
      return out;
    };
    const whiteY = geo.kbTop + geo.kbH * 0.85;    // 白键区（黑键之下，避开键名那点小字）
    const blackY = geo.kbTop + geo.blackH * 0.5;  // 黑键区
    const whites = runs(whiteY, true);
    // 黑键区里"暗"的东西有三种：真黑键、键与键之间那条 1.6 px 的缝、
    // 以及键盘两端的键侧木。只在量出来的键盘范围内找，且宽度 > 5 px 才算黑键。
    const kbL = whites[0].x - 1;
    const kbR = whites.at(-1).x + whites.at(-1).w + 1;
    const blacks = runs(blackY, false, kbL, kbR).filter((r) => r.w > 5);

    // 列扫描：一根白键中间那列，最上面那个亮像素就是键床前沿
    const mid = whites[Math.floor(whites.length / 2)];
    const colX = Math.round(mid.x + mid.w / 2);
    let bedTop = null;
    for (let y = Math.max(0, Math.round(geo.kbTop) - 40); y < H; y++) {
      const p = g.getImageData(colX, y, 1, 1).data;
      if ((p[0] + p[1] + p[2]) / 3 > 120) { bedTop = y; break; }
    }
    // 黑键长度：从键宽 1/4 处往下数（**不能取正中**——黑键正压在两条白键的
    // 键缝上，键缝那条抗锯齿暗线（亮度 111）会一直被当成黑键，数到画布底）
    const bc = blacks[Math.floor(blacks.length / 2)];
    let blackLen = null;
    if (bc) {
      const bx = Math.round(bc.x + bc.w * 0.25);
      blackLen = 0;
      for (let y = Math.round(geo.kbTop); y < H; y++) {
        const p = g.getImageData(bx, y, 1, 1).data;
        if ((p[0] + p[1] + p[2]) / 3 > 120) break;
        blackLen++;
      }
    }
    // 键盘两侧不该有琴键：白键行最左/最右那两个像素是暗的（露出键侧木）
    const brightAt = (x, y) => {
      const p = g.getImageData(x, Math.round(y), 1, 1).data;
      return (p[0] + p[1] + p[2]) / 3 > 120;
    };
    return {
      W, H, geo, bedTop, blackLen,
      whiteCount: whites.length, blackCount: blacks.length,
      whiteWidth: whites.map((r) => r.w), blackWidth: blacks.map((r) => r.w),
      firstStart: whites[0].x, lastStart: whites.at(-1).x,
      firstBlackCenter: blacks[0] ? blacks[0].x + blacks[0].w / 2 : null,
      cheekLeft: !brightAt(2, whiteY), cheekRight: !brightAt(W - 3, whiteY),
    };
  });

  const pitch = (m.lastStart - m.firstStart) / (m.whiteCount - 1);   // 中心距：首尾跨距算，避开整数取整误差
  const faceW = med(m.whiteWidth);                                   // 白键面宽（中心距 − 键缝）
  const bedH = m.H - m.bedTop;
  const blackW = med(m.blackWidth);

  console.log(`\n【${label}】画布 ${m.W}×${m.H}`);
  console.log(`   中心距 ${pitch.toFixed(2)} px · 白键面 ${faceW.toFixed(2)}×${bedH} px · 黑键 ${blackW.toFixed(2)}×${m.blackLen}`);
  console.log(`   键盘 x=${m.firstStart}…${(m.lastStart + faceW).toFixed(0)}（画布宽 ${m.W}）`);

  ok(m.whiteCount === 52 && m.blackCount === 36, '88 键画全（52 白 + 36 黑）',
    `${m.whiteCount} 白 / ${m.blackCount} 黑`);
  ok(near(bedH / pitch, STD.lenPitch, STD.lenPitch * 0.04), '键床深 : 中心距 = 150 : 23.5',
    `实测 ${(bedH / pitch).toFixed(3)} · 标准 ${STD.lenPitch.toFixed(3)}`);
  ok(near(faceW / pitch, STD.facePitch, 0.03), '键缝 = 白键宽的 1.2/23.5',
    `面宽 ${(faceW / pitch).toFixed(3)} vs ${STD.facePitch.toFixed(3)}`);
  ok(near(blackW / faceW, STD.blackFace, 0.05), '黑键宽 : 白键面宽 = 13.9 : 22.3',
    `${(blackW / faceW).toFixed(3)} vs ${STD.blackFace.toFixed(3)}`);
  ok(near(m.blackLen / bedH, STD.blackLen, 0.04), '黑键露长 : 键床深 = 95 : 150',
    `${(m.blackLen / bedH).toFixed(3)} vs ${STD.blackLen.toFixed(3)}`);
  const left = m.firstStart;
  const right = m.lastStart + faceW + (pitch - faceW);
  const kbW = right - left + (pitch - faceW);
  ok(near(kbW / m.W, STD.kbBody, 0.01), '键盘总宽 : 屏宽 = 1222 : 1490（键盘 82%，两侧键侧木）',
    `${(kbW / m.W * 100).toFixed(1)}% vs ${(STD.kbBody * 100).toFixed(1)}%`);
  ok(near((m.W - kbW) / 2, left - (pitch - faceW) / 2, 3), '键盘水平居中',
    `左空 ${(left - (pitch - faceW) / 2).toFixed(1)} · 右空 ${(m.W - right - (pitch - faceW) / 2).toFixed(1)}`);
  ok(m.cheekLeft && m.cheekRight, '两侧键侧木画出来了（真琴键盘两侧各 134 mm）',
    `左 ${m.cheekLeft} · 右 ${m.cheekRight}`);
  // 第一个黑键是 A#0，落在 A0/B0 之间的键缝上（真琴还有 0.5 mm 制造调整）
  ok(near(m.firstBlackCenter, left + pitch, 2.5), '黑键落在白键缝上（不是压在白键中间）',
    `黑键中心 ${m.firstBlackCenter.toFixed(1)} · 键缝 ${(left + pitch).toFixed(1)}`);
  return { pitch, faceW, bedH, blackW, kbW };
}

const a = await measure('常规窗口 1600×1000');
await page.setViewport({ width: 2400, height: 520, deviceScaleFactor: 1 });
await sleep(600);
const b = await measure('又宽又扁 2400×520（尺寸不该因此变形或压缩）');
ok(near(b.bedH / b.pitch, STD.lenPitch, STD.lenPitch * 0.04), '扁窗口下键形比例依然等于真琴',
  `${(b.bedH / b.pitch).toFixed(3)}`);
ok(near(b.kbW / 2400, STD.kbBody, 0.01), '扁窗口下键盘仍占屏宽 82%（没有压缩拟合）',
  `${(b.kbW / 2400 * 100).toFixed(1)}%`);
ok(near(b.pitch / a.pitch, 2400 / 1600, 0.01), '唯一那个缩放就是屏幕宽 : 琴身宽',
  `中心距 ${a.pitch.toFixed(2)} → ${b.pitch.toFixed(2)} px（比值 ${(b.pitch / a.pitch).toFixed(3)}，屏宽比 1.500）`);

/* ── 点按命中：画出来的键位和点下去响的音必须是同一个键 ── */
// 窄窗口下控制面板会盖住最右侧琴键的一小部分；先收起面板，再测完整键盘。
await page.click('#panelClose');
await sleep(400);
const geo = await page.evaluate(() => window.__piano().wf.metrics);
const BLACK_PC = new Set([1, 3, 6, 8, 10]);
const whites = [];
for (let m = 21; m <= 108; m++) if (!BLACK_PC.has(m % 12)) whites.push(m);
const pitch = geo.kbW / 52;
const targets = [
  { label: '第 1 个白键 A0', x: geo.kbX0 + pitch * 0.5, y: geo.kbTop + geo.kbH * 0.85, midi: whites[0] },
  { label: '中间白键', x: geo.kbX0 + pitch * 25.5, y: geo.kbTop + geo.kbH * 0.85, midi: whites[25] },
  { label: '最后一个白键 C8', x: geo.kbX0 + pitch * 51.5, y: geo.kbTop + geo.kbH * 0.85, midi: whites[51] },
  { label: '第一个黑键 A#0', x: geo.kbX0 + pitch * 1, y: geo.kbTop + geo.blackH * 0.5, midi: 22 },
  { label: '黑键下方的白键 B0', x: geo.kbX0 + pitch * 1.5, y: geo.kbTop + geo.kbH * 0.85, midi: 23 },
];
await page.evaluate(() => window.__piano().recorder.start());
const hits = [];
for (const t of targets) {
  await page.mouse.move(t.x, t.y);
  await page.mouse.down();
  await sleep(70);
  await page.mouse.up();
  const last = await page.evaluate(() => {
    const ev = window.__piano().recorder.events.filter((e) => e.type === 'on');
    return ev.length ? ev.at(-1).midi : null;
  });
  hits.push({ ...t, got: last });
}
await page.evaluate(() => window.__piano().recorder.stop());
console.log('');
for (const h of hits) ok(h.got === h.midi, `点按 ${h.label}`, `响的是 midi=${h.got}（期望 ${h.midi}）`);

await browser.close();
console.log(failures ? `\n=== 失败 ${failures} 项 ===` : '\n=== 全部通过 ===');
process.exit(failures ? 1 : 0);
