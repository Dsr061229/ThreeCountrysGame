/**
 * 几何构件 —— 汉代形制，全部由代码生成，不依赖任何外部模型。
 *
 * 取舍原则：城池视角下每块地只占屏幕几十像素，微观细节看不见。
 * 所以力气花在**剪影、阴影、物件密度**上 ——
 * 出檐够不够深、屋顶比例对不对、院子里有没有堆着柴和瓮，
 * 这些决定了它像不像一座真的汉代县城。
 */
import * as THREE from 'three';
import { materials } from './textures.ts';

const M = (): ReturnType<typeof materials> => materials();

/**
 * 接地阴影。
 *
 * 建筑与地面接触的那一圈暗，是立体感最大的来源 —— 没有它，
 * 房子看起来像浮在地上的贴纸。做成一张径向渐变的贴片压在地面上，
 * 比全屏 SSAO 便宜两个数量级，而在固定俯角下效果几乎一样。
 */
let aoTexture: THREE.CanvasTexture | null = null;

function contactShadowTexture(): THREE.CanvasTexture {
  if (aoTexture) return aoTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0,0,0,0.60)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.32)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  aoTexture = new THREE.CanvasTexture(c);
  return aoTexture;
}

/**
 * 装饰件用的共享材质。
 *
 * 这些一定要共享，不能每次调用都 new 一个 ——
 * 几何合并是按材质分桶的，材质实例各不相同就等于完全没合并，
 * 一片接地阴影就是一个 draw call。这条曾经让天下图跑到 4 FPS。
 */
let shared: {
  ao: THREE.MeshBasicMaterial;
  dark: THREE.MeshStandardMaterial;
  leaf: THREE.MeshStandardMaterial;
  pottery: THREE.MeshStandardMaterial;
  goods: THREE.MeshStandardMaterial[];
} | null = null;

function sharedMats(): NonNullable<typeof shared> {
  if (shared) return shared;
  const std = (color: number, roughness = 1): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color, roughness });
  shared = {
    ao: new THREE.MeshBasicMaterial({
      map: contactShadowTexture(), transparent: true, depthWrite: false, opacity: 0.85,
    }),
    dark: std(0x1a1613),
    leaf: std(0x4e5c33),
    pottery: std(0x6b5544, 0.9),
    goods: [0x8a7a4e, 0x6c5e42, 0x93704a, 0x5d6b4a].map((c) => std(c, 0.95)),
  };
  return shared;
}

/** 压在地面上的一片接地阴影。w/d 是覆盖范围 */
export function contactShadow(w: number, d = w): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), sharedMats().ao);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.035;
  m.renderOrder = 1;
  return m;
}

