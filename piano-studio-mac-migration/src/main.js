/**
 * 三角钢琴 · 实时渲染（性能自适应版）
 *
 * 装配顺序：材质（要生成贴图，最慢）→ 环境烘焙 → 几何 → 后处理。
 * 每一步之间让出主线程，加载动画才不会僵住。
 *
 * 关于性能：这套东西要跑在核显上，所以渲染管线做了分级 + 自动降档。
 * 详细的开销实测见 core/postfx.js 顶部的注释。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { SPEC } from './spec.js';
import { buildStudioEnv } from './core/hdri.js';
import { createMaterials } from './core/materials.js';
import { createPostFX, TIERS } from './core/postfx.js';
import { buildFloor } from './core/floor.js';
import { buildContactShadow } from './core/contactShadow.js';
import { rimShape, shapeToOutline } from './core/outline.js';

import { createAudioEngine } from './audio/engine.js';
import { createSampler } from './audio/sampler.js';
import { createSource } from './audio/source.js';
import { createInteraction } from './interaction.js';
import { createWaterfall } from './viz/waterfall.js';
import { createRecorder } from './record/recorder.js';
import { createVideoExporter } from './record/video.js';

import { buildBody } from './parts/body.js';
import { buildKeyboard } from './parts/keyboard.js';
import { buildLid, buildMusicDesk, buildFallboard } from './parts/lid.js';
import { buildBase } from './parts/base.js';
import { buildInterior } from './parts/strings.js';

const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

/* ══ 视角预设 ═══════════════════════════════════════════════ */
const VIEWS = {
  hero: { pos: [-2.66, 1.31, 1.64], target: [0.02, 0.83, -0.84], name: '全景' },
  keyboard: { pos: [0.18, 1.30, 0.62], target: [0.04, 0.72, -0.07], name: '键盘' },
  interior: { pos: [-1.22, 2.42, -0.62], target: [0.12, 0.80, -0.94], name: '琴腹' },
  bend: { pos: [2.45, 1.06, -2.62], target: [0.05, 0.78, -1.00], name: '尾部' },
  top: { pos: [0.40, 4.25, -0.55], target: [0.02, 0.74, -0.85], name: '俯视' },
  tail: { pos: [-1.56, 0.44, -2.92], target: [0.05, 0.86, -1.16], name: '低角' },
};

/* ══ 画质档位 ═══════════════════════════════════════════════
   每档给出后处理配置 + 地板反射规格 + 阴影贴图尺寸。
   数值是照着实测开销定的（见 postfx.js 里的表）。 */
const TIER_SPEC = {
  high: { pixelRatio: 1.5, mirror: [1024, 640], mirrorEvery: 1 },
  medium: { pixelRatio: 1.15, mirror: [512, 320], mirrorEvery: 2 },
  low: { pixelRatio: 0.85, mirror: [256, 160], mirrorEvery: 3 },
};

const el = (id) => document.getElementById(id);
const setStatus = (text, pct) => {
  const t = el('loadText');
  const b = el('loadBar');
  if (t) t.textContent = text;
  if (b) b.style.width = `${Math.round(pct)}%`;
};

let renderer, scene, camera, controls, postfx, lidRig, floorRig, keyLight;
let keyboardRig, fallboardRig, baseRig, audio, interaction;
let wf = null;                   // 瀑布流录制视图
let recorder = null;             // 演奏录制（事件流 + 琴声）
let exporter = null;             // 瀑布流视频导出（画面 + 原声）
let exportTo3D = false;          // 导出前若在 3D 视图，导出完自动切回去
let avOffset = 300;              // 导出视频时画面相对琴声延后多少毫秒（补偿监听设备延迟）
let wfMode = false;
let engineRef = null;            // 内置合成器（采样引擎挂在它上面）
let sampler = null;              // 采样音源引擎（本地装了音源库才有）
let sampleLibs = [];             // samples/index.json 里列出的可用音源库
let currentTier = 'medium';
const clock = new THREE.Clock();
let camTween = null;
let pendingShot = false;

