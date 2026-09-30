/**
 * 采样音源引擎：读取 build-samples.mjs 生成的清单，按需 fetch + 解码真实钢琴采样。
 *
 * 设计要点（都是为了"像一台真钢琴"和"弹下去立刻有声"）：
 *
 *  · **懒加载 + LRU**。整套 Salamander 是 30 个根音 × 16 层力度 ≈ 480 个采样，
 *    全解码进内存要 1.5 GB。这里按 (根音, 层) 为单位按需解码，用字节预算做 LRU
 *    淘汰（默认 320 MB），长期只驻留你真正弹到的那些音。
 *
 *  · **没就绪就先出声**。采样是异步解码的，第一次弹某个音必然还没就绪。
 *    这时不静音也不等待，而是把这一音交回调用方用合成器兜底，
 *    同时把该根音的全部力度层排进后台队列——弹第二遍时采样已经就位。
 *    代价只是最先几个音是合成的，换来的是"任何时候弹下去都有声音"。
 *
 *  · **按根音就近移调**。Salamander 每小三度采一个根音，最坏只移 1 个半音
 *    （playbackRate = 2^(Δ/12)），音色与衰减几乎听不出偏差。
 *
 *  · **力度分层**：每层带自己的 hivel，取第一个 hivel ≥ 当前力度者。
 *
 *  · 松键触发 release 采样（琴槌离弦噪声 / 弦共振），踏板有踩放噪声——
 *    这两样是真钢琴"松键也有声音"的来源，纯合成器做不出来。
 *
 * 采样经 HTTP 读取，所以采样模式需要本地服务器（start.command 或 npm start）。
 * 从 file:// 直接打开时 fetch 会被拦掉，调用方会安静地退回合成器。
 */

const DEFAULTS = {
  baseUrl: './samples/',
  // 解码后缓存预算。要能装下"常用力度带"的预热集（30 根音 × 9 层 ≈ 680 MB），
  // 否则最旧的根音会被 LRU 整段淘汰，弹到它时又要退回合成器。
  cacheBytes: 1024 * 1024 * 1024,
  maxVoices: 64,
  concurrency: 6,                    // 并发 fetch/decode 数
  releaseGain: 0.5,                  // 松键采样相对音量
  pedalGain: 0.45,                   // 踏板噪声相对音量
  resonanceGain: 0.6,                // 弦共振采样相对音量（延音踏板下松键时触发）
  masterGain: 1.0,
};