function mesh(
  geo: THREE.BufferGeometry, mat: THREE.Material,
  x = 0, y = 0, z = 0, rotY = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.y = rotY;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function box(w: number, h: number, d: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────
// 屋顶
// ─────────────────────────────────────────────────────────────

/**
 * 悬山顶的一面坡。做成带瓦垄起伏的曲面 ——
 * 汉代屋面已有微微的凹曲（举折），直板的斜面会立刻显得像纸盒子。
 */
function slopeGeometry(w: number, run: number, rise: number, ridges: number): THREE.BufferGeometry {
  const segX = Math.max(6, ridges);
  const segZ = 6;
  const g = new THREE.PlaneGeometry(w, Math.hypot(run, rise), segX, segZ);
  const pos = g.attributes['position'] as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    // 瓦垄：沿面阔方向的细微起伏
    const ridge = Math.sin((x / w) * Math.PI * 2 * ridges) * 0.028;
    pos.setZ(i, ridge);
  }
  g.computeVertexNormals();
  return g;
}

export interface RoofOpts {
  /** 面阔 */ w: number;
  /** 进深 */ d: number;
  /** 举高 */ rise: number;
  /** 出檐 */ eave: number;
}

/** 悬山顶：两坡 + 两山墙 + 正脊。汉代最常见的做法 */
function gableRoof(o: RoofOpts): THREE.Group {
  const g = new THREE.Group();
  const m = M();
  const W = o.w + o.eave * 2;
  const D = o.d + o.eave * 2;
  const half = D / 2;
  const angle = Math.atan2(o.rise, half);
  const ridges = Math.max(5, Math.round(W / 0.42));

  for (const sign of [1, -1]) {
    // PlaneGeometry 立在 XY 面上，绕 X 轴转到坡面的角度
    const s = mesh(slopeGeometry(W, half, o.rise, ridges), m.tile);
    s.rotation.order = 'YXZ';
    s.rotation.set(sign > 0 ? -(Math.PI / 2 - angle) : (Math.PI / 2 - angle), 0, 0);
    s.position.set(0, o.rise / 2, (sign * half) / 2);
    g.add(s);
  }

  // 正脊：一道厚实的横梁，是屋顶剪影的关键
  const ridge = mesh(box(W + 0.12, 0.16, 0.3), m.tile, 0, o.rise + 0.06, 0);
  g.add(ridge);
  // 脊两端微微翘起
  for (const sx of [-1, 1]) {
    g.add(mesh(box(0.28, 0.22, 0.32), m.tile, (sx * (W + 0.12)) / 2, o.rise + 0.14, 0));
  }

  // 山墙：把两坡之间的三角形补上
  const gableShape = new THREE.Shape();
  gableShape.moveTo(-half, 0);
  gableShape.lineTo(half, 0);
  gableShape.lineTo(0, o.rise);
  gableShape.closePath();
  const gableGeo = new THREE.ShapeGeometry(gableShape);
  for (const sx of [-1, 1]) {
    const gm = mesh(gableGeo, M().earth, (sx * W) / 2, 0, 0);
    gm.rotation.y = Math.PI / 2;
    g.add(gm);
  }

  return g;
}

// ─────────────────────────────────────────────────────────────
// 建筑
// ─────────────────────────────────────────────────────────────

export interface HallOpts {
  w?: number;
  d?: number;
  h?: number;
  eave?: number;
  /** 台基高度，0 为无台基 */ podium?: number;
  /** 正面柱子数量 */ columns?: number;
  thatchRoof?: boolean;
  seed?: number;
}

/** 一座正经的房子：台基 + 檐柱 + 夯土墙 + 出檐深远的屋顶 */
export function hall(o: HallOpts = {}): THREE.Group {
  const {
    w = 4, d = 3, h = 2.3, eave = 0.75, podium = 0.3,
    columns = 4, thatchRoof = false, seed = 1,
  } = o;
  const m = M();
  const g = new THREE.Group();
  g.add(contactShadow((w + eave * 2) * 1.5, (d + eave * 2) * 1.5));
  let y = 0;

  if (podium > 0) {
    g.add(mesh(box(w + 1.0, podium, d + 1.0), m.stone, 0, podium / 2, 0));
    y = podium;
  }

  // 墙。略微内收，汉代墙体下大上小
  const wall = mesh(box(w, h, d), m.earth, 0, y + h / 2, 0);
  wall.scale.set(1, 1, 1);
  g.add(wall);

  // 檐柱：立在台基边缘，撑起出檐。这是「木构」读得出来的关键
  const colGeo = new THREE.CylinderGeometry(0.1, 0.12, h + 0.15, 8);
  for (let i = 0; i < columns; i++) {
    const t = columns === 1 ? 0.5 : i / (columns - 1);
    const x = -w / 2 + t * w;
    g.add(mesh(colGeo, m.woodDark, x, y + (h + 0.15) / 2, d / 2 + eave * 0.55));
    g.add(mesh(colGeo, m.woodDark, x, y + (h + 0.15) / 2, -d / 2 - eave * 0.55));
  }

  // 额枋：柱头之间的横木
  g.add(mesh(box(w + eave * 1.1, 0.13, 0.13), m.wood, 0, y + h + 0.02, d / 2 + eave * 0.55));
  g.add(mesh(box(w + eave * 1.1, 0.13, 0.13), m.wood, 0, y + h + 0.02, -d / 2 - eave * 0.55));

  // 门与直棂窗
  g.add(mesh(box(0.9, h * 0.72, 0.08), m.woodDark, 0, y + h * 0.36, d / 2 + 0.02));
  const r = rng(seed);
  for (const sx of [-1, 1]) {
    const wx = sx * (w * 0.3);
    if (Math.abs(wx) < 0.6) continue;
    g.add(mesh(box(0.62, 0.5, 0.06), m.woodDark, wx, y + h * 0.62, d / 2 + 0.02));
    for (let k = 0; k < 4; k++) {
      g.add(mesh(box(0.05, 0.44, 0.04), m.wood, wx - 0.22 + k * 0.15, y + h * 0.62, d / 2 + 0.05));
    }
  }

  const rise = Math.max(0.75, Math.min(w, d) * 0.4);
  const roof = thatchRoof ? thatchGable(w + eave * 2, d + eave * 2, rise) : gableRoof({ w, d, rise, eave });
  roof.position.y = y + h;
  g.add(roof);

  // 檐下随意堆的杂物，密度决定「有人住」的感觉
  if (r() > 0.4) g.add(placed(jar(), -w / 2 + 0.35, 0, d / 2 + eave * 0.4));
  if (r() > 0.5) g.add(placed(firewood(seed + 3), w / 2 - 0.4, 0, d / 2 + eave * 0.5));

  return g;
}

/** 茅草的两坡顶，给民居和小屋用 */
function thatchGable(W: number, D: number, rise: number): THREE.Group {
  const g = new THREE.Group();
  const m = M();
  const half = D / 2;
  const angle = Math.atan2(rise, half);
  const slopeLen = Math.hypot(half, rise);
  for (const sign of [1, -1]) {
    const s = mesh(new THREE.PlaneGeometry(W, slopeLen, 4, 4), m.thatch);
    s.rotation.order = 'YXZ';
    s.rotation.set(sign > 0 ? -(Math.PI / 2 - angle) : (Math.PI / 2 - angle), 0, 0);
    s.position.set(0, rise / 2, (sign * half) / 2);
    s.material = m.thatch;
    g.add(s);
  }
  g.add(mesh(box(W + 0.1, 0.18, 0.26), m.thatch, 0, rise + 0.05, 0));
  const shape = new THREE.Shape();
  shape.moveTo(-half, 0); shape.lineTo(half, 0); shape.lineTo(0, rise); shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  for (const sx of [-1, 1]) {
    const gm = mesh(geo, m.earth, (sx * W) / 2, 0, 0);
    gm.rotation.y = Math.PI / 2;
    g.add(gm);
  }
  return g;
}

/** 茅屋。民居的基本单元 */
export function hut(seed = 1): THREE.Group {
  const r = rng(seed);
  const w = 2.0 + r() * 0.7, d = 1.7 + r() * 0.5, h = 1.5 + r() * 0.25;
  const m = M();
  const g = new THREE.Group();
  g.add(contactShadow((w + 0.8) * 1.6, (d + 0.8) * 1.6));
  g.add(mesh(box(w, h, d), m.earth, 0, h / 2, 0));
  g.add(mesh(box(0.62, h * 0.7, 0.07), m.woodDark, 0, h * 0.35, d / 2 + 0.02));
  const roof = thatchGable(w + 0.8, d + 0.8, 0.62 + r() * 0.2);
  roof.position.y = h;
  g.add(roof);
  return g;
}

/**
 * 粮囤。汉代的圆囤，下面架空防潮，顶上覆草，是粮仓最好认的形象。
 */
export function granaryBin(seed = 1): THREE.Group {
  const r = rng(seed);
  const m = M();
  const g = new THREE.Group();
  const rad = 0.75 + r() * 0.2, h = 1.5 + r() * 0.3;
  g.add(contactShadow((rad + 0.35) * 3.2));
  // 架空的木础
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    g.add(mesh(
      new THREE.CylinderGeometry(0.08, 0.09, 0.35, 6), m.woodDark,
      Math.cos(a) * rad * 0.6, 0.175, Math.sin(a) * rad * 0.6,
    ));
  }
  g.add(mesh(new THREE.CylinderGeometry(rad + 0.06, rad + 0.06, 0.1, 14), m.wood, 0, 0.4, 0));
  g.add(mesh(new THREE.CylinderGeometry(rad, rad * 0.98, h, 14), m.earth, 0, 0.45 + h / 2, 0));
  // 束腰的竹箍
  for (const t of [0.25, 0.6, 0.9]) {
    const hoop = mesh(new THREE.TorusGeometry(rad + 0.02, 0.035, 5, 14), m.wood, 0, 0.45 + h * t, 0);
    hoop.rotation.x = Math.PI / 2;
    g.add(hoop);
  }
  const cap = mesh(new THREE.ConeGeometry(rad + 0.35, 0.68, 14), m.thatch, 0, 0.45 + h + 0.34, 0);
  g.add(cap);
  return g;
}