/* ══ 帧率自适应 ═════════════════════════════════════════════
   核显的余量很窄，靠人眼挑档位不现实：同一个人在不同浏览器、不同窗口大小下
   表现能差一倍。所以启动后持续量帧时间，越界就自动升降档。
   加计数器限制是为了防振荡——刚降档又立刻升回去会来回跳。 */
const perf = {
  samples: [],
  sinceCheck: 0,
  changes: 0,
  lastMedian: 0,
};

function tierOf(name) { return TIERS[name] ?? TIERS.medium; }

function applyTier(name) {
  const spec = TIER_SPEC[name];
  const cfg = tierOf(name);
  if (!spec) return;
  currentTier = name;
  postfx?.setTier(name);
  floorRig?.userData.setMirrorEvery(spec.mirrorEvery);
  floorRig?.userData.setMirrorSize(spec.mirror[0], spec.mirror[1]);
  if (keyLight) {
    const want = cfg.shadow;
    if (keyLight.shadow.mapSize.x !== want) {
      keyLight.shadow.mapSize.set(want, want);
      keyLight.shadow.map?.dispose();
      keyLight.shadow.map = null;      // three 会按新尺寸重建
    }
  }
  const badge = el('tierBadge');
  if (badge) badge.textContent = { high: '高', medium: '中', low: '低' }[name] ?? name;
  const pick = el('tierPick');
  if (pick && pick.value !== name) pick.value = name;
  onResize();                      // 分辨率倍率变了要重新分配缓冲
}

/* ══ 弹奏时自动降档 ═════════════════════════════════════════
   弹奏要跟手，而音频合成本身也在抢 CPU（一个音最多 30 个振荡器），
   所以按下第一个键就切到低档保帧率，停下来一会儿再升回去。
   延迟 1.4 秒恢复是为了避免断奏时档位来回跳、画面一闪一闪。 */
let playMode = false;
let tierBeforePlay = null;
let restoreTimer = null;

function handlePlayState(playing) {
  const tone = el('playState');
  if (tone) {
    tone.textContent = playing ? '演奏中' : '已停止';
    tone.classList.toggle('on', playing);
  }
  if (playing) {
    if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }
    if (playMode) return;
    playMode = true;
    tierBeforePlay = currentTier;
    if (currentTier !== 'low') applyTier('low');
  } else {
    if (!playMode) return;
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      restoreTimer = null;
      playMode = false;
      if (tierBeforePlay && tierBeforePlay !== currentTier && perf.changes < 99) {
        applyTier(tierBeforePlay);
      }
    }, 1400);
  }
}

function feedPerf(dtMs, now) {
  perf.samples.push(dtMs);
  if (perf.samples.length > 90) perf.samples.shift();
  if (now - perf.sinceCheck < 1800 || perf.samples.length < 45) return;
  perf.sinceCheck = now;

  const s = [...perf.samples].sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)];
  perf.lastMedian = median;

  const fpsEl = el('fpsBadge');
  if (fpsEl) fpsEl.textContent = String(Math.round(1000 / median));

  // 阈值按"弹奏要跟手"来定：50fps 是下限，低于它就降档。
  // 定太松（试过 26ms≈38fps）会停在 40fps 上下不动，按键反馈明显发黏。
  if (perf.changes >= 4 || playMode) return;
  if (median > 20 && currentTier !== 'low') {
    applyTier(currentTier === 'high' ? 'medium' : 'low');
    perf.changes++;
    perf.samples.length = 0;
  } else if (median < 9 && currentTier !== 'high') {  // 有富余，升档
    applyTier(currentTier === 'low' ? 'medium' : 'high');
    perf.changes++;
    perf.samples.length = 0;
  }
}

