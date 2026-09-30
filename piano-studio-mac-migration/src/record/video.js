/**
 * 瀑布流视频导出：把瀑布流画面和应用内琴声合成一段视频。
 *
 *   画面  canvas.captureStream(60) 直接抓瀑布流那张 2D 画布——录到的正是
 *         屏幕上看到的光条与键盘。3D 场景和面板都是 DOM/另一个 canvas，
 *         不在抓取范围内，所以要视频里只有瀑布流就只需要抓这一张。
 *   原声  音频从引擎压缩器上的 MediaStreamDestination 抽头，与「下载琴声」
 *         同源，合成器和采样音源都在里面。全程内部抽头，不碰麦克风。
 *
 * MediaRecorder 只能实时编码，所以**导出 = 按原速把这一遍重放一次**，
 * 耗时约等于演奏时长。开头留一段空白键盘当前奏（光条从零长出来），
 * 结尾等最后一批光条飞出画面再收尾，都不额外加戏。
 *
 * ── 音画对齐 ──────────────────────────────────────────────
 * 监听链路上（声卡/耳机/蓝牙）声音比你按下去的瞬间晚到，录音时你听到的琴声
 * 就滞后于眼前的光条。文件里两条轨其实是对齐的（实测差 12 ms），但**在同一个
 * 监听设备上回放时，视频声音同样会晚到**——所以给画面加一段可调延后
 * （getOffset，默认 0.3 s）：琴声照旧按原时间轴发声，光条与琴键高亮整体推迟，
 * 于是你在自己的设备上看到的和听到的就对上了。分享给别人（对方延迟正常）时
 * 选「不补偿」。
 *
 * 实现上不是改文件，而是**画面内容真的晚 0.3 s 才动**：回放时间轴照旧驱动
 * 发声，光条由本模块按同一时间轴 + 偏移另行驱动（导出期间 main 把
 * interaction 钩子通往瀑布流的直连掐掉，避免两边同时驱动）。
 */

import { triggerDownload, stamp } from './recorder.js';

/* 优先 mp4：微信/iPhone 直接能放；不支持时退回 webm（Chrome 系全支持） */
const MIMES = [
  ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'],
  ['video/webm;codecs=vp9,opus', 'webm'],
  ['video/webm;codecs=vp8,opus', 'webm'],
  ['video/webm', 'webm'],
];