/** 井：井栏 + 辘轳架 */
export function wellHead(): THREE.Group {
  const m = M();
  const g = new THREE.Group();
  g.add(contactShadow(2.6));
  g.add(mesh(new THREE.CylinderGeometry(0.52, 0.58, 0.42, 12), m.stone, 0, 0.21, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.44, 12), sharedMats().dark, 0, 0.23, 0));
  for (const sx of [-1, 1]) {
    g.add(mesh(new THREE.CylinderGeometry(0.055, 0.065, 1.15, 6), m.woodDark, sx * 0.52, 0.58, 0));
  }
  g.add(mesh(box(1.3, 0.09, 0.09), m.wood, 0, 1.13, 0));
  const winch = mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.7, 8), m.wood, 0, 1.02, 0);
  winch.rotation.z = Math.PI / 2;
  g.add(winch);
  g.add(placed(jar(), 0.85, 0, 0.5));
  return g;
}

/** 市集摊棚 */
export function stall(seed = 1): THREE.Group {
  const r = rng(seed);
  const m = M();
  const g = new THREE.Group();
  const w = 1.9 + r() * 0.5, d = 1.3;
  g.add(contactShadow(w * 2.2, d * 3));
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    g.add(mesh(new THREE.CylinderGeometry(0.045, 0.05, 1.55, 5), m.woodDark,
      (sx * w) / 2, 0.775, (sz * d) / 2));
  }
  // 布幔：一面斜挂
  const awn = mesh(new THREE.PlaneGeometry(w + 0.5, d + 0.9), m.cloth, 0, 1.62, 0);
  awn.rotation.x = -Math.PI / 2 + 0.16;
  g.add(awn);
  // 案板与货
  g.add(mesh(box(w, 0.09, d * 0.8), m.wood, 0, 0.82, 0));
  const goods = sharedMats().goods;
  for (let i = 0; i < 4 + Math.floor(r() * 4); i++) {
    const gm = goods[Math.floor(r() * goods.length)]!;
    g.add(mesh(
      new THREE.SphereGeometry(0.09 + r() * 0.07, 6, 5),
      gm,
      -w / 2 + 0.2 + r() * (w - 0.4), 0.92, -d * 0.3 + r() * d * 0.6,
    ));
  }
  return g;
}