async function boot() {
  try {
    setStatus('初始化渲染器…', 6);
    await yieldFrame();

    const canvas = el('view');
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // 抗锯齿交给 composer 的 MSAA 渲染目标
      powerPreference: 'high-performance',
      stencil: false,
    });
    // 核显的瓶颈是像素填充率，渲染分辨率是最有效的那根旋钮：
    // 高分屏上 DPR 2× 就是四倍像素。具体倍率跟着画质档位走（见 TIER_SPEC）。
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, TIER_SPEC.medium.pixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.84;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    scene.backgroundBlurriness = 0.7;
    scene.backgroundIntensity = 0.13;

    camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.05, 120);
    camera.position.fromArray(VIEWS.hero.pos);

    controls = new OrbitControls(camera, canvas);
    controls.target.fromArray(VIEWS.hero.target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.055;
    controls.rotateSpeed = 0.62;
    controls.zoomSpeed = 0.8;
    controls.minDistance = 0.55;
    controls.maxDistance = 9;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minPolarAngle = 0.12;
    controls.update();

    setStatus('生成程序化贴图…', 18);
    await yieldFrame();
    const M = createMaterials(renderer);

    setStatus('烘焙摄影棚环境光…', 40);
    await yieldFrame();
    const env = buildStudioEnv(renderer, { sigma: 0.018, boost: 0.80 });
    scene.environment = env;
    scene.background = env;

    setupLights();

    setStatus('铺设地板…', 52);
    await yieldFrame();
    floorRig = buildFloor(renderer, M, {
      mirrorWidth: TIER_SPEC.medium.mirror[0],
      mirrorHeight: TIER_SPEC.medium.mirror[1],
      mirrorEvery: TIER_SPEC.medium.mirrorEvery,
    });
    scene.add(floorRig);
    // 接触阴影：GTAO 的廉价替身，见 contactShadow.js
    scene.add(buildContactShadow(shapeToOutline(rimShape(), 96)));

    setStatus('放样琴身侧板…', 62);
    await yieldFrame();
    scene.add(buildBody(M));

    setStatus('排布 88 个琴键…', 72);
    await yieldFrame();
    keyboardRig = buildKeyboard(M);
    scene.add(keyboardRig.group);

    setStatus('铺设琴弦与铸铁板…', 80);
    await yieldFrame();
    scene.add(buildInterior(M));

    setStatus('安装琴盖与踏板…', 88);
    await yieldFrame();
    lidRig = buildLid(M);
    scene.add(lidRig.group);
    fallboardRig = buildFallboard(M);
    scene.add(fallboardRig.group);
    scene.add(buildMusicDesk(M));
    baseRig = buildBase(M);
    scene.add(baseRig.group);

    setStatus('编译后处理链…', 95);
    await yieldFrame();
    postfx = createPostFX(renderer, scene, camera, { tier: 'medium' });
    applyTier('medium');

    /* ── 音源 ──────────────────────────────────────────────
       内置合成器永远可用；本地若装了采样音源库（samples/index.json），
       再叠一层采样引擎，两个音源共用同一套主输出链（压缩/混响/音量）。 */
    const engine = createAudioEngine();
    engine.ensureContext();          // 挂起状态也要先建好，采样才能提前预载
    sampleLibs = await probeSampleLibs();
    if (sampleLibs.length && engine.ctx) {
      try {
        sampler = createSampler(engine);
      } catch (e) {
        console.warn('[piano] 采样音源初始化失败，仅用合成器:', e.message);
      }
    }
    audio = createSource(engine, sampler);
    engineRef = engine;

    interaction = createInteraction({
      renderer, camera, controls,
      keyboard: keyboardRig,
      audio,
      onPlayStateChange: handlePlayState,
      onSustainChange: handleSustain,
      onMidiChange: handleMidiState,
      onNoteOn: (m, vel) => {
        if (!exporter?.drivesVisual) wf?.noteOn(m, vel);   // 导出中由导出器按偏移驱动
        recorder?.recordEvent('on', m, vel);
      },
      onNoteOff: (m) => {
        if (!exporter?.drivesVisual) wf?.noteOff(m);
        recorder?.recordEvent('off', m);
      },
    });

    wf = createWaterfall({
      canvas: el('wf'),
      speed: Number(localStorage.getItem('piano.wfSpeed')) || 160,
      onUserNote: (m) => interaction.playNote(m, 0.78),
      onUserNoteOff: (m) => interaction.silenceNote(m),
    });

    recorder = createRecorder({
      engine: engineRef,
      feed: {
        resume: () => audio.resume(),
        noteOn: (m, v) => interaction.playNote(m, v),
        noteOff: (m) => interaction.silenceNote(m),
        setSustain: (on) => interaction.setSustain(on),
        allOff: () => { interaction.setSustain(false); interaction.releaseAll(); },
      },
      onState: handleRecState,
    });

    exporter = createVideoExporter({
      engine: engineRef,
      train: recorder,
      visual: wf,                       // 导出时画面按偏移由导出器驱动
      canvas: el('wf'),
      isIdle: () => !wf?.busy,          // 光条全飞出画面后收尾
      getOffset: () => avOffset,
      onState: handleExpState,
    });

    bindUI();
    window.addEventListener('resize', onResize);
    onResize();

    setStatus('就绪', 100);
    await yieldFrame();
    el('loading')?.classList.add('done');

    animate();
  } catch (err) {
    console.error(err);
    setStatus(`初始化失败：${err.message}`, 100);
    el('loading')?.classList.add('error');
  }
}

