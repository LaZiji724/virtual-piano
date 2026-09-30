/**
 * 琴腿、脚轮、踏板架。
 *
 * 腿不是直上直下的方柱：真机的腿带锥度（底部收到顶部的七成），
 * 顶端坐在一块比腿更粗的"腿座"上，腿座再顶住琴身底框。
 * 少了腿座这一层，腿会像凭空插在琴腹上。
 */

import * as THREE from 'three';
import { SPEC } from '../spec.js';

/** 圆角方形的轮廓点（逆时针） */
function roundedRect(w, r, segPerCorner = 3) {
  const h = w / 2;
  const pts = [];
  const corners = [
    [h - r, h - r, 0],
    [-h + r, h - r, Math.PI / 2],
    [-h + r, -h + r, Math.PI],
    [h - r, -h + r, Math.PI * 1.5],
  ];
  for (const [cx, cz, a0] of corners) {
    for (let i = 0; i <= segPerCorner; i++) {
      const a = a0 + (Math.PI / 2) * (i / segPerCorner);
      pts.push(new THREE.Vector2(cx + r * Math.cos(a), cz + r * Math.sin(a)));
    }
  }
  return pts;
}

/** 带锥度的圆角方柱：底面 wBot 见方，顶面收缩到 wBot·taper。
 *  建好之后一律归一化到 y ∈ [0, h]——ExtrudeGeometry 的实际 y 范围
 *  取决于 bevelThickness，硬算平移量必然错位。 */
function taperedPost(wBot, h, taper, radius) {
  const shape = new THREE.Shape(roundedRect(wBot, radius, 3));
  const bevel = 0.004;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(h - 2 * bevel, 1e-3),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 1,
  });
  geo.rotateX(-Math.PI / 2);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const y0 = bb.min.y;
  const span = Math.max(bb.max.y - y0, 1e-6);

  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp((pos.getY(i) - y0) / span, 0, 1);
    pos.setY(i, t * h);
    const s = 1 + (taper - 1) * t;
    pos.setX(i, pos.getX(i) * s);
    pos.setZ(i, pos.getZ(i) * s);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** 黄铜双轮脚轮 */
