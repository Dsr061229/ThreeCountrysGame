/**
 * 战场 —— 野战的 3D 视图。
 *
 * 这一层存在的理由只有一条：**看不见阵型就等于没在打仗**。
 * 所以它读的是模拟层那份格子坐标，一格不差地摆出来：
 * 谁站在坡上、谁陷在沼里、骑兵绕到了哪一侧，都在画面上。
 *
 * 与城内图、天下图同一套美术语言：45° 正交、程序化材质、代码生成的几何。
 */
import * as THREE from 'three';
import { banner, tree } from './build.ts';
import { Army, ranksOf } from './host.ts';
import { materials } from './textures.ts';
import {
  FIELD_COLS, FIELD_ROWS, OWN_ROWS, UNIT_NAME,
  type FieldBattle, type FieldUnit, type Terrain,
} from '../sim/field_types.ts';

/** 一格多大 */
const CELL = 11;
/**
 * 一个小人代表多少兵。
 *
 * 从十一改成三 —— 一支两百人的队伍从十六个小人变成六十多个。
 * 「宏大」这件事上没有别的诀窍：**人得多**。
 * 改得动的前提是小人已经换成了实例化渲染（见 view/host.ts）。
 */
const FIG_PER_MAN = 2;
/** 坡比平地高多少。渲染与站位共用这一个数 */
const HILL_H = 2.2;
/** 一队最多画这么多小人。再多在这个尺度下也数不清了 */
const FIG_MAX = 90;
/** 一队最少画这么多 —— 一两个小人看不出是一支队伍 */
const FIG_MIN = 6;
const CAM_DIST = 120;
/**
 * 镜头的高度系数。
 *
 * 0.9 大致是四十五度俯视，0.52 大致是三十度 ——
 * 城内图与天下图仍旧是四十五度（那两处本来就要看布局），
 * 战场这一处例外：这里要看的是**队列**，不是平面图。
 */
const CAM_ELEVATION = 0.52;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 阵中人与人的间距 */
const SPACING = 1.15;

/** 这么多兵该画几个小人 */
function figuresFor(men: number): number {
  return Math.min(FIG_MAX, Math.max(FIG_MIN, Math.round(men / FIG_PER_MAN)));
}

/**
 * 站位的参差。
 *
 * 完全对齐的队列在这个尺度下看着像印刷品，而人站不了那么齐。
 * 用确定的散列而不是随机数 —— 同一个人每一帧都该站在同一个地方，
 * 否则整片军阵会抖。
 */