function setupLights() {
  // 主光：位置和强度都是拿捏过的。
  //
  // 位置必须在相机这一侧（左前），否则琴朝向镜头的那面会背光发黑；
  // 但这样一来影子就朝右后方拖、被琴身自己挡住大半，所以还得把灯**架高**
  // （俯角约 45°），让影子短到贴着琴脚，从镜头的俯视角度才看得见。
  //
  // 强度给到 6 是被 IBL 逼的：Three.js 的环境贴图不做遮挡，会从整个半球
  // 均匀补光，方向光的影子很容易被填平。环境那侧配合压到 0.80，
  // 漆面的反射由 envMapIntensity 单独补回来。
  const key = new THREE.DirectionalLight(0xfff4e6, 6.0);
  key.position.set(-2.8, 4.6, 1.9);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.9;
  key.shadow.camera.far = 14;
  key.shadow.camera.left = -1.9;
  key.shadow.camera.right = 1.9;
  key.shadow.camera.top = 1.9;
  key.shadow.camera.bottom = -1.9;
  // 改完正交相机的范围必须手动更新投影矩阵，否则用的还是默认的 ±5——
  // 这一步漏过，阴影会一直糊着。
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.006;
  key.target.position.set(0, 0.7, -0.8);
  scene.add(key, key.target);
  keyLight = key;

  const fill = new THREE.DirectionalLight(0xdbe6ff, 0.42);
  fill.position.set(3.3, 1.5, -0.4);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffe4c2, 0.80);
  rim.position.set(0.7, 1.5, -3.6);
  scene.add(rim);
}

/* ══ 相机动画 ═══════════════════════════════════════════════ */
function flyTo(view, ms = 900) {
  camTween = {
    t: 0,
    ms,
    fromPos: camera.position.clone(),
    fromTgt: controls.target.clone(),
    toPos: new THREE.Vector3().fromArray(view.pos),
    toTgt: new THREE.Vector3().fromArray(view.target),
  };
}

function updateTween(dt) {
  if (!camTween) return;
  camTween.t = Math.min(1, camTween.t + (dt * 1000) / camTween.ms);
  const e = camTween.t < 0.5
    ? 4 * camTween.t ** 3
    : 1 - ((-2 * camTween.t + 2) ** 3) / 2;
  camera.position.lerpVectors(camTween.fromPos, camTween.toPos, e);
  controls.target.lerpVectors(camTween.fromTgt, camTween.toTgt, e);
  if (camTween.t >= 1) camTween = null;
}

