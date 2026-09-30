/**
 * 程序化贴图。
 *
 * 全模型不加载任何外部资源，木纹、锤纹漆、毛毡全部用 canvas 现画。
 * 这些贴图的作用不是"贴个图案"，而是给平面加**微表面变化**——
 * 一块完全没有纹理的黑漆在渲染里会读成塑料，加上极淡的法线扰动之后
 * 高光才会在边缘微微散开，那才是聚酯漆的观感。
 */

import * as THREE from 'three';

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, ctx: c.getContext('2d') };
}

function toTexture(canvas, { srgb = false, repeat = [1, 1], aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/* ── 值噪声：给纹理添一层不均匀，避免出现"数学般干净"的假感 ── */
function makeNoise(seed = 1) {
  const rand = mulberry32(seed);
  const grid = new Float32Array(256 * 256);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const at = (x, y) => grid[((y & 255) * 256) + (x & 255)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ══ 云杉音板 ═══════════════════════════════════════════════
   真机音板是整块云杉，纹路细密、几乎平行，颜色从浅蜜色到淡橙。
   纹路方向沿木纹的一致性很重要——音板的纹理是顺着琴弦走的。 */
export function spruceTextures(size = 1024) {
  const { c, ctx } = canvas2d(size, size);
  const rand = mulberry32(7717);
  const noise = makeNoise(31);

  ctx.fillStyle = '#c99a5c';
  ctx.fillRect(0, 0, size, size);

  // 底色斑驳
  const img = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const n = noise(x / 34, y / 210) * 0.55 + noise(x / 7, y / 60) * 0.45;
      const k = (n - 0.5) * 34;
      img.data[i] = Math.min(255, Math.max(0, img.data[i] + k));
      img.data[i + 1] = Math.min(255, Math.max(0, img.data[i + 1] + k * 0.85));
      img.data[i + 2] = Math.min(255, Math.max(0, img.data[i + 2] + k * 0.6));
    }
  }
  ctx.putImageData(img, 0, 0);

  // 年轮：沿 x 方向缓慢起伏的细线
  ctx.lineWidth = 1;
  for (let i = 0; i < 900; i++) {
    const x0 = rand() * size;
    const dark = rand() < 0.35;
    ctx.strokeStyle = dark
      ? `rgba(120,72,30,${0.10 + rand() * 0.18})`
      : `rgba(255,226,182,${0.05 + rand() * 0.10})`;
    ctx.beginPath();
    const drift = (rand() - 0.5) * 40;
    for (let y = 0; y <= size; y += 16) {
      const x = x0 + Math.sin(y * 0.012 + i) * 3.2 + drift * (y / size) + (rand() - 0.5) * 1.2;
      y === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const color = toTexture(c, { srgb: true, repeat: [2, 2] });

  // 粗糙度：木纹本身有极细的深浅差，做一张近似的灰度图
  const { c: rc, ctx: rctx } = canvas2d(256, 256);
  const rimg = rctx.createImageData(256, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4;
      const v = 150 + noise(x / 5, y / 48) * 60;
      rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = v;
      rimg.data[i + 3] = 255;
    }
  }
  rctx.putImageData(rimg, 0, 0);
  const rough = toTexture(rc, { repeat: [2, 2] });

  return { color, rough };
}

/* ══ 地板：深色胡桃木宽板 ═══════════════════════════════════
   钢琴最后终归要落在一块地板上。地板承担两件事：
   接住阴影、以及在低粗糙度下把环境的灯带糊成一片柔和的倒影。 */
export function floorTextures(size = 1024, boards = 6) {
  const { c, ctx } = canvas2d(size, size);
  const rand = mulberry32(2024);
  const noise = makeNoise(97);

  // 底色直接写 ImageData。逐像素 fillRect 会产生上百万次绘制调用，
  // 加载时要卡好几秒。
  const img = ctx.createImageData(size, size);
  const boardH = size / boards;
  for (let b = 0; b < boards; b++) {
    const y0 = b * boardH;
    const base = 0.42 + rand() * 0.26;               // 每块板深浅不同
    for (let y = 0; y < boardH; y++) {
      for (let x = 0; x < size; x++) {
        const i = ((y0 + y) * size + x) * 4;
        const g = noise(x / 160, (y0 + y) / 26) * 0.6 + noise(x / 22, (y0 + y) / 7) * 0.4;
        const v = base * (0.80 + g * 0.38);
        img.data[i] = 34 * v;
        img.data[i + 1] = 25 * v;
        img.data[i + 2] = 20 * v;
        img.data[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  // 木纹细线与板缝：数量少，用绘制指令反而更省事
  for (let b = 0; b < boards; b++) {
    const y0 = b * boardH;
    // 木纹线只画 22 条。画多了（试过 130 条）在屏幕上只有不到两个像素的
    // 间隔，会直接变成摩尔纹，地板看着像拉丝金属而不是木头。
    for (let i = 0; i < 22; i++) {
      const gy = y0 + rand() * boardH;
      ctx.strokeStyle = `rgba(${rand() < 0.5 ? '16,10,6' : '78,56,36'},${0.10 + rand() * 0.16})`;
      ctx.lineWidth = 1.0 + rand() * 2.2;
      ctx.beginPath();
      for (let x = 0; x <= size; x += 32) {
        const y = gy + Math.sin(x * 0.006 + i) * 2.4 + (rand() - 0.5) * 1.4;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillRect(0, y0, size, 3.0);
  }

  const color = toTexture(c, { srgb: true, repeat: [7, 7], aniso: 16 });

  // 抛光地板：光泽有起伏，这一层决定倒影是"一片"还是"一条条"
  const { c: rc, ctx: rctx } = canvas2d(512, 512);
  const rimg = rctx.createImageData(512, 512);
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 512; x++) {
      const i = (y * 512 + x) * 4;
      const boardBand = Math.floor(y / (512 / boards));
      const v = 124 + noise(x / 90, y / 12) * 62 + (boardBand % 2) * 14;
      rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = v;
      rimg.data[i + 3] = 255;
    }
  }
  rctx.putImageData(rimg, 0, 0);
  const rough = toTexture(rc, { repeat: [7, 7], aniso: 16 });

  return { color, rough };
}

/* ══ 铸铁板：真机是金色锤纹漆，不是抛光金属 ═══════════════════
   所以这张图主要给 roughness 用——满板均匀的金色金属会像一面镜子，
   把顶光整片反回来，糊成一块。锤纹把反射打碎成细密的颗粒才对。 */
export function plateTextures(size = 512) {
  const noise = makeNoise(613);

  // 预计算高度场：法线要四次采样邻居，直接调噪声会变成两百万次插值
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      H[y * size + x] = noise(x / 9, y / 9) * 0.6 + noise(x / 2.4, y / 2.4) * 0.4;
    }
  }
  const at = (x, y) => H[(((y % size) + size) % size) * size + (((x % size) + size) % size)];

  const { c, ctx } = canvas2d(size, size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const k = 0.74 + H[y * size + x] * 0.34;
      img.data[i] = Math.min(255, 146 * k);
      img.data[i + 1] = Math.min(255, 114 * k);
      img.data[i + 2] = Math.min(255, 50 * k);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const color = toTexture(c, { srgb: true, repeat: [3, 3] });

  // 锤纹起伏 → 粗糙度 + 法线
  const { c: rc, ctx: rctx } = canvas2d(size, size);
  const { c: nc, ctx: nctx } = canvas2d(size, size);
  const rimg = rctx.createImageData(size, size);
  const nimg = nctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const v = 108 + at(x, y) * 78;
      rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = v;
      rimg.data[i + 3] = 255;

      const dx = (at(x + 1, y) - at(x - 1, y)) * 2.6;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 2.6;
      const len = Math.hypot(-dx, -dy, 1);
      nimg.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 3] = 255;
    }
  }
  rctx.putImageData(rimg, 0, 0);
  nctx.putImageData(nimg, 0, 0);
  return {
    color,
    rough: toTexture(rc, { repeat: [3, 3] }),
    normal: toTexture(nc, { repeat: [3, 3] }),
  };
}

/* ══ 毛毡（制音器、踏板垫） ═════════════════════════════════ */
export function feltTexture(size = 256) {
  const { c, ctx } = canvas2d(size, size);
  const img = ctx.createImageData(size, size);
  const rand = mulberry32(4242);
  for (let i = 0; i < size * size; i++) {
    const k = 0.7 + rand() * 0.5;
    img.data[i * 4] = Math.min(255, 138 * k);
    img.data[i * 4 + 1] = Math.min(255, 28 * k);
    img.data[i * 4 + 2] = Math.min(255, 34 * k);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, { srgb: true, repeat: [4, 4] });
}

/* ══ 琴键上的微纹理 ═════════════════════════════════════════
   白键用久了会有极细的纵向磨痕。强度要压到几乎看不见——
   真机的新琴键就是很平的，做夸张了像用了二十年。 */
export function keyWearNormal(size = 256) {
  const { c, ctx } = canvas2d(size, size);
  const rand = mulberry32(881);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    img.data[i * 4] = 128; img.data[i * 4 + 1] = 128;
    img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.lineWidth = 1;
  for (let i = 0; i < 260; i++) {
    const x = rand() * size;
    ctx.strokeStyle = `rgba(${rand() < 0.5 ? '150,128,255' : '106,128,255'},0.5)`;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + (rand() - 0.5) * 3, size);
    ctx.stroke();
  }
  return toTexture(c, { repeat: [1, 3] });
}

/* ══ 发光柔光箱（供程序化 HDRI 使用） ═══════════════════════
   用**灰度**做边缘衰减、alpha 留满，而不是 alpha 渐变：
   这样面板不需要 transparent 就能被 PMREM 正确烘焙，也避开半透明
   物体在环境烘焙里的排序问题。材质那边把 color 设成大于 1 的亮度，
   由这张图从中心 1 衰减到边缘 0。 */
export function softPanelTexture(size = 256, feather = 0.45) {
  const { c, ctx } = canvas2d(size, size);
  const img = ctx.createImageData(size, size);
  const e = Math.min(0.95, Math.max(0.02, feather));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = Math.min(x, size - 1 - x) / (size * 0.5);
      const v = Math.min(y, size - 1 - y) / (size * 0.5);
      const s = (t) => { const q = Math.min(1, Math.max(0, t / e)); return q * q * (3 - 2 * q); };
      const g = Math.round(s(u) * s(v) * 255);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = g;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, { repeat: [1, 1], aniso: 1 });
}

/* ══ 黑漆的橘皮纹法线 ═══════════════════════════════════════
   聚酯漆在固化时会形成极细微的橘皮。完全光滑的表面会把环境
   反射成一面完美的镜子，反而假。加一层很淡的法线扰动，
   高光边缘就会"化开"一点点。 */
export function lacquerNormal(size = 512, strength = 0.32) {
  const noise = makeNoise(555);
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      H[y * size + x] = noise(x / 7, y / 7) * 0.7 + noise(x / 2.2, y / 2.2) * 0.3;
    }
  }
  const at = (x, y) => H[(((y % size) + size) % size) * size + (((x % size) + size) % size)];

  const { c, ctx } = canvas2d(size, size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(-dx, -dy, 1);
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, { repeat: [6, 6] });
}