function jitterAt(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function cellXZ(col: number, row: number): [number, number] {
  return [
    (col - (FIELD_COLS - 1) / 2) * CELL,
    (row - (FIELD_ROWS - 1) / 2) * CELL,
  ];
}

/** 反过来：世界坐标落在哪一格。拖动布阵要用 */
function xzToCell(x: number, z: number): { col: number; row: number } {
  return {
    col: Math.round(x / CELL + (FIELD_COLS - 1) / 2),
    row: Math.round(z / CELL + (FIELD_ROWS - 1) / 2),
  };
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

/**
 * 地形的颜色拉开了距离。
 *
 * 上一版五种地形全是相邻的暗绿，在斜射光下几乎分不出来。
 * 地形若看不出区别，它就只是一层背景 ——
 * 而它本来应当是布阵时最要紧的那个依据。
 */
const TERRAIN_COLOR: Record<Terrain, number> = {
  plain: 0x76824c,
  hill: 0xa79a5c,
  forest: 0x33452a,
  marsh: 0x4a4f3c,
  ford: 0x3f6b7a,
};

export interface FieldViewCallbacks {
  /** 布阵时把某队拖到了某格 */
  onPlace: (unitId: string, col: number, row: number) => void;
  onPickUnit: (unitId: string | null) => void;
}

interface UnitVisual {
  group: THREE.Group;
  /**
   * 这一队画几个小人。
   *
   * 小人本身不在这里 —— 它们是全场共用的实例网格（见 view/host.ts），
   * 每次同步整片重摆。这一队只记「该摆几个、摆成什么样」。
   */
  figures: number;
  /** 阵中各人的相对站位，摆一次用很多帧 */
  ranks: { dx: number; dz: number }[];
  /** 朝向（弧度） */
  facing: number;
  flagMesh: THREE.Mesh | null;
  /** 头上的标牌：兵种 + 人数 */
  label: THREE.Sprite;
  labelKind: string;
  labelMen: number;
  color: THREE.Color;
  /** 当前显示位置，用来做平滑移动 */
  x: number;
  z: number;
  targetX: number;
  targetZ: number;
  men: number;
  routed: boolean;
  /** 溃逃动画走了多远。0 表示还在阵中 */
  flee: number;
  side: 'own' | 'foe';
}

/** 一个短命的场上特效：尘头、倒地的人。活过 life 秒就自己收走 */
interface Effect {
  obj: THREE.Object3D;
  age: number;
  life: number;
  vy: number;
  spin: number;
}

export class FieldView {
  private readonly host: HTMLElement;
  private readonly cb: FieldViewCallbacks;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private readonly sun: THREE.DirectionalLight;
  private readonly terrainRoot = new THREE.Group();
  private readonly unitRoot = new THREE.Group();
  private readonly units = new Map<string, UnitVisual>();
  private readonly pickTargets: THREE.Mesh[] = [];
  /** 布阵区的高亮格 */
  private readonly zoneCells: THREE.Mesh[] = [];
  private readonly effects: Effect[] = [];
  private readonly fxRoot = new THREE.Group();
  private army: Army;
  /**
   * 上一次同步时各队的模拟数据。
   *
   * 摆小人需要知道兵种与阵营，而渲染循环里没有模拟状态 ——
   * 队伍每帧都在往前挪，小人得跟着挪，所以这份数据要留着。
   */
  private readonly lastUnits = new Map<string, FieldUnit>();
  private readonly marker: THREE.Mesh;

  private terrainKey = '';
  private panX = 0;
  private panZ = 0;
  private zoom = 44;
  private raf = 0;
  private lastFrame = 0;
  private paused = false;
  private dragging: string | null = null;
  private deployMode = false;

  constructor(host: HTMLElement, cb: FieldViewCallbacks) {
    this.host = host;
    this.cb = cb;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      // 开发期保留绘制缓冲，才能把画面读回来自检
      preserveDrawingBuffer: import.meta.env.DEV,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x8a9aa6);
    // 贴地的一层薄尘。军队一动就该有土 ——
    // 它同时把远山推远、把近处的兵推近，画面才有纵深
    {
      const haze = new THREE.Mesh(
        new THREE.CylinderGeometry(300, 300, 26, 24, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0xc0b49a, transparent: true, opacity: 0.16,
          side: THREE.BackSide, depthWrite: false,
        }),
      );
      haze.position.y = 9;
      this.scene.add(haze);
    }
    // 注意：雾按到相机的真实距离算。正交相机站在两百单位外，
    // 雾若从 170 起，整片战场都会蒙上一层灰
    this.scene.fog = new THREE.Fog(0x93a3ae, 260, 520);

    const aspect = host.clientWidth / Math.max(1, host.clientHeight);
    this.camera = new THREE.OrthographicCamera(
      -this.zoom * aspect, this.zoom * aspect, this.zoom, -this.zoom, 0.1, 600,
    );

    this.scene.add(new THREE.HemisphereLight(0xbdd0dd, 0x5f5a44, 0.78));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.22));
    this.sun = new THREE.DirectionalLight(0xfff0d8, 1.9);
    this.sun.position.set(70, 120, 50);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0007;
    this.sun.shadow.normalBias = 0.03;
    const sc = this.sun.shadow.camera;
    sc.left = -90; sc.right = 90; sc.top = 90; sc.bottom = -90; sc.near = 1; sc.far = 330;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.scene.add(this.terrainRoot);
    this.scene.add(this.unitRoot);
    this.scene.add(this.fxRoot);
    this.army = new Army(this.scene);

    // 拖动时脚下的落点提示
    const mk = new THREE.Mesh(
      new THREE.RingGeometry(CELL * 0.32, CELL * 0.4, 4, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffe9b0, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      }),
    );
    mk.rotation.x = -Math.PI / 2;
    mk.rotation.z = Math.PI / 4;
    mk.position.y = 0.4;
    mk.visible = false;
    this.marker = mk;
    this.scene.add(mk);

    this.buildPickGrid();
    this.bindInput();
    this.resize();
    this.updateCamera();
  }

  // ───────────────────────────────────────────────────────────
  // 地形
  // ───────────────────────────────────────────────────────────

  private buildPickGrid(): void {
    const geo = new THREE.PlaneGeometry(CELL, CELL);
    const mat = new THREE.MeshBasicMaterial({ visible: false });
    for (let row = 0; row < FIELD_ROWS; row++) {
      for (let col = 0; col < FIELD_COLS; col++) {
        const [x, z] = cellXZ(col, row);
        const m = new THREE.Mesh(geo, mat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(x, 0.6, z);
        m.userData['col'] = col;
        m.userData['row'] = row;
        this.scene.add(m);
        this.pickTargets.push(m);
      }
    }
  }

  private buildTerrain(f: FieldBattle): void {
    const key = f.cells.map((c) => c.terrain[0]).join('');
    if (key === this.terrainKey) return;
    this.terrainKey = key;

    this.terrainRoot.clear();
    this.zoneCells.length = 0;
    const m = materials();
    const r = rng(key.length * 977 + 7);

    // 远处的原野
    const far = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), m.dirt);
    far.rotation.x = -Math.PI / 2;
    far.position.y = -0.8;
    far.receiveShadow = true;
    this.terrainRoot.add(far);

    // 四周的远山。
    //
    // 没有它，战场就是一块浮在灰色里的地毯 —— 镜头一压低这件事尤其明显。
    // 山只是几个压扁的多面体，隔着雾看不清细节，但它把地平线**关住**了，
    // 于是这片地就有了「在某个地方」的感觉。
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + r() * 0.2;
      const dist = 210 + r() * 90;
      const h = 26 + r() * 46;
      const hill = new THREE.Mesh(
        new THREE.ConeGeometry(38 + r() * 34, h, 5 + Math.floor(r() * 3)),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(0x6d7a72).lerp(new THREE.Color(0x9aa8ac), r() * 0.6),
          roughness: 1, flatShading: true,
        }),
      );
      hill.position.set(Math.cos(a) * dist, h / 2 - 6, Math.sin(a) * dist);
      hill.rotation.y = r() * Math.PI;
      this.terrainRoot.add(hill);
    }

    for (let row = 0; row < FIELD_ROWS; row++) {
      for (let col = 0; col < FIELD_COLS; col++) {
        const cell = f.cells[row * FIELD_COLS + col]!;
        const [x, z] = cellXZ(col, row);
        const h = cell.terrain === 'hill' ? HILL_H : 0;
        // 沼与河滩比地面低一截 —— 低洼地本来就是水往里流的地方
        const sunk = cell.terrain === 'marsh' || cell.terrain === 'ford' ? 0.5 : 0;

        const pad = new THREE.Mesh(
          new THREE.BoxGeometry(CELL, Math.max(0.6, h + 0.8), CELL),
          new THREE.MeshStandardMaterial({
            color: TERRAIN_COLOR[cell.terrain],
            roughness: cell.terrain === 'ford' ? 0.35 : 1,
            metalness: 0,
          }),
        );
        pad.position.set(x, (h + 0.8) / 2 - 0.8 - sunk, z);
        pad.receiveShadow = true;
        pad.castShadow = h > 0;
        this.terrainRoot.add(pad);

        this.dressCell(cell.terrain, x, z, h - sunk, col * 31 + row * 7, r);

        // 布阵区标出来，玩家才知道能把人放哪
        if (OWN_ROWS.includes(row as 5 | 6)) {
          const zone = new THREE.Mesh(
            new THREE.PlaneGeometry(CELL * 0.94, CELL * 0.94),
            new THREE.MeshBasicMaterial({
              color: 0xc8a45c, transparent: true, opacity: 0.2, side: THREE.DoubleSide,
            }),
          );
          zone.rotation.x = -Math.PI / 2;
          zone.position.set(x, h - sunk + 0.08, z);
          zone.visible = false;
          this.terrainRoot.add(zone);
          this.zoneCells.push(zone);
        }
      }
    }
  }

  /**
   * 给一格地铺上地物。
   *
   * 颜色不够 —— 斜射光下五种绿到头来都差不多。
   * 真正让地形分得出来的是长在上面的东西：
   * 林里密密麻麻都是树，沼里一汪一汪都是水和苇，
   * 坡上有岩骨和枯草，河滩就是一条蓝的。
   */
  private dressCell(
    t: Terrain, x: number, z: number, h: number, seed: number, r: () => number,
  ): void {
    const m = materials();
    const put = (o: THREE.Object3D, dx: number, dz: number, dy = 0): void => {
      o.position.set(x + dx, h + dy, z + dz);
      this.terrainRoot.add(o);
    };
    const spread = (): number => (r() - 0.5) * CELL * 0.78;

    if (t === 'forest') {
      // 密林：树要多到遮住地面
      for (let i = 0; i < 9; i++) {
        put(tree(0.85 + r() * 0.75, seed + i), spread(), spread());
      }
      for (let i = 0; i < 4; i++) {
        const bush = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.5 + r() * 0.4, 0),
          new THREE.MeshStandardMaterial({ color: 0x3d5230, roughness: 1 }),
        );
        bush.castShadow = true;
        put(bush, spread(), spread(), 0.4);
      }
      return;
    }

    if (t === 'marsh') {
      // 水泡子 + 苇丛，地面发暗发湿
      for (let i = 0; i < 3; i++) {
        const pool = new THREE.Mesh(
          new THREE.CircleGeometry(1.2 + r() * 1.4, 12), m.water,
        );
        pool.rotation.x = -Math.PI / 2;
        put(pool, spread(), spread(), 0.06);
      }
      for (let i = 0; i < 14; i++) {
        const reed = new THREE.Mesh(
          new THREE.ConeGeometry(0.14, 1.6 + r() * 0.8, 4),
          new THREE.MeshStandardMaterial({ color: 0x8a8a56, roughness: 1 }),
        );
        reed.castShadow = true;
        put(reed, spread(), spread(), 0.8);
      }
      return;
    }

    if (t === 'ford') {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(CELL, CELL), m.water);
      w.rotation.x = -Math.PI / 2;
      put(w, 0, 0, 0.22);
      // 两岸的石子
      for (let i = 0; i < 5; i++) {
        const rock = new THREE.Mesh(
          new THREE.DodecahedronGeometry(0.3 + r() * 0.3, 0), m.stone,
        );
        rock.castShadow = true;
        put(rock, spread(), (r() > 0.5 ? 1 : -1) * CELL * 0.42, 0.2);
      }
      return;
    }

    if (t === 'hill') {
      // 坡：岩骨与枯草，上面没什么遮蔽物
      for (let i = 0; i < 3; i++) {
        if (r() > 0.55) continue;
        const rock = new THREE.Mesh(
          new THREE.DodecahedronGeometry(0.45 + r() * 0.5, 0), m.stone,
        );
        rock.castShadow = true;
        put(rock, spread(), spread(), 0.3);
      }
      for (let i = 0; i < 6; i++) {
        const tuft = new THREE.Mesh(
          new THREE.ConeGeometry(0.22, 0.6, 4),
          new THREE.MeshStandardMaterial({ color: 0xb9ac6a, roughness: 1 }),
        );
        put(tuft, spread(), spread(), 0.3);
      }
      return;
    }

    // 平地：几丛草，不多。它本来就是用来行军的
    for (let i = 0; i < 4; i++) {
      if (r() > 0.7) continue;
      const tuft = new THREE.Mesh(
        new THREE.ConeGeometry(0.2, 0.5, 4),
        new THREE.MeshStandardMaterial({ color: 0x7f8a4e, roughness: 1 }),
      );
      put(tuft, spread(), spread(), 0.25);
    }
  }

  private heightAt(f: FieldBattle, col: number, row: number): number {
    const c = f.cells[row * FIELD_COLS + col];
    if (c?.terrain === 'hill') return HILL_H;
    // 沼与河滩是低洼地，站在里面的人要矮一截
    if (c?.terrain === 'marsh' || c?.terrain === 'ford') return -0.5;
    return 0;
  }

  // ───────────────────────────────────────────────────────────
  // 队伍
  // ───────────────────────────────────────────────────────────

  /**
   * 一队人：按人数摆出一小方阵，脚下一块本方颜色的地毯，头上一块标牌。
   *
   * 在这个尺度下一个兵只有十几个像素高。所以辨识度靠三样，缺一不可：
   *   剪影 —— 步卒持矛直立、弓弩半蹲张弓、骑兵骑在马上
   *   地毯 —— 一眼看出「这里站着一队」，以及是谁的
   *   标牌 —— 兵种和人数写在头上，不用去数小人
   */
  private makeUnit(u: FieldUnit, color: THREE.Color): UnitVisual {
    const g = new THREE.Group();

    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(CELL * 0.44, 24),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.36;
    g.add(pad);

    // 外圈一道亮边，压在地毯上，远看也分得清两军
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(CELL * 0.44, CELL * 0.5, 24),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.38;
    g.add(ring);

    // 小人不在这一队里 —— 它们是全场共用的实例网格。
    // 这里只算出「该摆几个、站成什么样」，摆的动作在 sync 里一次做完
    const n = figuresFor(u.men);

    const b = banner(10);
    b.position.set(0, 0, u.side === 'own' ? 3.2 : -3.2);
    g.add(b);
    let flagMesh: THREE.Mesh | null = null;
    b.traverse((o) => {
      if (o instanceof THREE.Mesh && o.geometry.type === 'PlaneGeometry') flagMesh = o;
    });
    if (flagMesh) {
      const fm = flagMesh as THREE.Mesh;
      fm.material = (fm.material as THREE.Material).clone();
      ((fm.material as THREE.MeshStandardMaterial)).color.copy(color);
    }

    const label = makeUnitLabel(UNIT_NAME[u.kind], u.men, color, u.side === 'own');
    label.position.set(0, 13, 0);
    g.add(label);

    this.unitRoot.add(g);
    return {
      group: g,
      figures: n,
      ranks: ranksOf(n, jitterAt),
      facing: u.side === 'own' ? 0 : Math.PI,
      flagMesh, label,
      labelKind: UNIT_NAME[u.kind], labelMen: u.men,
      color,
      x: 0, z: 0, targetX: 0, targetZ: 0,
      men: u.men, routed: u.routed,
      flee: 0, side: u.side,
    };
  }

  // ───────────────────────────────────────────────────────────

  sync(f: FieldBattle, ownColor: string, foeColor: string): void {
    this.buildTerrain(f);
    this.deployMode = f.phase === 'deploy';
    for (const z of this.zoneCells) z.visible = this.deployMode;

    const own = new THREE.Color(ownColor);
    const foe = new THREE.Color(foeColor);
    const seen = new Set<string>();

    for (const u of f.units) {
      seen.add(u.id);
      this.lastUnits.set(u.id, u);
      let vis = this.units.get(u.id);
      let justMade = false;
      if (!vis) {
        vis = this.makeUnit(u, u.side === 'own' ? own : foe);
        const [x, z] = cellXZ(u.col, u.row);
        vis.x = x; vis.z = z;
        this.units.set(u.id, vis);
        justMade = true;
      }

      // 人数掉了就少几个小人 —— 折损要看得见。
      // 队形只在人数真的变了时才重排，免得每帧都在重算
      const want = figuresFor(u.men);
      if (want !== vis.figures) {
        vis.figures = want;
        vis.ranks = ranksOf(want, jitterAt);
      }

      const [tx, tz] = cellXZ(u.col, u.row);
      // 这一轮掉了多少人。掉了就在这块地上留下痕迹 ——
      // 数字变小是账，倒下的人才是仗
      const lost = vis.men - u.men;
      if (!justMade && lost > 0 && f.phase !== 'deploy') {
        this.spawnCasualties(vis, lost, tx, this.heightAt(f, u.col, u.row), tz);
      }
      vis.targetX = tx;
      vis.targetZ = tz;
      vis.group.position.y = this.heightAt(f, u.col, u.row);
      vis.men = u.men;

      // 位置必须在这里就写进去。
      // 只靠渲染循环里的 lerp 去写，意味着在第一帧到来之前所有队伍都堆在原点 ——
      // 那时候的画面就是「一片空地中间挤着一坨人」。
      //
      // 布阵阶段还要**立刻吸附**：拖一支队伍过去，它得当场就在那儿。
      // 慢慢滑过去在交战时是对的（那是在行军），在布阵时只会让人觉得没跟手。
      if (justMade || f.phase === 'deploy') {
        vis.x = tx;
        vis.z = tz;
        vis.group.position.x = tx;
        vis.group.position.z = tz;
      }

      // 人数变了就重画标牌
      if (vis.labelMen !== u.men) {
        vis.labelMen = u.men;
        const tex = (vis.label.material as THREE.SpriteMaterial).map;
        tex?.dispose();
        const fresh = makeUnitLabel(vis.labelKind, u.men, vis.color, u.side === 'own');
        (vis.label.material as THREE.SpriteMaterial).map =
          (fresh.material as THREE.SpriteMaterial).map;
        (vis.label.material as THREE.SpriteMaterial).needsUpdate = true;
      }

      // 朝向：面朝最近的敌人。列阵而立的两军对着看，才像在打仗
      const foes = f.units.filter((x) => x.side !== u.side && !x.routed);
      if (foes.length > 0) {
        let near = foes[0]!;
        for (const t of foes) {
          const d = Math.hypot(t.col - u.col, t.row - u.row);
          if (d < Math.hypot(near.col - u.col, near.row - u.row)) near = t;
        }
        vis.facing = Math.atan2(near.col - u.col, near.row - u.row);
      }

      if (u.routed !== vis.routed) {
        vis.routed = u.routed;
        // 溃兵：旗先倒。人不当场蒸发 —— 由渲染循环把他们往后方赶出画面
        if (u.routed && vis.flagMesh) vis.flagMesh.visible = false;
        if (u.routed) {
          vis.flee = 0.0001;
          // 整队转身往回跑
          vis.facing += Math.PI;
          vis.label.visible = false;
        }
      }
      if (!u.routed) vis.group.visible = true;
    }

    for (const [id, vis] of this.units) {
      if (seen.has(id)) continue;
      this.unitRoot.remove(vis.group);
      this.units.delete(id);
      this.lastUnits.delete(id);
    }

    this.placeArmy();

    // 同步完立刻画一帧，不必等下一次 rAF
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 把全场的小人摆一遍。
   *
   * 每次整片重来，不做增量 —— 军阵每一轮都在变，
   * 想把「谁死了谁挪了」增量地记下来，代码会比重画贵得多。
   */
  private placeArmy(): void {
    this.army.begin();
    for (const [id, vis] of this.units) {
      if (!vis.group.visible) continue;
      const u = this.lastUnits.get(id);
      if (!u) continue;
      const g = vis.group.position;
      const alt = u.side === 'foe';
      const scale = u.kind === 'horse' ? 2.5 : 2.8;
      for (let i = 0; i < vis.ranks.length; i++) {
        const r = vis.ranks[i]!;
        // 队形按朝向转过去 —— 一支面朝东的队伍，横排也该是南北向的
        const cos = Math.cos(vis.facing);
        const sin = Math.sin(vis.facing);
        const dx = r.dx * SPACING;
        const dz = r.dz * SPACING;
        this.army.place(
          u.kind, alt,
          g.x + dx * cos + dz * sin,
          g.y + this.bob(i),
          g.z - dx * sin + dz * cos,
          vis.facing, scale,
        );
      }
    }
    this.army.commit();
  }

  /** 站定了也微微晃一下，免得看着像一堆摆件 */
  private bob(i: number): number {
    return Math.sin(this.lastFrame / 520 + i * 1.7) * 0.05;
  }

  /**
   * 一队人挨了打。
   *
   * 倒下的人数按实际折损来 —— 掉三个人就倒三个，掉三十个就倒一片。
   * 另外扬一团土：交战那一格必须和别处看着不一样，
   * 否则玩家只能靠读日志才知道哪儿在打。
   */
  private spawnCasualties(
    vis: UnitVisual, lost: number, x: number, y: number, z: number,
  ): void {
    const n = clamp(Math.round(lost / 6), 1, 6);
    for (let i = 0; i < n; i++) {
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.36, 1.5, 3, 6),
        new THREE.MeshStandardMaterial({
          color: vis.color.clone().multiplyScalar(0.55),
          roughness: 1, transparent: true,
        }),
      );
      // 躺下
      body.rotation.z = Math.PI / 2;
      body.rotation.y = Math.random() * Math.PI * 2;
      body.position.set(
        x + (Math.random() - 0.5) * CELL * 0.7,
        y + 0.5,
        z + (Math.random() - 0.5) * CELL * 0.7,
      );
      this.fxRoot.add(body);
      this.effects.push({ obj: body, age: 0, life: 5.5, vy: 0, spin: 0 });
    }

    // 尘头
    for (let i = 0; i < 3; i++) {
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(1.1 + Math.random() * 0.9, 7, 5),
        new THREE.MeshBasicMaterial({
          color: 0xb9a884, transparent: true, opacity: 0.4, depthWrite: false,
        }),
      );
      puff.position.set(
        x + (Math.random() - 0.5) * CELL * 0.8,
        y + 1.4,
        z + (Math.random() - 0.5) * CELL * 0.8,
      );
      this.fxRoot.add(puff);
      this.effects.push({
        obj: puff, age: 0, life: 1.5, vy: 2.6 + Math.random() * 1.6, spin: 0,
      });
    }
  }

  private stepEffects(dt: number): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i]!;
      e.age += dt;
      const t = e.age / e.life;
      if (t >= 1) {
        this.fxRoot.remove(e.obj);
        const mesh = e.obj as THREE.Mesh;
        mesh.geometry?.dispose();
        (mesh.material as THREE.Material)?.dispose();
        this.effects.splice(i, 1);
        continue;
      }
      e.obj.position.y += e.vy * dt;
      e.vy *= 0.94;
      const mat = (e.obj as THREE.Mesh).material as THREE.Material & { opacity: number };
      // 最后三成寿命才开始淡出，免得刚出现就看不见了
      mat.opacity = (e.vy > 0.1 ? 0.4 : 1) * (t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3);
      if (e.vy > 0.1) e.obj.scale.multiplyScalar(1 + dt * 0.9);
    }
  }

  /** 开发期自检：把画面读回来采样，确认真的画出了东西 */
  pixels(): number[][] {
    const c = this.renderer.domElement;
    const tmp = document.createElement('canvas');
    tmp.width = c.width; tmp.height = c.height;
    const g = tmp.getContext('2d')!;
    g.drawImage(c, 0, 0);
    const out: number[][] = [];
    for (let iy = 1; iy <= 4; iy++) {
      for (let ix = 1; ix <= 4; ix++) {
        const d = g.getImageData(
          Math.floor((c.width * ix) / 5), Math.floor((c.height * iy) / 5), 1, 1,
        ).data;
        out.push([d[0]!, d[1]!, d[2]!]);
      }
    }
    return out;
  }

  /** 镜头推到出事的地方 */
  focusCell(col: number, row: number): void {
    const [x, z] = cellXZ(col, row);
    this.panX = x * 0.55;
    this.panZ = z * 0.55;
    this.updateCamera();
  }

  // ───────────────────────────────────────────────────────────
  // 输入：布阵时可以把自己的队伍拖到阵前两行
  // ───────────────────────────────────────────────────────────

  private updateCamera(): void {
    this.panX = clamp(this.panX, -70, 70);
    this.panZ = clamp(this.panZ, -70, 70);
    // 仰角压到三十度上下。
    //
    // 四十五度是俯视 —— 看到的是一堆人的头顶，读起来像棋盘。
    // 压低之后人是**立在地上**的，一排一排挡在你和远山之间，
    // 军阵才有厚度。这是「宏大」最省力也最有效的一刀。
    this.camera.position.set(
      this.panX + CAM_DIST, CAM_DIST * CAM_ELEVATION, this.panZ + CAM_DIST,
    );
    this.camera.lookAt(this.panX, 3, this.panZ);
    this.camera.updateMatrixWorld();
  }

  private groundPointAt(nx: number, ny: number, out: THREE.Vector3): boolean {
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    return this.raycaster.ray.intersectPlane(this.groundPlane, out) !== null;
  }

  private pickCell(): { col: number; row: number } | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickTargets, false)[0];
    if (!hit) return null;
    return {
      col: hit.object.userData['col'] as number,
      row: hit.object.userData['row'] as number,
    };
  }

  /** 光标底下是自己的哪一队 */
  private pickOwnUnit(f: FieldBattle): string | null {
    const c = this.pickCell();
    if (!c) return null;
    const u = f.units.find(
      (x) => x.side === 'own' && !x.routed && x.col === c.col && x.row === c.row,
    );
    return u?.id ?? null;
  }

  private currentField: FieldBattle | null = null;

  setField(f: FieldBattle): void {
    this.currentField = f;
  }

  private bindInput(): void {
    const el = this.renderer.domElement;
    let panning = false;
    const anchor = new THREE.Vector3();
    const now = new THREE.Vector3();

    const setPointer = (e: PointerEvent | WheelEvent): void => {
      const r = el.getBoundingClientRect();
      this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    };

    el.addEventListener('pointerdown', (e) => {
      setPointer(e);
      // 布阵时左键拖队伍，其余情况一律是拖地图
      if (this.deployMode && e.button === 0 && this.currentField) {
        const id = this.pickOwnUnit(this.currentField);
        if (id) {
          this.dragging = id;
          this.cb.onPickUnit(id);
          el.setPointerCapture(e.pointerId);
          return;
        }
      }
      if (!this.groundPointAt(this.pointer.x, this.pointer.y, anchor)) return;
      panning = true;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
    });

    el.addEventListener('pointermove', (e) => {
      setPointer(e);
      if (this.dragging) {
        const c = this.pickCell();
        if (c && OWN_ROWS.includes(c.row as 5 | 6)) {
          const [x, z] = cellXZ(c.col, c.row);
          this.marker.position.set(x, 0.5, z);
          this.marker.visible = true;
        } else {
          this.marker.visible = false;
        }
        return;
      }
      if (panning && this.groundPointAt(this.pointer.x, this.pointer.y, now)) {
        this.panX += anchor.x - now.x;
        this.panZ += anchor.z - now.z;
        this.updateCamera();
      }
    });

    const end = (e: PointerEvent): void => {
      if (this.dragging) {
        const c = this.pickCell();
        if (c && OWN_ROWS.includes(c.row as 5 | 6)) this.cb.onPlace(this.dragging, c.col, c.row);
        this.dragging = null;
        this.marker.visible = false;
      }
      panning = false;
      el.style.cursor = 'default';
      try { el.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const aspect = this.host.clientWidth / Math.max(1, this.host.clientHeight);
      this.zoom = clamp(
        this.zoom * (e.deltaY > 0 ? 1.1 : 1 / 1.1),
        this.fitZoom(aspect) * 0.55, 110,
      );
      this.resize();
      this.updateCamera();
    }, { passive: false });

    window.addEventListener('resize', () => this.resize());
  }

  /**
   * 缩放的下限由战场本身定：整片地必须装得进画面。
   *
   * 写死一个 zoom 的后果是竖屏下战场比视野还宽 ——
   * 侧翼的骑兵直接跑到镜头外，玩家会以为它没了。
   */
  private fitZoom(aspect: number): number {
    const halfW = ((FIELD_COLS + 1) * CELL) / 2;
    const halfH = ((FIELD_ROWS + 1) * CELL) / 2;
    return Math.max(halfH, halfW / Math.max(0.35, aspect));
  }

  private resize(): void {
    const w = this.host.clientWidth, h = Math.max(1, this.host.clientHeight);
    const aspect = w / h;
    const z = Math.max(this.zoom, this.fitZoom(aspect));
    this.camera.left = -z * aspect;
    this.camera.right = z * aspect;
    this.camera.top = z;
    this.camera.bottom = -z;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /** 开发期自检：场景里到底有什么，队伍在不在镜头里 */
  probe(): unknown {
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(
        this.camera.projectionMatrix, this.camera.matrixWorldInverse,
      ),
    );
    let meshes = 0;
    this.scene.traverse((o) => { if (o instanceof THREE.Mesh) meshes++; });
    const units = [...this.units.entries()].map(([id, v]) => {
      const p = new THREE.Vector3();
      v.group.getWorldPosition(p);
      return {
        id,
        at: [Math.round(p.x), Math.round(p.z)],
        visible: v.group.visible,
        figures: v.figures,
        inView: frustum.containsPoint(p),
      };
    });
    return {
      meshes,
      terrainChildren: this.terrainRoot.children.length,
      unitChildren: this.unitRoot.children.length,
      units,
      camera: [Math.round(this.camera.position.x), Math.round(this.camera.position.y), Math.round(this.camera.position.z)],
      zoom: this.zoom,
      canvas: [this.renderer.domElement.width, this.renderer.domElement.height],
      deployMode: this.deployMode,
      figuresDrawn: this.army.drawn(),
    };
  }

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

      // 队伍平滑地走到新位置 —— 一格一格瞬移看不出「在推进」
      for (const v of this.units.values()) {
        if (v.routed) {
          // 溃逃：朝本方后方跑，跑出画面才收起来。
          // 一支溃兵原地消失是看不懂的，跑掉才看得懂
          v.flee += dt;
          const away = v.side === 'own' ? 1 : -1;
          v.group.position.x = v.x;
          v.group.position.z = v.z + away * v.flee * 46;
          if (v.flee > 1.9) v.group.visible = false;
          continue;
        }
        v.x = lerp(v.x, v.targetX, Math.min(1, dt * 3.2));
        v.z = lerp(v.z, v.targetZ, Math.min(1, dt * 3.2));
        v.group.position.x = v.x;
        v.group.position.z = v.z;
      }

      this.stepEffects(dt);
      // 队伍在往前挪，小人得跟着挪
      this.placeArmy();

      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.army.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/**
 * 队伍头上的标牌。
 *
 * 这是「分得清」最直接的一件事：兵种和人数写在头上，
 * 不必去数底下那几个小人，也不必猜哪一队是自己的。
 */
function makeUnitLabel(
  kind: string, men: number, color: THREE.Color, mine: boolean,
): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const dpr = 2;
  canvas.width = 220 * dpr;
  canvas.height = 64 * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  const text = kind + ' ' + men;
  ctx.font = '600 30px "Songti SC", "SimSun", serif';
  const w = ctx.measureText(text).width + 30;
  const x0 = 110 - w / 2;

  ctx.fillStyle = mine ? 'rgba(18,15,10,0.86)' : 'rgba(30,14,12,0.86)';
  ctx.fillRect(x0, 10, w, 40);
  ctx.strokeStyle = '#' + color.getHexString();
  ctx.lineWidth = 2.5;
  ctx.strokeRect(x0, 10, w, 40);
  // 左侧一条本方色的竖条，斜眼一扫也知道是谁的
  ctx.fillStyle = '#' + color.getHexString();
  ctx.fillRect(x0, 10, 5, 40);

  ctx.fillStyle = '#f0e6d4';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 110, 31);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, depthTest: false, transparent: true,
  }));
  sprite.scale.set(13, 3.8, 1);
  sprite.renderOrder = 30;
  return sprite;
}

export { cellXZ, xzToCell };