/* ══ 音源（本地采样音源库）═══════════════════════════════════
   采样库是本地资源，不进线上包。HTTP 下探测可用音源；file:// 构建版直接
   使用内置合成器，避免浏览器拦截清单请求。 */
async function probeSampleLibs() {
  // A file:// build remains fully usable with the built-in synthesizer. Fetching
  // the sample index from file:// is blocked by browsers and only adds noise.
  if (location.protocol === 'file:') return [];
  try {
    const r = await fetch('./samples/index.json', { cache: 'no-cache' });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.libraries) ? j.libraries : [];
  } catch (e) {
    return [];      // file:// 下会被 CORS 拦掉，属预期
  }
}

/** 切换音源：'synth' 或某个采样库 id */
async function useSource(id) {
  const stat = el('srcStat');
  if (id === 'synth' || !sampler) {
    audio?.setMode('synth');
    if (stat) stat.textContent = '内置合成音源（加法合成）';
    localStorage.setItem('piano.source', 'synth');
    return;
  }
  const lib = sampleLibs.find((l) => l.id === id);
  if (!lib) return;
  if (stat) stat.textContent = `正在读取 ${lib.name} 的清单…`;
  try {
    await sampler.load(`./samples/${lib.manifest}`);
    audio?.setMode('sample');
    localStorage.setItem('piano.source', id);
    if (!samplerOff) {
      samplerOff = sampler.onProgress((s) => {
        const tag = el('srcStat');
        if (!tag) return;
        tag.textContent = `${s.name} · 驻留 ${s.ready} 层` +
          ` · 缓存 ${(s.bytes / 1048576).toFixed(0)} MB` +
          (s.pending ? ` · 待载 ${s.pending}` : '') +
          (s.failed ? ` · 失败 ${s.failed}` : '');
      });
    }
    document.getElementById('srcCredit')?.replaceChildren(
      document.createTextNode(lib.credit ?? ''),
    );
  } catch (e) {
    console.warn('[piano] 采样清单读取失败:', e.message);
    if (stat) stat.textContent = `采样音源不可用（${e.message}），已用内置合成音源`;
    audio?.setMode('synth');
  }
}
let samplerOff = null;

/* ══ 延音 & MIDI ═════════════════════════════════════════════
   延音的唯一真相在 interaction 里，这里只负责把变化摊到三处：
   合成器收声逻辑、右踏板动画、面板上的延音按钮。 */
function handleSustain(on) {
  audio?.setSustain(on);
  baseRig?.pedalRig.set(on);
  if (!exporter?.drivesVisual) wf?.setSustain(on);   // 导出中由导出器按偏移驱动
  recorder?.recordEvent('cc64', 64, on ? 127 : 0);
  const b = el('susBtn');
  if (b) {
    b.classList.toggle('on', on);
    b.textContent = on ? '延音 · 开（空格）' : '延音 · 关（空格）';
  }
}

function handleMidiState(name) {
  const tag = el('midiState');
  if (tag) {
    tag.textContent = name || '未接入';
    tag.style.color = name ? 'var(--accent)' : '';
  }
}

/* ══ 瀑布流录制视图 ═════════════════════════════════════════
   打开后 3D 渲染整个停掉（音频链路不受影响），全屏 2D 画布接管。 */
function setWfMode(on) {
  if (!on) exporter?.cancel();     // 导出途中切走会让画面空掉，先收尾
  wfMode = on;
  wf?.setActive(on);
  el('view').style.display = on ? 'none' : 'block';
  document.body.classList.toggle('wf-mode', on);
  const hud = el('hud');
  if (hud) hud.style.display = on ? 'none' : '';
  const btn = el('wfBtn');
  if (btn) {
    btn.textContent = on ? '返回 3D 视图' : '打开录制视图';
    btn.classList.toggle('rec', on);
  }
  if (!on) {
    wf?.releaseAll();
    recorder?.stopPlay();
  }
}

