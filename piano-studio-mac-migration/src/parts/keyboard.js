/**
 * 键盘：88 键、键床、键侧木、前挡条、名板。
 *
 * 三条容易做错、这里专门守住的规矩：
 *  1. **黑键横跨白键的后半段**。黑键前端距白键前端 55 mm、后端与白键后端齐平。
 *     反过来做（黑键落在白键前半段）一眼就能看出键盘像装反了。
 *  2. **前挡条必须低于键面**。真机的 key slip 顶面比白键顶面低约 15 mm，
 *     做平或做高会从正前方把整排琴键遮掉一截。
 *  3. **白键前端略突出于琴身**，键侧木在两侧夹住键盘——不是把键盘塞进一个盒子里。
 *
 * 关于可弹奏：每个键必须是**能单独动**的。早先为了省 draw call 把 88 个键
 * 合并成两个 mesh，结果一个键都按不下去。现在改成 InstancedMesh——同样是
 * 两个 draw call，但每个实例可以有独立矩阵，raycast 还能直接拿到 instanceId
 * 反查是哪个音。
 *
 * 按键动作：绕键**后端**的水平轴转一个小角度（前端下沉约 10 mm，约 3.8°），
 * 跟真机一样。几何的原点就放在那条轴上，动画只是乘一个旋转矩阵。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SPEC, keyLayout } from '../spec.js';
import { rimShape, shapeToOutline, shrinkPolygon, clipPolygonZ, ensureCCW } from '../core/outline.js';
import { extrudeAlongX, capPolygon } from '../core/loft.js';

const KEYBED_Y = SPEC.keyTopY - SPEC.keyH;      // 白键落座面
const KEY_BACK_Z = SPEC.keyFrontZ - SPEC.keyLen; // 键后端（= 旋转轴所在）
const KEY_DIP = 0.010;                           // 按下时前端下沉量（米）

/** 白键侧视剖面（ZY 平面逆时针）：前端面 → 顶面 → 后端面。
 *  白键本身方方正正，只在前缘顶角留一道 ~2 mm 的工艺倒角
 *  （早先是一道 15 mm 的大圆唇，看起来像肥皂）。 */
function whiteKeyProfile() {
  const { keyFrontZ: z0, keyLen: L, keyH: H } = SPEC;
  return [
    { z: z0, y: 0 },
    { z: z0, y: H - 0.0016 },
    { z: z0 - 0.0007, y: H - 0.0004 },
    { z: z0 - 0.0020, y: H },
    { z: z0 - L, y: H },
    { z: z0 - L, y: 0 },
  ];
}

/** 黑键侧视剖面：前端面比白键矮一截，顶面高出 12 mm */
function blackKeyProfile() {
  const { keyFrontZ, blackInset, keyLen, blackTopY } = SPEC;
  const zf = keyFrontZ - blackInset;
  const zb = keyFrontZ - keyLen;
  const H = blackTopY - KEYBED_Y;
  return [
    { z: zf, y: 0 },
    { z: zf, y: 0.0205 },
    { z: zf - 0.0055, y: 0.0315 },
    { z: zf - 0.0120, y: 0.0338 },
    { z: zb, y: H },
    { z: zb, y: 0 },
  ];
}

