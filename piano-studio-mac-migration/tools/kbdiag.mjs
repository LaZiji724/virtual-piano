/**
 * 键盘特写：透视近景，关 Bloom（否则白键整片过曝，什么都看不清）。
 * 顺带把「按下时琴键前端尖点的世界 Y」量出来——方向对不对只能靠这个。
 * 用法： node tools/kbdiag.mjs
 */
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
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done'), { timeout: 120000, polling: 400 });

await page.evaluate(() => {
  for (const id of ['panel', 'hud', 'loading']) {
    const e = document.getElementById(id);
    if (e) e.style.display = 'none';
  }
  const p = window.__piano();
  p.setTier('low');                       // 低档 = 无 Bloom，几何看得清
  p.renderer.toneMappingExposure = 0.62;
  p.camera.fov = 30;
  p.camera.updateProjectionMatrix();
  p.controls.enabled = false;
});

// ── 按键方向：前端尖点 vs 后端，按下前后的世界 Y ──────────
const dir = await page.evaluate(() => {
  const THREE = window.__THREE;
  const p = window.__piano();
  const kb = p.keyboardRig;
  const s = kb.slotOf(60);
  const read = () => {
    const m = new THREE.Matrix4();
    s.mesh.getMatrixAt(s.index, m);
    const tip = new THREE.Vector3(0, 0.022, 0.15).applyMatrix4(m);
    const back = new THREE.Vector3(0, 0.022, 0).applyMatrix4(m);
    return { tip: +tip.y.toFixed(4), back: +back.y.toFixed(4), tipZ: +tip.z.toFixed(4) };
  };
  kb.allUp(); for (let i = 0; i < 300; i++) kb.update(0.016);
  const up = read();
  kb.press(60, 1); for (let i = 0; i < 300; i++) kb.update(0.016);
  const down = read();
  kb.allUp(); for (let i = 0; i < 300; i++) kb.update(0.016);
  return { up, down, tipDelta: +(down.tip - up.tip).toFixed(4), backDelta: +(down.back - up.back).toFixed(4) };
});
console.log('按键方向：', JSON.stringify(dir));
console.log(dir.tipDelta < -0.005 ? '  ✓ 前端下沉，方向正确' : '  ✗ 前端没有下沉');

async function shot(name, { target, dir, dist, press = [], fall = 90 }) {
  await page.evaluate(({ target, dir, dist, press, fall }) => {
    const p = window.__piano();
    const t = new window.__THREE.Vector3(...target);
    const d = new window.__THREE.Vector3(...dir).normalize().multiplyScalar(dist);
    p.camera.position.copy(t).add(d);
    p.camera.lookAt(t);
    p.controls.target.copy(t);
    p.fallboardRig.setAngle(fall);
    p.keyboardRig.allUp();
    for (const m of press) p.keyboardRig.press(m, 1);
    for (let i = 0; i < 200; i++) p.keyboardRig.update(0.016);
  }, { target, dir, dist, press, fall });
  await new Promise((r) => setTimeout(r, 700));
  await page.screenshot({ path: `shots/${name}.png` });
  console.log(`已保存 shots/${name}.png`);
}

// 斜上方 45° 看整排键盘（就是用户看到"黑边框"的那个角度）
await shot('k-persp', { target: [0, 0.74, -0.06], dir: [0.30, 0.86, 1.0], dist: 1.5 });
// 侧视单键剖面，按下 C4 / E4 / G4
await shot('k-side', { target: [0.08, 0.718, -0.06], dir: [1, 0.06, 0.05], dist: 0.55, press: [60, 64, 67] });
// 键盘盖 0 / 45 / 90
await shot('k-fall0', { target: [0, 0.76, -0.08], dir: [0.6, 0.45, 1.0], dist: 0.95, fall: 0 });
await shot('k-fall45', { target: [0, 0.76, -0.08], dir: [0.6, 0.45, 1.0], dist: 0.95, fall: 45 });
await shot('k-fall90', { target: [0, 0.76, -0.08], dir: [0.6, 0.45, 1.0], dist: 0.95, fall: 90 });

await browser.close();