function handleRecState(s) {
  const busy = !!exporter?.busy;          // 导出是实时重放，期间别让它被动打断
  const rec = el('recBtn');
  if (rec) {
    rec.textContent = s.recording ? '■ 停止录制' : '● 开始录制';
    rec.classList.toggle('rec', s.recording);
    rec.disabled = s.playing || busy;
  }
  const play = el('playBtn');
  if (play) {
    play.textContent = s.playing ? '■ 停止回放' : '▶ 回放';
    play.disabled = !s.hasTake || s.recording || busy;
    play.classList.toggle('rec', s.playing);
  }
  const dlM = el('dlMid');
  if (dlM) dlM.disabled = !s.hasTake || busy;
  const dlA = el('dlAudio');
  if (dlA) {
    dlA.disabled = !s.audioBlob || busy;
    dlA.textContent = s.audioOK ? '下载琴声 .webm' : '此浏览器不支持琴声录制';
  }
  const st = el('recStat');
  if (st && !busy) st.textContent = s.statText;
  if (exporter) handleExpState(exporter.state);
}

/* 导出视频按钮：空闲时可点、导出中变取消、封装中禁用 */
let expWasBusy = false;
function handleExpState(s) {
  const btn = el('dlVideo');
  if (btn) {
    if (!s.videoOK) btn.textContent = '此浏览器不支持视频导出';
    else if (s.finishing) btn.textContent = '正在封装视频…';
    else if (s.exporting) btn.textContent = '■ 取消导出';
    else btn.textContent = `导出瀑布流视频（.${s.ext} · 含原声）`;
    btn.classList.toggle('rec', s.exporting || s.finishing);
    btn.disabled = s.finishing
      || (!s.exporting && (!recorder?.hasTake || recorder?.recording));
  }
  const off = el('avOff');
  if (off) off.disabled = s.busy;      // 导出途中改对齐值会让前后半段对不上
  const st = el('recStat');
  if (st && s.busy) st.textContent = s.statText;     // 导出进度盖住录制状态
  // 收尾后回到导出前的视图（从 3D 进来的就切回 3D）
  if (!s.busy && expWasBusy && exportTo3D) {
    exportTo3D = false;
    setWfMode(false);
  }
  expWasBusy = s.busy;
}