/** 陶窑：工坊的标志物，顶上会冒烟 */
export function kiln(): THREE.Group {
  const m = M();
  const g = new THREE.Group();
  g.add(contactShadow(4.2));
  g.add(mesh(new THREE.CylinderGeometry(0.85, 1.15, 1.7, 12), m.earth, 0, 0.85, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.3, 0.42, 0.7, 10), m.earth, 0, 2.0, 0));
  g.add(mesh(box(0.5, 0.55, 0.3), sharedMats().dark, 0, 0.3, 1.1));
  for (let i = 0; i < 3; i++) g.add(placed(jar(), -1.5 + i * 0.55, 0, 1.5));
  return g;
}

/** 军帐 */
export function tent(seed = 1): THREE.Group {
  const r = rng(seed);
  const m = M();
  const g = new THREE.Group();
  const w = 1.9 + r() * 0.4;
  g.add(contactShadow(w * 3));
  const body = mesh(new THREE.ConeGeometry(w, 1.7, 6), m.cloth, 0, 0.85, 0);
  body.rotation.y = r() * 1.2;
  g.add(body);
  g.add(mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.4, 5), m.woodDark, 0, 1.2, 0));
  return g;
}

/** 兵器架 */
export function weaponRack(): THREE.Group {
  const m = M();
  const g = new THREE.Group();
  g.add(mesh(box(1.8, 0.08, 0.1), m.wood, 0, 1.0, 0));
  for (const sx of [-1, 1]) g.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.05, 5), m.woodDark, sx * 0.85, 0.52, 0));
  for (let i = 0; i < 6; i++) {
    const s = mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.9, 4), m.woodDark, -0.75 + i * 0.3, 0.95, 0);
    s.rotation.x = 0.12;
    g.add(s);
  }
  return g;
}

/**
 * 旗号。
 *
 * 旗上要有字。
 *
 * 这不只是考据 —— 在天下图那个尺度上，一面纯色小旗根本认不出是谁的，
 * 而「曹」「袁」「孫」这样一个字，一眼就读得出来。汉代军旗本来也是这么用的。
 * 做成竖幅（纵幅悬于横杆），比横幅在斜俯视下的可读面积大得多。
 */