export function createSampler(audio, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const ctx = audio.ctx;
  if (!ctx) throw new Error('createSampler 需要已初始化的音频引擎（先 resume 一次）');

  // 采样总线：接到音频引擎的干/湿通道上，与合成器共用主输出链
  const bus = ctx.createGain();
  bus.gain.value = cfg.masterGain;
  audio.connectSource(bus);

  let manifest = null;
  let tuning = null;

  const buffers = new Map();      // file -> { buf, bytes, at }  解码缓存（LRU，按文件路径）
  const inflight = new Map();     // key -> Promise
  const voices = new Map();       // midi -> { src, gain }
  const sustained = new Set();
  const rrCount = new Map();      // midi -> 回合计数（round-robin 交替采样）
  const queue = [];
  let cacheBytes = 0;
  let sustainOn = false;
  let decoded = 0;
  let failed = 0;
  let disposed = false;
  let active = 0;
  const progressCbs = [];

  /* ── 清单 ─────────────────────────────────────────────── */

  async function load(manifestUrl) {
    const r = await fetch(manifestUrl, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`清单读取失败 ${r.status}`);
    manifest = await r.json();
    tuning = manifest.tune ?? null;
    buffers.clear();
    queue.length = 0;
    cacheBytes = 0;
    decoded = 0;
    failed = 0;
    emit();
    prewarm();
    return manifest;
  }

  /** 某个键的力度层列表：踩着踏板且有 PedalOn 变体时用之（音色里已含共鸣），
   *  否则用默认列表。Salamander 只有 layers；Piano in 162 是 layersOff/layersOn。 */
  function layersFor(key) {
    if (sustainOn && key.layersOn) return key.layersOn;
    return key.layers ?? key.layersOff;
  }

  /** 就近根音。逐音采样的库（Piano in 162）root == midi，零移调；
   *  小三度采样的库（Salamander）最坏移 1 个半音。 */
  function rootFor(midi) {
    const keys = manifest.keys;
    let best = keys[0];
    let bestD = Infinity;
    for (const k of keys) {
      const d = Math.abs(k.midi - midi);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  /** 力度选层：第一个 hivel ≥ 力度的层 */
  function layerFor(layers, vel127) {
    for (let i = 0; i < layers.length; i++) if (vel127 <= layers[i].vel) return i;
    return layers.length - 1;
  }

  // 路径必须逐段转义：采样文件名里的升号（D#1v1.flac）在 URL 里是片段分隔符，
  // 不转义的话请求会变成 ".../D"，14 个带 # 的根音全部 404
  const url = (file) => cfg.baseUrl + (manifest?.base ?? '')
    + file.split('/').map(encodeURIComponent).join('/');

  /* ── 解码与缓存：一律按**文件路径**为键 ───────────────────
     同一个 (音, 层) 在 Piano in 162 里可能对应 2 个踏板状态 × 2 次循环
     共 4 个不同文件，按 (midi, idx) 做缓存键会互相覆盖。路径是唯一的。 */
  function cachedFile(file) {
    const e = buffers.get(file);
    if (e) { e.at = performance.now(); return e.buf; }
    return null;
  }

  function store(file, buf) {
    const bytes = buf.length * buf.numberOfChannels * 4;
    const old = buffers.get(file);
    if (old) { cacheBytes -= old.bytes; buffers.delete(file); }
    buffers.set(file, { buf, bytes, at: performance.now() });
    cacheBytes += bytes;
    decoded++;
    while (cacheBytes > cfg.cacheBytes && buffers.size > 1) {
      let oldest = null;
      let oldestAt = Infinity;
      for (const [kk, v] of buffers) if (v.at < oldestAt) { oldestAt = v.at; oldest = kk; }
      cacheBytes -= buffers.get(oldest).bytes;
      buffers.delete(oldest);
    }
  }

  function decode(ab) {
    // 回调式 API 的兼容性比 Promise 版好（老 Safari 只认回调）
    return new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej));
  }

  /** 取一个采样文件（带缓存与去重）。inflight 也按文件路径去重。 */
  function fetchFile(file) {
    const hit = buffers.get(file);
    if (hit) { hit.at = performance.now(); return Promise.resolve(hit.buf); }
    if (inflight.has(file)) return inflight.get(file);
    const p = fetch(url(file))
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${file}`);
        return r.arrayBuffer();
      })
      .then(decode)
      .then((buf) => {
        inflight.delete(file);
        if (!disposed) { store(file, buf); emit(); }
        return buf;
      })
      .catch((e) => {
        inflight.delete(file);
        failed++;
        if (failed <= 3) console.warn('[sampler] 采样不可用，该音改用合成器:', e.message);
        emit();
        return null;
      });
    inflight.set(file, p);
    return p;
  }

  /** 取一个零散采样（release / pedal）：同样走文件缓存 */
  function fetchOne(file) { return fetchFile(file); }

  /** 后台队列：限制并发，避免一次开几百个 fetch 把连接池打死 */
  function pump() {
    while (active < cfg.concurrency && queue.length) {
      const file = queue.shift();
      active++;
      fetchFile(file).finally(() => { active--; pump(); });
    }
  }

  function enqueue(file, front = false) {
    if (buffers.has(file) || inflight.has(file)) return;
    if (queue.includes(file)) return;
    (front ? queue.unshift(file) : queue.push(file));
    pump();
  }

  /** 一个层的采样文件数组：rr: [f1, f2]（round-robin）或 file: 单文件 */
  const filesOf = (layer) => layer.rr ?? [layer.file];

  /** 预热：铺满"常用力度带"——人耳最常听到的就是中弱到中强这一段。
   *  带宽要能整段装进缓存预算（见 cacheBytes 注释），否则最旧的根音会被
   *  反复淘汰／重解码，第一次弹它还得分给合成器。
   *  round-robin 只预热第一份，第二份等真弹到再取（顶替机制会先用第一份）。 */
  function prewarm() {
    const probe = manifest.keys[0];
    const n0 = (probe.layers ?? probe.layersOff).length;
    const lo = Math.max(0, Math.round(n0 * 0.3));
    const hi = Math.min(n0 - 1, Math.round(n0 * 0.7));
    for (const k of manifest.keys) {
      const ls = k.layers ?? k.layersOff;
      for (let i = lo; i <= Math.min(hi, ls.length - 1); i++) {
        enqueue(filesOf(ls[i])[0]);
      }
    }
  }

  /* ── 发声 ─────────────────────────────────────────────── */
  function startBuffer(buf, { gain, rate, when }) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(bus);
    src.start(when);
    return { src, gain: g };
  }

  function stopVoice(midi, tc) {
    const v = voices.get(midi);
    if (!v) return;
    const t = ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(Math.max(v.gain.gain.value, 0.0001), t);
    v.gain.gain.setTargetAtTime(0, t, tc);
    try { v.src.stop(t + tc * 8 + 0.05); } catch (e) { /* 已停 */ }
    voices.delete(midi);
  }

  /** 松键噪声 / 弦共振：真钢琴松键也有声音。
      未挂音源库（manifest 为空）时静默返回——合成模式下这些采样本就不存在，
      但调用方（踏板链路）不能因此断掉。 */
  function releaseNoise(midi, vel) {
    if (!manifest?.release?.length) return;
    let best = null;
    let bestD = Infinity;
    for (const r of manifest.release) {
      const d = Math.abs(r.midi - midi);
      if (d < bestD) { bestD = d; best = r; }
    }
    if (!best) return;
    const fire = (buf) => {
      const t = ctx.currentTime;
      const g = cfg.releaseGain * (0.35 + 0.65 * vel) * Math.pow(10, (best.gain ?? 0) / 20);
      const v = startBuffer(buf, { gain: 0, rate: Math.pow(2, (midi - best.midi) / 12), when: t });
      v.gain.gain.setValueAtTime(0, t);
      v.gain.gain.linearRampToValueAtTime(g, t + 0.002);
      v.gain.gain.setTargetAtTime(0, t + 0.01, 0.12);
      try { v.src.stop(t + 1.8); } catch (e) { /* 忽略 */ }
    };
    const buf = cachedFile(best.file);
    if (buf) fire(buf); else fetchOne(best.file).then((b) => b && fire(b));
  }

  /**
   * 弦共振：延音踏板踩着时松键，未被制音的弦会继续 sympathetic 共振。
   * Accurate-Salamander 把这段录成了 harmL 采样族（每小三度一个根音）。
   * 采样自然衰减，不做硬停止——踏板抬起后共鸣本来也会拖一点尾巴。
   */
  function resonanceNoise(midi, vel) {
    if (!manifest?.resonance?.length) return;
    let best = null;
    let bestD = Infinity;
    for (const r of manifest.resonance) {
      const d = Math.abs(r.midi - midi);
      if (d < bestD) { bestD = d; best = r; }
    }
    if (!best) return;
    const fire = (buf) => {
      const t = ctx.currentTime;
      const g = cfg.resonanceGain * (0.35 + 0.65 * vel) * Math.pow(10, (best.gain ?? 0) / 20);
      const v = startBuffer(buf, { gain: 0, rate: Math.pow(2, (midi - best.midi) / 12), when: t });
      v.gain.gain.setValueAtTime(0, t);
      v.gain.gain.linearRampToValueAtTime(g, t + 0.01);
      v.gain.gain.setTargetAtTime(0, t + 0.3, 1.4);   // 长尾巴：共鸣是慢慢散掉的
      try { v.src.stop(t + 12); } catch (e) { /* 忽略 */ }
    };
    const buf = cachedFile(best.file);
    if (buf) fire(buf); else fetchOne(best.file).then((b) => b && fire(b));
  }

  function pedalNoise(kind) {
    const files = manifest?.pedal?.[kind];
    if (!files?.length) return;
    const f = files[Math.floor(Math.random() * files.length)];
    const fire = (buf) => {
      const t = ctx.currentTime;
      const v = startBuffer(buf, { gain: 0, rate: 1, when: t });
      v.gain.gain.setValueAtTime(0, t);
      v.gain.gain.linearRampToValueAtTime(cfg.pedalGain * Math.pow(10, (f.gain ?? 0) / 20), t + 0.004);
      v.gain.gain.setTargetAtTime(0, t + 0.02, 0.15);
      try { v.src.stop(t + 2); } catch (e) { /* 忽略 */ }
    };
    const buf = cachedFile(f.file);
    if (buf) fire(buf); else fetchOne(f.file).then((b) => b && fire(b));
  }

  /**
   * @returns 'sample' = 用了真采样；'synth' = 这个音还没就绪，请调用方用合成器兜底
   */
  function noteOn(midi, vel = 0.78, when) {
    if (!manifest) return 'synth';
    const t0 = when ?? ctx.currentTime;
    const key = rootFor(midi);
    const ls = layersFor(key);
    if (!ls?.length) return 'synth';
    const vi = Math.min(127, Math.max(1, Math.round(vel * 127)));
    const idx = layerFor(ls, vi);

    // round-robin：同一键同一力度在两份录音之间交替（Piano in 162 是真双 take）
    const rrN = (rrCount.get(midi) ?? 0) + 1;
    rrCount.set(midi, rrN);

    let layer = ls[idx];
    const files = filesOf(layer);
    let file = files[(rrN - 1) % files.length];
    let buf = cachedFile(file);
    let gainTrim = 0;

    if (!buf) {
      // 目标文件还没解码好：在本根音**已缓存的采样**里就近找一份顶替
      // （同层另一份 RR、相邻力度层都行）——音高音色都是真钢琴，
      // 只是力度略有出入，比合成器像得多。目标文件排到队首、邻居随后。
      enqueue(file, true);
      for (const d of [-1, 1, -2, 2]) {
        const j = idx + d;
        if (j >= 0 && j < ls.length) for (const f of filesOf(ls[j])) enqueue(f);
      }
      // 力度层粗的库（5 层）顶替时音量补偿要更大
      const dbPerStep = ls.length <= 8 ? 4 : 1.6;
      let bestD = Infinity;
      for (let j = 0; j < ls.length; j++) {
        for (const f of filesOf(ls[j])) {
          if (!buffers.has(f)) continue;
          const d = Math.abs(j - idx);
          if (d < bestD) { bestD = d; file = f; gainTrim = (j - idx) * dbPerStep; }
        }
      }
      if (!isFinite(bestD)) return 'synth';   // 这个根音一个采样都还没有，交给合成器
      buf = cachedFile(file);
    }

    if (voices.has(midi)) stopVoice(midi, 0.02);

    const cents = (layer.tune ?? 0) + (tuning?.[midi] ?? 0);
    const rate = Math.pow(2, (midi - key.midi) / 12) * Math.pow(2, cents / 1200);
    const g = (0.22 + 0.78 * Math.pow(vel, 1.25))
      * Math.pow(10, (layer.gain ?? 0) / 20) * Math.pow(10, -gainTrim / 20);

    if (voices.size >= cfg.maxVoices) stopVoice(voices.keys().next().value, 0.05);

    const v = startBuffer(buf, { gain: 0, rate, when: t0 });
    v.gain.gain.setValueAtTime(0, t0);
    v.gain.gain.linearRampToValueAtTime(g, t0 + 0.004);
    voices.set(midi, v);
    return 'sample';
  }

  function noteOff(midi, vel = 0.6) {
    if (!voices.has(midi)) return;
    if (sustainOn) {
      // 踏板踩着松键：制音器不落，但弦的共鸣层要进来（Accurate 的 harmL 族）
      sustained.add(midi);
      resonanceNoise(midi, vel);
      return;
    }
    stopVoice(midi, 0.18);      // 制音器落下有个过程，不是瞬间静音
    releaseNoise(midi, vel);
  }

  function setSustain(on) {
    if (sustainOn === on) return;
    sustainOn = on;
    if (on) {
      pedalNoise('down');
    } else {
      pedalNoise('up');
      for (const midi of Array.from(sustained)) {
        stopVoice(midi, 0.18);
        releaseNoise(midi, 0.5);
      }
      sustained.clear();
    }
  }

  function allOff() {
    for (const midi of Array.from(voices.keys())) stopVoice(midi, 0.05);
    sustained.clear();
  }

  function stats() {
    return {
      name: manifest?.name ?? null,
      credit: manifest?.credit ?? null,
      ready: buffers.size,          // 当前驻留内存的力度层数
      decoded,                      // 累计解码次数（含被 LRU 淘汰后重解码的）
      pending: inflight.size + queue.length,
      bytes: cacheBytes,
      failed,
      loading: inflight.size > 0 || queue.length > 0,
    };
  }

  function emit() {
    const s = stats();
    for (const cb of progressCbs) cb(s);
  }

  return {
    load,
    noteOn,
    noteOff,
    setSustain,
    allOff,
    stats,
    onProgress: (cb) => {
      progressCbs.push(cb);
      return () => { const i = progressCbs.indexOf(cb); if (i >= 0) progressCbs.splice(i, 1); };
    },
    get ready() { return !!manifest; },
    get manifest() { return manifest; },
    dispose() {
      disposed = true;
      allOff();
      buffers.clear();
      queue.length = 0;
      manifest = null;
    },
  };
}