/* ══ UI ═════════════════════════════════════════════════════ */
function bindUI() {
  const nav = el('views');
  if (nav) {
    Object.entries(VIEWS).forEach(([key, v]) => {
      const b = document.createElement('button');
      b.textContent = v.name;
      b.dataset.view = key;
      b.className = key === 'hero' ? 'on' : '';
      b.addEventListener('click', () => {
        flyTo(v);
        nav.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      });
      nav.appendChild(b);
    });
  }

  const lid = el('lid');
  lid?.addEventListener('input', () => {
    const deg = Number(lid.value);
    lidRig?.setLidAngle(deg);
    el('lidVal').textContent = `${deg}°`;
  });
  if (lid) {
    lid.value = String(SPEC.lidOpenDeg);
    el('lidVal').textContent = `${SPEC.lidOpenDeg}°`;
  }

  const fall = el('fall');
  fall?.addEventListener('input', () => {
    const deg = Number(fall.value);
    fallboardRig?.setAngle(deg);
    el('fallVal').textContent = `${deg}°`;
  });
  if (fall) {
    fall.value = String(SPEC.fallOpenDeg);
    el('fallVal').textContent = `${SPEC.fallOpenDeg}°`;
  }

  // 音源选择：本机装了采样音源库才出现采样选项
  const pick = el('srcPick');
  if (pick) {
    pick.replaceChildren();
    const add = (value, label) => {
      const o = document.createElement('option');
      o.value = value; o.textContent = label;
      pick.appendChild(o);
    };
    add('synth', '内置合成（加法合成）');
    for (const lib of sampleLibs) add(lib.id, `${lib.name}（采样 · ${lib.piano}）`);
    pick.disabled = !sampleLibs.length;
    pick.addEventListener('change', () => { useSource(pick.value); });

    const saved = localStorage.getItem('piano.source');
    const initial = sampleLibs.some((l) => l.id === saved) ? saved : 'synth';
    pick.value = initial;
    if (initial !== 'synth') useSource(initial);
    else el('srcStat').textContent = sampleLibs.length
      ? '内置合成音源（可选本地采样音源）'
      : '内置合成音源 · 采样音源仅本地可用，见 README';
  }

  el('panelToggle')?.addEventListener('click', () => {
    el('panel')?.classList.toggle('collapsed');
  });

  /* 面板头部：锁定 + 收起。锁定后面板钉住，收起按钮失效，
     防止弹奏时误触把面板收走。 */
  let panelLocked = false;
  el('panelClose')?.addEventListener('click', () => {
    if (!panelLocked) el('panel')?.classList.add('collapsed');
  });
  el('lockBtn')?.addEventListener('click', () => {
    panelLocked = !panelLocked;
    const btn = el('lockBtn');
    btn.classList.toggle('locked', panelLocked);
    btn.textContent = panelLocked ? '🔒' : '🔓';
    btn.title = panelLocked ? '已锁定：面板不会被收起' : '锁定面板';
    const close = el('panelClose');
    if (close) close.style.display = panelLocked ? 'none' : '';
  });

  // 延音开关：点了就走 interaction 的统一入口，键盘空格 / MIDI 踏板同源
  el('susBtn')?.addEventListener('click', () => {
    interaction?.setSustain(!interaction.sustainOn);
  });

  el('shot')?.addEventListener('click', () => { pendingShot = true; });

  const vol = el('vol');
  vol?.addEventListener('input', () => {
    const v = Number(vol.value) / 100;
    audio?.setVolume(v);
    el('volVal').textContent = `${vol.value}%`;
  });

  // 手动画质档位：自适应有时会低估（比如用户在别处开着视频），留个手动口
  el('tierPick')?.addEventListener('change', (e) => {
    perf.changes = 99;                  // 手动定档后不再自动改
    applyTier(e.target.value);
  });

  /* ── 瀑布流录制 ──────────────────────────────────────── */
  el('wfBtn')?.addEventListener('click', () => setWfMode(!wfMode));

  const spd = el('wfSpeed');
  if (spd) {
    const saved = Number(localStorage.getItem('piano.wfSpeed'));
    if (saved >= 40 && saved <= 400) spd.value = String(saved);
    el('wfSpeedVal').textContent = spd.value;
    spd.addEventListener('input', () => {
      el('wfSpeedVal').textContent = spd.value;
      localStorage.setItem('piano.wfSpeed', spd.value);
      wf?.setSpeed(Number(spd.value));
    });
  }

  el('recBtn')?.addEventListener('click', () => {
    if (recorder?.recording) recorder.stop();
    else recorder?.start();
  });
  el('playBtn')?.addEventListener('click', () => {
    if (recorder?.playing) recorder.stopPlay();
    else recorder?.play();
  });
  el('dlMid')?.addEventListener('click', () => recorder?.downloadMidi());
  el('dlAudio')?.addEventListener('click', () => recorder?.downloadAudio());

  /* 音画对齐：监听设备（声卡/耳机/蓝牙）让声音晚到，画面就按这个值延后补偿。
     文件内部两条轨本来是对齐的，补偿只影响导出时画面的时间轴。 */
  const offSel = el('avOff');
  const offStat = el('avOffStat');
  const refreshLatency = () => {
    const lat = audio?.ctx?.outputLatency;      // 秒（Chrome 才有这个属性）
    if (offStat) {
      offStat.textContent = Number.isFinite(lat) && lat > 0
        ? `监听设备延迟约 ${Math.round(lat * 1000)} ms（声音晚到多少，画面就延后多少）`
        : '读不到监听设备延迟，按听感调：声音晚到多少，画面就延后多少';
    }
  };
  if (offSel) {
    const raw = localStorage.getItem('piano.avOffset');   // 没存过是 null，Number(null)=0 会吃掉默认值
    const saved = raw === null ? NaN : Number(raw);
    if (Number.isFinite(saved) && saved >= 0 && saved <= 1000) avOffset = saved;
    offSel.value = String(avOffset);
    offSel.addEventListener('change', () => {
      avOffset = Number(offSel.value) || 0;
      localStorage.setItem('piano.avOffset', String(avOffset));
    });
    offSel.addEventListener('pointerdown', refreshLatency);   // 换过耳机再点开就能看到新值
  }
  refreshLatency();

  el('dlVideo')?.addEventListener('click', () => {
    if (exporter?.busy) { exporter.cancel(); return; }
    // 视频抓的是瀑布流那张画布，先把视图切过去清屏，等两帧画出来再开录
    exportTo3D = !wfMode;
    setWfMode(true);
    wf?.releaseAll();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (exporter?.start()) return;
      if (exportTo3D) { exportTo3D = false; setWfMode(false); }
      const st = el('recStat');
      if (st) st.textContent = exporter?.videoOK ? '先录一段再导出' : '此浏览器不支持视频导出';
    }));
  });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (exporter?.busy) { exporter.cancel(); return; }
    if (wfMode) setWfMode(false);
  });
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const spec = TIER_SPEC[currentTier] ?? TIER_SPEC.medium;
  const pr = Math.min(window.devicePixelRatio, spec.pixelRatio);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h);
  postfx?.setSize(w, h, pr);
}