const glyphCache = new Map<string, THREE.CanvasTexture>();

export function glyphTexture(glyph: string): THREE.CanvasTexture {
  const cached = glyphCache.get(glyph);
  if (cached) return cached;

  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d')!;
  // 底色留白，颜色交给材质的 color 去乘 —— 这样换势力不必重画贴图
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 128, 256);
  // 边缘压深一点，模拟布幅的卷边
  g.fillStyle = 'rgba(0,0,0,0.16)';
  g.fillRect(0, 0, 128, 8);
  g.fillRect(0, 248, 128, 8);
  g.fillStyle = 'rgba(20,16,12,0.92)';
  g.font = '700 92px "Songti SC", "SimSun", "Noto Serif CJK SC", serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(glyph, 64, 116);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  glyphCache.set(glyph, tex);
  return tex;
}

/** 带旗号字的竖幅军旗。返回旗面本身，方便之后换颜色 */
export function bannerFlag(
  glyph: string, height = 8, width = 1.9,
): { group: THREE.Group; flag: THREE.Mesh } {
  const m = M();
  const g = new THREE.Group();
  const poleR = Math.max(0.07, width * 0.05);
  g.add(mesh(new THREE.CylinderGeometry(poleR, poleR * 1.25, height, 7), m.woodDark, 0, height / 2, 0));
  // 横杆
  g.add(mesh(box(width * 1.12, poleR * 1.6, poleR * 1.6), m.wood, width * 0.5, height - 0.2, 0));

  const flagH = width * 2.1;
  const geo = new THREE.PlaneGeometry(width, flagH, 6, 8);
  const pos = geo.attributes['position'] as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    // 风吹起来的波，越往外摆幅越大
    const t = (pos.getX(i) + width / 2) / width;
    pos.setZ(i, Math.sin(t * 5.2) * width * 0.12 * t);
  }
  geo.computeVertexNormals();

  const flag = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: glyphTexture(glyph),
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  }));
  flag.position.set(width * 0.5, height - 0.28 - flagH / 2, 0);
  flag.castShadow = true;
  g.add(flag);
  return { group: g, flag };
}

/** 旗杆与旗（无字，城内装饰用） */
export function banner(height = 3.4): THREE.Group {
  const m = M();
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.055, 0.07, height, 6), m.woodDark, 0, height / 2, 0));
  const flag = mesh(new THREE.PlaneGeometry(0.75, 1.5, 4, 4), m.banner, 0.4, height - 0.95, 0);
  const pos = flag.geometry.attributes['position'] as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, Math.sin((pos.getX(i) + 0.375) * 5) * 0.09);
  }
  flag.geometry.computeVertexNormals();
  g.add(flag);
  return g;
}

// ─────────────────────────────────────────────────────────────
// 地块表面：田、水、地
// ─────────────────────────────────────────────────────────────

/** 田垄。一条条起伏的垄沟，是农田最好认的特征 */
export function fieldPatch(w: number, d: number, level: number, seed = 1): THREE.Group {
  const g = new THREE.Group();
  const m = M();
  const base = mesh(new THREE.PlaneGeometry(w, d), m.field, 0, 0.02, 0);
  base.rotation.x = -Math.PI / 2;
  base.castShadow = false;
  g.add(base);

  const r = rng(seed);
  const rows = Math.min(14, 5 + level * 2);
  const rowGeo = box(w * 0.9, 0.09, 0.16);
  for (let i = 0; i < rows; i++) {
    const z = -d / 2 + (d / (rows + 1)) * (i + 1);
    g.add(mesh(rowGeo, m.dirt, 0, 0.06, z));
  }
  // 作物：等级越高越密
  const clumps = level * 14;
  const cropGeo = new THREE.ConeGeometry(0.09, 0.34, 4);
  for (let i = 0; i < clumps; i++) {
    const x = -w / 2 + 0.3 + r() * (w - 0.6);
    const z = -d / 2 + 0.3 + r() * (d - 0.6);
    const c = mesh(cropGeo, m.crop, x, 0.19, z);
    c.rotation.y = r() * 3;
    c.castShadow = false;
    g.add(c);
  }
  // 田埂上的稻草堆
  if (level >= 3) g.add(placed(haystack(seed), w / 2 - 0.7, 0, -d / 2 + 0.7));
  return g;
}

