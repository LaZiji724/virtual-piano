/**
 * 演奏录制：MIDI 事件流 + 应用内琴声，两路同步录。
 *
 *   事件流  interaction 的 noteOn/noteOff/踏板挂钩喂进来（MIDI、鼠标、
 *           电脑键盘三路输入都汇在那里），带 performance.now 时间戳；
 *   琴声    在音频引擎的压缩器输出上并接一个 MediaStreamDestination，
 *           MediaRecorder 直接录应用内合成的声音——纯内部抽头，
 *           全程不碰麦克风，也不依赖系统声音采集。
 *
 * 回放按录制时间轴重新走 noteOn/noteOff 管线，3D 琴键和瀑布流都会重演。
 * 导出标准 MIDI 文件（format 0 / 480 PPQ / 120 BPM）。
 */

const PPQ = 480;
const MS_PER_QUARTER = 500;          // 120 BPM

export function createRecorder({ engine, feed, onState }) {
  let recording = false;
  let playing = false;

  let events = [];                   // { t, type:'on'|'off'|'cc64', midi?, vel? }
  let t0 = 0;
  let duration = 0;
  let noteCount = 0;

  let audioBlob = null;
  let mediaRecorder = null;
  let audioChunks = [];
  const audioOK = typeof MediaRecorder !== 'undefined'
    && MediaRecorder.isTypeSupported('audio/webm;codecs=opus');

  /* 回放调度：指针扫描事件表，主循环每帧 tick 一次 */
  let playIdx = 0;
  let playT0 = 0;

  const emit = () => onState?.(getState());

  function fmt(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function getState() {
    return {
      recording, playing, audioOK,
      hasTake: events.length > 0,
      noteCount,
      duration,
      statText: recording
        ? `录制中 ${fmt(performance.now() - t0)} · ${noteCount} 音符`
        : events.length
          ? `已录 ${fmt(duration)} · ${noteCount} 音符`
          : '就绪',
    };
  }

  /* ── 录制 ─────────────────────────────────────────────── */
  function start() {
    if (recording || playing) return false;
    events = [];
    noteCount = 0;
    t0 = performance.now();
    recording = true;
    feed?.resume?.();
    if (audioOK) {
      try {
        const stream = engine?.createTapStream?.();
        if (stream) {
          audioChunks = [];
          mediaRecorder = new MediaRecorder(stream, { audioBitsPerSecond: 192000 });
          mediaRecorder.ondataavailable = (e) => {
            if (e.data.size) audioChunks.push(e.data);
          };
          mediaRecorder.onstop = () => {
            audioBlob = audioChunks.length
              ? new Blob(audioChunks, { type: 'audio/webm' })
              : null;
            emit();               // 琴声 Blob 是异步封装好的，这里补一次状态刷新
          };
          mediaRecorder.start(250);
        }
      } catch (e) {
        console.warn('[recorder] 琴声录制不可用:', e.message);
        mediaRecorder = null;
      }
    }
    emit();
    return true;
  }

  function stop() {
    if (!recording) return;
    recording = false;
    duration = performance.now() - t0;
    if (mediaRecorder?.state !== 'inactive') mediaRecorder?.stop();
    emit();
  }

  /** interaction 挂钩喂事件；回放期间忽略（防回环） */
  function recordEvent(type, midi, val) {
    if (!recording || playing) return;
    if (type === 'on') noteCount++;
    events.push({ t: performance.now() - t0, type, midi, vel: val });
  }

  /* ── 回放 ─────────────────────────────────────────────── */
  function play() {
    if (!events.length || playing || recording) return false;
    playing = true;
    playIdx = 0;
    playT0 = performance.now();
    emit();
    return true;
  }

  function stopPlay() {
    if (!playing) return;
    playing = false;
    feed?.setSustain?.(false);
    feed?.allOff?.();
    emit();
  }

  function tick() {
    if (!playing) return;
    const t = performance.now() - playT0;
    while (playIdx < events.length && events[playIdx].t <= t) {
      const e = events[playIdx++];
      if (e.type === 'on') feed?.noteOn?.(e.midi, e.vel);
      else if (e.type === 'off') feed?.noteOff?.(e.midi);
      else if (e.type === 'cc64') feed?.setSustain?.(e.vel >= 64);
    }
    if (playIdx >= events.length && t > duration + 400) stopPlay();
  }

  /* ── 导出 MIDI ────────────────────────────────────────── */
  function downloadMidi() {
    if (!events.length) return;
    const blob = new Blob([buildMidiFile(events, duration)], { type: 'audio/midi' });
    triggerDownload(blob, `performance-${stamp()}.mid`);
  }

  function downloadAudio() {
    if (!audioBlob) return;
    triggerDownload(audioBlob, `performance-${stamp()}.webm`);
  }

  return {
    start, stop, recordEvent, play, stopPlay, tick,
    downloadMidi, downloadAudio,
    get recording() { return recording; },
    get playing() { return playing; },
    get hasTake() { return events.length > 0; },
    get audioBlob() { return audioBlob; },
    get events() { return events; },       // 测试/调试用只读
    get statText() { return getState().statText; },
  };
}

export function triggerDownload(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ══ 标准 MIDI 文件构建（format 0）═══════════════════════════
   纯函数、零 DOM 依赖，node 侧测试脚本直接 import。 */

export function buildMidiFile(events, durationMs) {
  const evs = events
    .filter((e) => e.type === 'on' || e.type === 'off' || e.type === 'cc64')
    .map((e) => ({ ...e, tick: msToTick(Math.max(0, e.t)) }))
    .sort((a, b) => a.tick - b.tick
      || tieOrder(a) - tieOrder(b));

  const track = [];
  let last = 0;
  const push = (...bs) => track.push(...bs);
  for (const e of evs) {
    push(...vlq(e.tick - last));
    last = e.tick;
    if (e.type === 'on') push(0x90, e.midi, clampVel(e.vel));
    else if (e.type === 'off') push(0x80, e.midi, 0);
    else push(0xb0, 64, clampVel(e.vel));
  }
  push(...vlq(msToTick(Math.max(durationMs ?? 0, 0)) - last), 0xff, 0x2f, 0x00);

  const head = [
    0x4d, 0x54, 0x68, 0x64,              // MThd
    0, 0, 0, 6,                          // 头长 6
    0, 0,                                // format 0
    0, 1,                                // 1 轨
    (PPQ >> 8) & 0xff, PPQ & 0xff,
  ];
  const trkLen = track.length;
  return new Uint8Array([
    ...head,
    0x4d, 0x54, 0x72, 0x6b,              // MTrk
    (trkLen >>> 24) & 0xff, (trkLen >>> 16) & 0xff, (trkLen >>> 8) & 0xff, trkLen & 0xff,
    ...track,
  ]);
}

/** 同一 tick 内：踏板 → 收音 → 击弦，避免悬空音符 */
function tieOrder(e) {
  return e.type === 'cc64' ? 0 : e.type === 'off' ? 1 : 2;
}

function msToTick(ms) {
  return Math.round((ms / MS_PER_QUARTER) * PPQ);
}

function clampVel(v) {
  return Math.max(1, Math.min(127, Math.round((v ?? 0.8) * 127)));
}

function vlq(n) {
  const bytes = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  return bytes;
}
