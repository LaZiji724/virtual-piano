/**
 * 键盘剖面测量：沿 Z 竖直扫一条线，把命中的每个面都列出来。
 * 用法： node tools/scan.mjs
 */
import puppeteer from 'puppeteer-core';
import { resolveBrowserPath } from './_browser.mjs';

const CHROME = resolveBrowserPath();
const PAGE_URL = process.env.PAGE_URL
  || new globalThis.URL('../index.html', import.meta.url).href;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--window-size=1400,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done'), { timeout: 120000, polling: 400 });

const out = await page.evaluate(() => {
  const THREE = window.__THREE;
  const p = window.__piano();
  const kb = p.keyboardRig;
  const res = {};

  const name = (o) => {
    let n = o, d = 0;
    while (n && d++ < 6) { if (n.name) return n.name; n = n.parent; }
    return '(无名)';
  };

  // ── A. 按键方向：白键前端尖点的世界 Y ────────────────────
  {
    const s = kb.slotOf(60);
    const g = s.mesh.geometry;
    g.computeBoundingBox();
    const bb = g.boundingBox;
    res.whiteKeyGeoBB = [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z].map(v => +v.toFixed(4));
    const tipLocal = new THREE.Vector3(0, bb.max.y, bb.max.z);   // 顶面 × 最前端
    const backLocal = new THREE.Vector3(0, bb.max.y, 0);         // 顶面 × 后端
    const read = () => {
      const m = new THREE.Matrix4();
      s.mesh.getMatrixAt(s.index, m);
      return {
        tip: +tipLocal.clone().applyMatrix4(m).y.toFixed(4),
        back: +backLocal.clone().applyMatrix4(m).y.toFixed(4),
      };
    };
    kb.allUp(); for (let i = 0; i < 300; i++) kb.update(0.016);
    const up = read();
    kb.press(60, 1); for (let i = 0; i < 300; i++) kb.update(0.016);
    const down = read();
    res.pressDir = { up, down, tipDelta: +(down.tip - up.tip).toFixed(4), backDelta: +(down.back - up.back).toFixed(4) };
    kb.allUp(); for (let i = 0; i < 300; i++) kb.update(0.016);
  }

  // ── B. 沿 Z 竖直扫描线：把键盘剖面每一层都列出来 ──────────
  const scanAt = (x, label) => {
    const rows = [];
    const rc = new THREE.Raycaster();
    for (let z = 0.14; z >= -0.36; z -= 0.005) {
      rc.set(new THREE.Vector3(x, 2.5, z), new THREE.Vector3(0, -1, 0));
      const hits = rc.intersectObjects(p.scene.children, true).filter(h => h.point.y > 0.6 && h.point.y < 1.0);
      if (!hits.length) { rows.push({ z: +z.toFixed(3), top: null }); continue; }
      rows.push({
        z: +z.toFixed(3),
        top: +hits[0].point.y.toFixed(4),
        topName: name(hits[0].object),
        all: hits.slice(0, 3).map(h => `${name(h.object)}@${h.point.y.toFixed(3)}`),
      });
    }
    return { label, rows };
  };
  res.scanWhiteGap = scanAt(0.0, 'x=0（E4/F4 键缝）');
  res.scanWhiteMid = scanAt(0.0067, 'x=0.0067（C4 键中）');
  res.scanBlack = scanAt(0.0, 'x=0（黑键）');

  // ── C. 横向扫描：俯视时每一列的最高面，看黑边框在哪 ──────
  {
    const rc = new THREE.Raycaster();
    const cols = [];
    for (let x = -0.80; x <= 0.80; x += 0.01) {
      let best = null;
      for (let z = 0.06; z >= -0.20; z -= 0.004) {
        rc.set(new THREE.Vector3(x, 2.5, z), new THREE.Vector3(0, -1, 0));
        const hits = rc.intersectObjects(p.scene.children, true).filter(h => h.point.y > 0.6 && h.point.y < 1.0);
        if (hits.length && (!best || hits[0].point.y > best.y)) best = { y: hits[0].point.y, n: name(hits[0].object), z };
      }
      cols.push({ x: +x.toFixed(3), ...(best ? { y: +best.y.toFixed(3), n: best.n, z: +best.z.toFixed(3) } : { y: null }) });
    }
    // 压缩成连续区间
    const runs = [];
    for (const c of cols) {
      const last = runs[runs.length - 1];
      if (last && last.n === c.n && Math.abs(last.y - c.y) < 0.002 && last.x1 >= c.x - 0.011) last.x1 = c.x;
      else runs.push({ n: c.n, y: c.y, x0: c.x, x1: c.x });
    }
    res.columns = runs.filter(r => r.x1 - r.x0 > 0.008 || r.n !== 'whiteKeyMesh').slice(0, 40);
  }

  return res;
});


for (const key of ['scanWhiteGap','scanWhiteMid']) {
  const sc = out[key];
  console.log('=== ' + sc.label + ' ===');
  let prev = 'INIT';
  for (const r of sc.rows) {
    const cur = r.top === null ? 'none' : r.top.toFixed(3) + ' ' + r.topName;
    if (cur !== prev) { console.log('  z=' + r.z.toFixed(3).padStart(6) + '  ' + cur + (r.all ? '   [' + r.all.join(' | ') + ']' : '')); prev = cur; }
  }
}
console.log('=== 横向（俯视最高面） ===');
for (const c of out.columns) console.log('  x ' + c.x0.toFixed(2) + ' → ' + c.x1.toFixed(2) + '   y=' + c.y + '  ' + c.n);

await browser.close();