/** 陂塘：蓄水的池子，带土堤 */
export function pondPatch(w: number, d: number): THREE.Group {
  const g = new THREE.Group();
  const m = M();
  const water = mesh(new THREE.PlaneGeometry(w - 1.0, d - 1.0), m.water, 0, 0.06, 0);
  water.rotation.x = -Math.PI / 2;
  water.castShadow = false;
  g.add(water);
  // 堤
  const bankH = 0.3;
  for (const [bw, bd, bx, bz] of [
    [w, bankH, 0, -d / 2 + 0.35],
    [w, bankH, 0, d / 2 - 0.35],
  ] as const) {
    g.add(mesh(box(bw, bankH, 0.7), m.dirt, bx, bd / 2, bz));
  }
  for (const sx of [-1, 1]) {
    g.add(mesh(box(0.7, bankH, d - 1.4), m.dirt, (sx * (w - 0.7)) / 2, bankH / 2, 0));
  }
  return g;
}

// ─────────────────────────────────────────────────────────────
// 杂物 —— 密度决定「有人住」的感觉
// ─────────────────────────────────────────────────────────────

function placed(o: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
  o.position.set(x, y, z);
  return o;
}

export function jar(): THREE.Mesh {
  const geo = new THREE.LatheGeometry([
    new THREE.Vector2(0.02, 0), new THREE.Vector2(0.14, 0.02), new THREE.Vector2(0.2, 0.16),
    new THREE.Vector2(0.16, 0.3), new THREE.Vector2(0.11, 0.36), new THREE.Vector2(0.13, 0.4),
  ], 10);
  return mesh(geo, sharedMats().pottery);
}

export function firewood(seed = 1): THREE.Group {
  const r = rng(seed);
  const g = new THREE.Group();
  const m = M();
  const logGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.75, 5);
  for (let i = 0; i < 9; i++) {
    const l = mesh(logGeo, m.woodDark,
      (r() - 0.5) * 0.35, 0.06 + Math.floor(i / 3) * 0.11, (r() - 0.5) * 0.3);
    l.rotation.z = Math.PI / 2;
    l.rotation.y = r() * 0.5;
    g.add(l);
  }
  return g;
}

export function haystack(seed = 1): THREE.Group {
  const r = rng(seed);
  const g = new THREE.Group();
  g.add(mesh(new THREE.ConeGeometry(0.55 + r() * 0.15, 1.0 + r() * 0.3, 8), M().thatch, 0, 0.55, 0));
  return g;
}

export function tree(scale = 1, seed = 1): THREE.Group {
  const r = rng(seed);
  const m = M();
  const g = new THREE.Group();
  g.add(contactShadow(2.2 * scale));
  const h = (1.6 + r() * 0.7) * scale;
  g.add(mesh(new THREE.CylinderGeometry(0.09 * scale, 0.16 * scale, h, 7), m.woodDark, 0, h / 2, 0));
  const leaf = sharedMats().leaf;
  for (let i = 0; i < 3; i++) {
    const rad = (0.62 - i * 0.12) * scale;
    const s = mesh(new THREE.IcosahedronGeometry(rad, 0), leaf,
      (r() - 0.5) * 0.35 * scale, h + i * 0.34 * scale - 0.1, (r() - 0.5) * 0.35 * scale);
    s.rotation.set(r() * 3, r() * 3, r() * 3);
    g.add(s);
  }
  return g;
}

export function cart(): THREE.Group {
  const m = M();
  const g = new THREE.Group();
  g.add(mesh(box(1.2, 0.12, 0.8), m.wood, 0, 0.42, 0));
  for (const sx of [-1, 1]) {
    const wheel = mesh(new THREE.TorusGeometry(0.34, 0.055, 5, 12), m.woodDark, sx * 0.45, 0.34, 0);
    wheel.rotation.y = Math.PI / 2;
    g.add(wheel);
  }
  g.add(mesh(box(0.08, 0.08, 1.2), m.woodDark, 0, 0.46, 0.9));
  return g;
}

