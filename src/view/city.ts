/**
 * 城池场景 —— 伪 3D 的雍丘城。
 *
 * 它只做两件事：把只读状态画出来，把点击翻译成回调。
 * 这里**不允许**出现任何游戏规则；能不能建、够不够钱，都是模拟层的事。
 *
 * 相机固定 45° 斜俯视、正交投影、不可自由旋转 ——
 * 这样每个构件只需要在一个角度下成立，是没有美术团队时唯一可控的做法。
 */
import * as THREE from 'three';
import {
  banner, bannerFlag, cart, cornerTower, fence, fieldPatch, firewood, gateTower,
  granaryBin, hall, haystack, hut, jar, kiln, person, pondPatch, scaffold, stall,
  tent, tree, wallRun, weaponRack, wellHead,
} from './build.ts';
import { materials, SEASON_FIELD } from './textures.ts';
import { SkyDome } from './sky.ts';
import { mergeStatic } from './merge.ts';
import type { City, Plot } from '../sim/types.ts';
import { CITY_SIZE, YAMEN_PLOT } from '../sim/types.ts';
import type { Season } from '../sim/time.ts';

/** 相机到视点的距离。正交投影下它不改变成像大小，只影响雾与裁剪 */
const CAM_DIST = 95;

/**
 * 视觉昼夜的周期，单位是**真实秒**，与游戏速度无关。
 *
 * 这一条很关键：一个游戏日只有 4 秒，如果把昼夜绑在游戏日上，
 * 10 倍速下太阳会 0.4 秒转一圈，那不是昼夜交替，是频闪灯。
 * 所以「日」只作经济结算单位，昼夜是纯粹的氛围，各走各的钟。
 */
const SKY_CYCLE_SECONDS = 240;

/** 视野能推出去多远。有了它就不会把城划丢，也就不需要「回到城中」按钮 */
const PAN_LIMIT = 46;

/** 键盘平移的速度（世界单位／秒，按当前缩放缩放） */
const KEY_PAN_SPEED = 1.15;

/** 一块地的边长与间距（街） */
const PLOT = 8.6;
const STREET = 2.2;
const PITCH = PLOT + STREET;

