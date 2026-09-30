/**
 * 音源：Web Audio 实时加法合成，不用任何采样。
 *
 * 移植自隔壁 grand-piano 项目的发声引擎。核心是让音色"像钢琴"的几件事：
 *
 *   · 每个音按基频展开成 4–30 个正弦泛音（低音泛音多、高音少）；
 *   · 泛音频率带**弦刚性引起的非谐性**修正 f·n·√(1+Bn²)，低音 B 更大——
 *     真钢琴的泛音不是严格整数倍，缺了这一项听上去就是电子琴；
 *   · **每个泛音有独立的指数衰减率**，高次泛音衰减更快，这是"像不像"的关键；
 *   · 起振叠一段带通滤过的短噪声，模拟琴槌击弦的瞬态；
 *   · 立体声按音高铺开（低音偏左、高音偏右），接程序生成的脉冲响应混响。
 *
 * 延音踏板：踩下时 noteOff 只是把音挂进 sustained 集合，松开才真正收声。
 */

export function createAudioEngine({ volume = 0.70, maxVoices = 40 } = {}) {
  // 输出链末尾有压缩器兜底，前面可以把增益给足。0.70 的默认音量原来只有
  // vpeak 0.28 × vol 的净增益，系统音量拉满也嫌小声——整体提升约 2 档。
  const MAKEUP = 2.1;
  let ctx = null;
  let master = null;
  let dryGain = null;
  let wetGain = null;
  let compNode = null;           // 输出链末端的压缩器，录音抽头并接在它上面
  let tapDest = null;
  let ready = false;

  const voices = new Map();      // midi -> { out, panner, oscs, stopAt }
  const sustained = new Set();   // 踏板保持中的音
  let sustainOn = false;
  let vol = volume;

  /** 程序生成的混响脉冲响应：两级低通噪声 + 指数衰减包络 */
  function makeImpulse(seconds, decay, damp) {
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      let lp2 = 0;
      for (let i = 0; i < len; i++) {
        const n = Math.random() * 2 - 1;
        lp = lp * (1 - damp) + n * damp;
        lp2 = lp2 * (1 - damp * 0.6) + lp * damp * 0.6;
        const env = Math.pow(1 - i / len, decay);
        d[i] = lp2 * env * 3.2;
      }
    }
    return buf;
  }

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    // latencyHint: interactive 让浏览器选低延迟输出缓冲，弹奏更跟手
    ctx = new AC({ latencyHint: 'interactive' });

    master = ctx.createGain();
    master.gain.value = vol * MAKEUP;

    const comp = ctx.createDynamicsCompressor();
    compNode = comp;
    // 阈值抬高一点、压比加大：前面增益给足之后它兼任限制器，防止和弦削波
    comp.threshold.value = -11;
    comp.knee.value = 22;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;

    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 5200;
    shelf.gain.value = -2.5;

    master.connect(shelf);
    shelf.connect(comp);
    comp.connect(ctx.destination);

    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(2.4, 2.9, 0.34);
    wetGain = ctx.createGain();
    wetGain.gain.value = 0.20;
    dryGain = ctx.createGain();
    dryGain.gain.value = 0.86;
    wetGain.connect(conv);
    conv.connect(master);
    dryGain.connect(master);

    ready = true;
  }

  /** 浏览器要求用户手势之后才能出声，第一次按键时调这个 */
  function resume() {
    init();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  /** 提前建好 AudioContext（挂起状态即可）：采样音源要在用户手势之前就预载 */
  function ensureContext() {
    init();
    return ctx;
  }

  /** 把外部音源（采样器）接进同一条主输出链：压缩器、混响、音量全都共用 */
  function connectSource(node) {
    init();
    node.connect(dryGain);
    node.connect(wetGain);
  }

  /** 录音抽头：在压缩器输出上并接一路，录到的就是应用内的完整琴声
      （含采样音源、混响、音量），纯内部连线，不经过任何系统采集设备 */
  function createTapStream() {
    init();
    if (!ready) return null;
    if (!tapDest) {
      tapDest = ctx.createMediaStreamDestination();
      compNode.connect(tapDest);
    }
    return tapDest.stream;
  }

  function noteOn(midi, vel = 0.8, when) {
    if (!ready) return null;
    const t0 = when !== undefined ? when : ctx.currentTime;
    const velv = Math.max(0.05, Math.min(1, vel));

    // 复音数上限：超了就掐掉最早的那个
    if (voices.size >= maxVoices) {
      const oldest = voices.keys().next().value;
      forceRelease(oldest, 0.05);
    }

    const f0 = 440 * Math.pow(2, (midi - 69) / 12);
    const isLow = midi < 48;

    const tauBase = 4.2 * Math.pow(0.5, (midi - 21) / 36);          // 低音余音长
    const N = Math.round(Math.max(4, Math.min(30, 30 - (midi - 21) * 0.215)));
    const brightK = Math.max(0, (midi - 57) / 51) * 0.40;           // 高音抑制高频泛音
    const B = 0.00012 + Math.max(0, (72 - midi) / 72) * 0.00055;    // 弦刚性

    const out = ctx.createGain();
    out.gain.value = 0;

    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-0.55, Math.min(0.55, (midi - 60) / 90));
    out.connect(panner);
    panner.connect(dryGain);
    panner.connect(wetGain);

    // 琴槌击弦的瞬态
    const noiseLen = 0.014 + (isLow ? 0.016 : 0);
    const nBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * noiseLen), ctx.sampleRate);
    const nd = nBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) {
      nd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / nd.length, 2.6);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = nBuf;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = Math.min(f0 * 4.2, 7000);
    nf.Q.value = 0.7;
    const ng = ctx.createGain();
    ng.gain.value = (isLow ? 0.16 : 0.075) * velv;
    noise.connect(nf); nf.connect(ng); ng.connect(out);
    noise.start(t0);
    noise.stop(t0 + noiseLen + 0.02);

    const oscs = [];
    for (let n = 1; n <= N; n++) {
      const freq = f0 * n * Math.sqrt(1 + B * n * n);      // 非谐性
      if (freq > 17500) break;

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;

      const amp = Math.pow(n, -1.28) * Math.exp(-brightK * (n - 1));
      const tauN = tauBase * Math.pow(n, -0.78);           // 高次泛音衰减更快
      const peak = amp * velv * (0.5 + 0.5 * Math.log(1 + n) / Math.log(1 + N));

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.0018 + 0.0012 * n);
      g.gain.setTargetAtTime(0, t0 + 0.002 + 0.0012 * n, tauN);
      osc.connect(g);
      g.connect(out);
      osc.start(t0);
      oscs.push({ osc, gain: g, tau: tauN, peak });
    }

    if (!oscs.length) return null;

    const overallTau = tauBase * 0.85;
    const vpeak = 0.42 * Math.pow(velv, 1.45);
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(vpeak, t0 + 0.004 + (isLow ? 0.012 : 0));

    const life = Math.max(2.2, overallTau * 6.5);
    const stopAt = t0 + life;

    voices.set(midi, { out, panner, oscs, stopAt });
    oscs[oscs.length - 1].osc.onended = () => {
      const v = voices.get(midi);
      if (v && v.out === out) voices.delete(midi);
    };
    for (const o of oscs) o.osc.stop(stopAt);

    return { stopAt };
  }

  function releaseVoice(v, tc) {
    const t = ctx.currentTime;
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setValueAtTime(Math.max(v.out.gain.value, 0.0001), t);
    v.out.gain.setTargetAtTime(0, t, tc);
    const hard = t + tc * 9;
    for (const o of v.oscs) {
      try { o.osc.stop(hard); } catch (e) { /* 已经停了 */ }
    }
  }

  function noteOff(midi, immediate) {
    const v = voices.get(midi);
    if (!v) return;
    if (sustainOn && !immediate) { sustained.add(midi); return; }
    releaseVoice(v, 0.075);
  }

  function forceRelease(midi, tc) {
    const v = voices.get(midi);
    if (!v) return;
    sustained.delete(midi);
    releaseVoice(v, tc);
  }

  function setSustain(on) {
    sustainOn = on;
    if (!on) {
      for (const midi of Array.from(sustained)) {
        const v = voices.get(midi);
        if (v) releaseVoice(v, 0.16);
      }
      sustained.clear();
    }
  }

  function setVolume(v) {
    vol = v;
    if (master) master.gain.setTargetAtTime(v * MAKEUP, ctx.currentTime, 0.03);
  }

  function allOff() {
    for (const midi of Array.from(voices.keys())) forceRelease(midi, 0.05);
    sustained.clear();
  }

  return {
    resume,
    ensureContext,
    connectSource,
    createTapStream,
    noteOn,
    noteOff,
    setSustain,
    setVolume,
    allOff,
    get ctx() { return ctx; },
    get isReady() { return ready; },
    get activeVoices() { return voices.size; },
  };
}
