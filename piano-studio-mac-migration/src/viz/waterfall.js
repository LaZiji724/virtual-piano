/**
 * 瀑布流录制视图：屏幕底部一台标准钢琴键盘，弹奏时琴键点亮，
 * 光条从键位向上生长（长度 = 按压时长 × 速率），松开后定长匀速上飞。
 *
 * 键位横向坐标直接复用 spec.js 的 keyCenterX（世界坐标米制），
 * 归一化到键盘宽度——和 3D 琴键逐键对齐，黑键微调也一并继承。
 *
 * ── 键盘怎么画 ────────────────────────────────────────────
 * **按真实毫米尺寸画，只做一次缩放**：屏幕宽 = 琴身宽 1.49 m（SPEC.halfWidth×2），
 * 于是每个尺寸都是"真实尺寸 × 这一个比例"，没有第二处拟合：
 *   白键 23.5 mm 中心距 × 150 mm 长（八度 7 键 = 164.5 mm，即通用 165 mm 标准）
 *   黑键 13.9 mm 宽 × 95 mm 露出长（前端缩进 55 mm）
 *   键盘总宽 52 × 23.5 = 1222 mm，占屏宽 1222/1490 = 82%，
 *   两侧剩余的就是琴身那两道键侧木（3D 里同样 1.222 m 键盘落在 1.49 m 琴身中）。
 * 所以键形比例任何时候都不会变形，也不存在"窗口太扁就压缩/缩放"那类二次拟合。
 *
 * 延音踏板踩下时，noteOff 不切断光条，继续生长到踏板抬起为止，
 * 和听感里的止音时刻保持一致。
 */

import { SPEC, keyCenterX, isBlackKey } from '../spec.js';

/* 琴身宽度 1.49 m 就是唯一的比例基准（改 spec.js 这里跟着变） */
const BODY_W = SPEC.halfWidth * 2;

const WHITE_HUES = [197, 90];    // 白键光条：青蓝
const BLACK_HUES = [40, 95];     // 黑键光条：金
const BG_TOP = '#0b0d13';
const BG_BOT = '#10131c';

