/**
 * 琴盖（大盖 + 小盖）、撑杆、谱架。
 *
 * 铰链在**直边一侧**（+X），琴盖向弯边方向掀起——所以从观众席看过去，
 * 掀开的琴盖把琴腹的声音投向观众，这正是三角钢琴在舞台上的摆放逻辑。
 * 铰链轴简化成一条直线（真机是沿弯边装三副合页、靠间隙容纳曲率）。
 */

import * as THREE from 'three';
import { SPEC } from '../spec.js';
import { rimShape, shapeToOutline, clipPolygonZ, ensureCCW } from '../core/outline.js';
import { slabFromOutline, extrudeAlongX } from '../core/loft.js';

/** 一根圆杆，从 a 指向 b */
function strut(a, b, r, mat, seg = 12) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  m.castShadow = true;
  return m;
}

/** 谱架面板：一块带横向镂空槽的板 */
function musicDeskBoard(w, h, thick, mat) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(w / 2, h);
  s.lineTo(-w / 2, h);
  s.closePath();
  for (let i = 0; i < 3; i++) {
    const y0 = h * (0.20 + i * 0.245);
    const p = new THREE.Path();
    p.moveTo(-w / 2 + 0.055, y0);
    p.lineTo(w / 2 - 0.055, y0);
    p.lineTo(w / 2 - 0.055, y0 + 0.020);
    p.lineTo(-w / 2 + 0.055, y0 + 0.020);
    p.closePath();
    s.holes.push(p);
  }
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: thick - 0.004,
    bevelEnabled: true,
    bevelThickness: 0.002,
    bevelSize: 0.002,
    bevelSegments: 1,
    curveSegments: 1,
  });
  geo.translate(0, 0, -(thick - 0.004) / 2);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function buildLid(M) {
  const g = new THREE.Group();
  g.name = 'lid';

  const outline = shapeToOutline(rimShape(), 384);
  const { lidThick: T, lidBevel: B, lidHingeX: HX, lidHingeY: HY } = SPEC;

  /* ── 大盖：绕直边外侧的水平轴掀起 ── */
  const mainOutline = ensureCCW(clipPolygonZ(outline, SPEC.bodyBackZ - 0.02, SPEC.frontLidBackZ - 0.002));
  const mainGeo = slabFromOutline(mainOutline, T, B, SPEC.rimTop);

  const mainPivot = new THREE.Group();
  mainPivot.position.set(HX, HY, 0);
  const mainMesh = new THREE.Mesh(mainGeo, M.lacquer);
  mainMesh.position.set(-HX, -HY, 0);
  mainMesh.castShadow = true;
  mainMesh.receiveShadow = true;
  mainPivot.add(mainMesh);
  g.add(mainPivot);

  /* ── 小盖：留在原位，盖住谱架上方的琴腹前端 ── */
  const frontOutline = ensureCCW(clipPolygonZ(outline, SPEC.frontLidBackZ + 0.002, SPEC.lidFrontZ));
  const frontMesh = new THREE.Mesh(slabFromOutline(frontOutline, T, B, SPEC.rimTop), M.lacquer);
  frontMesh.castShadow = true;
  frontMesh.receiveShadow = true;
  g.add(frontMesh);

  /* ── 撑杆：长度按当前开盖角反算，下端锚在琴腹内、上端顶住盖板内侧 ── */
  const setLidAngle = (deg) => {
    const th = THREE.MathUtils.degToRad(deg);
    mainPivot.rotation.z = -th;
    return th;
  };

  const propGroup = new THREE.Group();
  g.add(propGroup);

  function rebuildProp(deg) {
    propGroup.clear();
    const th = THREE.MathUtils.degToRad(deg);
    // 盖板内侧取一个离铰链足够远的点，撑杆才有实际支撑长度
    const localX = 0.10 - HX;
    const localY = (SPEC.rimTop + 0.001) - HY;
    const px = HX + localX * Math.cos(th) + localY * Math.sin(th);
    const py = HY - localX * Math.sin(th) + localY * Math.cos(th);

    const zProp = -0.98;
    const top = new THREE.Vector3(px, py, zProp);
    const bottom = new THREE.Vector3(0.455, SPEC.rimBottom + 0.135, zProp);

    propGroup.add(strut(bottom, top, 0.0115, M.bridgeWood));
    // 下端做一个小托座，避免杆子像凭空插在琴腹里
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.030, 0.052), M.innerWood);
    seat.position.copy(bottom);
    seat.castShadow = true;
    propGroup.add(seat);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.016, 12, 8), M.felt);
    tip.position.copy(top);
    propGroup.add(tip);
  }

  setLidAngle(SPEC.lidOpenDeg);
  rebuildProp(SPEC.lidOpenDeg);

  return {
    group: g,
    setLidAngle: (deg) => { setLidAngle(deg); rebuildProp(deg); },
    mainPivot,
  };
}

