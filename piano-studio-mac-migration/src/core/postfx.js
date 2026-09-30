/**
 * 后处理链（可分级）。
 *
 * 这是整条管线里最吃性能的部分，也是"要不要砍"争议最大的部分。
 * 实测数据（1600×1000，AMD Radeon 610M 核显）：
 *
 *   GTAO           ~40 ms   ← 独占一半帧时间，已移除
 *   Bloom          ~10 ms
 *   阴影 4096      ~10 ms
 *   主渲染+色调映射 ~22 ms
 *
 * GTAO 被砍掉不是因为它不好看，而是它要跑一遍法线+深度预 pass 再做 AO 和降噪，
 * 核显扛不住。它在这里的真正贡献只有"让钢琴坐在地板上"这一件事，
 * 而那件事用一张烘焙的接触阴影就能做到，成本约等于零（见 contactShadow.js）。
 *
 * 剩下的两项做成可调：Bloom 能降分辨率，Vignette 是纯像素运算几乎免费。
 *
 * 抗锯齿用 WebGL2 的多重采样渲染目标，档位在初始化时定死（RT 创建后不能改采样数）。
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * 色调映射 + 色彩空间 + 暗角，**合并成一个全屏 pass**。
 *
 * 分开放（OutputPass 一个、Vignette 一个）在核显上是实打实的两倍开销：
 * 这个分辨率下每次全屏 pass 都要把一百六十万像素读一遍写一遍，
 * 而核显的瓶颈正是像素填充率而不是几何量。合成一个就省掉一整趟往返。
 *
 * 内部用的是 three 自己的 tonemapping / colorspace chunk，所以行为跟
 * 官方 OutputPass 完全一致，只是多叠了一层暗角。
 */
class OutputVignettePass extends Pass {
  constructor({ strength = 0.38, radius = 0.95 } = {}) {
    super();
    this.uniforms = {
      tDiffuse: { value: null },
      toneMappingExposure: { value: 1 },
      vignetteStrength: { value: strength },
      vignetteRadius: { value: radius },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float vignetteStrength;
        uniform float vignetteRadius;
        varying vec2 vUv;

        // 注意：这里**不能**写 #include <tonemapping_pars_fragment> 或
        // <colorspace_pars_fragment>。three 在 WebGLProgram 的 prefixFragment
        // 里已经无条件注入了 colorspace 的解析函数、并在启用色调映射时注入了
        // tonemapping 的那一套（含 toneMappingExposure 这个 uniform）。
        // 再 include 一次会让 sRGBTransferEOTF 等函数重复定义，shader 编译直接失败。
        // 下面两个 *_fragment 是"应用"型 chunk，不含定义，可以放心用。

        void main() {
          gl_FragColor = texture2D( tDiffuse, vUv );

          // 暗角放在色调映射**之前**：作用在线性亮度上才不会把暗部压死
          vec2 p = ( vUv - 0.5 ) * 2.0;
          float d = length( p * vec2( 1.0, 0.88 ) );
          float v = smoothstep( vignetteRadius, vignetteRadius * 0.34, d );
          gl_FragColor.rgb *= mix( 1.0 - vignetteStrength, 1.0, v );

          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.fsQuad = new FullScreenQuad(this.material);
    this._outputColorSpace = null;
    this._toneMapping = null;
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;

    // 输出色彩空间 / 色调映射变了要重建 defines——这段逻辑跟官方 OutputPass 一致
    if (this._outputColorSpace !== renderer.outputColorSpace || this._toneMapping !== renderer.toneMapping) {
      this._outputColorSpace = renderer.outputColorSpace;
      this._toneMapping = renderer.toneMapping;
      this.material.defines = {};
      if (THREE.ColorManagement.getTransfer(this._outputColorSpace) === THREE.SRGBTransfer) {
        this.material.defines.SRGB_TRANSFER = '';
      }
      const map = {
        [THREE.LinearToneMapping]: 'LINEAR_TONE_MAPPING',
        [THREE.ReinhardToneMapping]: 'REINHARD_TONE_MAPPING',
        [THREE.CineonToneMapping]: 'CINEON_TONE_MAPPING',
        [THREE.ACESFilmicToneMapping]: 'ACES_FILMIC_TONE_MAPPING',
        [THREE.AgXToneMapping]: 'AGX_TONE_MAPPING',
        [THREE.NeutralToneMapping]: 'NEUTRAL_TONE_MAPPING',
      };
      const name = map[this._toneMapping];
      if (name) this.material.defines[name] = '';
      this.material.needsUpdate = true;
    }

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.fsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
      this.fsQuad.render(renderer);
    }
  }

  dispose() {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}

/** 画质档位。msaa 只在初始化时生效，其余可运行时切换。 */
export const TIERS = {
  high: { msaa: 4, bloom: true, bloomScale: 1.0, shadow: 4096 },
  medium: { msaa: 2, bloom: true, bloomScale: 0.5, shadow: 2048 },
  low: { msaa: 0, bloom: false, bloomScale: 0.5, shadow: 1024 },
};

export function createPostFX(renderer, scene, camera, { tier = 'medium' } = {}) {
  const cfg = TIERS[tier] ?? TIERS.medium;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());

  const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: cfg.msaa,
    depthBuffer: true,
  });

  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));

  // Bloom 的每一级都在更小的 mipmap 上做，所以起始分辨率直接决定开销。
  // bloomScale 把它的内部缓冲再缩一档，视觉上只是光晕略微更"散"。
  const bloomRes = new THREE.Vector2(
    Math.max(64, Math.round(size.x * cfg.bloomScale)),
    Math.max(64, Math.round(size.y * cfg.bloomScale)),
  );
  const bloom = new UnrealBloomPass(
    bloomRes,
    0.30,     // strength：克制。黑漆的质感来自高光本身，不是光晕
    0.62,     // radius
    1.8,      // threshold：必须远高于 1，否则白键会整片落进 Bloom 被反复加亮
  );
  bloom.enabled = cfg.bloom;
  composer.addPass(bloom);

  // 色调映射 + 色彩空间 + 暗角，一个 pass 搞定（见上面 OutputVignettePass 的注释）
  const output = new OutputVignettePass({ strength: 0.38, radius: 0.95 });
  composer.addPass(output);

  return {
    composer,
    bloom,
    output,
    tier,
    // composer 内部会把 CSS 尺寸乘上 pixelRatio 再分发给各 pass，
    // 所以这里只要把比例同步过去就行
    setSize(w, h, pixelRatio) {
      if (pixelRatio !== undefined) composer.setPixelRatio(pixelRatio);
      composer.setSize(w, h);
    },
    /** 运行时切档：只动能动的部分，MSAA 保持不变 */
    setTier(name) {
      const c = TIERS[name];
      if (!c) return;
      this.tier = name;
      bloom.enabled = c.bloom;
      return c;
    },
  };
}