export function buildKeyboard(M) {
  const g = new THREE.Group();
  g.name = 'keyboard';

  const layout = keyLayout();
  const whites = layout.filter((k) => !k.black);
  const blacks = layout.filter((k) => k.black);

  /* ── 1. 琴键：几何原点挪到「键后端底面的中点」，
         也就是按键时的旋转轴。这样动画只是一个平移 + 一个旋转。
         y 方向**不要**再平移：剖面的 y 本来就从 0（键床面）起算，
         实例矩阵里的 KEYBED_Y 负责把它抬到位。两边都减一次的话，
         整排琴键会掉到地板高度——而且因为实例矩阵和几何偏移互相抵消，
         眼睛看着还挺正常，只有 raycast 会告诉你它根本不在那儿。 ── */
  const whiteGeo = extrudeAlongX(whiteKeyProfile(), SPEC.keyPitch - SPEC.keyGap);
  whiteGeo.translate(0, 0, -KEY_BACK_Z);
  const blackGeo = extrudeAlongX(blackKeyProfile(), SPEC.blackW);
  blackGeo.translate(0, 0, -KEY_BACK_Z);

  const whiteMesh = new THREE.InstancedMesh(whiteGeo, M.whiteKey, whites.length);
  const blackMesh = new THREE.InstancedMesh(blackGeo, M.blackKey, blacks.length);
  for (const m of [whiteMesh, blackMesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);   // 每帧可能改
  }

  // 每个实例的基础信息：平移量 + 当前的按下量
  const slots = new Map();          // midi -> { mesh, index, x, amount, target }
  const maxAngle = Math.asin(KEY_DIP / SPEC.keyLen);

  function place(mesh, index, x, amount) {
    const m = new THREE.Matrix4();
    m.makeTranslation(x, KEYBED_Y, KEY_BACK_Z);
    if (amount > 0.0001) {
      // **正号**：绕 +X 转正角把远端压低。几何原点在键后端，前端在 z = +keyLen，
      // 正角下 y' = y·cosθ − z·sinθ 里的 −z·sinθ 就是下沉量。
      // 早先写的是负号，结果按下去琴键往上翘 10 mm——截图看不出来，
      // 得把前端尖点的世界 Y 前后一减才知道（tools/scan.mjs 的 pressDir）。
      m.multiply(new THREE.Matrix4().makeRotationX(amount * maxAngle));
    }
    mesh.setMatrixAt(index, m);
  }

  whites.forEach((k, i) => {
    place(whiteMesh, i, k.x, 0);
    slots.set(k.midi, { mesh: whiteMesh, index: i, x: k.x, amount: 0, target: 0 });
  });
  blacks.forEach((k, i) => {
    place(blackMesh, i, k.x, 0);
    slots.set(k.midi, { mesh: blackMesh, index: i, x: k.x, amount: 0, target: 0 });
  });
  whiteMesh.instanceMatrix.needsUpdate = true;
  blackMesh.instanceMatrix.needsUpdate = true;

  g.add(whiteMesh, blackMesh);

  const inner = ensureCCW(shrinkPolygon(shapeToOutline(rimShape(), 384), SPEC.rimThick));

  /* ── 2. 键床：分两层。
         后段承托琴键（就在琴键下面），前段压下去 13 mm。
         真机上琴键前端是**悬在前档上方**的；只做一层平的，按下去的琴键
         前端会直接切进键床里穿帮——按键下沉量正好是 10 mm。 */
  {
    const bedTop = KEYBED_Y - 0.0015;             // 比键底面低一点点，免得共面闪烁
    const bedZ0 = -0.196;                         // 后沿：名板之下
    const bedZ1 = -0.056;                         // 前沿：让开琴键下压的那一段

    const back = ensureCCW(clipPolygonZ(inner, bedZ0, bedZ1));
    const bed = new THREE.Mesh(capPolygon(back, [], 1), M.lacquerInner);
    bed.position.y = bedTop;
    bed.receiveShadow = true;
    g.add(bed);

    // 前档不能用内轮廓裁——内轮廓的前缘在 z = −0.052，裁出来只剩一条 4 mm 的碎片。
    // 它本来就该是一块实实在在的横档，直接给个盒子，一直伸到前挡条底下不留缝。
    const railFrontZ = SPEC.keySlipFrontZ - 0.010;
    const railW = 1.386;
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(railW, 0.030, railFrontZ - bedZ1), M.lacquerInner,
    );
    rail.position.set(0, KEYBED_Y - 0.013 - 0.015, (bedZ1 + railFrontZ) / 2);
    rail.receiveShadow = true;
    g.add(rail);

    // 两层之间的立面。缺了它，从 1.2 mm 宽的键缝里往下看是个空洞
    const riser = new THREE.Mesh(new THREE.BoxGeometry(railW, 0.020, 0.012), M.lacquerInner);
    riser.position.set(0, bedTop - 0.009, bedZ1 - 0.003);
    g.add(riser);
  }

  /* ── 3. 前挡条（key slip）：顶面压在键面之下 15 mm。
         宽度正好卡在两侧键侧木之间——键盘盖关下来时前沿就搭在它后沿上，
         两者必须对得上，多出来一截会从键侧木里穿出去。 ── */
  {
    const h = 0.030;
    const top = KEYBED_Y + 0.007;
    const z0 = SPEC.keySlipBackZ;
    const z1 = SPEC.keySlipFrontZ;
    const slip = new THREE.Mesh(
      new THREE.BoxGeometry(SPEC.keyHalfW * 2, h, z1 - z0), M.lacquer,
    );
    slip.position.set(0, top - h / 2, (z0 + z1) / 2);
    slip.castShadow = true;
    slip.receiveShadow = true;
    g.add(slip);
  }

  /* ── 4. 键侧木：夹住键盘两端，顶面与侧板齐平——键盘盖就是嵌在这两块之间 ── */
  {
    const halfSpan = SPEC.keyHalfW;
    const xOuter = SPEC.halfWidth;
    const w = xOuter - halfSpan;
    const yTop = SPEC.cheekTop;
    const yBot = KEYBED_Y - 0.030;
    const zFront = SPEC.keySlipFrontZ + 0.002;
    const zBack = -0.170;
    for (const sgn of [-1, 1]) {
      const blk = new THREE.Mesh(
        new THREE.BoxGeometry(w, yTop - yBot, zFront - zBack), M.lacquer,
      );
      blk.position.set(sgn * (halfSpan + w / 2), (yTop + yBot) / 2, (zFront + zBack) / 2);
      blk.castShadow = true;
      blk.receiveShadow = true;
      g.add(blk);
    }
  }

  /* ── 5. 名板：兼作键盘后挡板，琴键后端插进它内部，不露缝。
         它的前脸同时是键盘盖的铰链线（SPEC.fallBackZ）——所以位置不是随便放的：
         必须在琴键后端（z ≈ −0.14）再往后让出 fallThick，键盘盖竖起来时才
         不会压在后半截琴键上。 ── */
  {
    const yBot = KEYBED_Y - 0.020;
    const yTop = 0.858;
    const zFront = SPEC.fallBackZ;
    const zBack = -0.200;
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(1.32, yTop - yBot, zFront - zBack), M.lacquer,
    );
    board.position.set(0, (yTop + yBot) / 2, (zFront + zBack) / 2);
    board.castShadow = true;
    board.receiveShadow = true;
    g.add(board);

    // 名板顶沿一条细黄铜压线，真机上这里是品牌铭牌的所在
    const trim = new THREE.Mesh(new THREE.BoxGeometry(1.325, 0.007, 0.023), M.brass);
    trim.position.set(0, yTop + 0.0025, (zFront + zBack) / 2);
    g.add(trim);
  }

  /* ── 对外接口：拾取与按键动画 ── */

  /** 从射线命中的实例反查 midi */
  function midiAt(mesh, instanceId) {
    for (const [midi, s] of slots) {
      if (s.mesh === mesh && s.index === instanceId) return midi;
    }
    return null;
  }

  return {
    group: g,
    hitMeshes: [whiteMesh, blackMesh],
    midiAt,

    /** 查某个音对应的实例位置（调试/测试用） */
    slotOf(midi) { return slots.get(midi) ?? null; },

    /** 设定某个键的目标按下量 0–1 */
    press(midi, amount) {
      const s = slots.get(midi);
      if (s) s.target = Math.max(0, Math.min(1, amount));
    },

    /** 每帧把按下量平滑推向目标值并写回实例矩阵；有变化就返回 true */
    update(dt) {
      let dirty = false;
      for (const s of slots.values()) {
        if (Math.abs(s.amount - s.target) < 0.002) {
          if (s.amount !== s.target) { s.amount = s.target; dirty = true; }
          else continue;
        } else {
          // 按下快、回弹稍慢，接近真机的键感
          const k = s.target > s.amount ? 1 - Math.pow(0.0015, dt) : 1 - Math.pow(0.02, dt);
          s.amount += (s.target - s.amount) * k;
          dirty = true;
        }
        place(s.mesh, s.index, s.x, s.amount);
      }
      if (dirty) {
        whiteMesh.instanceMatrix.needsUpdate = true;
        blackMesh.instanceMatrix.needsUpdate = true;
      }
      return dirty;
    },

    allUp() {
      for (const s of slots.values()) s.target = 0;
    },
  };
}