/* ══ 主循环 ═════════════════════════════════════════════════ */
let lastT = performance.now();

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dtMs = now - lastT;
  lastT = now;

  const dt = Math.min(dtMs / 1000, 0.1);

  if (wfMode) {
    wf?.update();                 // 2D 瀑布流接管画面，3D 整条渲染链歇着
  } else {
    updateTween(dt);
    controls.update();
    keyboardRig?.update(dt);        // 按键下沉/回弹
    baseRig?.pedalRig.update(dt);   // 延音踏板踩放
    postfx.composer.render();

    feedPerf(dtMs, now);

    // 截图必须紧挨着 render 同步取，drawing buffer 合成后就被清掉了
    if (pendingShot) {
      pendingShot = false;
      const a = document.createElement('a');
      a.download = `grand-piano-${Date.now()}.png`;
      a.href = renderer.domElement.toDataURL('image/png');
      a.click();
    }
  }

  // 回放调度在两种视图下都要走（3D 里回放时琴键也会重演）
  recorder?.tick();
  exporter?.tick();               // 视频导出：前奏 → 回放 → 尾巴 → 收尾
  if (recorder?.recording) {
    const st = el('recStat');
    if (st) st.textContent = recorder.statText;
  }
}

window.__THREE = THREE;
window.useSource = useSource;      // 调试/测试用：切音源
window.__piano = () => ({
  scene, camera, controls, renderer, postfx, lidRig, fallboardRig, floorRig, keyboardRig, baseRig, audio, engine: engineRef, sampler, interaction, wf, recorder, exporter,
  get sampleLibs() { return sampleLibs; },
  get wfMode() { return wfMode; },
  setWfMode,
  get tier() { return currentTier; },
  setTier: (n) => { perf.changes = 99; applyTier(n); },
  stats: () => ({ tier: currentTier, medianMs: perf.lastMedian, changes: perf.changes }),
});

/** 调试用：把屏幕归一化坐标处的物体打出来 */
window.__pick = (nx, ny) => {
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
  return rc.intersectObjects(scene.children, true).slice(0, 4).map((h) => ({
    name: h.object.name || h.object.parent?.name || '(无名)',
    material: h.object.material?.name || h.object.material?.uuid?.slice(0, 6),
    dist: +h.distance.toFixed(3),
    point: [+h.point.x.toFixed(3), +h.point.y.toFixed(3), +h.point.z.toFixed(3)],
    color: h.object.material?.color?.getHexString?.(),
  }));
};

boot();
