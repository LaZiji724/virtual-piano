/**
 * 琴身：侧板（rim）、音板、底板、弦轴板。
 *
 * 侧板是整个模型里最吃几何质量的一块。它不是"一圈竖直的墙"——
 * 顶面外侧有 17 mm 圆角，内侧有 8 mm 圆角，而最要紧的是：
 * **键盘段的两侧键侧木比琴身段矮 245 mm**。真机上侧板顶面从键盘往后
 * 有一个台阶，键盘段只有一道齐键面的矮墙（键侧木），琴身段才升到全高。
 * 如果整圈做成等高的围板，从正前方看会把整排琴键遮死，而且俯视时
 * 键盘像是被塞进一个盒子里——完全不像三角钢琴。
 */

import * as THREE from 'three';
import { SPEC, rimTopAt } from '../spec.js';
import { rimShape, shapeToOutline, shrinkPolygon, clipPolygonZ, ensureCCW } from '../core/outline.js';
import { loftClosed, rimProfile, capPolygon } from '../core/loft.js';

/** 查轮廓在某个 z 处的横向跨度（粗插值，够用） */
function spanAt(outline, z, tol = 0.03) {
  let min = Infinity, max = -Infinity;
  for (const p of outline) {
    if (Math.abs(p.z - z) < tol) {
      if (p.x < min) min = p.x;
      if (p.x > max) max = p.x;
    }
  }
  // 兜底：一个点都没落进容差时不能把 ±Infinity 传出去，
  // 否则 (min+max)/2 会算成 NaN，物体会直接消失
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [-0.6, 0.6];
  return [min, max];
}

export function buildBody(M) {
  const g = new THREE.Group();
  g.name = 'body';

  const outline = shapeToOutline(rimShape(), 384);
  const inner = ensureCCW(shrinkPolygon(outline, SPEC.rimThick));

  /* ── 1. 侧板：沿轮廓扫掠 rimProfile，每点的顶面高度由 z 决定 ──
         注意必须把 pt.x 一起传进去：键盘段正对琴键的那一截要塌到键床之下，
         只看 z 的话会在琴键前面横起一道墙（详见 spec.js 的 rimTopAt）。 */
  const rimGeo = loftClosed(
    outline,
    (pt) => rimProfile(
      rimTopAt(pt.z, pt.x), SPEC.rimBottom, SPEC.rimThick, SPEC.rimTopR, SPEC.rimInnerR, 6,
    ),
    10,
  );
  const rim = new THREE.Mesh(rimGeo, M.lacquer);
  rim.castShadow = true;
  rim.receiveShadow = true;
  g.add(rim);

  /* ── 2. 音板：内腔底部的云杉板 ── */
  const sbOutline = ensureCCW(clipPolygonZ(inner, SPEC.bodyBackZ + 0.012, SPEC.innerStartZ));
  const soundboard = new THREE.Mesh(capPolygon(sbOutline, [], 1), M.soundboard);
  soundboard.position.y = SPEC.soundboardY;
  soundboard.receiveShadow = true;
  g.add(soundboard);

  /* ── 3. 底板：封住琴腹下方，避免仰视时看穿 ── */
  const bottom = new THREE.Mesh(capPolygon(sbOutline, [], -1), M.innerWood);
  bottom.position.y = SPEC.rimBottom + 0.007;
  g.add(bottom);

  /* ── 4. 音板前缘的挡条：遮住单面音板的薄边 ── */
  {
    const [x0, x1] = spanAt(inner, SPEC.innerStartZ + 0.004, 0.05);
    const w = Math.max(0.2, x1 - x0);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, 0.022), M.innerWood);
    bar.position.set((x0 + x1) / 2, SPEC.soundboardY - 0.02, SPEC.innerStartZ + 0.011);
    g.add(bar);
  }

  /* ── 5. 弦轴板：键盘后方那块厚木，真机上铸铁板前端压在它上面 ── */
  {
    const zFront = -0.155;
    const zBack = SPEC.innerStartZ;
    const zc = (zFront + zBack) / 2;
    const [x0, x1] = spanAt(inner, zc, 0.14);
    const w = Math.max(0.3, x1 - x0);
    const yTop = SPEC.plateY;
    const yBot = SPEC.soundboardY - 0.028;
    const h = yTop - yBot;
    const block = new THREE.Mesh(new THREE.BoxGeometry(w, h, zFront - zBack), M.innerWood);
    block.position.set((x0 + x1) / 2, (yTop + yBot) / 2, zc);
    block.castShadow = true;
    block.receiveShadow = true;
    g.add(block);
  }

  /* ── 6. 琴腹内的承重肋木（从琴下方或掀盖时能瞥见） ── */
  {
    const ribMat = M.innerWood;
    for (let i = 0; i < 5; i++) {
      const t = 0.10 + i * 0.19;
      const z = SPEC.bodyBackZ * (0.28 + t * 0.68);
      const [x0, x1] = spanAt(inner, z, 0.10);
      const w = x1 - x0;
      if (w < 0.25) continue;
      const rib = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, 0.032, 0.045), ribMat);
      rib.position.set((x0 + x1) / 2, SPEC.soundboardY - 0.024, z);
      g.add(rib);
    }
  }

  return g;
}
