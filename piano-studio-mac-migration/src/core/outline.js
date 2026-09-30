/**
 * 轮廓曲线与多边形工具。
 *
 * 琴身俯视轮廓用三次贝塞尔手工调过：直边（spine）是一条笔直的弦，
 * 弯边（bentside）先外凸到最宽、再向尾部圆滑收拢，尾部圆钝而不收成尖角。
 * 这组控制点是照着真机俯视图一点点试出来的，改动前先想清楚。
 */

import * as THREE from 'three';
import { SPEC } from '../spec.js';

/**
 * 琴身俯视轮廓（THREE.Shape）。
 * Shape 局部坐标：x = 沿琴长（键盘端 0 → 尾端 1.62），y = 横向（−直边 / +弯边）。
 * 取世界坐标时用 (X = −y, Z = −x)。
 */
export function rimShape() {
  const HW = SPEC.halfWidth;
  const s = new THREE.Shape();
  s.moveTo(0.0, -HW);                                   // 右前角（直边侧）
  s.lineTo(1.285, -HW);                                 // 直边，笔直的一段
  s.bezierCurveTo(1.470, -0.748, 1.620, -0.545, 1.620, -0.265);  // 右后收向琴尾
  s.bezierCurveTo(1.620, -0.010, 1.540, 0.255, 1.365, 0.455);    // 琴尾圆弧
  s.bezierCurveTo(1.185, 0.585, 0.970, 0.675, 0.785, 0.705);     // 尾 → 弯边
  s.bezierCurveTo(0.590, 0.737, 0.405, 0.750, 0.300, 0.750);     // 弯边最宽处
  s.lineTo(0.0, HW);                                    // 弯边收回左前角
  s.closePath();
  return s;
}

/** Shape → 世界 XZ 平面的点数组，保证逆时针（放样绕向依赖这一点） */
export function shapeToOutline(shape, divisions = 384) {
  const raw = shape.getSpacedPoints(divisions);
  if (raw.length > 1 && raw[0].distanceTo(raw[raw.length - 1]) < 1e-7) raw.pop();
  const pts = raw.map((p) => new THREE.Vector3(-p.y, 0, -p.x));
  return ensureCCW(pts);
}

/** 反向则原地翻转，使多边形在 XZ 平面上呈逆时针 */
export function ensureCCW(pts) {
  if (signedArea2(pts) < 0) pts.reverse();
  return pts;
}

/** 有向面积的两倍（XZ 平面，把 z 当 y 用） */
export function signedArea2(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.z - q.x * p.z;
  }
  return a;
}

export function polygonCentroid(pts) {
  const c = new THREE.Vector3();
  for (const p of pts) { c.x += p.x; c.z += p.z; }
  return c.divideScalar(pts.length);
}

/**
 * 逆时针闭合轮廓在顶点 i 处的内向法线。
 * 逆时针多边形，切线 (tx,tz) 的左法线 (−tz,tx) 指向内部。
 */
export function inwardNormal(pts, i) {
  const n = pts.length;
  const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n], p = pts[i];
  let tx = b.x - a.x, tz = b.z - a.z;
  const len = Math.hypot(tx, tz);
  if (len < 1e-9) return { x: 0, z: 0 };
  tx /= len; tz /= len;
  return { x: -tz, z: tx };
}

/** 沿内向法线整体收缩（生成内轮廓）。收缩量远小于最小曲率半径时是安全的。 */
export function shrinkPolygon(pts, dist) {
  return pts.map((p, i) => {
    const n = inwardNormal(pts, i);
    return new THREE.Vector3(p.x + n.x * dist, 0, p.z + n.z * dist);
  });
}

/* ── 多边形裁剪（Sutherland–Hodgman） ─────────────────────
   把闭合轮廓按 z 区间裁开。琴盖分段、内腔前后边界都靠它。 */

function clipHalf(pts, limit, keepLess) {
  const out = [];
  const inside = (p) => (keepLess ? p.z <= limit : p.z >= limit);
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const ai = inside(a), bi = inside(b);
    if (ai) out.push(a);
    if (ai !== bi) {
      const t = (limit - a.z) / (b.z - a.z);
      out.push(new THREE.Vector3(
        a.x + (b.x - a.x) * t, 0, limit,
      ));
    }
  }
  return out;
}

/** 裁出 z ∈ [zMin, zMax] 的部分 */
export function clipPolygonZ(pts, zMin, zMax) {
  return clipHalf(clipHalf(pts, zMax, true), zMin, false);
}

/* ── 转成 THREE.Shape（供 ExtrudeGeometry 使用） ──────────
   Shape 的 (x, y) 对应世界的 (X, −Z)：
   这样绕 X 轴转 −90° 后，挤出方向正好落成世界 +Y，形状落在 XZ 平面上。 */

export function outlineToShape(pts) {
  const s = new THREE.Shape();
  pts.forEach((p, i) => (i ? s.lineTo(p.x, -p.z) : s.moveTo(p.x, -p.z)));
  s.closePath();
  return s;
}

export function outlineToPath(pts) {
  const p = new THREE.Path();
  pts.forEach((q, i) => (i ? p.lineTo(q.x, -q.z) : p.moveTo(q.x, -q.z)));
  p.closePath();
  return p;
}