export function fence(len: number, seed = 1): THREE.Group {
  const r = rng(seed);
  const g = new THREE.Group();
  const m = M();
  const n = Math.max(2, Math.round(len / 0.42));
  for (let i = 0; i < n; i++) {
    const p = mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.72 + r() * 0.14, 5), m.woodDark,
      -len / 2 + (len / (n - 1)) * i, 0.36, 0);
    p.rotation.z = (r() - 0.5) * 0.12;
    g.add(p);
  }
  g.add(mesh(box(len, 0.05, 0.05), m.wood, 0, 0.56, 0));
  return g;
}

/** 在建工地：脚手架 + 土堆 + 材料 */
export function scaffold(w = 3, d = 2.4, seed = 1): THREE.Group {
  const r = rng(seed);
  const m = M();
  const g = new THREE.Group();
  g.add(mesh(box(w, 0.22, d), m.dirt, 0, 0.11, 0));
  const postGeo = new THREE.CylinderGeometry(0.05, 0.055, 1.9, 5);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    g.add(mesh(postGeo, m.woodDark, (sx * w) / 2.4, 0.95, (sz * d) / 2.4));
  }
  for (const y of [0.7, 1.4]) {
    g.add(mesh(box(w / 1.2, 0.06, 0.06), m.wood, 0, y, -d / 2.4));
    g.add(mesh(box(w / 1.2, 0.06, 0.06), m.wood, 0, y, d / 2.4));
  }
  g.add(mesh(new THREE.ConeGeometry(0.5, 0.5, 7), m.dirt, w / 2 - 0.3, 0.25, d / 2 - 0.3));
  for (let i = 0; i < 3; i++) {
    g.add(mesh(box(0.7, 0.1, 0.22), m.stone, -w / 2 + 0.5, 0.27 + i * 0.11, -d / 2 + 0.5 + r() * 0.2));
  }
  return g;
}

// ─────────────────────────────────────────────────────────────
// 人
// ─────────────────────────────────────────────────────────────

/**
 * 一个人。深衣的锥形轮廓 + 头 + 束发。
 * 城池视角下只有十几个像素高，所以剪影比细节重要得多。
 */
export function person(alt = false): THREE.Group {
  const m = M();
  const g = new THREE.Group();
  const robe = alt ? m.robeB : m.robeA;
  g.add(mesh(new THREE.CylinderGeometry(0.11, 0.2, 0.62, 7), robe, 0, 0.31, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.14, 6), robe, 0, 0.68, 0));
  g.add(mesh(new THREE.SphereGeometry(0.095, 7, 6), m.skin, 0, 0.8, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.07, 0.085, 0.08, 6), m.robeB, 0, 0.88, 0));
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

// ─────────────────────────────────────────────────────────────
// 兵
// ─────────────────────────────────────────────────────────────

/**
 * 三个兵种要一眼分得出来。
 *
 * 在战场那个尺度下，一个人只有十几个像素高 —— 靠脸、靠衣服颜色都认不出，
 * **只有剪影能认**。所以步卒直立持矛、弓弩半蹲张弓、骑兵骑在马上，
 * 三个轮廓从任何角度看都不一样。
 */
