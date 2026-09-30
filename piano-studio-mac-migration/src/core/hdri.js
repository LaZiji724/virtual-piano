/**
 * 程序化摄影棚 HDRI。
 *
 * 不加载 .hdr 文件，直接搭一个"虚拟摄影棚"渲染进 PMREM。
 *
 * 关键点在于**灯板亮度大于 1**：`MeshBasicMaterial.color` 设成 10 之类的线性值，
 * 渲染目标又是 HalfFloat，于是环境贴图里真的存着 10 这种数值。黑漆反射它的时候
 * 高光会真正过曝，Bloom 也才有东西可以拾取。用纯色块（最大值 1）搭出来的环境，
 * 无论怎么调曝光，漆面永远是一层灰蒙蒙的膜——这是"看着像塑料"的根因。
 *
 * 灯位设计上，顶部放几条**细长**灯带而不是一大片均匀柔光箱：细长光源在
 * 光滑曲面上反射出来是细长光带，那才是钢琴漆的典型观感；整片均匀光只会
 * 反出一块没有形状的灰。灯带还必须沿琴身长轴（Z）摆放，光带方向才跟着对。
 */

import * as THREE from 'three';
import { softPanelTexture } from './textures.js';

/** 线性空间亮度（可以 > 1） */
function lum(r, g, b) {
  return new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
}

/**
 * 影棚空间的垂直亮度剖面（equirect，贴在一个大球的背面）。
 *
 * 这张图决定了黑漆"反射到什么"，是整张画面层次的来源。要的是一条
 * 两头暗、地平线亮的剖面：
 *   · 天顶必须暗 —— 水平面（琴盖）正对着反射它，一亮就糊成白板；
 *   · 地平线附近要亮 —— 琴身侧板是竖直的，反射的正是这一带。全黑的话
 *     侧板就是死黑一片，看着像块 abs 塑料而不是漆；
 *   · 地面要暗，但比天顶亮一点，给琴腹下缘留一点余晖。
 * 再叠一层缓慢的噪声和一点暖色，反射里就有了"信息"，不再是均匀的死板。
 */
