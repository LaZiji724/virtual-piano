/**
 * 放样（loft）几何生成器。
 *
 * 这个模型里所有"有厚度的围合件"——琴身侧板、琴盖边缘、键侧木——都不是
 * 简单挤出，而是**沿轮廓曲线扫掠一个 2D 截面**。区别在于：挤出得到的是
 * 硬邦邦的直角边，而真机侧板顶面是一道 17 mm 的圆弧，光打上去会拉出一条
 * 连续的高光线，这条高光线就是"这看着像台钢琴"的一半原因。
 *
 * 绕向推导（改动前务必重读）：
 *   轮廓保证逆时针 ⇒ 内向法线 n = (−tz, 0, tx)
 *   顶点 P(i,j) = p_i + n_i · u_j + (0, v_j, 0)
 *   三角形 (i,j)(i,j+1)(i+1,j+1) 的法线 = (0,∂v,0) × (t·ds) = −n·(dv·ds)
 *   即外墙面法线朝外、内墙面法线朝内、底面朝下——全部正确，不必事后翻转。
 *   前提是 profile 的 v 沿"外表面自下而上 → 顶面 → 内表面自上而下"排列。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { inwardNormal, polygonCentroid } from './outline.js';

/**
 * 沿闭合轮廓放样出一个环状曲面。
 * @param outline    Vector3 数组（XZ 平面，逆时针，闭合但首尾不重复）
 * @param profileFn  (pt, i) => [{u, v}]  u = 沿内向法线深入的距离，v = 世界高度
 * @param uvRepeat   UV 沿轮廓方向的重复次数
 */
