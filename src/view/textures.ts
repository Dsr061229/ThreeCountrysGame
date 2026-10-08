/**
 * 程序化材质。
 *
 * 没有美术资源，「真实」只能靠两件事：**真实的形制比例** 和 **真实的表面质感**。
 * 这个文件负责后者 —— 全部用 canvas 现画，不依赖任何外部贴图文件。
 *
 * 每种材质同时产出颜色图与凹凸图。凹凸图不是装饰：夯土的颗粒、瓦垄的起伏、
 * 木头的纹理，在斜射的日光下会投出细小的明暗，那才是「看起来是真东西」的来源。
 */
import * as THREE from 'three';

const SIZE = 256;

function canvas(): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  return { c, g: c.getContext('2d')! };
}

/** 稳定的伪随机，保证每次生成的贴图一致（热重载时不会突然变样） */
function rnd(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function toTexture(c: HTMLCanvasElement, repeat = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function toBump(c: HTMLCanvasElement, repeat = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  return t;
}

/** 撒颗粒。质感的基础 —— 纯色平面永远像塑料 */
function speckle(
  g: CanvasRenderingContext2D, seed: number, count: number,
  colors: string[], minR = 0.6, maxR = 2.4,
): void {
  const r = rnd(seed);
  for (let i = 0; i < count; i++) {
    g.fillStyle = colors[Math.floor(r() * colors.length)]!;
    const x = r() * SIZE, y = r() * SIZE, rad = minR + r() * (maxR - minR);
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
  }
}

// ─────────────────────────────────────────────────────────────
// 夯土墙 —— 汉代版筑，一层一层夯上去，侧面看得见夯层
// ─────────────────────────────────────────────────────────────

function rammedEarth(): { map: THREE.Texture; bump: THREE.Texture } {
  const { c, g } = canvas();
  g.fillStyle = '#c2ac84';
  g.fillRect(0, 0, SIZE, SIZE);
  speckle(g, 11, 2600, ['#d0bb90', '#ab966e', '#dac69c', '#9c8862'], 0.5, 1.8);

  // 夯层：每 32px 一道，是版筑一板的高度
  const r = rnd(23);
  for (let y = 0; y < SIZE; y += 32) {
    g.strokeStyle = 'rgba(120,102,74,0.35)';
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(0, y + r() * 2);
    for (let x = 0; x <= SIZE; x += 16) g.lineTo(x, y + (r() - 0.5) * 3);
    g.stroke();
  }
  // 风蚀的斑
  for (let i = 0; i < 18; i++) {
    g.fillStyle = `rgba(150,132,102,${0.06 + r() * 0.08})`;
    g.beginPath();
    g.ellipse(r() * SIZE, r() * SIZE, 8 + r() * 26, 5 + r() * 14, r() * 3, 0, Math.PI * 2);
    g.fill();
  }

  const b = canvas();
  b.g.fillStyle = '#808080';
  b.g.fillRect(0, 0, SIZE, SIZE);
  speckle(b.g, 11, 2600, ['#9a9a9a', '#6a6a6a', '#a4a4a4', '#5f5f5f'], 0.5, 1.8);
  const r2 = rnd(23);
  for (let y = 0; y < SIZE; y += 32) {
    b.g.strokeStyle = 'rgba(60,60,60,0.6)';
    b.g.lineWidth = 2;
    b.g.beginPath();
    b.g.moveTo(0, y + r2() * 2);
    for (let x = 0; x <= SIZE; x += 16) b.g.lineTo(x, y + (r2() - 0.5) * 3);
    b.g.stroke();
  }

  return { map: toTexture(c), bump: toBump(b.c) };
}

// ─────────────────────────────────────────────────────────────
// 瓦 —— 筒瓦一垄一垄，是汉代屋顶最显眼的特征
// ─────────────────────────────────────────────────────────────

function roofTile(): { map: THREE.Texture; bump: THREE.Texture } {
  const { c, g } = canvas();
  g.fillStyle = '#525a5e';
  g.fillRect(0, 0, SIZE, SIZE);

  const r = rnd(77);
  const pitch = 16; // 一垄的宽度
  for (let x = 0; x < SIZE; x += pitch) {
    // 筒瓦（凸）
    const grad = g.createLinearGradient(x, 0, x + pitch * 0.55, 0);
    grad.addColorStop(0, '#42484c');
    grad.addColorStop(0.45, '#7b838a');
    grad.addColorStop(1, '#373d41');
    g.fillStyle = grad;
    g.fillRect(x, 0, pitch * 0.55, SIZE);
    // 板瓦（凹）
    g.fillStyle = '#3d4347';
    g.fillRect(x + pitch * 0.55, 0, pitch * 0.45, SIZE);
  }
  // 一片片瓦的横向接缝
  for (let y = 0; y < SIZE; y += 26) {
    g.strokeStyle = 'rgba(30,34,36,0.5)';
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(SIZE, y);
    g.stroke();
    g.strokeStyle = 'rgba(140,146,150,0.18)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, y + 2);
    g.lineTo(SIZE, y + 2);
    g.stroke();
  }
  // 苔痕与旧色
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(${90 + r() * 30 | 0},${100 + r() * 25 | 0},${75 + r() * 20 | 0},${0.05 + r() * 0.1})`;
    g.beginPath();
    g.ellipse(r() * SIZE, r() * SIZE, 4 + r() * 12, 3 + r() * 8, 0, 0, Math.PI * 2);
    g.fill();
  }

  const b = canvas();
  for (let x = 0; x < SIZE; x += pitch) {
    const grad = b.g.createLinearGradient(x, 0, x + pitch * 0.55, 0);
    grad.addColorStop(0, '#4a4a4a');
    grad.addColorStop(0.45, '#ffffff');
    grad.addColorStop(1, '#3a3a3a');
    b.g.fillStyle = grad;
    b.g.fillRect(x, 0, pitch * 0.55, SIZE);
    b.g.fillStyle = '#2a2a2a';
    b.g.fillRect(x + pitch * 0.55, 0, pitch * 0.45, SIZE);
  }
  for (let y = 0; y < SIZE; y += 26) {
    b.g.strokeStyle = 'rgba(0,0,0,0.7)';
    b.g.lineWidth = 2;
    b.g.beginPath();
    b.g.moveTo(0, y); b.g.lineTo(SIZE, y); b.g.stroke();
  }

  return { map: toTexture(c), bump: toBump(b.c) };
}

// ─────────────────────────────────────────────────────────────
// 木、茅草、夯土地面、水
// ─────────────────────────────────────────────────────────────

function wood(): { map: THREE.Texture; bump: THREE.Texture } {
  const { c, g } = canvas();
  g.fillStyle = '#6f5235';
  g.fillRect(0, 0, SIZE, SIZE);
  const r = rnd(41);
  for (let i = 0; i < 130; i++) {
    g.strokeStyle = `rgba(${50 + r() * 50 | 0},${36 + r() * 34 | 0},${22 + r() * 24 | 0},${0.25 + r() * 0.4})`;
    g.lineWidth = 0.6 + r() * 2.2;
    const x = r() * SIZE;
    g.beginPath();
    g.moveTo(x, 0);
    for (let y = 0; y <= SIZE; y += 24) g.lineTo(x + (r() - 0.5) * 5, y);
    g.stroke();
  }
  const b = canvas();
  b.g.fillStyle = '#808080';
  b.g.fillRect(0, 0, SIZE, SIZE);
  const r2 = rnd(41);
  for (let i = 0; i < 130; i++) {
    b.g.strokeStyle = `rgba(${40 + r2() * 120 | 0},${40 + r2() * 120 | 0},${40 + r2() * 120 | 0},0.5)`;
    b.g.lineWidth = 0.6 + r2() * 2.2;
    const x = r2() * SIZE;
    b.g.beginPath();
    b.g.moveTo(x, 0);
    for (let y = 0; y <= SIZE; y += 24) b.g.lineTo(x + (r2() - 0.5) * 5, y);
    b.g.stroke();
  }
  return { map: toTexture(c), bump: toBump(b.c) };
}

function thatch(): { map: THREE.Texture; bump: THREE.Texture } {
  const { c, g } = canvas();
  g.fillStyle = '#a08a55';
  g.fillRect(0, 0, SIZE, SIZE);
  const r = rnd(59);
  for (let i = 0; i < 1400; i++) {
    g.strokeStyle = `rgba(${140 + r() * 70 | 0},${118 + r() * 60 | 0},${70 + r() * 45 | 0},${0.3 + r() * 0.5})`;
    g.lineWidth = 0.7 + r() * 1.3;
    const x = r() * SIZE, y = r() * SIZE, len = 10 + r() * 22;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (r() - 0.5) * 5, y + len);
    g.stroke();
  }
  const b = canvas();
  b.g.fillStyle = '#707070';
  b.g.fillRect(0, 0, SIZE, SIZE);
  const r2 = rnd(59);
  for (let i = 0; i < 1400; i++) {
    b.g.strokeStyle = `rgba(${r2() * 255 | 0},${r2() * 255 | 0},${r2() * 255 | 0},0.5)`;
    b.g.lineWidth = 0.7 + r2() * 1.3;
    const x = r2() * SIZE, y = r2() * SIZE;
    b.g.beginPath();
    b.g.moveTo(x, y);
    b.g.lineTo(x + (r2() - 0.5) * 5, y + 10 + r2() * 22);
    b.g.stroke();
  }
  return { map: toTexture(c), bump: toBump(b.c) };
}

function dirt(): { map: THREE.Texture; bump: THREE.Texture } {
  const { c, g } = canvas();
  g.fillStyle = '#9d8560';
  g.fillRect(0, 0, SIZE, SIZE);
  speckle(g, 97, 4200, ['#ab936d', '#8b7554', '#b8a179', '#7d6a4c', '#a58e68'], 0.5, 2.6);
  const r = rnd(103);
  for (let i = 0; i < 26; i++) {
    g.fillStyle = `rgba(${120 + r() * 30 | 0},${104 + r() * 26 | 0},${76 + r() * 22 | 0},${0.08 + r() * 0.12})`;
    g.beginPath();
    g.ellipse(r() * SIZE, r() * SIZE, 12 + r() * 40, 8 + r() * 26, r() * 3, 0, Math.PI * 2);
    g.fill();
  }
  const b = canvas();
  b.g.fillStyle = '#7d7d7d';
  b.g.fillRect(0, 0, SIZE, SIZE);
  speckle(b.g, 97, 4200, ['#999', '#5f5f5f', '#a8a8a8', '#4f4f4f'], 0.5, 2.6);
  return { map: toTexture(c), bump: toBump(b.c) };
}

/**
 * 郊野的地。
 *
 * 原先大地和夯土墙用的是同一种材质 —— 土黄压土黄，剪影分不出来。
 * 但解决办法不是把地涂成绿的：那样会假、会平。
 *
 * 真正拉开距离的是**明度和肌理**：郊野是偏暗的干燥土地，
 * 有斑驳、有稀疏草丛、有淡淡的田界；夯土墙是干净的浅土黄。
 * 同一个色系里差两档明度，加上完全不同的纹理密度，建筑自然就浮出来了。
 */
function wildland(): { map: THREE.Texture; bump: THREE.Texture } {
  const { c, g } = canvas();
  g.fillStyle = '#877c62';
  g.fillRect(0, 0, SIZE, SIZE);

  const r = rnd(223);

  // 大块的深浅：地不是一片匀色，远看就是这些斑在起作用
  for (let i = 0; i < 26; i++) {
    const dark = r() > 0.5;
    g.fillStyle = dark
      ? `rgba(112,102,80,${0.10 + r() * 0.16})`
      : `rgba(176,166,138,${0.08 + r() * 0.14})`;
    g.beginPath();
    g.ellipse(r() * SIZE, r() * SIZE, 14 + r() * 52, 10 + r() * 38, r() * 3, 0, Math.PI * 2);
    g.fill();
  }

  // 土粒
  speckle(g, 211, 4600, ['#968a6c', '#786e56', '#a2957a', '#6c634c', '#8b8066'], 0.5, 2.3);

  // 田界：几道很淡的直线，暗示这一带被人耕过
  for (let i = 0; i < 7; i++) {
    const vertical = r() > 0.5;
    const p = r() * SIZE;
    g.strokeStyle = `rgba(126,116,92,${0.16 + r() * 0.14})`;
    g.lineWidth = 1 + r();
    g.beginPath();
    if (vertical) { g.moveTo(p, 0); g.lineTo(p, SIZE); }
    else { g.moveTo(0, p); g.lineTo(SIZE, p); }
    g.stroke();
  }

  // 稀疏草丛。只是点缀，不能连成一片绿
  for (let i = 0; i < 340; i++) {
    const x = r() * SIZE, y = r() * SIZE;
    g.strokeStyle = `rgba(${106 + r() * 30 | 0},${112 + r() * 26 | 0},${72 + r() * 24 | 0},${0.30 + r() * 0.34})`;
    g.lineWidth = 0.8 + r() * 0.9;
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (r() - 0.5) * 5, y - 3 - r() * 4);
      g.stroke();
    }
  }

  const b = canvas();
  b.g.fillStyle = '#7d7d7d';
  b.g.fillRect(0, 0, SIZE, SIZE);
  speckle(b.g, 211, 4600, ['#949494', '#666', '#a0a0a0', '#585858'], 0.5, 2.3);
  const r2 = rnd(227);
  for (let i = 0; i < 340; i++) {
    b.g.strokeStyle = `rgba(210,210,210,${0.3 + r2() * 0.4})`;
    b.g.lineWidth = 0.9;
    const x = r2() * SIZE, y = r2() * SIZE;
    b.g.beginPath();
    b.g.moveTo(x, y);
    b.g.lineTo(x + (r2() - 0.5) * 5, y - 4);
    b.g.stroke();
  }

  return { map: toTexture(c), bump: toBump(b.c) };
}

function stone(): { map: THREE.Texture; bump: THREE.Texture } {
  const { c, g } = canvas();
  g.fillStyle = '#8e8b83';
  g.fillRect(0, 0, SIZE, SIZE);
  speckle(g, 131, 2400, ['#9d9a91', '#7d7a72', '#a6a39a', '#6e6b64'], 0.5, 2.2);
  // 条石的缝
  const r = rnd(137);
  for (let y = 0; y < SIZE; y += 42) {
    g.strokeStyle = 'rgba(70,68,62,0.55)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, y); g.lineTo(SIZE, y); g.stroke();
    const off = r() * 60;
    for (let x = off; x < SIZE; x += 78) {
      g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 42); g.stroke();
    }
  }
  const b = canvas();
  b.g.fillStyle = '#8a8a8a';
  b.g.fillRect(0, 0, SIZE, SIZE);
  speckle(b.g, 131, 2400, ['#a0a0a0', '#6a6a6a'], 0.5, 2.2);
  const r2 = rnd(137);
  for (let y = 0; y < SIZE; y += 42) {
    b.g.strokeStyle = 'rgba(20,20,20,0.8)';
    b.g.lineWidth = 3;
    b.g.beginPath(); b.g.moveTo(0, y); b.g.lineTo(SIZE, y); b.g.stroke();
    const off = r2() * 60;
    for (let x = off; x < SIZE; x += 78) {
      b.g.beginPath(); b.g.moveTo(x, y); b.g.lineTo(x, y + 42); b.g.stroke();
    }
  }
  return { map: toTexture(c), bump: toBump(b.c) };
}

// ─────────────────────────────────────────────────────────────
// 材质库。全部走 MeshStandardMaterial —— 要真实的光照响应，就不能用 Lambert
// ─────────────────────────────────────────────────────────────

export interface Materials {
  earth: THREE.MeshStandardMaterial;
  tile: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  woodDark: THREE.MeshStandardMaterial;
  thatch: THREE.MeshStandardMaterial;
  dirt: THREE.MeshStandardMaterial;
  /** 郊野的地。靠明度与肌理和夯土墙拉开距离，建筑才有剪影 */
  grass: THREE.MeshStandardMaterial;
  road: THREE.MeshStandardMaterial;
  stone: THREE.MeshStandardMaterial;
  water: THREE.MeshStandardMaterial;
  cloth: THREE.MeshStandardMaterial;
  banner: THREE.MeshStandardMaterial;
  /** 田地。颜色随季节换 */
  field: THREE.MeshStandardMaterial;
  crop: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  robeA: THREE.MeshStandardMaterial;
  robeB: THREE.MeshStandardMaterial;
}

let cached: Materials | null = null;

export function materials(): Materials {
  if (cached) return cached;

  const e = rammedEarth();
  const t = roofTile();
  const w = wood();
  const th = thatch();
  const d = dirt();
  const st = stone();
  const gr = wildland();

  const std = (
    o: THREE.MeshStandardMaterialParameters,
  ): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial(o);

  cached = {
    earth: std({ map: e.map, bumpMap: e.bump, bumpScale: 1.1, roughness: 0.95, metalness: 0 }),
    tile: std({ map: t.map, bumpMap: t.bump, bumpScale: 1.8, roughness: 0.72, metalness: 0 }),
    wood: std({ map: w.map, bumpMap: w.bump, bumpScale: 0.9, roughness: 0.85, metalness: 0 }),
    woodDark: std({
      map: w.map, bumpMap: w.bump, bumpScale: 0.5, roughness: 0.9,
      metalness: 0, color: 0x8a7358,
    }),
    thatch: std({ map: th.map, bumpMap: th.bump, bumpScale: 2.0, roughness: 1, metalness: 0 }),
    dirt: std({ map: d.map, bumpMap: d.bump, bumpScale: 0.5, roughness: 1, metalness: 0 }),
    grass: std({ map: gr.map, bumpMap: gr.bump, bumpScale: 1.0, roughness: 1, metalness: 0 }),
    road: std({
      map: d.map, bumpMap: d.bump, bumpScale: 0.35, roughness: 1,
      metalness: 0, color: 0xc4b393,
    }),
    stone: std({ map: st.map, bumpMap: st.bump, bumpScale: 1.1, roughness: 0.9, metalness: 0 }),
    water: std({
      // 中原的河是含沙的，不是海蓝
      color: 0x5b7078, roughness: 0.2, metalness: 0.1,
      transparent: true, opacity: 0.9,
    }),
    cloth: std({ color: 0xc9b998, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }),
    banner: std({ color: 0x8e2f24, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }),
    field: std({ color: 0x6f7a45, roughness: 1, metalness: 0 }),
    crop: std({ color: 0x8a9448, roughness: 1, metalness: 0 }),
    skin: std({ color: 0xc9a487, roughness: 0.9, metalness: 0 }),
    robeA: std({ color: 0x6b6558, roughness: 0.95, metalness: 0 }),
    robeB: std({ color: 0x4e5560, roughness: 0.95, metalness: 0 }),
  };
  return cached;
}

/**
 * 四时换色。冬天田是裸土，秋天是金黄 —— 季节必须看得见。
 * grass 一栏给郊野的大地用（materials().grass.color）。
 */
export const SEASON_FIELD: Record<string, { field: number; crop: number; grass: number }> = {
  spring: { field: 0x7d7c48, crop: 0x8fa04e, grass: 0xe8e4d2 },
  summer: { field: 0x5f7038, crop: 0x6d8a3c, grass: 0xdce0c8 },
  autumn: { field: 0x9a8442, crop: 0xc2a24e, grass: 0xf2e4c4 },
  winter: { field: 0x8a8272, crop: 0x9a917e, grass: 0xdadad6 },
};
