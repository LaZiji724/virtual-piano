/**
 * 地板：低分辨率实时反射 + 木地板 + 接触阴影挂点。
 *
 * IBL 里没有钢琴，光靠环境贴图地板映不出琴身，画面会立刻显得"摆在真空里"。
 * 所以底下垫一层 Reflector。但它是**每帧把整个场景再渲染一遍**，
 * 在核显上是很实的一笔开销，所以这里做了两件事：
 *
 *   1. 分辨率可调（低档降到 256×160，靠双线性放大自带柔化，本来也不需要清晰）；
 *   2. 可以**隔帧更新**（mirrorEvery）——反射滞后一两帧，肉眼几乎看不出，
 *      但开销直接减半。
 *
 * 另外换掉了 Reflector 自带的 fragment shader：它的 blendOverlay 假设输入落在
 * [0,1]，而灯带反射是 HDR 值（10 上下），会被当成"高光"再放大一遍，
 * 地板上浮出一片比灯还亮的斑马纹。这里改成乘法混合，color 直接就是反射率。
 */

import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

const SoftReflectorShader = {
  name: 'SoftReflectorShader',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    blurRadius: { value: 0.0065 },
  },
  vertexShader: /* glsl */`
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    void main() {
      vUv = textureMatrix * vec4( position, 1.0 );
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform float blurRadius;
    varying vec4 vUv;

    void main() {
      vec2 uv = vUv.xy / vUv.w;
      vec2 r = vec2( blurRadius, 0.0 );

      // 5 抽样的一维核，沿屏幕横向。地板是掠射角观察的，横向模糊本就
      // 比各向同性更自然，顺便把九次纹理采样砍到五次——核显上这是实打实的钱。
      vec4 sum = texture2D( tDiffuse, uv ) * 0.32;
      sum += texture2D( tDiffuse, uv + vec2(  r.x, 0.0 ) ) * 0.19;
      sum += texture2D( tDiffuse, uv + vec2( -r.x, 0.0 ) ) * 0.19;
      sum += texture2D( tDiffuse, uv + vec2(  r.x * 2.1, 0.0 ) ) * 0.15;
      sum += texture2D( tDiffuse, uv + vec2( -r.x * 2.1, 0.0 ) ) * 0.15;

      gl_FragColor = vec4( sum.rgb * color, 1.0 );
    }`,
};

export function buildFloor(renderer, M, {
  size = 26,
  mirrorWidth = 1024,
  mirrorHeight = 640,
  mirrorEvery = 1,
} = {}) {
  const g = new THREE.Group();
  g.name = 'floor';

  const mirror = new Reflector(new THREE.PlaneGeometry(size, size), {
    shader: SoftReflectorShader,
    textureWidth: mirrorWidth,
    textureHeight: mirrorHeight,
    color: 0x6a6a6a,
    clipBias: 0.004,
  });
  // 反射用**加法**叠在地板之上，而不是让地板半透明再透出来。
  // 半透明方案会把反射压到十几个百分点，琴身在暗地板上的倒影直接消失；
  // 而且半透明地板接阴影也不干净。
  mirror.material.blending = THREE.AdditiveBlending;
  mirror.material.transparent = true;
  mirror.material.depthWrite = false;
  // Reflector 默认只给一张无 mipmap 的贴图。地板是掠射角观察的，反射图
  // 会被极度拉伸，没有 mipmap 就在远处拉出规则摩尔纹。
  {
    const tex = mirror.getRenderTarget().texture;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
    tex.needsUpdate = true;
  }
  mirror.rotation.x = -Math.PI / 2;
  mirror.position.y = 0.002;
  g.add(mirror);

  // 隔帧更新：跳过时 Reflector 不会重渲染，材质继续用上一帧的贴图
  const baseOnBeforeRender = mirror.onBeforeRender;
  let tick = 0;
  let every = Math.max(1, mirrorEvery | 0);
  mirror.onBeforeRender = function (...args) {
    if (every > 1 && (tick++ % every) !== 0) return;
    baseOnBeforeRender.apply(this, args);
  };

  const floorMat = M.floor.clone();
  floorMat.envMapIntensity = 0.30;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.001;
  floor.receiveShadow = true;
  g.add(floor);

  g.userData.setMirrorEvery = (n) => { every = Math.max(1, n | 0); };
  g.userData.setMirrorSize = (w, h) => {
    mirror.getRenderTarget().setSize(w, h);
    const tex = mirror.getRenderTarget().texture;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
  };
  g.userData.mirror = mirror;

  return g;
}