function plotXZ(index: number): [number, number] {
  const gx = index % CITY_SIZE;
  const gz = Math.floor(index / CITY_SIZE);
  const off = ((CITY_SIZE - 1) * PITCH) / 2;
  return [gx * PITCH - off, gz * PITCH - off];
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 平滑过渡。昼夜的每一项都必须连续插值，任何硬切换都会被眼睛看成闪烁 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

const PAN_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
const WINTER_TINT = new THREE.Color(0.62, 0.69, 0.75);

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** 城外围兵的样貌信息。规则仍在模拟层，这里只管画 */
export interface BesiegerInfo {
  factionId: string;
  banner: string;
  color: string;
  troops: number;
}

export interface CityViewCallbacks {
  onPickPlot: (index: number) => void;
  onHoverPlot: (index: number | null) => void;
}

interface PlotNode {
  group: THREE.Group;
  /** 内容签名。变了才重建，避免每帧重造几何 */
  sig: string;
}

/** 一个在街上走动的人 */
interface Walker {
  obj: THREE.Group;
  /** 沿街道的参数位置 */ t: number;
  speed: number;
  axis: 'x' | 'z';
  lane: number;
}

export class CityView {
  private readonly host: HTMLElement;
  private readonly cb: CityViewCallbacks;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly ambient: THREE.AmbientLight;

  private readonly plotRoot = new THREE.Group();
  private readonly pickTargets: THREE.Mesh[] = [];
  private readonly nodes = new Map<number, PlotNode>();
  private readonly hoverRing: THREE.Mesh;
  private readonly sky: SkyDome;
  private ramparts: THREE.Group | null = null;
  private rampartRing = -1;

  private readonly walkers: Walker[] = [];
  private readonly walkerPool: THREE.Group[] = [];
  private readonly smokes: { mesh: THREE.Points; base: number }[] = [];
  private siegeCamp: THREE.Group | null = null;
  private siegeKey = '';
  private razeMode = false;

  private zoom = 30;
  private panX = 0;
  private panZ = 0;
  private hovered: number | null = null;
  private raf = 0;
  private lastFrame = 0;
  private paused = false;
  private season: Season = 'spring';
  /** 视觉昼夜的相位 0~1：0.25 日出、0.5 正午、0.75 日落 */
  private skyTime = 0.32;
  private readonly keys = new Set<string>();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(host: HTMLElement, cb: CityViewCallbacks) {
    this.host = host;
    this.cb = cb;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      // 开发期保留绘制缓冲，才能把画面读回来做检查
      preserveDrawingBuffer: import.meta.env.DEV,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    host.appendChild(this.renderer.domElement);

    // 渐变天穹。一块均匀的蓝灰和青瓦屋顶的明度太接近，剪影会沉进背景里 ——
    // 真实的天空从来不是一个颜色，顶上深、近地平线浅而暖，
    // 这道渐变本身就把建筑的轮廓托了出来。
    this.sky = new SkyDome();
    this.scene.add(this.sky.mesh);
    // 注意：雾按到相机的真实距离算。相机在正交模式下站得很远（见 CAM_DIST），
    // 雾的近远端必须跟着推出去，否则整座城会被雾吃干净。
    this.scene.fog = new THREE.Fog(this.sky.horizon.getHex(), 150, 340);

    const aspect = host.clientWidth / Math.max(1, host.clientHeight);
    this.camera = new THREE.OrthographicCamera(
      -this.zoom * aspect, this.zoom * aspect, this.zoom, -this.zoom, 0.1, 600,
    );

    this.hemi = new THREE.HemisphereLight(0xbfd4e2, 0x6a5f4a, 0.55);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.18);
    this.scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xfff1d8, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;
    const sc = this.sun.shadow.camera;
    sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 1; sc.far = 260;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.buildGround();
    this.scene.add(this.plotRoot);

    // 悬停指示：地块边缘的一圈浅框
    const ringGeo = new THREE.RingGeometry(PLOT * 0.6, PLOT * 0.64, 4, 1);
    this.hoverRing = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    this.hoverRing.rotation.x = -Math.PI / 2;
    this.hoverRing.rotation.z = Math.PI / 4;
    this.hoverRing.position.y = 0.12;
    this.hoverRing.visible = false;
    this.scene.add(this.hoverRing);

    this.buildPickTargets();
    this.bindInput();
    this.resize();
  }

  // ───────────────────────────────────────────────────────────
  // 静态场景
  // ───────────────────────────────────────────────────────────

  private buildGround(): void {
    const m = materials();
    // 城外的郊野用耕地材质 —— 夯土的城墙压在土黄的地上会分不出剪影
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), m.grass);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    (m.grass.map as THREE.Texture).repeat.set(60, 60);
    (m.grass.bumpMap as THREE.Texture).repeat.set(60, 60);
    this.scene.add(ground);

    // 街道：横竖各 6 条，铺在地块之间
    const roadMat = m.road;
    (roadMat.map as THREE.Texture).repeat.set(10, 2);
    const roads = new THREE.Group();
    const span = CITY_SIZE * PITCH;
    for (let i = 0; i <= CITY_SIZE; i++) {
      const p = -span / 2 + i * PITCH;
      for (const axis of ['x', 'z'] as const) {
        const geo = axis === 'x'
          ? new THREE.PlaneGeometry(span + STREET, STREET)
          : new THREE.PlaneGeometry(STREET, span + STREET);
        const road = new THREE.Mesh(geo, roadMat);
        road.rotation.x = -Math.PI / 2;
        road.position.set(axis === 'x' ? 0 : p, 0.01, axis === 'x' ? p : 0);
        road.receiveShadow = true;
        roads.add(road);
      }
    }
    this.scene.add(mergeStatic(roads));

    // 城外零星的树，给画面一个边界感
    const r = rng(4242);
    const woods = new THREE.Group();
    for (let i = 0; i < 46; i++) {
      const a = r() * Math.PI * 2;
      const dist = span * 0.78 + r() * 60;
      const t = tree(0.9 + r() * 0.8, i * 7 + 3);
      t.position.set(Math.cos(a) * dist, 0, Math.sin(a) * dist);
      woods.add(t);
    }
    this.scene.add(mergeStatic(woods));
  }

  private buildPickTargets(): void {
    const geo = new THREE.PlaneGeometry(PLOT, PLOT);
    const mat = new THREE.MeshBasicMaterial({ visible: false });
    for (let i = 0; i < CITY_SIZE * CITY_SIZE; i++) {
      const [x, z] = plotXZ(i);
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.05, z);
      m.userData['plot'] = i;
      this.scene.add(m);
      this.pickTargets.push(m);
    }
  }

  /** 城墙。外郭拓开时整圈重建 */
  private buildRamparts(ring: number): void {
    if (this.rampartRing === ring) return;
    this.rampartRing = ring;
    if (this.ramparts) {
      this.scene.remove(this.ramparts);
      this.ramparts.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }
    const g = new THREE.Group();
    const inner = ring >= 1 ? CITY_SIZE : 3;
    const half = (inner * PITCH) / 2 + 1.4;

    for (const [axis, sign] of [['x', 1], ['x', -1], ['z', 1], ['z', -1]] as const) {
      const run = wallRun(half * 2);
      if (axis === 'x') {
        run.position.set(0, 0, sign * half);
      } else {
        run.position.set(sign * half, 0, 0);
        run.rotation.y = Math.PI / 2;
      }
      g.add(run);
    }
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const t = cornerTower();
      t.position.set(sx * half, 0, sz * half);
      g.add(t);
    }
    // 南门
    const gate = gateTower();
    gate.position.set(0, 0, half);
    g.add(gate);

    const merged = mergeStatic(g);
    this.scene.add(merged);
    this.ramparts = merged;
  }

  // ───────────────────────────────────────────────────────────
  // 地块内容
  // ───────────────────────────────────────────────────────────

  private plotSignature(plot: Plot, index: number, open: boolean): string {
    if (!open) return 'locked';
    if (plot.work) {
      const kind = plot.work.demolish ? 'raze' : 'build';
      return `${kind}:${plot.work.buildingId}:${plot.work.toLevel}:${plot.buildingId}:${plot.level}`;
    }
    return `${plot.buildingId ?? 'empty'}:${plot.level}:${index}`;
  }

  private buildPlotContent(plot: Plot, index: number, open: boolean): THREE.Group {
    const g = new THREE.Group();
    const r = rng(index * 977 + 13);
    const m = materials();

    if (!open) {
      // 未开放的外郭：荒地，几丛草和一段断墙
      const waste = new THREE.Mesh(new THREE.PlaneGeometry(PLOT, PLOT), m.dirt);
      waste.rotation.x = -Math.PI / 2;
      waste.position.y = 0.03;
      waste.receiveShadow = true;
      g.add(waste);
      for (let i = 0; i < 5; i++) {
        const t = tree(0.5 + r() * 0.4, index * 31 + i);
        t.position.set((r() - 0.5) * PLOT * 0.8, 0, (r() - 0.5) * PLOT * 0.8);
        g.add(t);
      }
      return g;
    }

    if (plot.work) {
      // 拆除时房子还立在那里，只是围了脚手架、堆了瓦砾 ——
      // 直接变成空工地会让人以为已经拆完了
      if (plot.work.demolish && plot.buildingId && plot.level > 0) {
        g.add(this.buildingFor(plot.buildingId, plot.level, index, r));
        for (let i = 0; i < 4; i++) {
          const rubble = new THREE.Mesh(
            new THREE.DodecahedronGeometry(0.28 + r() * 0.22, 0),
            m.stone,
          );
          rubble.position.set(-PLOT * 0.3 + r() * PLOT * 0.6, 0.18, PLOT * 0.3 + r() * 0.6);
          rubble.rotation.set(r() * 3, r() * 3, r() * 3);
          rubble.castShadow = true;
          g.add(rubble);
        }
      } else {
        g.add(scaffold(PLOT * 0.42, PLOT * 0.34, index));
      }
      const cartObj = cart();
      cartObj.position.set(PLOT * 0.28, 0, PLOT * 0.34);
      cartObj.rotation.y = r() * 3;
      g.add(cartObj);
      const w = person(true);
      w.position.set(-PLOT * 0.2, 0, PLOT * 0.3);
      g.add(w);
      return g;
    }

    const id = plot.buildingId;
    const lv = plot.level;

    if (id && lv > 0) {
      g.add(this.buildingFor(id, lv, index, r));
      // 屋顶炊烟：住人的地方才有
      if (id === 'house' || id === 'farm') this.addSmoke(g, -PLOT * 0.3, 2.2, PLOT * 0.36);
      return g;
    }

    if (!id || lv <= 0) {
      // 空地：荒着的院子，围一圈篱笆
      const f1 = fence(PLOT * 0.7, index);
      f1.position.set(0, 0, -PLOT * 0.35);
      g.add(f1);
      for (let i = 0; i < 3; i++) {
        const t = tree(0.45 + r() * 0.3, index * 17 + i);
        t.position.set((r() - 0.5) * PLOT * 0.6, 0, (r() - 0.5) * PLOT * 0.6);
        g.add(t);
      }
      return g;
    }

    return g;
  }

  /** 按建筑种类与等级造出这块地上的东西 */
  private buildingFor(
    id: string, lv: number, index: number, r: () => number,
  ): THREE.Group {
    const g = new THREE.Group();
    switch (id) {
      case 'yamen': {
        const main = hall({ w: 5.6, d: 3.8, h: 2.6 + lv * 0.25, eave: 0.95, podium: 0.45, columns: 6, seed: index });
        main.position.set(0, 0, -1.2);
        g.add(main);
        const wing = hall({ w: 3.0, d: 2.4, h: 1.9, eave: 0.7, podium: 0.25, columns: 3, seed: index + 5 });
        wing.position.set(-3.0, 0, 2.2);
        wing.rotation.y = Math.PI / 2;
        g.add(wing);
        const b = banner(4.2);
        b.position.set(2.9, 0, 2.6);
        g.add(b);
        g.add(this.place(tree(1.2, index + 9), 3.2, -2.6));
        break;
      }
      case 'farm': {
        g.add(fieldPatch(PLOT * 0.86, PLOT * 0.7, lv, index));
        const h = hut(index);
        h.position.set(-PLOT * 0.3, 0, PLOT * 0.36);
        g.add(h);
        if (lv >= 2) g.add(this.place(haystack(index + 2), PLOT * 0.3, PLOT * 0.34));
        if (lv >= 4) {
          const c = cart();
          c.position.set(PLOT * 0.05, 0, PLOT * 0.38);
          g.add(c);
        }
        break;
      }
      case 'house': {
        const n = Math.min(7, 2 + lv);
        for (let i = 0; i < n; i++) {
          const h = hut(index * 13 + i);
          const col = i % 3, row = Math.floor(i / 3);
          h.position.set(-2.6 + col * 2.7 + (r() - 0.5) * 0.4, 0, -2.2 + row * 2.7);
          h.rotation.y = (r() - 0.5) * 0.3;
          g.add(h);
        }
        g.add(this.place(fence(PLOT * 0.8, index), 0, PLOT * 0.4));
        g.add(this.place(firewood(index + 4), 3.0, 2.6));
        break;
      }
      case 'granary': {
        const n = Math.min(6, 1 + lv);
        for (let i = 0; i < n; i++) {
          const b = granaryBin(index * 7 + i);
          const col = i % 3, row = Math.floor(i / 3);
          b.position.set(-2.5 + col * 2.5, 0, -1.6 + row * 2.6);
          g.add(b);
        }
        const shed = hall({ w: 3.2, d: 2.2, h: 1.8, eave: 0.7, podium: 0.2, columns: 3, seed: index });
        shed.position.set(0, 0, PLOT * 0.36);
        g.add(shed);
        break;
      }
      case 'well': {
        const w = wellHead();
        g.add(w);
        g.add(this.place(tree(1.1, index), -2.6, -2.2));
        for (let i = 0; i < 3 + lv; i++) {
          g.add(this.place(jar(), -3 + r() * 6, -3 + r() * 6));
        }
        g.add(this.place(fence(PLOT * 0.6, index), 0, PLOT * 0.36));
        break;
      }
      case 'market': {
        const n = Math.min(10, 3 + lv * 2);
        for (let i = 0; i < n; i++) {
          const s = stall(index * 11 + i);
          const col = i % 4, row = Math.floor(i / 4);
          s.position.set(-3.3 + col * 2.3, 0, -2.6 + row * 2.4);
          g.add(s);
        }
        break;
      }
      case 'pond': {
        g.add(pondPatch(PLOT * 0.86, PLOT * 0.76));
        g.add(this.place(tree(1.3, index), -PLOT * 0.36, PLOT * 0.36));
        g.add(this.place(tree(1.0, index + 3), PLOT * 0.34, -PLOT * 0.3));
        break;
      }
      case 'treasury': {
        const main = hall({ w: 4.6, d: 3.2, h: 2.4, eave: 0.85, podium: 0.4, columns: 5, seed: index });
        main.position.set(0, 0, -0.8);
        g.add(main);
        if (lv >= 2) {
          const side = hall({ w: 2.8, d: 2.2, h: 1.8, eave: 0.65, podium: 0.25, columns: 3, seed: index + 2 });
          side.position.set(-2.9, 0, 2.4);
          g.add(side);
        }
        g.add(this.place(fence(PLOT * 0.8, index), 0, PLOT * 0.42));
        break;
      }
      case 'workshop': {
        for (let i = 0; i < Math.min(3, lv); i++) {
          const k = kiln();
          k.position.set(-2.6 + i * 2.7, 0, -1.4);
          g.add(k);
          this.addSmoke(g, -2.6 + i * 2.7, 2.5, -1.4);
        }
        const shed = hall({ w: 3.6, d: 2.2, h: 1.9, eave: 0.75, podium: 0.2, columns: 4, seed: index });
        shed.position.set(0, 0, PLOT * 0.34);
        g.add(shed);
        break;
      }
      case 'barracks': {
        const n = Math.min(8, 3 + lv * 2);
        for (let i = 0; i < n; i++) {
          const t = tent(index * 19 + i);
          const col = i % 4, row = Math.floor(i / 4);
          t.position.set(-3.2 + col * 2.2, 0, -2.2 + row * 2.6);
          g.add(t);
        }
        g.add(this.place(weaponRack(), 0, PLOT * 0.34));
        const b = banner(3.6);
        b.position.set(PLOT * 0.34, 0, PLOT * 0.3);
        g.add(b);
        break;
      }
      case 'school': {
        const main = hall({ w: 5.0, d: 3.4, h: 2.4, eave: 0.95, podium: 0.4, columns: 6, seed: index });
        main.position.set(0, 0, -1.0);
        g.add(main);
        g.add(this.place(tree(1.5, index), -3.0, 2.6));
        g.add(this.place(tree(1.2, index + 4), 3.0, 2.4));
        break;
      }
      default: {
        const h = hall({ w: 4, d: 3, h: 2.2, seed: index });
        g.add(h);
      }
    }

    return g;
  }


  private place(o: THREE.Object3D, x: number, z: number): THREE.Object3D {
    o.position.set(x, 0, z);
    return o;
  }

  /** 炊烟：几十个半透明点缓慢上升。廉价，但「有人在生活」全靠它 */
  private addSmoke(parent: THREE.Group, x: number, y: number, z: number): void {
    const n = 26;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = x + (Math.random() - 0.5) * 0.3;
      pos[i * 3 + 1] = y + (i / n) * 3.2;
      pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.3;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xd8d2c6, size: 0.55, transparent: true, opacity: 0.28,
      depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    parent.add(pts);
    this.smokes.push({ base: y, mesh: pts });
  }

  // ───────────────────────────────────────────────────────────
  // 状态同步
  // ───────────────────────────────────────────────────────────

  /**
   * @param besieger 城外的围兵。null 表示无事。
   *   被围时城外要真的立起营盘 —— 只在屏幕角落弹一行红字，
   *   玩家感受不到「兵临城下」这四个字。
   */
  sync(city: City, season: Season, besieger: BesiegerInfo | null = null): void {
    this.season = season;
    this.syncSiege(besieger);

    this.buildRamparts(city.ring);

    // 四时换色：田与草的颜色随季节走，季节必须看得见
    const sf = SEASON_FIELD[season]!;
    const m = materials();
    m.field.color.setHex(sf.field);
    m.crop.color.setHex(sf.crop);
    m.grass.color.setHex(sf.grass);

    for (let i = 0; i < city.plots.length; i++) {
      const plot = city.plots[i]!;
      const open = isOpen(city, i);
      const sig = this.plotSignature(plot, i, open);
      const node = this.nodes.get(i);
      if (node?.sig === sig) continue;

      if (node) {
        this.plotRoot.remove(node.group);
        disposeTree(node.group);
      }
      const raw = this.buildPlotContent(plot, i, open);
      const [x, z] = plotXZ(i);
      raw.position.set(x, 0, z);
      // 一块地上有几十个网格，二十五块就是上千个 draw call。
      // 内容在下一次签名变化之前不会动，所以按材质压成几个
      const group = mergeStatic(raw);
      this.plotRoot.add(group);
      this.nodes.set(i, { group, sig });
    }

    this.syncWalkers(city);
  }

  /**
   * 城外的围兵。
   *
   * 营盘立在南门之外、城墙与视野之间，规模跟着敌军人数走。
   * 兵少时是几顶帐篷，兵多时是连营 —— 玩家一眼就知道这次有多凶。
   */
  private syncSiege(info: BesiegerInfo | null): void {
    const key = info ? info.factionId + ':' + Math.floor(info.troops / 250) : '';
    if (key === this.siegeKey) return;
    this.siegeKey = key;

    if (this.siegeCamp) {
      this.scene.remove(this.siegeCamp);
      disposeTree(this.siegeCamp);
      this.siegeCamp = null;
    }
    if (!info) return;

    const m = materials();
    const g = new THREE.Group();
    const r = rng(info.factionId.length * 131 + 7);
    const span = CITY_SIZE * PITCH;
    const line = span / 2 + 16;
    const tents = Math.max(4, Math.min(26, Math.round(info.troops / 90)));
    const color = new THREE.Color(info.color);

    for (let i = 0; i < tents; i++) {
      const row = Math.floor(i / 9);
      const x = -span * 0.42 + (i % 9) * (span * 0.105) + (r() - 0.5) * 2.4;
      const z = line + row * 5.2 + (r() - 0.5) * 1.6;
      const t = tent(i * 7 + 3);
      t.position.set(x, 0, z);
      t.rotation.y = r() * 0.6;
      g.add(t);
      if (i % 3 === 0) {
        const p = person(i % 2 === 1);
        p.position.set(x + 1.6, 0, z - 1.8);
        p.rotation.y = Math.PI;
        g.add(p);
      }
    }

    // 中军的旗号，颜色与围城方一致
    const { group: pole, flag } = bannerFlag(info.banner, 6.5, 1.8);
    pole.position.set(0, 0, line - 3.4);
    (flag.material as THREE.MeshStandardMaterial).color.copy(color);
    g.add(pole);

    // 攻城器械：几架云梯斜靠着，说明他们不只是在等
    for (const sx of [-1, 1]) {
      const ladder = new THREE.Group();
      for (const off of [-0.5, 0.5]) {
        const rail = new THREE.Mesh(
          new THREE.CylinderGeometry(0.09, 0.09, 8.5, 5), m.woodDark,
        );
        rail.position.set(off, 4.2, 0);
        rail.castShadow = true;
        ladder.add(rail);
      }
      for (let k = 0; k < 8; k++) {
        const rung = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.09, 0.09), m.wood);
        rung.position.set(0, 0.8 + k, 0);
        ladder.add(rung);
      }
      ladder.position.set(sx * span * 0.2, 0, line - 8.5);
      ladder.rotation.x = -0.5;
      g.add(ladder);
    }

    // 营火
    for (let i = 0; i < 3; i++) {
      const fire = new THREE.Mesh(
        new THREE.ConeGeometry(0.6, 1.0, 6),
        new THREE.MeshStandardMaterial({
          color: 0xd0752e, emissive: 0x8a3d10, emissiveIntensity: 0.9, roughness: 1,
        }),
      );
      fire.position.set(-span * 0.28 + i * span * 0.28, 0.5, line + 2.4);
      g.add(fire);
      this.addSmoke(g, fire.position.x, 1.4, fire.position.z);
    }

    this.scene.add(g);
    this.siegeCamp = g;
  }

  /** 街上的行人。数量跟着户口走 —— 城活没活，一眼就看得出来 */
  private syncWalkers(city: City): void {
    const want = Math.max(2, Math.min(40, Math.floor(city.households / 45)));
    while (this.walkers.length < want) {
      const obj = this.walkerPool.pop() ?? person(this.walkers.length % 2 === 1);
      this.scene.add(obj);
      const span = CITY_SIZE * PITCH;
      const lanes = CITY_SIZE + 1;
      const laneIdx = Math.floor(Math.random() * lanes);
      this.walkers.push({
        obj,
        t: Math.random(),
        speed: (0.018 + Math.random() * 0.02) * (Math.random() > 0.5 ? 1 : -1),
        axis: Math.random() > 0.5 ? 'x' : 'z',
        lane: -span / 2 + laneIdx * PITCH + (Math.random() - 0.5) * (STREET * 0.5),
      });
    }
    while (this.walkers.length > want) {
      const w = this.walkers.pop()!;
      this.scene.remove(w.obj);
      this.walkerPool.push(w.obj);
    }
  }

  // ───────────────────────────────────────────────────────────
  // 光照：太阳角度随时辰真的在动
  // ───────────────────────────────────────────────────────────

  /**
   * 昼夜。
   *
   * 两条规矩：
   *  1. **每一项都连续插值**。任何 if(夜) / else(昼) 的硬切换，眼睛都会看成闪一下。
   *  2. **夜里不许变暗到看不清**。这是一个盯着自己城池的经营游戏，
   *     如果一半时间画面是黑的，昼夜就不是氛围而是障碍。
   *     所以入夜只降一点亮度，主要变的是**色温和光的方向**——
   *     太阳落下的同时月光接管，影子转向、变长、变软。
   */
  private updateSun(): void {
    const t = this.skyTime;
    // 0.25 日出、0.5 正午、0.75 日落
    const az = (t - 0.25) * Math.PI * 2;
    const elev = Math.sin(az);

    /** 白昼程度 0~1，黎明黄昏是平滑过渡 */
    const dayness = smoothstep(-0.18, 0.30, elev);
    /** 贴近地平线的程度，用来加朝霞晚霞 */
    const horizon = (1 - Math.min(1, Math.abs(elev) / 0.42)) * dayness;

    // 主光源始终在地平线以上：白天是太阳，夜里同一盏灯变成月亮。
    // 这样影子的方向一直在缓慢转动，时间的流逝看得见，画面却不会断电。
    const h = 26 + (elev * 0.5 + 0.5) * 88;
    this.sun.position.set(
      Math.cos(az) * 105 + this.panX,
      h,
      Math.sin(az) * 62 + 34 + this.panZ,
    );
    this.sun.target.position.set(this.panX, 0, this.panZ);
    this.sun.target.updateMatrixWorld();

    // 光色：月白 → 日光，再往地平线方向掺进晚霞的暖调
    const r = lerp(0.72, 1.00, dayness);
    const g = lerp(0.80, 0.96, dayness) - horizon * 0.14;
    const b = lerp(0.98, 0.90, dayness) - horizon * 0.34;
    this.sun.color.setRGB(r, g, b);
    // 夜里留足直射光。影子还在、方向照常转，只是淡而冷 ——
    // 亮度不能掉到看不清城池的程度，否则昼夜就成了障碍而不是氛围。
    //
    // 白天的直射光给得很足、补光压得较低：立体感靠的是**光比**，
    // 补光一高，所有面的明度就拉平，房子会变成一张贴纸。
    this.sun.intensity = 1.15 + dayness * 1.75;

    // 天光。夜里抬高环境光，把直射光损失的那部分补回来
    this.hemi.intensity = 0.84 - dayness * 0.46;
    this.hemi.color.setRGB(
      lerp(0.58, 0.72, dayness),
      lerp(0.66, 0.82, dayness),
      lerp(0.88, 0.92, dayness),
    );
    this.hemi.groundColor.setRGB(
      lerp(0.34, 0.42, dayness),
      lerp(0.32, 0.37, dayness),
      lerp(0.32, 0.29, dayness),
    );
    this.ambient.intensity = 0.46 - dayness * 0.30;

    // 天穹。顶上深、近地平线浅而暖 —— 这道渐变本身就把建筑轮廓托了出来。
    // 雾色必须与地平线一致，否则远景会脱节成两截。
    // 饱和度刻意压得很低：满地是低饱和的暖灰，天上挂一块饱和的天青，
    // 两边就不在一个体系里。真实的中原天空本来也是发灰的淡蓝。
    const topR = lerp(0.17, 0.45, dayness);
    const topG = lerp(0.22, 0.56, dayness);
    const topB = lerp(0.32, 0.62, dayness);
    const horR = lerp(0.40, 0.79, dayness) + horizon * 0.14;
    const horG = lerp(0.44, 0.77, dayness) - horizon * 0.04;
    const horB = lerp(0.52, 0.72, dayness) - horizon * 0.18;
    const grdR = lerp(0.28, 0.55, dayness);
    const grdG = lerp(0.29, 0.52, dayness);
    const grdB = lerp(0.32, 0.46, dayness);
    const hor = this.sky.setRGB([topR, topG, topB], [horR, horG, horB], [grdR, grdG, grdB]);
    (this.scene.fog as THREE.Fog).color.copy(hor);

    // 曝光：夜里略微上调，把整体压回可读的水平
    this.renderer.toneMappingExposure = 1.16 - dayness * 0.10;

    // 冬天整体偏冷偏灰
    if (this.season === 'winter') {
      this.hemi.color.lerp(WINTER_TINT, 0.35);
      this.sun.intensity *= 0.9;
    }
  }

  /** 顶栏显示时辰用。它跟着看得见的太阳走 */
  /**
   * 拆除模式。
   *
   * 藏在面板页脚里的按钮本来就不好找 —— 改成推土机那种做法：
   * 进入模式本身就是那个「你确定吗」，之后左键点谁就拆谁。
   * 之所以敢让点击直接生效，是因为拆除有工期、中途可以停手且不损失钱粮。
   */
  setRazeMode(on: boolean): void {
    this.razeMode = on;
    const mat = this.hoverRing.material as THREE.MeshBasicMaterial;
    mat.color.setHex(on ? 0xd8503c : 0xffe9b0);
    this.renderer.domElement.style.cursor = on ? 'crosshair' : 'default';
  }

  getSkyTime(): number {
    return this.skyTime;
  }

  // ───────────────────────────────────────────────────────────
  // 输入
  // ───────────────────────────────────────────────────────────

  private bindInput(): void {
    const el = this.renderer.domElement;
    let dragging = false;
    let dragged = false;
    let dragButton = 0;
    /** 按下时光标抓住的那个地面点。整个拖拽过程中它必须一直待在光标下 */
    const anchor = new THREE.Vector3();
    const now = new THREE.Vector3();

    const setPointer = (e: PointerEvent): void => {
      const rect = el.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };

    el.addEventListener('pointerdown', (e) => {
      setPointer(e);
      if (!this.groundPointAt(this.pointer.x, this.pointer.y, anchor)) return;
      dragging = true;
      dragged = false;
      dragButton = e.button;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
    });

    el.addEventListener('pointermove', (e) => {
      setPointer(e);

      if (dragging) {
        // 抓着地图拖：把锚点重新拽回光标底下。
        // 这样无论俯角、缩放、屏幕比例如何，手感永远是 1:1 的。
        if (this.groundPointAt(this.pointer.x, this.pointer.y, now)) {
          const dx = anchor.x - now.x;
          const dz = anchor.z - now.z;
          if (Math.abs(dx) + Math.abs(dz) > 0.12) dragged = true;
          this.panX += dx;
          this.panZ += dz;
          this.updateCamera();
        }
        this.hoverRing.visible = false;
        this.hovered = null;
        return;
      }
      this.updateHover();
    });

    const endDrag = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      el.style.cursor = 'default';
      try { el.releasePointerCapture(e.pointerId); } catch { /* 指针已释放 */ }
      // 拖过就不算点击 —— 否则每次挪动视野都会误开一张地块卡片
      if (!dragged && dragButton === 0) {
        const hit = this.pickPlot();
        if (hit !== null) this.cb.onPickPlot(hit);
      }
      this.updateHover();
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('pointerleave', () => {
      this.hoverRing.visible = false;
      this.hovered = null;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    // 对准光标缩放：缩放前后，光标底下的那一点应当还是同一点
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      setPointer(e as unknown as PointerEvent);
      const before = new THREE.Vector3();
      const hadPoint = this.groundPointAt(this.pointer.x, this.pointer.y, before);

      const step = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      this.zoom = clamp(this.zoom * step, 11, 62);
      this.resize();
      this.updateCamera();

      if (hadPoint) {
        const after = new THREE.Vector3();
        if (this.groundPointAt(this.pointer.x, this.pointer.y, after)) {
          this.panX += before.x - after.x;
          this.panZ += before.z - after.z;
          this.updateCamera();
        }
      }
    }, { passive: false });

    // 键盘平移。方向按屏幕来，不是按世界轴 —— 按 W 就该往画面上方走
    const track = (e: KeyboardEvent, down: boolean): void => {
      // 正在输入框里打字时不抢按键
      const el2 = e.target as HTMLElement | null;
      if (el2 && (el2.tagName === 'INPUT' || el2.tagName === 'TEXTAREA' || el2.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (!PAN_KEYS.has(k)) return;
      if (down) this.keys.add(k); else this.keys.delete(k);
      e.preventDefault();
    };
    window.addEventListener('keydown', (e) => track(e, true));
    window.addEventListener('keyup', (e) => track(e, false));
    window.addEventListener('blur', () => this.keys.clear());

    window.addEventListener('resize', () => this.resize());
  }

  /** 键盘平移，每帧调用 */
  private applyKeyPan(dt: number): void {
    if (this.keys.size === 0) return;
    let sx = 0, sy = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) sy -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) sy += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) sx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) sx += 1;
    if (sx === 0 && sy === 0) return;

    // 屏幕右 = 世界 (+x,-z) 方向；屏幕上 = 世界 (-x,-z) 方向（相机绕 Y 转了 45°）
    const c = Math.SQRT1_2;
    const speed = KEY_PAN_SPEED * this.zoom * dt;
    const len = Math.hypot(sx, sy) || 1;
    const nx = (sx / len) * speed, ny = (sy / len) * speed;
    this.panX += (nx * c) + (ny * c);
    this.panZ += (-nx * c) + (ny * c);
    this.updateCamera();
  }

  private pickPlot(): number | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickTargets, false);
    const first = hits[0];
    if (!first) return null;
    return (first.object.userData['plot'] as number | undefined) ?? null;
  }

  private updateHover(): void {
    const hit = this.pickPlot();
    if (hit === this.hovered) return;
    this.hovered = hit;
    this.cb.onHoverPlot(hit);
    if (hit === null) {
      this.hoverRing.visible = false;
      this.renderer.domElement.style.cursor = this.razeMode ? 'crosshair' : 'default';
    } else {
      const [x, z] = plotXZ(hit);
      this.hoverRing.position.set(x, 0.12, z);
      this.hoverRing.visible = true;
      this.renderer.domElement.style.cursor = this.razeMode ? 'crosshair' : 'pointer';
    }
  }

  // ───────────────────────────────────────────────────────────

  /** 相机固定 45° 俯视，只有平移与缩放。拖拽时必须立刻调用，否则下一帧的锚点会算错 */
  private updateCamera(): void {
    this.panX = clamp(this.panX, -PAN_LIMIT, PAN_LIMIT);
    this.panZ = clamp(this.panZ, -PAN_LIMIT, PAN_LIMIT);
    this.camera.position.set(this.panX + CAM_DIST, CAM_DIST * 0.85, this.panZ + CAM_DIST);
    this.camera.lookAt(this.panX, 0, this.panZ);
    this.camera.updateMatrixWorld();
  }

  /** 光标此刻指在地面的哪一点。拖拽与对准缩放都靠它 */
  private groundPointAt(ndcX: number, ndcY: number, out: THREE.Vector3): boolean {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    return this.raycaster.ray.intersectPlane(this.groundPlane, out) !== null;
  }

  private resize(): void {
    const w = this.host.clientWidth, h = Math.max(1, this.host.clientHeight);
    const aspect = w / h;
    this.camera.left = -this.zoom * aspect;
    this.camera.right = this.zoom * aspect;
    this.camera.top = this.zoom;
    this.camera.bottom = -this.zoom;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /**
   * 暂停渲染。切换视图时两个场景都留在内存里，只停掉不在前台的那个 ——
   * 销毁再重建会丢掉相机位置，也会让每次切换都卡一下。
   */
  setPaused(p: boolean): void {
    this.paused = p;
    this.renderer.domElement.style.display = p ? 'none' : '';
    if (!p) this.resize();
  }

  start(): void {
    const loop = (now: number): void => {
      this.raf = requestAnimationFrame(loop);
      if (this.paused) { this.lastFrame = now; return; }
      const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0.016;
      this.lastFrame = now;

      this.applyKeyPan(dt);
      this.updateCamera();

      // 昼夜按真实时间走，与游戏速度无关
      this.skyTime = (this.skyTime + dt / SKY_CYCLE_SECONDS) % 1;
      this.updateSun();

      // 行人
      const span = CITY_SIZE * PITCH + STREET;
      for (const w of this.walkers) {
        w.t += w.speed * dt;
        if (w.t > 1) w.t -= 1;
        if (w.t < 0) w.t += 1;
        const p = -span / 2 + w.t * span;
        if (w.axis === 'x') {
          w.obj.position.set(p, 0, w.lane);
          w.obj.rotation.y = w.speed > 0 ? Math.PI / 2 : -Math.PI / 2;
        } else {
          w.obj.position.set(w.lane, 0, p);
          w.obj.rotation.y = w.speed > 0 ? 0 : Math.PI;
        }
        // 走路的上下起伏，一点点就够
        w.obj.position.y = Math.abs(Math.sin(w.t * 220)) * 0.035;
      }

      // 炊烟上升
      for (const s of this.smokes) {
        const pos = s.mesh.geometry.attributes['position'] as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          let y = pos.getY(i) + dt * (0.5 + (i % 5) * 0.08);
          if (y > s.base + 3.6) y = s.base;
          pos.setY(i, y);
        }
        pos.needsUpdate = true;
      }

      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** 开发期自检用：把画面读回来，看构图是否成立 */
  probe(): { w: number; h: number; sample: number[][] } {
    const c = this.renderer.domElement;
    const tmp = document.createElement('canvas');
    tmp.width = c.width; tmp.height = c.height;
    const g = tmp.getContext('2d')!;
    g.drawImage(c, 0, 0);
    const sample: number[][] = [];
    for (let iy = 1; iy <= 5; iy++) {
      for (let ix = 1; ix <= 5; ix++) {
        const x = Math.floor((c.width * ix) / 6);
        const y = Math.floor((c.height * iy) / 6);
        const d = g.getImageData(x, y, 1, 1).data;
        sample.push([d[0]!, d[1]!, d[2]!]);
      }
    }
    return { w: c.width, h: c.height, sample };
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** 与模拟层同一套开放判定 —— 这里只是读，规则仍在 sim 里 */
function isOpen(city: City, index: number): boolean {
  const x = index % CITY_SIZE, y = Math.floor(index / CITY_SIZE);
  const edge = x === 0 || y === 0 || x === CITY_SIZE - 1 || y === CITY_SIZE - 1;
  return edge ? city.ring >= 1 : true;
}

function disposeTree(o: THREE.Object3D): void {
  o.traverse((n) => {
    if (n instanceof THREE.Mesh || n instanceof THREE.Points) {
      n.geometry.dispose();
    }
  });
}

export { plotXZ, PLOT, PITCH, YAMEN_PLOT };
