/**
 * 接触阴影：GTAO 的廉价替身。
 *
 * 实测 GTAO 在这台机器（AMD Radeon 610M 核显）上要吃掉 ~40 ms，占了一整帧的
 * 一半——它得先渲染一遍法线+深度、再做 AO 与降噪，核显根本扛不住。
 *
 * 但 GTAO 在这里真正贡献的其实只有一件事：让钢琴"坐"在地板上而不是浮着。
 * 那件事完全可以用一张预烘焙的暗化贴图来做——把琴的俯视轮廓羽化后乘到地板上，
 * 成本是每帧一次带纹理的四边形绘制，约等于零。
 *
 * 用乘法混合（白=不变，黑=压暗）而不是 alpha 混合，这样地板本身的木纹、
 * 倒影都还在，只是被压暗，跟真实的环境光遮蔽观感一致。
 */

import * as THREE from 'three';

/**
 * @param outline 世界 XZ 平面的闭合轮廓（通常是琴身俯视轮廓）
 * @param opts.size     贴图覆盖的世界尺寸（米），要留出羽化余量
 * @param opts.texSize  贴图分辨率
 * @param opts.blur     羽化半径（米）
 * @param opts.strength 中心处的压暗强度 0–1
 */
export function buildContactShadow(outline, {
  size = 2.9,
  texSize = 512,
  blur = 0.075,
  strength = 0.82,
} = {}) {
  const box = new THREE.Box3().setFromPoints(outline);
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;

  const c = document.createElement('canvas');
  c.width = c.height = texSize;
  const ctx = c.getContext('2d');

  // 白底：乘法混合下白色 = 地板原样不变
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, texSize, texSize);

  const px = (v, center) => ((v - center) / size + 0.5) * texSize;
  const blurPx = (blur / size) * texSize;

  ctx.save();
  ctx.filter = `blur(${blurPx.toFixed(1)}px)`;
  ctx.fillStyle = `rgba(0,0,0,${strength})`;
  ctx.beginPath();
  outline.forEach((p, i) => {
    const X = px(p.x, cx);
    const Y = px(p.z, cz);
    if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
  });
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      blending: THREE.MultiplyBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(cx, 0.0045, cz);   // 压在地板与反射层之上
  mesh.renderOrder = 2;
  mesh.name = 'contactShadow';
  return mesh;
}
