/**
 * 琴腹内部：铸铁板、琴弦、弦轴钉、弦马、制音器。
 *
 * 合上琴盖时这些全看不见，但琴盖掀起来之后它们就是画面的主体，
 * 所以不能糊弄。
 *
 * 弦的排布按真机来：低音区单根缠弦、中音区两根、高音区三根，
 * 共约 226 根。低音弦还要**斜跨**到右后方并抬高一点——这就是
 * 三角钢琴的 overstringing（交叉挂弦），掀开盖子一眼就能认出来。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SPEC, keyLayout } from '../spec.js';
import { rimShape, shapeToOutline, shrinkPolygon, clipPolygonZ, ensureCCW } from '../core/outline.js';
import { loftClosed, capPolygon } from '../core/loft.js';

/** 椭圆孔轮廓 */
function ellipse(cx, cz, rx, rz, n = 26) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(new THREE.Vector3(cx + rx * Math.cos(a), 0, cz + rz * Math.sin(a)));
  }
  return ensureCCW(pts);
}

/** 每根弦：起点、终点、半径 */
function stringLayout() {
  const keys = keyLayout();
  const groups = [];
  for (const k of keys) {
    const count = k.midi <= 33 ? 1 : (k.midi <= 45 ? 2 : 3);
    groups.push({ midi: k.midi, count, x: k.x });
  }
  const total = groups.reduce((s, g) => s + g.count, 0);

  // 按**弦数**分宽度，不是按音数。按音数均分的话低音区 13 个音只摊到
  // 13 根弦，左边会空出一大片没弦的金色音板；真机上弦是近似等间距排的，
  // 每个音占的宽度正比于它有几根弦。
  const xLow = -0.615, xHigh = 0.668;
  const perString = (xHigh - xLow) / total;
  const innerGap = perString * 0.86;          // 组内紧凑、组间留缝

  const z0 = -0.292;                          // 弦轴钉端
  const out = [];
  let cursor = xLow;

  groups.forEach((grp, gi) => {
    const groupWidth = grp.count * perString;
    const cx = cursor + groupWidth / 2;
    cursor += groupWidth;

    const t = gi / (groups.length - 1);
    const isBass = grp.midi <= 45;
    // 弦长：低音长、高音短。真实挂弦钉沿一条斜线排列。
    const lenT = Math.pow(t, 0.82);
    const zBack = -1.470 + 0.690 * lenT;

    for (let s = 0; s < grp.count; s++) {
      const off = (s - (grp.count - 1) / 2) * innerGap;
      // 低音弦斜向右后方并压在中高音弦上方——交叉挂弦
      const bias = isBass ? 0.30 * (1 - t) : 0;
      const x0 = cx + off;
      const x1 = cx + off + bias;
      const y = SPEC.stringY + (grp.midi <= 40 ? 0.019 : 0);
      const r = grp.midi <= 33 ? 0.0026 : (grp.midi <= 45 ? 0.0018 : 0.0011);
      out.push({
        x0, x1, y,
        z0: z0 - (isBass ? 0.010 : 0),
        z1: zBack,
        r,
        bass: isBass,
        midi: grp.midi,
      });
    }
  });

  return { strings: out, total };
}