function studioRoomTexture(W = 256, H = 256) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);

  // 独立的轻量噪声（不引 textures.js 的 mulberry，避免循环依赖）
  const grid = new Float32Array(64 * 64);
  let seed = 909;
  for (let i = 0; i < grid.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    grid[i] = seed / 4294967296;
  }
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const at = (a, b) => grid[(((b % 64) + 64) % 64) * 64 + (((a % 64) + 64) % 64)];
    return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v)
         + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v;
  };

  for (let y = 0; y < H; y++) {
    const v = 1 - y / (H - 1);                 // 1 = 天顶，0 = 地面
    const base = v > 0.5
      ? 0.020 + 0.118 * (1 - (v - 0.5) / 0.5) ** 2.2
      : 0.032 + 0.106 * (v / 0.5) ** 1.6;
    const warm = Math.max(0, 1 - Math.abs(v - 0.5) / 0.34);
    for (let x = 0; x < W; x++) {
      const n = noise(x / 26, y / 26);
      const k = base * (0.72 + n * 0.56);
      const i = (y * W + x) * 4;
      img.data[i] = Math.min(255, k * 255 * (1 + warm * 0.15));
      img.data[i + 1] = Math.min(255, k * 255);
      img.data[i + 2] = Math.min(255, k * 255 * (1 - warm * 0.10));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;           // 这几张图存的是线性亮度，不是颜色
  t.wrapS = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

/**
 * 灯位表。坐标以钢琴中心为原点，PMREM 只关心方向，位置只影响张角。
 *
 * 两条不能违反的规矩：
 *
 * 1. **天顶必须留暗**。灯带横跨正上方的话，水平面（琴盖、侧板顶面圆边）
 *    在俯视时会正对着把整条灯带反射进镜头，漆面糊成一片没有形状的纯白。
 *    所以四条顶灯全部沿 Z 向铺开、并推到 x = ±2 ~ ±6 的斜上方。
 *
 * 2. **顶灯要纵向（沿 Z）**，不是横向。长条光源反射到琴盖上拉出的光带，
 *    方向跟着光源走——真机的产品照里那条光是顺着琴身长轴的，横着来就假了。
 *
 * 侧面那两条竖灯负责琴身侧板的高光，一直垂到地平线以下（侧板法线朝外，
 * 相机俯视时反射方向是朝下的，光源不垂下去就什么也接不到）。
 */
const RIG = [
  // ── 顶部四条纵向灯带
  { size: [1.30, 19], pos: [-1.95, 6.40, -0.80], rot: [Math.PI / 2, 0, 0], lum: [10.5, 10.1, 9.4] },
  { size: [1.30, 19], pos: [-5.30, 6.40, -0.80], rot: [Math.PI / 2, 0, 0], lum: [8.2, 7.9, 7.4] },
  { size: [1.30, 19], pos: [2.45, 6.40, -0.80], rot: [Math.PI / 2, 0, 0], lum: [11.5, 11.1, 10.3] },
  { size: [1.30, 19], pos: [6.10, 6.40, -0.80], rot: [Math.PI / 2, 0, 0], lum: [7.6, 7.4, 7.0] },

  // ── 左右竖直长灯：给侧板拉出竖光带
  { size: [3.2, 11.0], pos: [-9.0, 2.2, 0.4], rot: [0, Math.PI / 2, 0], lum: [5.2, 5.8, 7.0] },
  { size: [3.2, 11.0], pos: [9.0, 2.2, -0.6], rot: [0, -Math.PI / 2, 0], lum: [6.4, 5.4, 4.2] },

  // ── 前方柔光箱：照亮键盘与琴身正面
  { size: [11, 7.5], pos: [0, 2.4, 9.2], rot: [0, 0, 0], lum: [3.6, 3.7, 4.0] },

  // ── 后方轮廓光
  { size: [9, 6.5], pos: [0, 3.2, -9.6], rot: [0, Math.PI, 0], lum: [3.0, 2.8, 2.5] },

  // ── 地板反光（避免下半球全黑，黑漆的下缘会死掉）
  { size: [20, 20], pos: [0, -7.8, 0], rot: [-Math.PI / 2, 0, 0], lum: [0.30, 0.29, 0.31] },
];

/**
 * 烘焙环境贴图。
 * @param renderer WebGLRenderer
 * @param sigma    PMREM 额外模糊，越大灯带边缘越柔
 * @param boost    环境整体强度，用于统一调光
 */
export function buildStudioEnv(renderer, { sigma = 0.018, boost = 1.0 } = {}) {
  const envScene = new THREE.Scene();

  // 影棚空间：一个大球的背面，贴垂直亮度剖面。
  // 半径要罩得住最远的那块灯板（地板反光那块的角在 16 m 开外）。
  const roomTex = studioRoomTexture();
  const room = new THREE.Mesh(
    new THREE.SphereGeometry(22, 48, 32),
    new THREE.MeshBasicMaterial({
      map: roomTex,
      side: THREE.BackSide,
      toneMapped: false,
    }),
  );
  envScene.add(room);

  const panelTex = softPanelTexture(256, 0.42);
  const geo = new THREE.PlaneGeometry(1, 1);

  for (const p of RIG) {
    const mat = new THREE.MeshBasicMaterial({
      map: panelTex,
      color: lum(p.lum[0] * boost, p.lum[1] * boost, p.lum[2] * boost),
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.scale.set(p.size[0], p.size[1], 1);
    m.position.fromArray(p.pos);
    m.rotation.set(...p.rot);
    envScene.add(m);
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromScene(envScene, sigma, 0.1, 120);
  pmrem.dispose();

  envScene.remove(room);
  room.geometry.dispose();
  room.material.dispose();
  envScene.traverse((o) => {
    if (o.isMesh) o.material.dispose();
  });
  geo.dispose();

  return rt.texture;
}
