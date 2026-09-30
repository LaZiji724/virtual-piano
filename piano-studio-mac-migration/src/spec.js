/**
 * 三角钢琴尺寸规格表（单位：米）
 *
 * 参照 Yamaha C1X 一档的小型三角钢琴：琴身 1.62 m × 1.49 m。
 * 真实小型三角琴的长宽比在 1.05–1.10（九尺音乐会琴是 1.83，照那个比例做出来
 * 会被拉得很长，尾腿离前腿两米远，不像家用琴）。俯视是一个接近等边三角形、
 * 但尾部圆钝的轮廓——尾部收窄到约 0.6 m，不收成尖角。
 *
 * 坐标约定
 *   +X  演奏者右手侧（直边 / spine，高音侧）
 *   -X  演奏者左手侧（弯边 / bentside，低音侧）
 *   +Y  上，地面为 0
 *   +Z  琴的前方（键盘朝外）
 *   原点 = 键盘前沿 × 琴身中线 × 地面
 */

export const SPEC = {
  /* ── 琴身平面 ─────────────────────────────────────────── */
  halfWidth: 0.745,        // 最大半宽（直边一侧）
  bodyFrontZ: 0.0,         // 琴身前端面
  bodyBackZ: -1.62,        // 琴尾

  /* ── 琴身竖直 ─────────────────────────────────────────── */
  rimBottom: 0.655,        // 侧板底面（琴腿从这儿往下）
  rimTop: 0.99,            // 侧板顶面（键盘段之外）
  // 键盘段两侧键侧木的顶面。这不是随便定的：它同时是**键盘盖关闭时的顶面**，
  // 键盘盖要严丝合缝地嵌在两侧键侧木之间、顶面齐平，所以两者必须同高。
  // 比白键顶面高 40 mm——真机上键侧木就是这么立在琴键两端的。
  cheekTop: 0.760,
  rimThick: 0.052,         // 侧板厚度
  rimTopR: 0.017,          // 侧板顶面外侧圆角
  rimInnerR: 0.008,        // 侧板顶面内侧圆角
  // 键盘段→琴身段的顶面过渡（沿 Z）。必须落在名板之后，
  // 这样琴盖前缘（z = −0.30）所在的位置侧板已经是全高，盖板才搁得稳。
  cheekZ0: -0.280,         // 过渡起点（琴身侧）
  cheekZ1: -0.200,         // 过渡终点（键盘侧）
  // 键槽半宽：|x| 小于这个值就是琴键正上方，侧板顶面必须塌到键床之下。
  // 不塌的话，侧板会在琴键正前方横起一道比键面还高的墙——俯视时琴键上
  // 多出一条黑边，正前方还会把琴键整个遮掉。只有两端的键侧木保持 cheekTop。
  keyWellHalf: 0.700,

  /* ── 键盘 ─────────────────────────────────────────────── */
  keyTopY: 0.72,           // 白键顶面
  keyH: 0.022,             // 白键自身高度
  keyLen: 0.15,            // 白键全长（前端 → 后端）
  keyFrontZ: 0.01,         // 白键前端（略突出于琴身前端面）
  keyPitch: 0.0235,        // 白键中心距
  keyGap: 0.0012,          // 键缝
  blackTopY: 0.732,        // 黑键顶面（高出白键 12 mm）
  blackLen: 0.095,
  blackInset: 0.055,       // 黑键前端相对白键前端的缩进
  blackW: 0.0139,
  firstMidi: 21,           // A0
  lastMidi: 108,           // C8
  whiteCount: 52,
  keyHalfW: 0.611,         // 键盘半宽 = whiteCount × keyPitch ÷ 2，键侧木与键盘盖都照它对齐
  keySlipBackZ: 0.022,     // 前挡条后沿（= 键盘盖关闭时的前沿，两者对接）
  keySlipFrontZ: 0.043,    // 前挡条前沿
  keySlipTopY: 0.705,      // 前挡条顶面（比白键顶面低 15 mm）

  /* ── 键盘盖（fallboard）─────────────────────────────────
     铰链在**后沿**、名板前脸那条线上，向前盖住琴键。0° 关闭、90° 立起。
     侧视是一个 L 形：水平板 + 一道前唇。前唇是关键——
     只做一块平板的话，关到底也压不住琴键前端面，从正前方仍能看见一排键尖。
     前唇下沿正好落在前挡条顶面（keySlipTopY），前沿正好落在前挡条后沿
     （keySlipBackZ），关上是严丝合缝的一整块。
     唇内侧（fallLipZ）留在琴键前端面（keyFrontZ）之后再退 1.5 mm：
     琴键按下去会向下、向前各走一点，贴死了会被穿模。 */
  fallBackZ: -0.176,       // 铰链所在（= 名板前脸，见 keyboard.js 的名板）
  fallFrontZ: 0.022,       // 关闭时的前沿 = keySlipBackZ
  fallLipZ: 0.0115,        // 前唇内表面
  fallThick: 0.024,        // 板厚（底面 0.736，比黑键顶面高 4 mm）
  fallOpenDeg: 90,         // 默认全开（能弹）

  /* ── 琴盖 ─────────────────────────────────────────────── */
  lidThick: 0.026,
  lidBevel: 0.005,
  lidFrontZ: -0.30,        // 琴盖前缘（其前是谱架与键盘）
  frontLidBackZ: -0.72,    // 小盖后缘 = 大盖前缘
  lidHingeX: 0.752,        // 铰链轴（直边外侧）
  lidHingeY: 1.003,
  lidOpenDeg: 48,          // 默认开启角

  /* ── 内部 ─────────────────────────────────────────────── */
  soundboardY: 0.712,      // 音板顶面
  plateY: 0.775,           // 铸铁板顶面
  stringY: 0.789,          // 琴弦高度
  innerStartZ: -0.30,      // 内腔前缘

  /* ── 琴腿 ─────────────────────────────────────────────── */
  legFrontX: 0.600,
  legFrontZ: -0.170,
  legBackX: 0.055,
  legBackZ: -1.430,
  legTop: 0.126,           // 肩部方料边长
  legTaper: 0.745,         // 底部相对顶部的缩放
  casterH: 0.076,          // 脚轮总高

  /* ── 踏板架 ───────────────────────────────────────────── */
  lyreTopZ: -0.300,        // 立柱锚在琴身底面的位置
  pedalY: 0.098,           // 踏板面高度
  pedalSpread: 0.105,      // 左右踏板中心距中线
};