export function buildInterior(M) {
  const g = new THREE.Group();
  g.name = 'interior';

  const inner = ensureCCW(shrinkPolygon(shapeToOutline(rimShape(), 384), SPEC.rimThick));

  /* ── 1. 铸铁板 ─────────────────────────────────────────── */
  {
    const plateOutline = ensureCCW(
      clipPolygonZ(shrinkPolygon(inner, 0.015), SPEC.bodyBackZ + 0.055, SPEC.innerStartZ - 0.002),
    );
    const holes = [
      ellipse(-0.36, -0.62, 0.075, 0.150),
      ellipse(0.30, -0.58, 0.090, 0.115),
      ellipse(-0.16, -1.06, 0.075, 0.130),
      ellipse(0.32, -1.08, 0.070, 0.105),
    ].map(ensureCCW);

    const thick = 0.052;
    const parts = [];

    const top = capPolygon(plateOutline, holes, 1);
    top.translate(0, SPEC.plateY, 0);
    parts.push(top);

    const bot = capPolygon(plateOutline, holes, -1);
    bot.translate(0, SPEC.plateY - thick, 0);
    parts.push(bot);

    parts.push(loftClosed(plateOutline, () => ([
      { u: 0, v: SPEC.plateY - thick },
      { u: 0, v: SPEC.plateY },
    ]), 12));

    // 孔的侧壁：轮廓逆时针 ⇒ loft 的法线指向孔心
    for (const h of holes) {
      parts.push(loftClosed(h, () => ([
        { u: 0, v: SPEC.plateY - thick },
        { u: 0, v: SPEC.plateY },
      ]), 3));
    }

    const plate = new THREE.Mesh(mergeGeometries(parts), M.plate);
    plate.castShadow = true;
    plate.receiveShadow = true;
    g.add(plate);

    // 板缘一圈铸造圆边，让厚度看起来是"铸"出来的
    const lip = loftClosed(plateOutline, () => ([
      { u: -0.009, v: SPEC.plateY - 0.006 },
      { u: -0.009, v: SPEC.plateY + 0.004 },
      { u: 0.004, v: SPEC.plateY + 0.010 },
      { u: 0.016, v: SPEC.plateY + 0.004 },
      { u: 0.016, v: SPEC.plateY - 0.008 },
    ]), 12);
    const rim = new THREE.Mesh(lip, M.plate);
    rim.castShadow = true;
    g.add(rim);

    // 压弦条：中高音区把弦压住的那根金属条
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.012, 0.030), M.steel);
    bar.position.set(0.30, SPEC.plateY + 0.030, -0.315);
    bar.castShadow = true;
    g.add(bar);
  }

  /* ── 2. 弦马：琴弦跨过的木条 ─────────────────────────── */
  {
    const mainPts = [];
    for (let i = 0; i <= 22; i++) {
      const t = i / 22;
      const x = 0.60 - 1.06 * t;
      const z = -0.470 - 0.205 * Math.pow(t, 1.35) + 0.055 * Math.sin(t * Math.PI * 1.6);
      // 管心压到弦下方一个半径处，顶面正好托住琴弦（之前给高了 16 mm，弦被穿模）
      mainPts.push(new THREE.Vector3(x, SPEC.stringY - 0.018, z));
    }
    const curve = new THREE.CatmullRomCurve3(mainPts);
    const bridge = new THREE.Mesh(new THREE.TubeGeometry(curve, 60, 0.018, 8, false), M.bridgeWood);
    bridge.castShadow = true;
    g.add(bridge);

    // 短马：低音区独立的一条
    const bass = new THREE.Mesh(
      new THREE.BoxGeometry(0.030, 0.026, 0.30), M.bridgeWood,
    );
    bass.position.set(-0.555, SPEC.stringY - 0.013, -1.140);
    bass.rotation.y = 0.10;
    bass.castShadow = true;
    g.add(bass);
  }

  /* ── 3. 弦轴钉：按组错开成锯齿排 ─────────────────────── */
  {
    const { strings } = stringLayout();
    const geo = new THREE.CylinderGeometry(0.0038, 0.0038, 0.036, 8);
    const pin = new THREE.InstancedMesh(geo, M.steel, strings.length);
    const m = new THREE.Matrix4();
    strings.forEach((s, i) => {
      m.makeTranslation(s.x0, SPEC.plateY + 0.020, s.z0 + (i % 2 ? 0.019 : 0));
      pin.setMatrixAt(i, m);
    });
    pin.instanceMatrix.needsUpdate = true;
    pin.castShadow = true;
    g.add(pin);
  }

  /* ── 4. 琴弦 ─────────────────────────────────────────── */
  {
    const { strings, total } = stringLayout();
    const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, false);
    const mesh = new THREE.InstancedMesh(geo, M.steel, total);
    const up = new THREE.Vector3(0, 1, 0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();

    strings.forEach((s, i) => {
      a.set(s.x0, s.y, s.z0);
      b.set(s.x1, s.y, s.z1);
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      q.setFromUnitVectors(up, dir.normalize());
      p.copy(a).addScaledVector(dir, len / 2);
      // 上面 dir 已被归一化，重新算中点
      p.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      sc.set(s.r, len, s.r);
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    g.add(mesh);
  }

  /* ── 5. 制音器：弦上方的暗红毡垫（低音段没有） ──────── */
  {
    const { strings } = stringLayout();
    // 一个音一个毡垫（不是一根弦一个）；低音区那二十来个音本来就不装制音器
    const byMidi = new Map();
    for (const s of strings) {
      if (s.bass || s.z1 > -0.62) continue;
      if (!byMidi.has(s.midi)) byMidi.set(s.midi, []);
      byMidi.get(s.midi).push(s);
    }
    const dampers = [...byMidi.values()];
    const geo = new THREE.BoxGeometry(0.026, 0.030, 0.008);
    const mesh = new THREE.InstancedMesh(geo, M.felt, dampers.length);
    const m = new THREE.Matrix4();
    dampers.forEach((grp, i) => {
      const t = 0.30;
      const xs = grp.map((s) => s.x0 + (s.x1 - s.x0) * t);
      const x = (Math.min(...xs) + Math.max(...xs)) / 2;
      const z = grp[0].z0 + (grp[0].z1 - grp[0].z0) * t;
      m.makeTranslation(x, grp[0].y + 0.016, z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    g.add(mesh);
  }

  return g;
}