export function createVideoExporter({
  engine, train, visual, canvas, isIdle, onState,
  getOffset = () => 0,    // 画面相对琴声延后多少毫秒（补偿监听设备延迟，见文件头注释）
  preroll = 900,          // 开头空白键盘时长（奏前留白，光条才好从零长起）
  tailMin = 500,          // 最后一个音之后至少再录这么久
  tailMax = 12000,        // 光条迟迟飞不干净时的兜底上限（低速光条会飞很久）
  fps = 60,
}) {
  const supported = typeof MediaRecorder !== 'undefined'
    && typeof canvas?.captureStream === 'function';
  const pick = supported ? MIMES.find(([m]) => MediaRecorder.isTypeSupported(m)) : null;
  const videoOK = !!pick;
  const ext = pick?.[1] ?? 'webm';

  let phase = 'idle';     // idle | preroll | playing | tail | finishing
  let mediaRecorder = null;
  let chunks = [];
  let capStream = null;
  let cancelled = false;
  let playAt = 0;
  let tailAt = 0;
  let visIdx = 0;         // 画面事件指针（与琴声事件表同一份，按偏移单独消费）
  let t0 = 0;
  let lastEmit = 0;
  let lastBlob = null;

  const emit = () => onState?.(getState());

  function fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /** 码率跟着画布像素走：窗口大机器就多给点，小窗口别浪费 */
  function bitrate() {
    const px = (canvas.width || 1280) * (canvas.height || 720);
    return Math.round(Math.min(20e6, Math.max(6e6, px * 2.6)));
  }

  function getState() {
    // 回放前 recorder.duration 还是 0，用最后一条事件的时间兜底，进度条才有总数
    const total = Math.max(train?.duration ?? 0, train?.events?.at(-1)?.t ?? 0);
    const done = !!lastBlob;
    let statText;
    if (phase === 'preroll' || phase === 'playing' || phase === 'tail') {
      const el = Math.min(performance.now() - t0, total);
      statText = `导出中 ${fmt(el)} / ${fmt(total)}（实时录制，请勿切走）`;
    } else if (phase === 'finishing') {
      statText = '正在封装视频…';
    } else {
      statText = done ? `视频已导出 · ${fmt(total)}` : '就绪';
    }
    return {
      exporting: phase === 'preroll' || phase === 'playing' || phase === 'tail',
      finishing: phase === 'finishing',
      busy: phase !== 'idle',
      videoOK,
      ext,
      hasVideo: done,
      duration: total,
      statText,
    };
  }

  function cleanup() {
    // 只停画布抓取轨；音频轨是引擎常驻 tap 的，停了会连累「下载琴声」
    try { capStream?.getVideoTracks().forEach((t) => t.stop()); } catch (e) { /* 忽略 */ }
    capStream = null;
    mediaRecorder = null;
    chunks = [];
    phase = 'idle';
  }

  function finish() {
    if (phase === 'idle' || phase === 'finishing') return;
    train?.stopPlay?.();
    phase = 'finishing';
    emit();
    try {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      else cleanup();
    } catch (e) {
      console.warn('[video] 收尾失败:', e.message);
      cleanup();
    }
  }

  /** @returns boolean 是否真的开始导出 */
  function start() {
    if (phase !== 'idle' || !videoOK || !train?.hasTake) return false;
    if (train.recording || train.playing) return false;

    try {
      capStream = canvas.captureStream(fps);
      const tracks = [...capStream.getVideoTracks()];
      const tap = engine?.createTapStream?.();
      if (tap) tracks.push(...tap.getAudioTracks());
      const stream = new MediaStream(tracks);

      cancelled = false;
      chunks = [];
      lastBlob = null;
      mediaRecorder = new MediaRecorder(stream, {
        mimeType: pick[0],
        videoBitsPerSecond: bitrate(),
        audioBitsPerSecond: 192000,
      });
      mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = () => {
        const type = pick[0].split(';')[0];
        if (!cancelled && chunks.length) {
          lastBlob = new Blob(chunks, { type });
          triggerDownload(lastBlob, `piano-waterfall-${stamp()}.${ext}`);
        }
        cleanup();
        emit();
      };
      mediaRecorder.start(500);
    } catch (e) {
      console.warn('[video] 导出不可用:', e.message);
      cleanup();
      return false;
    }

    t0 = performance.now();
    playAt = t0 + preroll;
    visIdx = 0;
    phase = 'preroll';
    lastEmit = 0;
    emit();
    return true;
  }

  /** 画面按偏移延后驱动：琴声在 playAt + t 响，光条在 playAt + t + offset 动 */
  function driveVisual(now) {
    const events = train?.events;
    if (!events?.length || !visual) return;
    const off = Math.max(0, Number(getOffset()) || 0);
    const t = now - playAt;
    while (visIdx < events.length && events[visIdx].t + off <= t) {
      const e = events[visIdx++];
      if (e.type === 'on') visual.noteOn?.(e.midi, e.vel);
      else if (e.type === 'off') visual.noteOff?.(e.midi);
      else if (e.type === 'cc64') visual.setSustain?.(e.vel >= 64);
    }
  }

  /** 每帧由主循环驱动：前奏 → 交给 train 回放 → 尾巴 → 收尾 */
  function tick() {
    if (phase !== 'preroll' && phase !== 'playing' && phase !== 'tail') return;
    const now = performance.now();

    if (phase === 'preroll') {
      if (now >= playAt) {
        phase = 'playing';
        if (!train.play()) finish();      // 事件表空了（理论上不会），直接收尾
      }
    } else if (phase === 'playing') {
      driveVisual(now);
      if (!train.playing) { phase = 'tail'; tailAt = now; }
    } else if (phase === 'tail') {
      driveVisual(now);                   // 尾巴里还可能有被偏移推后的光条
      const idle = isIdle ? isIdle() : true;
      if (now - tailAt >= tailMin && (idle || now - tailAt >= tailMax)) finish();
    }

    if (now - lastEmit > 200) { lastEmit = now; emit(); }
  }

  function cancel() {
    if (phase === 'idle' || phase === 'finishing') return;
    cancelled = true;
    finish();
  }

  return {
    start, cancel, tick,
    get busy() { return phase !== 'idle'; },
    /** 导出期间画面由本模块按偏移驱动，main 别再把回放钩子直连瀑布流 */
    get drivesVisual() { return phase === 'preroll' || phase === 'playing' || phase === 'tail'; },
    get state() { return getState(); },
    get exporting() { return getState().exporting; },
    get videoOK() { return videoOK; },
    get lastBlob() { return lastBlob; },
    get statText() { return getState().statText; },
  };
}
