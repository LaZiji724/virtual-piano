/**
 * 材质库。
 *
 * 黑漆是这个模型里唯一真正难做的材质。它的"高级感"不来自更黑，
 * 而来自三层叠加：
 *   1. 底色层几乎不反光（specularIntensity 压低），负责呈现深邃的纯黑；
 *   2. 清漆层极光滑（clearcoatRoughness ≈ 0.02），负责把环境里的
 *      灯带反射成细长亮线；
 *   3. 一层极淡的橘皮法线，让那条亮线的边缘微微化开。
 * 少了第 3 层，表面会读成"一面完美的镜子"，反而假。
 */

import * as THREE from 'three';
import {
  spruceTextures, floorTextures, plateTextures, feltTexture,
  keyWearNormal, lacquerNormal,
} from './textures.js';

export function createMaterials(renderer) {
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const spruce = spruceTextures(1024);
  const floor = floorTextures(1024, 6);
  const plate = plateTextures(512);
  const felt = feltTexture(256);
  const keyWear = keyWearNormal(256);
  const orangePeel = lacquerNormal(512, 0.34);

  for (const t of [spruce.color, spruce.rough, floor.color, floor.rough,
    plate.color, plate.rough, plate.normal, felt, keyWear, orangePeel]) {
    t.anisotropy = Math.min(maxAniso, 8);
  }
  floor.color.anisotropy = floor.rough.anisotropy = maxAniso;

  const M = {
    /* ── 黑色高光聚酯漆：琴身、琴盖、谱架、名板 ── */
    lacquer: new THREE.MeshPhysicalMaterial({
      color: 0x07070a,
      roughness: 0.40,
      metalness: 0.0,
      specularIntensity: 0.42,
      clearcoat: 1.0,
      clearcoatRoughness: 0.024,
      normalMap: orangePeel,
      normalScale: new THREE.Vector2(0.055, 0.055),
      envMapIntensity: 2.05,
    }),

    /* ── 琴身内腔衬里：键床、音板挡条。
           必须做**真哑光**——粗糙度给 0.5 上下、还留着 clearcoat 的话，
           一块水平面会正对着把顶部灯带整条反射回来，在俯视图里变成一块惨白，
           看着像块塑料板而不是键床。── */
    lacquerInner: new THREE.MeshPhysicalMaterial({
      color: 0x0b0a09,
      roughness: 0.86,
      metalness: 0.0,
      specularIntensity: 0.18,
      clearcoat: 0.10,
      clearcoatRoughness: 0.55,
      envMapIntensity: 0.42,
    }),

    /* ── 白键：象牙调的赛璐珞，带极淡的纵向磨痕。
           底色不能给太亮：主光为了压住 IBL 已经开到 6 上下，
           白键 albedo 接近 1 的话特写会整片糊成纯白，一根键缝都留不下。── */
    whiteKey: new THREE.MeshPhysicalMaterial({
      color: 0xe6e0d3,
      roughness: 0.42,
      metalness: 0.0,
      clearcoat: 0.16,
      clearcoatRoughness: 0.40,
      normalMap: keyWear,
      normalScale: new THREE.Vector2(0.035, 0.035),
      envMapIntensity: 0.42,
    }),

    /* ── 黑键：比琴身更哑的模压塑料 ── */
    blackKey: new THREE.MeshPhysicalMaterial({
      color: 0x0d0d10,
      roughness: 0.26,
      metalness: 0.0,
      specularIntensity: 0.5,
      clearcoat: 0.7,
      clearcoatRoughness: 0.16,
      envMapIntensity: 1.0,
    }),

    /* ── 云杉音板 ── */
    soundboard: new THREE.MeshStandardMaterial({
      map: spruce.color,
      roughnessMap: spruce.rough,
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.28,
    }),

    /* ── 铸铁板：金色锤纹涂装。metalness 不能给满，
           满金属 + 均匀色会把顶光整片反回来，糊成一块死金 ── */
    plate: new THREE.MeshStandardMaterial({
      map: plate.color,
      roughnessMap: plate.rough,
      normalMap: plate.normal,
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughness: 1.0,
      metalness: 0.22,
      envMapIntensity: 0.26,
    }),

    /* ── 黄铜：踏板、脚轮、撑杆件，抛光但带一点使用痕迹 ── */
    brass: new THREE.MeshStandardMaterial({
      color: 0xc9a24a,
      roughness: 0.27,
      metalness: 1.0,
      envMapIntensity: 1.0,
    }),

    /* ── 镀镍钢：琴弦、弦轴钉、压弦条。
           226 根弦挤在一起时，反射率稍高就会糊成一片白钢丝球，
           所以比真机的抛光镍再哑一档。── */
    steel: new THREE.MeshStandardMaterial({
      color: 0x7e7c78,          // 中性偏暖，太蓝的话整片弦看着像塑料线
      roughness: 0.46,
      metalness: 0.88,
      envMapIntensity: 0.30,
    }),

    /* ── 内部木结构：底框、肋木、弦马 ── */
    innerWood: new THREE.MeshStandardMaterial({
      color: 0x3d2718,
      roughness: 0.78,
      metalness: 0.0,
      envMapIntensity: 0.35,
    }),

    /* ── 弦马（枫木，硬而亮） ── */
    bridgeWood: new THREE.MeshStandardMaterial({
      color: 0x6b4526,
      roughness: 0.55,
      metalness: 0.0,
      envMapIntensity: 0.5,
    }),

    /* ── 毛毡：制音器、踏板垫呢 ── */
    felt: new THREE.MeshStandardMaterial({
      map: felt,
      roughness: 0.95,
      metalness: 0.0,
      envMapIntensity: 0.3,
    }),

    /* ── 地板：深色胡桃木。压暗 + 削弱环境反射，让画面重心留在琴身上，
           地板只负责接住落地阴影、并给一点点环境的灯带倒影。── */
    floor: new THREE.MeshStandardMaterial({
      map: floor.color,
      roughnessMap: floor.rough,
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.42,
    }),

    /* ── 纯金属小件（铰链、螺丝） ── */
    hinge: new THREE.MeshStandardMaterial({
      color: 0x8a8e94,
      roughness: 0.42,
      metalness: 1.0,
      envMapIntensity: 0.8,
    }),
  };

  return M;
}
