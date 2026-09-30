/**
 * 音源门面：对外暴露和合成器完全一样的接口，内部按当前音源模式路由。
 *
 *   mode = 'synth'   只用内置加法合成合成器
 *   mode = 'sample'  优先用采样音源；某个音还没解码好时用合成器兜底，
 *                    所以"采样加载中"不会出现按下去没声音的空档
 *
 * 拾取与交互层（interaction.js）只认这套接口，不需要知道底下是哪个音源。
 */

export function createSource(engine, sampler) {
  let mode = 'synth';

  function noteOn(midi, vel, when) {
    if (mode === 'sample' && sampler?.ready) {
      // 'sample' = 采样已发声；'synth' = 还没就绪，需要合成器兜底
      if (sampler.noteOn(midi, vel, when) === 'sample') return 'sample';
    }
    engine.noteOn(midi, vel, when);
    return 'synth';
  }

  function noteOff(midi, vel) {
    // 两边都收：兜底期间合成器在响，采样就绪后采样在响，未发声的一方是空操作
    sampler?.noteOff(midi, vel);
    engine.noteOff(midi);
  }

  return {
    get mode() { return mode; },
    setMode(m) {
      if (m === mode) return;
      // 换音源时把旧音源正在响的音全收掉，避免两种音色叠在一起
      if (mode === 'sample') sampler?.allOff();
      else engine.allOff();
      mode = m;
    },
    resume() { engine.resume(); },
    ensureContext: () => engine.ensureContext(),
    connectSource: (n) => engine.connectSource(n),
    noteOn,
    noteOff,
    setSustain(on) { engine.setSustain(on); sampler?.setSustain(on); },
    setVolume: (v) => engine.setVolume(v),
    allOff() { engine.allOff(); sampler?.allOff(); },
    get ctx() { return engine.ctx; },
    get isReady() { return engine.isReady; },
    get activeVoices() { return engine.activeVoices; },
    get engine() { return engine; },
    get sampler() { return sampler; },
  };
}
