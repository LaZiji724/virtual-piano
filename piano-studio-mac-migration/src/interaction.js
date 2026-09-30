/**
 * 演奏输入：鼠标点键、电脑键盘、MIDI 键盘、延音踏板。
 *
 * 拾取走 raycast 打到琴键的 InstancedMesh，拿 instanceId 反查是哪个音——
 * 这也是为什么键盘必须用 InstancedMesh 而不是合并几何：合并之后一个键都点不到。
 *
 * 力度由落点决定：越靠近琴键外端，力臂越长，声音越强。真机就是这么回事。
 */

import * as THREE from 'three';

/** 电脑键盘映射：下排 C4–B4，上排 C5–B5 */
const KEY_MAP = {
  KeyZ: 48, KeyS: 49, KeyX: 50, KeyD: 51, KeyC: 52, KeyV: 53, KeyG: 54,
  KeyB: 55, KeyH: 56, KeyN: 57, KeyJ: 58, KeyM: 59,
  KeyQ: 60, Digit2: 61, KeyW: 62, Digit3: 63, KeyE: 64, KeyR: 65, Digit5: 66,
  KeyT: 67, Digit6: 68, KeyY: 69, Digit7: 70, KeyU: 71,
};

export function createInteraction({
  renderer, camera, controls, keyboard, audio,
  onPlayStateChange, onSustainChange, onMidiChange,
  onNoteOn, onNoteOff,
}) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const keyMeshes = keyboard.hitMeshes;

  const held = new Set();          // 当前按住的 midi
  const mouseHeld = new Set();     // 鼠标按住的 midi
  const computerHeld = new Set();  // 电脑键盘按住的
  let transpose = 0;
  let sustain = false;
  let dragging = false;
  const active = { lastNoteAt: 0 };

  /* ── 拾取 ── */
  function pick(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(keyMeshes, false);
    if (!hits.length) return null;
    const h = hits[0];
    const midi = keyboard.midiAt(h.object, h.instanceId);
    if (midi == null) return null;

    // 力度与电脑键盘弹奏完全一致（pointer 事件天然统一鼠标和触摸屏）。
    // 曾经按落点位置算力度，结果鼠标弹出来比键盘轻一大截。
    const vel = 0.78;
    return { midi, vel };
  }

  function noteOn(midi, vel) {
    const m = midi + transpose;
    if (m < 21 || m > 108) return;
    if (held.has(m)) return;
    held.add(m);
    audio.noteOn(m, vel);
    keyboard.press(m, Math.min(1, vel * 1.15));
    active.lastNoteAt = performance.now();
    onNoteOn?.(m, vel);               // 录制/瀑布流挂钩（三路输入统一走这）
    onPlayStateChange?.(true);
  }

  function noteOff(midi) {
    const m = midi + transpose;
    if (!held.has(m)) return;
    held.delete(m);
    audio.noteOff(m);
    keyboard.press(m, 0);
    onNoteOff?.(m);
    if (!held.size) onPlayStateChange?.(false);
  }

  /* ══ 鼠标 ══════════════════════════════════════════════ */
  const canvas = renderer.domElement;

  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    audio.resume();                       // 浏览器要求用户手势后才能出声
    const hit = pick(ev);
    if (!hit) return;                     // 没点到琴键就交给 OrbitControls 转视角
    ev.preventDefault();
    controls.enabled = false;             // 在键盘上拖动是刮奏，不是转视角
    dragging = true;
    canvas.setPointerCapture(ev.pointerId);
    mouseHeld.add(hit.midi);
    noteOn(hit.midi, hit.vel);
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const hit = pick(ev);
    if (!hit) return;
    if (mouseHeld.has(hit.midi)) return;
    // 滑到新键上：旧的松开、新的按下 —— 刮奏
    for (const m of Array.from(mouseHeld)) { mouseHeld.delete(m); noteOff(m); }
    mouseHeld.add(hit.midi);
    noteOn(hit.midi, hit.vel);
  });

  const endDrag = (ev) => {
    if (!dragging) return;
    dragging = false;
    controls.enabled = true;
    for (const m of Array.from(mouseHeld)) { mouseHeld.delete(m); noteOff(m); }
    try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* 已释放 */ }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /* ══ 电脑键盘 ══════════════════════════════════════════ */
  window.addEventListener('keydown', (ev) => {
    if (ev.repeat) return;
    // 音频必须由用户手势唤醒。漏了这一步的话，纯键盘弹奏会一声不响
    // （鼠标路径上有 resume，键盘路径上当初忘了）。
    if (KEY_MAP[ev.code] !== undefined || ev.code === 'Space') audio.resume();
    if (ev.code === 'Space') {
      ev.preventDefault();
      setSustain(true);
      return;
    }
    if (ev.code === 'BracketLeft') { transpose = Math.max(-24, transpose - 12); return; }
    if (ev.code === 'BracketRight') { transpose = Math.min(24, transpose + 12); return; }
    const midi = KEY_MAP[ev.code];
    if (midi === undefined) return;
    ev.preventDefault();
    if (computerHeld.has(midi)) return;
    computerHeld.add(midi);
    noteOn(midi, 0.78);
  });

  window.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space') {
      setSustain(false);
      return;
    }
    const midi = KEY_MAP[ev.code];
    if (midi === undefined) return;
    computerHeld.delete(midi);
    noteOff(midi);
  });

  // 失焦时把所有音掐掉，否则会一直响
  window.addEventListener('blur', () => {
    for (const m of Array.from(held)) noteOff(m);
    held.clear(); mouseHeld.clear(); computerHeld.clear();
    if (sustain) setSustain(false);
  });

  /** 延音的唯一入口：声音、踏板动画、面板按钮都从这里同步 */
  function setSustain(on) {
    if (sustain === on) return;
    sustain = on;
    onSustainChange?.(on);
  }

  /* ══ MIDI 键盘 ═════════════════════════════════════════ */
  let midiName = null;
  function handleMidi(data) {
    const [status, d1, d2] = data;
    const type = status & 0xf0;
    if (type === 0x90 && d2 > 0) { audio.resume(); noteOn(d1, 0.3 + (d2 / 127) * 0.7); }
    else if (type === 0x80 || (type === 0x90 && d2 === 0)) noteOff(d1);
    else if (type === 0xb0 && d1 === 64) {
      setSustain(d2 >= 64);
      if (!sustain && !held.size) onPlayStateChange?.(false);
    }
  }

  if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess({ sysex: false }).then((access) => {
      const attach = () => {
        const inputs = [...access.inputs.values()];
        if (!inputs.length) { midiName = null; onMidiChange?.(null); return; }
        midiName = inputs.map((i) => i.name).join(', ');
        for (const i of inputs) i.onmidimessage = (e) => handleMidi(e.data);
        onMidiChange?.(midiName);
      };
      attach();
      access.onstatechange = attach;   // 插拔设备时自动重挂
    }).catch(() => { onMidiChange?.(null); });
  }

  return {
    get midiName() { return midiName; },
    get transpose() { return transpose; },
    get sustainOn() { return sustain; },
    setSustain,
    /** 回放/瀑布流点键用的统一入口：发声、琴键动画、录制挂钩全部同源 */
    playNote(m, vel = 0.78) { noteOn(m, vel); },
    silenceNote(m) { noteOff(m); },
    releaseAll() {
      for (const m of Array.from(held)) noteOff(m);
      held.clear(); mouseHeld.clear(); computerHeld.clear();
      audio.allOff();
      keyboard.allUp();
    },
  };
}