/**
 * 键盘盖（fallboard）。
 *
 * 铰链在**后沿**——名板前脸那条线上，绕 X 轴翻转 0–90°：
 *   0°  平盖在琴键上方：顶面与两侧键侧木齐平（都是 SPEC.cheekTop），
 *       前沿落在前挡条后沿、前唇下沿落在前挡条顶面 —— 三面严丝合缝。
 *   90° 立起来贴著名板前脸，前唇朝前伸出去一条，跟真机掀开的样子一样。
 *
 * 侧视剖面的尺寸都不是随手取的：
 *  - 板底 = cheekTop − fallThick = 0.736，比黑键顶面（0.732）高 4 mm。
 *    再低就和黑键穿模——黑键比白键高 12 mm，这是键盘盖最容易做错的地方。
 *  - 前唇伸到 keySlipTopY 为止，把琴键前端面整个盖住。少了这道唇，
 *    关到底从正前方还能看见一排键尖，"严丝合缝"就无从谈起。
 */
export function buildFallboard(M) {
  const g = new THREE.Group();
  g.name = 'fallboard';

  const {
    fallBackZ, fallFrontZ, fallLipZ, fallThick: T,
    cheekTop, keySlipTopY, keyHalfW,
  } = SPEC;

  const L = fallFrontZ - fallBackZ;        // 板长（沿 Z，从铰链线算起）
  const LIP = cheekTop - keySlipTopY;      // 前唇下垂量
  const LIP_T = fallFrontZ - fallLipZ;     // 前唇厚度
  const w = keyHalfW * 2 - 0.002;          // 留 1 mm 总间隙，塞得进两块键侧木之间

  // 侧视剖面（ZY 平面，局部坐标：铰链线在 z = 0，板朝 +Z 伸出、朝 −Y 加厚）
  const prof = [
    { z: L, y: -LIP },                   // 前唇下沿
    { z: L, y: -0.0045 },                // 前立面直上
    { z: L - 0.0018, y: -0.0013 },       // 4.5 mm 圆角，分两段够用
    { z: L - 0.0045, y: 0 },
    { z: 0, y: 0 },                      // 顶面到铰链线
    { z: 0, y: -T },                     // 后立面
    { z: L - LIP_T, y: -T },             // 板底
    { z: L - LIP_T, y: -LIP },           // 唇根立面
  ];
  const geo = extrudeAlongX(prof, w);

  const pivot = new THREE.Group();
  pivot.position.set(0, cheekTop, fallBackZ);
  const mesh = new THREE.Mesh(geo, M.lacquer);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  pivot.add(mesh);
  g.add(pivot);

  // 绕 +X 转 −θ：(0,0,1) → (0, sinθ, cosθ)，板从水平一路转到竖直向上
  const setAngle = (deg) => {
    pivot.rotation.x = -THREE.MathUtils.degToRad(deg);
  };
  setAngle(SPEC.fallOpenDeg);

  return { group: g, pivot, setAngle };
}

/** 谱架：立在小盖之下、名板之后 */
export function buildMusicDesk(M) {
  const g = new THREE.Group();
  g.name = 'musicDesk';

  const w = 0.80;
  const h = 0.235;
  const board = musicDeskBoard(w, h, 0.010, M.lacquer);
  board.position.set(0, 0.742, -0.246);   // 让开名板背面（名板在 z = −0.200）
  board.rotation.x = -0.335;              // 顶部后仰，面向演奏者
  g.add(board);

  // 底部托条与两根支柱
  const rail = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.016, 0.030), M.lacquer);
  rail.position.set(0, 0.736, -0.232);
  rail.rotation.x = -0.335;
  rail.castShadow = true;
  g.add(rail);

  for (const sgn of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.075, 0.016), M.lacquer);
    leg.position.set(sgn * (w / 2 - 0.05), 0.700, -0.220);
    g.add(leg);
  }

  return g;
}