export function loftClosed(outline, profileFn, uvRepeat = 8) {
  const N = outline.length;
  const profiles = outline.map((p, i) => profileFn(p, i, outline));
  const M = profiles[0].length;

  for (let i = 1; i < N; i++) {
    if (profiles[i].length !== M) {
      throw new Error(`loftClosed: 第 ${i} 个截面点数 ${profiles[i].length} ≠ ${M}`);
    }
  }

  const positions = new Float32Array(N * M * 3);
  const uvs = new Float32Array(N * M * 2);
  const indices = new Uint32Array(N * (M - 1) * 6);

  for (let i = 0; i < N; i++) {
    const p = outline[i];
    const n = inwardNormal(outline, i);
    const prof = profiles[i];
    for (let j = 0; j < M; j++) {
      const { u, v } = prof[j];
      const k = (i * M + j) * 3;
      positions[k] = p.x + n.x * u;
      positions[k + 1] = v;
      positions[k + 2] = p.z + n.z * u;
      const ku = (i * M + j) * 2;
      uvs[ku] = (i / N) * uvRepeat;
      uvs[ku + 1] = j / (M - 1);
    }
  }

  let t = 0;
  for (let i = 0; i < N; i++) {
    const i2 = (i + 1) % N;
    for (let j = 0; j < M - 1; j++) {
      const a = i * M + j;
      const b = i * M + j + 1;
      const c = i2 * M + j + 1;
      const d = i2 * M + j;
      indices[t++] = a; indices[t++] = b; indices[t++] = c;
      indices[t++] = a; indices[t++] = c; indices[t++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** 侧板截面：外墙面 → 顶部外圆角 → 顶面 → 顶部内圆角 → 内墙面 → 底面 */
export function rimProfile(topY, bottomY, thick, rTop = 0.017, rIn = 0.008, seg = 6) {
  const pts = [];
  pts.push({ u: 0, v: bottomY });
  pts.push({ u: 0, v: topY - rTop });
  for (let k = 1; k <= seg; k++) {                       // 外圆角 180° → 90°
    const a = Math.PI * (1 - k / (2 * seg));
    pts.push({ u: rTop + rTop * Math.cos(a), v: topY - rTop + rTop * Math.sin(a) });
  }
  pts.push({ u: thick - rIn, v: topY });
  for (let k = 1; k <= seg; k++) {                       // 内圆角 90° → 0°
    const a = (Math.PI / 2) * (1 - k / seg);
    pts.push({ u: thick - rIn + rIn * Math.cos(a), v: topY - rIn + rIn * Math.sin(a) });
  }
  pts.push({ u: thick, v: bottomY });
  pts.push({ u: 0, v: bottomY });                        // 底面收回外缘（硬边，法线自然断开）
  return pts;
}

/**
 * 把闭合多边形（可带孔）三角化成水平面片。
 *
 * 绕向推导：顶点 2D 坐标取的是 (x, z)，映射回 3D 是 (x, 0, z)，
 * 于是 2D 的基向量落到世界的 +X 与 +Z 上，而 X × Z = −Y——
 * 也就是说**逆时针的 2D 三角形在 3D 里法线朝下**。想朝上就得翻过来。
 * 这里曾经反过一次，结果音板和铸铁板的顶面全被背面剔除，琴腹看进去是一片黑。
 *
 * @param up  +1 朝上 / −1 朝下
 */
export function capPolygon(outline, holes = [], up = 1) {
  const contour = outline.map((p) => new THREE.Vector2(p.x, p.z));
  const holePaths = holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.z)));
  const faces = THREE.ShapeUtils.triangulateShape(contour, holePaths);

  const all = contour.concat(...holePaths);
  const positions = new Float32Array(all.length * 3);
  const normals = new Float32Array(all.length * 3);
  const uvs = new Float32Array(all.length * 2);
  for (let i = 0; i < all.length; i++) {
    positions[i * 3] = all[i].x;
    positions[i * 3 + 2] = all[i].y;
    normals[i * 3 + 1] = up;
    uvs[i * 2] = all[i].x * 2;
    uvs[i * 2 + 1] = all[i].y * 2;
  }

  const indices = [];
  for (const f of faces) {
    if (up > 0) indices.push(f[0], f[2], f[1]);
    else indices.push(f[0], f[1], f[2]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * 由俯视轮廓拉出一块带圆边的板（琴盖、谱架托盘都走这条）。
 * 实现走 ExtrudeGeometry + bevel——它天生就是干这个的，
 * 而且轮廓是凸的，倒角不会在凹角处自交。
 *
 * @param outline  世界 XZ 平面轮廓
 * @param thick    总厚度
 * @param bevel    上下两面各自的圆角半径
 * @param yBottom  板底面所在高度
 */
export function slabFromOutline(outline, thick, bevel, yBottom) {
  const shape = new THREE.Shape();
  outline.forEach((p, i) => (i ? shape.lineTo(p.x, -p.z) : shape.moveTo(p.x, -p.z)));
  shape.closePath();

  const b = Math.min(bevel, thick * 0.45);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(thick - 2 * b, 1e-4),
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: 0,
    bevelSegments: 4,
    curveSegments: 1,
    steps: 1,
  });
  // shape 的 y 存的是 −z，绕 X 轴 −90° 后 (x, y, z) → (x, z, −y)，
  // 于是 shape.y 落回世界 −z、挤出方向落成世界 +y。
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, yBottom, 0);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** 轮廓质心，供朝向判断等使用 */
export function outlineCentroid(outline) {
  return polygonCentroid(outline);
}

/**
 * 把一条侧视剖面沿 X 方向挤出成柱体（琴键专用）。
 *
 * 不用 ExtrudeGeometry 是因为它给侧壁出的是平直着色——琴键前唇那道
 * 5 mm 的圆角会被切成几块硬面，特写时一眼假。这里显式建出侧壁与两个端盖，
 * 端盖另开一套顶点，于是端盖与侧壁之间保持硬边、而剖面内部的圆角是光滑的，
 * 正好是琴键该有的样子。
 *
 * @param profile [{z, y}] 闭合多边形，在 ZY 平面内逆时针（从 +X 方向看）
 * @param width   挤出宽度，结果落在 x ∈ [−w/2, +w/2]
 */
export function extrudeAlongX(profile, width) {
  const M = profile.length;
  const hw = width / 2;

  const positions = [];
  const uvs = [];
  const indices = [];

  // 侧壁顶点：两个 x 层
  for (let s = 0; s < 2; s++) {
    const x = s === 0 ? -hw : hw;
    for (let j = 0; j < M; j++) {
      positions.push(x, profile[j].y, profile[j].z);
      uvs.push(s, j / (M - 1));
    }
  }
  // 端盖顶点：另开一套，避免与侧壁共用而把硬边磨圆
  const capBase = 2 * M;
  for (let s = 0; s < 2; s++) {
    const x = s === 0 ? -hw : hw;
    for (let j = 0; j < M; j++) {
      positions.push(x, profile[j].y, profile[j].z);
      uvs.push(0.5, 0.5);
    }
  }

  // 侧壁：绕向推导见文件头注释（同一套内向法线逻辑）
  for (let j = 0; j < M; j++) {
    const j2 = (j + 1) % M;
    const a = j, b = j2, c = M + j2, d = M + j;
    indices.push(a, c, b, a, d, c);
  }

  // 端盖
  const contour = profile.map((p) => new THREE.Vector2(p.z, p.y));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  const baseL = capBase;
  const baseR = capBase + M;
  for (const f of faces) {
    indices.push(baseL + f[0], baseL + f[1], baseL + f[2]);   // −X 面：法线朝 −X
    indices.push(baseR + f[0], baseR + f[2], baseR + f[1]);   // +X 面：翻转
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * 由俯视轮廓拉出一块实心水平板（键床、内腔盖板之类）。
 * 侧面是一圈墙，上下各盖一个面。
 */
export function slabSolid(outline, yTop, thick, uvRepeat = 6) {
  const side = loftClosed(outline, () => ([
    { u: 0, v: yTop - thick },
    { u: 0, v: yTop },
    { u: thick, v: yTop },
    { u: thick, v: yTop - thick },
  ]), uvRepeat);

  const top = capPolygon(outline, [], 1);
  top.translate(0, yTop + 0.0002, 0);
  const bot = capPolygon(outline, [], -1);
  bot.translate(0, yTop - thick - 0.0002, 0);

  return mergeGeometries([side, top, bot]);
}