export function soldier(kind: 'foot' | 'bow' | 'horse', alt = false): THREE.Group {
  const m = M();
  const g = new THREE.Group();
  const robe = alt ? m.robeB : m.robeA;

  if (kind === 'horse') {
    // 马：一个厚身子 + 四条腿 + 脖子和头。骑手坐在上面，整体比步卒高出一大截
    const body = mesh(new THREE.BoxGeometry(0.36, 0.34, 0.92), m.woodDark, 0, 0.66, 0);
    g.add(body);
    for (const [lx, lz] of [[-0.13, -0.32], [0.13, -0.32], [-0.13, 0.32], [0.13, 0.32]] as const) {
      g.add(mesh(new THREE.CylinderGeometry(0.055, 0.045, 0.5, 5), m.woodDark, lx, 0.25, lz));
    }
    const neck = mesh(new THREE.BoxGeometry(0.2, 0.42, 0.2), m.woodDark, 0, 0.92, -0.46);
    neck.rotation.x = 0.42;
    g.add(neck);
    g.add(mesh(new THREE.BoxGeometry(0.17, 0.18, 0.3), m.woodDark, 0, 1.1, -0.6));
    // 骑手
    g.add(mesh(new THREE.CylinderGeometry(0.13, 0.19, 0.5, 6), robe, 0, 1.08, 0.04));
    g.add(mesh(new THREE.SphereGeometry(0.1, 7, 6), m.skin, 0, 1.4, 0.04));
    g.add(mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.09, 6), m.robeB, 0, 1.48, 0.04));
    // 长矛斜挑
    const lance = mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.5, 4), m.wood, 0.2, 1.15, 0.1);
    lance.rotation.z = 0.42;
    lance.rotation.x = -0.22;
    g.add(lance);
    g.traverse((o) => { o.castShadow = true; });
    return g;
  }

  if (kind === 'bow') {
    // 半蹲：比步卒矮一截，轮廓更紧
    g.add(mesh(new THREE.CylinderGeometry(0.13, 0.22, 0.46, 7), robe, 0, 0.23, 0));
    g.add(mesh(new THREE.SphereGeometry(0.095, 7, 6), m.skin, 0, 0.56, 0));
    g.add(mesh(new THREE.CylinderGeometry(0.07, 0.085, 0.08, 6), m.robeB, 0, 0.64, 0));
    // 弓：一段圆环，横在身前
    const bow = mesh(new THREE.TorusGeometry(0.26, 0.022, 4, 10, Math.PI * 1.15), m.woodDark, 0.16, 0.44, 0.1);
    bow.rotation.y = Math.PI / 2;
    bow.rotation.z = Math.PI / 2;
    g.add(bow);
    g.traverse((o) => { o.castShadow = true; });
    return g;
  }

  // 步卒：直立，一杆长矛竖着 —— 一片矛林是最好认的剪影
  g.add(mesh(new THREE.CylinderGeometry(0.11, 0.2, 0.62, 7), robe, 0, 0.31, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.14, 6), robe, 0, 0.68, 0));
  g.add(mesh(new THREE.SphereGeometry(0.095, 7, 6), m.skin, 0, 0.8, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.07, 0.085, 0.08, 6), m.robeB, 0, 0.88, 0));
  const spear = mesh(new THREE.CylinderGeometry(0.022, 0.022, 1.55, 4), m.wood, 0.18, 0.72, 0.02);
  spear.rotation.z = -0.08;
  g.add(spear);
  g.add(mesh(new THREE.ConeGeometry(0.045, 0.18, 4), m.stone, 0.24, 1.55, 0.02));
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

// ─────────────────────────────────────────────────────────────
// 城墙
// ─────────────────────────────────────────────────────────────

/** 一段夯土城墙，带女墙 */
export function wallRun(len: number): THREE.Group {
  const m = M();
  const g = new THREE.Group();
  const h = 3.1;
  const body = mesh(new THREE.BoxGeometry(len, h, 1.5), m.earth, 0, h / 2, 0);
  // 收分：城墙上窄下宽
  const pos = body.geometry.attributes['position'] as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) pos.setZ(i, pos.getZ(i) * 0.72);
  }
  body.geometry.computeVertexNormals();
  g.add(body);

  const n = Math.max(3, Math.floor(len / 1.6));
  for (let i = 0; i < n; i++) {
    const x = -len / 2 + 0.8 + (i * (len - 1.6)) / Math.max(1, n - 1);
    g.add(mesh(box(0.85, 0.55, 1.0), m.earth, x, h + 0.27, 0));
  }
  return g;
}

/** 城门楼 */
export function gateTower(): THREE.Group {
  const m = M();
  const g = new THREE.Group();
  g.add(contactShadow(9, 5));
  const w = 6.4, h = 3.6;
  g.add(mesh(box(w, h, 2.4), m.earth, 0, h / 2, 0));
  // 门洞
  const arch = mesh(box(1.9, 2.4, 2.7), sharedMats().dark, 0, 1.2, 0);
  g.add(arch);
  g.add(mesh(box(2.1, 2.5, 0.14), m.woodDark, 0, 1.25, 1.24));
  // 门楼
  const top = hall({ w: 5.2, d: 2.6, h: 1.9, eave: 0.8, podium: 0.18, columns: 5, seed: 9 });
  top.position.y = h;
  g.add(top);
  return g;
}

/** 角楼 */
export function cornerTower(): THREE.Group {
  const m = M();
  const g = new THREE.Group();
  g.add(mesh(box(2.6, 3.6, 2.6), m.earth, 0, 1.8, 0));
  const top = hall({ w: 2.4, d: 2.4, h: 1.5, eave: 0.7, podium: 0.15, columns: 3, seed: 17 });
  top.position.y = 3.6;
  g.add(top);
  return g;
}

export { placed };
