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
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done'), { timeout: 120000, polling: 400 });

const out = await page.evaluate(async () => {
  const THREE = window.__THREE;
  const p = window.__piano();
  const kb = p.keyboardRig;
  const res = {};

  res.hitMeshes = kb.hitMeshes.map(m => ({
    type: m.type, count: m.count, visible: m.visible,
    hasBS: !!m.geometry.boundingSphere,
    bs: m.geometry.boundingSphere ? [+m.geometry.boundingSphere.center.x.toFixed(3), +m.geometry.boundingSphere.center.y.toFixed(3), +m.geometry.boundingSphere.center.z.toFixed(3), +m.geometry.boundingSphere.radius.toFixed(3)] : null,
    matrixAutoUpdate: m.matrixAutoUpdate,
    inScene: (() => { let n = m, ok = false; while (n) { if (n === p.scene) ok = true; n = n.parent; } return ok; })(),
  }));

  // 用 midi 60 的实例矩阵反推它的世界位置，确认琴键到底在哪
  const slot = kb.slotOf(60);
  if (slot) {
    const m4 = new THREE.Matrix4();
    slot.mesh.getMatrixAt(slot.index, m4);
    const v = new THREE.Vector3().setFromMatrixPosition(m4);
    res.midi60 = { mesh: slot.mesh.type, index: slot.index, localPos: [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)] };
  }

  // 从琴键正上方往下打一条射线，看能不能命中
  const target = new THREE.Vector3(slot ? 0 : 0, 0.72, -0.05);
  const rc = new THREE.Raycaster();
  rc.set(new THREE.Vector3(target.x, 2.0, target.z), new THREE.Vector3(0, -1, 0));
  const hitsAll = rc.intersectObjects(p.scene.children, true);
  res.rayFromAbove = hitsAll.slice(0, 5).map(h => ({
    name: h.object.name || h.object.parent?.name || '?',
    type: h.object.type,
    inst: h.instanceId,
    y: +h.point.y.toFixed(3),
  }));

  const hitsKeys = rc.intersectObjects(kb.hitMeshes, false);
  res.rayHitsKeys = hitsKeys.slice(0, 4).map(h => ({ inst: h.instanceId, y: +h.point.y.toFixed(3), z: +h.point.z.toFixed(3) }));

  // InstancedMesh 自己的包围球 / 世界矩阵 / 实例 0 的矩阵
  res.meshDetail = kb.hitMeshes.map(m => {
    m.computeBoundingSphere?.();
    const bs = m.boundingSphere;
    const i0 = new THREE.Matrix4();
    m.getMatrixAt(0, i0);
    return {
      isInstanced: !!m.isInstancedMesh,
      count: m.count,
      meshBS: bs ? { c: [+bs.center.x.toFixed(3), +bs.center.y.toFixed(3), +bs.center.z.toFixed(3)], r: +bs.radius.toFixed(3) } : null,
      worldPos: m.getWorldPosition(new THREE.Vector3()).toArray().map(v => +v.toFixed(3)),
      inst0Pos: new THREE.Vector3().setFromMatrixPosition(i0).toArray().map(v => +v.toFixed(3)),
      geoDrawRange: m.geometry.drawRange.count,
      geoIndexCount: m.geometry.index ? m.geometry.index.count : null,
      geoPosCount: m.geometry.attributes.position.count,
      matType: m.material.type,
    };
  });

  // 单独对这个 mesh 调 raycast，看它自己报什么
  const solo = [];
  for (const m of kb.hitMeshes) {
    const arr = [];
    m.raycast(rc, arr);
    solo.push(arr.length);
  }
  res.soloRaycastHits = solo;

  // 对着 C4 那个实例的正上方往下打，这一发**必须**命中
  const probe = (() => {
    const s = kb.slotOf(60);
    if (!s) return 'no slot 60';
    const m4 = new THREE.Matrix4();
    s.mesh.getMatrixAt(s.index, m4);
    const base = new THREE.Vector3().setFromMatrixPosition(m4);   // 键后端底面中点
    const mid = new THREE.Vector3(base.x, base.y + 0.011, base.z + 0.075); // 键中点上方
    const r2 = new THREE.Raycaster();
    r2.set(new THREE.Vector3(mid.x, mid.y + 0.6, mid.z), new THREE.Vector3(0, -1, 0));
    const hitMesh = r2.intersectObject(s.mesh, false);
    const hitAll = r2.intersectObjects(p.scene.children, true).slice(0, 3)
      .map(h => h.object.name || h.object.parent?.name || '?');
    return { mid: [+mid.x.toFixed(3), +mid.y.toFixed(3), +mid.z.toFixed(3)],
             hitOwnMesh: hitMesh.length, hitAll };
  })();
  res.probeC4 = probe;

  // 几何包围球现在是什么
  res.geoBS = kb.hitMeshes.map(m => {
    const b = m.geometry.boundingSphere;
    return b ? [+b.center.x.toFixed(3), +b.center.y.toFixed(3), +b.center.z.toFixed(3), +b.radius.toFixed(3)] : null;
  });

  // 再算一下相机射线（屏幕中心）打到什么
  const rc2 = new THREE.Raycaster();
  rc2.setFromCamera(new THREE.Vector2(0, 0), p.camera);
  const camHits = rc2.intersectObjects(p.scene.children, true).slice(0, 3);
  res.screenCenter = camHits.map(h => ({ name: h.object.name || h.object.parent?.name || '?', inst: h.instanceId }));

  return res;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