function buildCaster(mat) {
  const g = new THREE.Group();
  const h = SPEC.casterH;

  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.019, h * 0.62, 14), mat);
  stem.position.y = h * 0.69;
  g.add(stem);

  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.021, 0.0055, 8, 18), mat);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = h * 0.40;
  g.add(collar);

  const wheelR = h * 0.40;
  for (const sgn of [-1, 1]) {
    const wheel = new THREE.Mesh(
      new THREE.CylinderGeometry(wheelR, wheelR, 0.010, 18),
      mat,
    );
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(sgn * 0.016, wheelR, 0);
    g.add(wheel);
  }
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.040, 10), mat);
  axle.rotation.z = Math.PI / 2;
  axle.position.y = wheelR;
  g.add(axle);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function buildBase(M) {
  const g = new THREE.Group();
  g.name = 'base';

  const legs = [
    { x: SPEC.legFrontX, z: SPEC.legFrontZ },
    { x: -SPEC.legFrontX, z: SPEC.legFrontZ },
    { x: SPEC.legBackX, z: SPEC.legBackZ },
  ];

  const yLegTop = SPEC.rimBottom - 0.030;      // 腿座底面
  const yLegBot = SPEC.casterH;

  for (const { x, z } of legs) {
    // 腿座：把腿接到琴身底框上
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.176, 0.062, 0.176), M.innerWood);
    seat.position.set(x, SPEC.rimBottom - 0.014, z);
    seat.castShadow = true;
    seat.receiveShadow = true;
    g.add(seat);

    // 腿：上宽下窄
    const h = yLegTop - yLegBot;
    const leg = new THREE.Mesh(taperedPost(SPEC.legTop, h, SPEC.legTaper, 0.020), M.lacquer);
    leg.position.set(x, yLegBot, z);
    leg.castShadow = true;
    leg.receiveShadow = true;
    g.add(leg);

    // 腿底的黄铜箍
    const ferrule = new THREE.Mesh(
      new THREE.CylinderGeometry(SPEC.legTop * SPEC.legTaper * 0.55, SPEC.legTop * SPEC.legTaper * 0.53, 0.020, 20),
      M.brass,
    );
    ferrule.position.set(x, yLegBot + 0.008, z);
    ferrule.castShadow = true;
    g.add(ferrule);

    const caster = buildCaster(M.brass);
    caster.position.set(x, 0, z);
    g.add(caster);
  }

  /* ── 踏板架（lyre）─────────────────────────────────────
     两个上支点 + 两根斜撑 + 立柱 + 踏板盒，每个连接点都必须实实在在接上，
     否则整组看上去是浮在空中的。 */
  {
    const y0 = SPEC.rimBottom;                  // 锚在琴腹底面
    const boxTop = 0.162;
    const boxBot = 0.104;
    const zBox = -0.318;

    for (const sgn of [-1, 1]) {
      const top = new THREE.Vector3(sgn * 0.085, y0 + 0.004, SPEC.lyreTopZ);
      const bot = new THREE.Vector3(sgn * 0.052, boxTop, zBox);
      const dir = new THREE.Vector3().subVectors(bot, top);
      const len = dir.length();
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.011, len, 10), M.innerWood);
      bar.position.copy(top).addScaledVector(dir, 0.5);
      bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      bar.castShadow = true;
      g.add(bar);
    }

    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.024, 0.13, 12), M.innerWood);
    post.position.set(0, boxTop + 0.055, zBox);
    post.castShadow = true;
    g.add(post);

    const box = new THREE.Mesh(new THREE.BoxGeometry(0.30, boxTop - boxBot, 0.075), M.lacquer);
    box.position.set(0, (boxTop + boxBot) / 2, zBox);
    box.castShadow = true;
    box.receiveShadow = true;
    g.add(box);
  }

  /* ── 三个踏板 ───────────────────────────────────────────
     截面画在 XY（宽×厚）、挤出沿 +Z——这已经就是水平放平的板，
     **不要再旋转**。早先照搬别处的 rotateX(-π/2)，把每块踏板立成了
     17 cm 高的竖片插在踏板盒后面。
     每块踏板一个 pivot 组，原点放在**后端转轴**上：延音踏板被踩下时
     就是绕它转，前端下沉、后端不动，跟真机的支点一样。 */
  {
    const y = SPEC.pedalY;
    const zBack = -0.318;
    const zFront = -0.152;
    const len = zFront - zBack;          // 0.166，挤出沿 +Z

    let sustainPedal = null;
    for (let i = 0; i < 3; i++) {
      const x = (i - 1) * SPEC.pedalSpread;
      const w = i === 1 ? 0.026 : 0.032;

      const pivot = new THREE.Group();
      pivot.position.set(x, y, zBack);

      const s = new THREE.Shape();
      s.moveTo(-w / 2, 0);
      s.lineTo(w / 2, 0);
      s.lineTo(w / 2, 0.011);
      s.lineTo(-w / 2, 0.011);
      s.closePath();
      const geo = new THREE.ExtrudeGeometry(s, {
        depth: len,
        bevelEnabled: true,
        bevelThickness: 0.0015,
        bevelSize: 0.0015,
        bevelSegments: 1,
        curveSegments: 1,
      });
      const plate = new THREE.Mesh(geo, M.brass);
      plate.castShadow = true;
      plate.receiveShadow = true;
      pivot.add(plate);

      // 前端滚花圆柱（脚感所在），跟着踏板一起动
      const roller = new THREE.Mesh(
        new THREE.CylinderGeometry(0.008, 0.008, w * 0.94, 14),
        M.brass,
      );
      roller.rotation.z = Math.PI / 2;
      roller.position.set(0, 0.005, len - 0.008);
      roller.castShadow = true;
      pivot.add(roller);

      g.add(pivot);
      if (i === 2) sustainPedal = pivot;   // i=2 → x=+0.105，最右侧那块
    }

    // 踏板盒下沿的毛毡垫
    const felt = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.008, 0.070), M.felt);
    felt.position.set(0, 0.104, -0.318);
    g.add(felt);

    /* 延音踏板踩放：绕后端转轴下压 0.042 rad，前端行程约 7 mm。
       set() 只记目标角，update() 每帧平滑过去——声音是瞬间跟手的，
       机械踏板有一点惯性反而更像真的。 */
    const PEDAL_ANGLE = 0.042;
    let pedalTarget = 0;
    const pedalRig = {
      set(on) { pedalTarget = on ? PEDAL_ANGLE : 0; },
      update(dt) {
        if (!sustainPedal) return;
        const d = pedalTarget - sustainPedal.rotation.x;
        if (Math.abs(d) < 0.0004) { sustainPedal.rotation.x = pedalTarget; return; }
        sustainPedal.rotation.x += d * Math.min(1, dt * 14);
      },
    };
    return { group: g, pedalRig };
  }
}