export function createWaterfall({
  canvas,
  speed = 160,             // 光条上飞速率 px/s（面板可调）
  onUserNote,              // (midi) => 在这根键上落指（用户点按画布）
  onUserNoteOff,           // (midi) => 抬指
}) {
  const ctx2d = canvas.getContext('2d');
  let w = 0, h = 0, dpr = 1;
  let active = false;
  let curSpeed = speed;
  let sustainOn = false;

  /* ── 键位表 ─────────────────────────────────────────────
     世界坐标跨度 = 52 白键 × keyPitch，keyCenterX 原点在琴中线，
     归一化成 0..1 的横向占比后乘画布宽。 */
  const SPAN = SPEC.whiteCount * SPEC.keyPitch;
  const norm = (m) => (keyCenterX(m) + SPAN / 2) / SPAN;

  const whiteMidis = [];
  const blacks = [];            // { midi, fx }  fx = 归一化中心
  for (let m = SPEC.firstMidi; m <= SPEC.lastMidi; m++) {
    if (isBlackKey(m)) blacks.push({ midi: m, fx: norm(m) });
    else whiteMidis.push(m);
  }

  /* ── 光条状态 ───────────────────────────────────────────
     按住中：底边锚在键盘上沿，长度随时间涨；
     松开后：born 时刻起整体上移，长度封存。 */
  const bars = [];              // { midi, vel, black, fx, start, born, len }
  const byMidi = new Map();     // midi -> 按住中的那条
  const pointers = new Map();   // pointerId -> midi（画布点按）

  let kbH = 0, kbTop = 0, whiteW = 0, blackW = 0, blackH = 0;
  let kbX0 = 0, kbW = 0;        // 键盘左端与总宽（两侧剩下的是键侧木）
  let gapPx = 0, scale = 0;     // scale = 像素/米，全画面唯一那个比例

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 唯一一次缩放：屏幕宽 = 琴身宽 1.49 m。后面每个尺寸都是真实毫米 × scale，
    // 不再按窗口做任何拟合或压缩，键形比例因此永远等于真琴。
    scale = w / BODY_W;
    kbW = SPEC.whiteCount * SPEC.keyPitch * scale;   // 键盘总宽 1222 mm（占屏宽 82%）
    kbX0 = (w - kbW) / 2;                            // 居中放进屏幕下方
    kbH = SPEC.keyLen * scale;                       // 键床深 150 mm
    kbTop = h - kbH;
    whiteW = SPEC.keyPitch * scale;
    blackW = SPEC.blackW * scale;
    blackH = SPEC.blackLen * scale;
    gapPx = SPEC.keyGap * scale;
  }

  /* ── 弹奏事件（三路输入统一从 main 转进来） ───────────── */
  function noteOn(midi, vel) {
    // 踏板吊着时同音重弹：老光条按重新击弦算，生长从头起
    const ex = byMidi.get(midi);
    if (ex) { ex.start = performance.now(); ex.vel = vel; return; }
    const bar = {
      midi, vel, black: isBlackKey(midi), fx: norm(midi),
      start: performance.now(), born: null, len: 0,
    };
    bars.push(bar);
    byMidi.set(midi, bar);
  }

  function noteOff(midi) {
    const bar = byMidi.get(midi);
    if (!bar) return;
    if (sustainOn) return;              // 踏板吊着，光条继续生长
    bar.len = (performance.now() - bar.start) / 1000 * curSpeed;
    bar.born = performance.now();
    byMidi.delete(midi);
  }

  function setSustain(on) {
    if (sustainOn === on) return;
    sustainOn = on;
    if (!on) {
      // 踏板抬起：所有被吊着的光条此刻定长放飞
      const now = performance.now();
      for (const bar of byMidi.values()) {
        bar.len = (now - bar.start) / 1000 * curSpeed;
        bar.born = now;
      }
      byMidi.clear();
    }
  }

  /** 光条继续生长到踏板松开——但键先松、踏板又踩着的音，
      音源侧还有一次真正的止音；这里跟 interaction 的 held 语义对齐即可 */
  function releaseAll() {
    byMidi.clear();
    bars.length = 0;
    for (const m of pointers.values()) onUserNoteOff?.(m);
    pointers.clear();
  }

  /* ── 画布点按（把虚拟键盘当琴键弹） ───────────────────── */
  function midiAt(px, py) {
    if (py < kbTop || py > h) return null;
    if (px < kbX0 || px > kbX0 + kbW) return null;      // 键侧木之外
    // 黑键在键床上层，优先命中
    if (py < kbTop + blackH) {
      for (const b of blacks) {
        const bx = kbX0 + b.fx * kbW;
        if (px >= bx - blackW / 2 && px <= bx + blackW / 2) return b.midi;
      }
    }
    const k = Math.floor((px - kbX0) / whiteW);
    return whiteMidis[Math.max(0, Math.min(SPEC.whiteCount - 1, k))] ?? null;
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (!active) return;
    const m = midiAt(ev.clientX, ev.clientY);
    if (m == null) return;
    ev.preventDefault();
    canvas.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, m);
    onUserNote?.(m);
  });
  const lift = (ev) => {
    const m = pointers.get(ev.pointerId);
    if (m == null) return;
    pointers.delete(ev.pointerId);
    onUserNoteOff?.(m);
  };
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);

  /* ── 绘制 ─────────────────────────────────────────────── */
  const hsla = ([hh, ss], ll, aa) => `hsla(${hh},${ss}%,${ll}%,${aa})`;

  function drawBar(bar, now) {
    let bottom, len;
    if (bar.born == null) {
      bottom = kbTop;
      len = (now - bar.start) / 1000 * curSpeed;
    } else {
      bottom = kbTop - (now - bar.born) / 1000 * curSpeed;
      len = bar.len;
    }
    // 上飞中：整条（含顶端）飞出画面上沿才回收。判据只看顶端，
    // 否则长光条会以"还没完全飞出去"的名义在幕后干留好几秒。
    if (bar.born != null && bottom - len < -40) return false;

    const bw = (bar.black ? blackW : whiteW) - gapPx * 2;
    const x = kbX0 + bar.fx * kbW - bw / 2;
    const top = Math.max(-40, bottom - len);
    const visH = Math.min(bottom, kbTop) - top;
    if (visH <= 0) return true;

    const hue = bar.black ? BLACK_HUES : WHITE_HUES;
    const ll = 52 + bar.vel * 22;
    const g = ctx2d.createLinearGradient(0, bottom, 0, top);
    g.addColorStop(0, hsla(hue, ll, 0.88));
    g.addColorStop(1, hsla(hue, ll, 0.38));
    ctx2d.fillStyle = g;
    roundRect(x, top, bw, visH, Math.min(5, bw / 2));
    ctx2d.fill();
    // 两道亮边勾出光条轮廓
    ctx2d.fillStyle = hsla(hue, ll + 18, 0.9);
    ctx2d.fillRect(x, top, bw, 2);
    return true;
  }

  function roundRect(x, y, rw, rh, r) {
    ctx2d.beginPath();
    ctx2d.moveTo(x + r, y);
    ctx2d.arcTo(x + rw, y, x + rw, y + rh, r);
    ctx2d.arcTo(x + rw, y + rh, x, y + rh, r);
    ctx2d.arcTo(x, y + rh, x, y, r);
    ctx2d.arcTo(x, y, x + rw, y, r);
    ctx2d.closePath();
  }

  function drawKeyboard() {
    // 键侧木：键盘两侧那两道（真琴上 1.49 m 琴身里嵌 1.222 m 键盘，两侧各 134 mm）。
    // 黑漆面 + 顶面反光，和 3D 琴体一个质感，键盘才不会看着像悬空的贴纸。
    const cheek = (x, cw, flip) => {
      if (cw <= 0.5) return;
      const g = ctx2d.createLinearGradient(0, kbTop, 0, kbTop + kbH);
      g.addColorStop(0, '#1b1f27');
      g.addColorStop(0.35, '#141821');
      g.addColorStop(1, '#0c0e13');
      ctx2d.fillStyle = g;
      ctx2d.fillRect(x, kbTop, cw, kbH);
      ctx2d.fillStyle = 'rgba(255,255,255,.09)';       // 顶面一道反光
      ctx2d.fillRect(x, kbTop, cw, Math.max(1, scale * 0.002));
      ctx2d.fillStyle = 'rgba(0,0,0,.55)';             // 与琴键的分界
      ctx2d.fillRect(flip ? x : x + cw - 1, kbTop, 1, kbH);
    };
    cheek(0, kbX0, false);
    cheek(kbX0 + kbW, w - kbX0 - kbW, true);

    // 白键
    for (let k = 0; k < whiteMidis.length; k++) {
      const m = whiteMidis[k];
      const held = byMidi.get(m);
      const x = kbX0 + k * whiteW;
      if (held) {
        const hue = WHITE_HUES;
        const g = ctx2d.createLinearGradient(0, kbTop, 0, h);
        g.addColorStop(0, hsla(hue, 72, 68, 1));
        g.addColorStop(1, hsla(hue, 80, 46, 1));
        ctx2d.fillStyle = g;
      } else {
        ctx2d.fillStyle = '#e8e2d6';
      }
      ctx2d.fillRect(x + gapPx / 2, kbTop, whiteW - gapPx, kbH);
      // C 标音名
      if (m % 12 === 0) {
        ctx2d.fillStyle = held ? 'rgba(255,255,255,.85)' : '#8a8577';
        ctx2d.font = `${Math.max(9, whiteW * 0.34)}px sans-serif`;
        ctx2d.textAlign = 'center';
        ctx2d.fillText(`C${Math.floor(m / 12) - 1}`, x + whiteW / 2, h - 7);
      }
    }
    // 白键面一条顶部分界线
    ctx2d.fillStyle = 'rgba(0,0,0,.55)';
    ctx2d.fillRect(kbX0, kbTop, kbW, 1);

    // 黑键
    for (const b of blacks) {
      const held = byMidi.get(b.midi);
      ctx2d.fillStyle = held ? hsla(BLACK_HUES, 62, 1) : '#171921';
      ctx2d.fillRect(kbX0 + b.fx * kbW - blackW / 2, kbTop, blackW, blackH);
      if (held) {
        ctx2d.fillStyle = hsla(BLACK_HUES, 75, 0.9);
        ctx2d.fillRect(kbX0 + b.fx * kbW - blackW / 2, kbTop + blackH - 3, blackW, 3);
      }
    }

    if (sustainOn) {
      ctx2d.fillStyle = 'rgba(216,178,106,.92)';
      ctx2d.font = '12px sans-serif';
      ctx2d.textAlign = 'left';
      ctx2d.fillText('延音踏板', 14, kbTop - 12);
    }
  }

  function update() {
    if (!active) return;
    const now = performance.now();

    const g = ctx2d.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, BG_TOP);
    g.addColorStop(1, BG_BOT);
    ctx2d.fillStyle = g;
    ctx2d.fillRect(0, 0, w, h);

    // 光条，顺带回收飞出的
    for (let i = bars.length - 1; i >= 0; i--) {
      if (!drawBar(bars[i], now)) bars.splice(i, 1);
    }

    drawKeyboard();

    // 顶部渐隐罩：光条升出去时柔和消失
    const fade = ctx2d.createLinearGradient(0, 0, 0, 80);
    fade.addColorStop(0, BG_TOP);
    fade.addColorStop(1, 'rgba(11,13,19,0)');
    ctx2d.fillStyle = fade;
    ctx2d.fillRect(0, 0, w, 80);
  }

  function setActive(on) {
    active = on;
    canvas.style.display = on ? 'block' : 'none';
    if (on) resize();
  }

  resize();
  window.addEventListener('resize', resize);

  return {
    noteOn, noteOff, setSustain, releaseAll, update, setActive, resize,
    get active() { return active; },
    /** 还有光条在屏上（按下中或上飞中）——视频导出靠它决定何时收尾 */
    get busy() { return bars.length > 0 || byMidi.size > 0; },
    /** 当前像素几何（测试与调试用：验键形比例是否等于 spec.js 的真实尺寸） */
    get metrics() {
      return { w, h, kbX0, kbW, kbTop, kbH, whiteW, blackW, blackH, gapPx, scale,
        bodyW: BODY_W, spanMm: SPEC.keyPitch * 7000, keyLenMm: SPEC.keyLen * 1000 };
    },
    setSpeed(v) { curSpeed = v; },
    get speed() { return curSpeed; },
  };
}