/**
 * 键盘段的侧板顶面高度（沿 Z 在 cheekTop 与 rimTop 之间平滑过渡）。
 *
 * **横向也必须看**，这是这里最容易做错的一处。侧板是一整圈闭合轮廓扫出来的，
 * 轮廓的前缘横跨整个琴宽——如果顶面只由 z 决定，这道前缘就会变成一堵贯穿
 * 键盘前方的实心墙。琴键顶面才 0.720，这堵墙却有 cheekTop 那么高，
 * 于是：俯视时琴键上多出一条黑边，正前方整排琴键被遮掉下半截。
 *
 * 所以键盘段里按 |x| 分两种：
 *   |x| < keyWellHalf  琴键正上方——顶面塌到键床之下，只留一道矮沿当键框前档
 *   |x| ≥ keyWellHalf  两端键侧木——保持 cheekTop，键盘盖就嵌在它们之间
 * 键身段（z ≤ cheekZ0）不受影响，仍是全高。
 *
 * @param z 轮廓点沿琴长的位置
 * @param x 轮廓点的横向位置（缺省 0 会让整圈都塌下去，务必传）
 */
export function rimTopAt(z, x = 0) {
  const t = smoothstep(SPEC.cheekZ0, SPEC.cheekZ1, z);          // 0 = 琴身段, 1 = 键盘段
  const bodyTop = SPEC.rimTop * (1 - t) + SPEC.cheekTop * t;
  // 膝点取得比键槽宽一点（0.630→0.700），坡道整段都藏在键侧木内部，看不见
  const side = smoothstep(SPEC.keyWellHalf - 0.070, SPEC.keyWellHalf, Math.abs(x));
  const railTop = SPEC.rimBottom + 0.032;                        // 键盘正前方那道矮沿
  const here = railTop + (SPEC.cheekTop - railTop) * side;
  return bodyTop + (here - bodyTop) * t;
}

export function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/* ── 键盘排布 ─────────────────────────────────────────────
   88 键从 A0 到 C8。白键等距排列，黑键挂在白键的键缝上。
   真实的黑键并非精确居中于键缝，制造商会做 0.5 mm 级的微调，
   让相邻黑键之间的间隙看起来均匀——照做。 */

const BLACK_PC = new Set([1, 3, 6, 8, 10]);
export const isBlackKey = (midi) => BLACK_PC.has(((midi % 12) + 12) % 12);

/** 一个八度内五个黑键相对白键边界的微调量（米） */
const BLACK_NUDGE = { 1: 0.0005, 3: 0.0006, 6: 0.0004, 8: 0.0004, 10: 0.0004 };

/**
 * 由 MIDI 号反推琴键的中心 X。
 * 白键：第 k 个白键占 [k·P, (k+1)·P]，整体居中于 x = 0。
 * 黑键：落在第 n 条白键缝上，n = 它前面白键的个数。
 */
export function keyCenterX(midi) {
  const { keyPitch: P, whiteCount: WC, firstMidi: M0 } = SPEC;
  const span = WC * P;
  let whites = 0;
  for (let m = M0; m < midi; m++) if (!isBlackKey(m)) whites++;
  if (isBlackKey(midi)) {
    const boundary = whites * P - span / 2;
    const pc = ((midi % 12) + 12) % 12;
    return boundary + (BLACK_NUDGE[pc] ?? 0);
  }
  // 白键：whites 是它之前白键的个数，正好是它自己的 0 起始下标。
  // 这里曾经写成 whites - 1，第一个白键算出 k = -1，整排白键向左错位
  // 一个键位——黑键按白键缝定位没跟着错，于是黑白键看起来互相错开。
  const k = whites;
  return (k + 0.5) * P - span / 2;
}

/** 键盘（88 键）的完整排布，供各部件共用 */
export function keyLayout() {
  const out = [];
  for (let m = SPEC.firstMidi; m <= SPEC.lastMidi; m++) {
    out.push({ midi: m, black: isBlackKey(m), x: keyCenterX(m) });
  }
  return out;
}
