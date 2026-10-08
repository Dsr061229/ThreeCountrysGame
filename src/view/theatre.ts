/**
 * 战场的画面。
 *
 * 这一版是推翻重做的。上一版的三处硬伤，每一处都值得写在这里：
 *
 *   一、**远山堆得太近**。三十座锥体摆在两三百单位外，
 *      而正交镜头的可视宽度也就三百多 —— 于是整屏都是山，战场反倒看不见。
 *      现在山退到七百开外，压扁、罩进雾里，只做地平线。
 *
 *   二、**镜头对着自家营寨**。敌营在三十二格外，直接在画面之外，
 *      玩家看不见要打的是谁。现在开局就把整片战场框进来。
 *
 *   三、**地是平涂的顶点色**。城池那边用的是带贴图和凹凸的材质，
 *      两下一比，战场像张示意图。现在地表用同一套材质，
 *      顶点色只做地貌之间的染色。
 *
 * 另外补上了两样本来就该有的东西：**两座真的营寨**（鹿角、辕门、
 * 成排的帐篷、粮车、马桩、炊烟），以及攻城时**一座真的城**（夯土墙、
 * 城楼、角楼，墙塌了会现出缺口）。
 */
import * as THREE from 'three';
import {
  banner, bannerFlag, cart, cornerTower, firewood, gateTower, haystack,
  hut, jar, tent, tree, wallRun, weaponRack,
} from './build.ts';
import { materials } from './textures.ts';
import { mergeStatic } from './merge.ts';
import { Army, ranksOf } from './host.ts';
import { skyTexture } from './sky.ts';
import type { Theatre, Unit } from '../sim/theatre_types.ts';
import { GROUND, KIND_NAME } from '../sim/theatre_types.ts';

/** 一格多少世界单位 */
const CELL = 8;
/** 一级高差多少世界单位 */
const RISE = 6.5;
/**
 * 水面在哪个高度。
 *
 * 比水格挖下去的深度略高一点 —— 差出来的那一截就是水深，
 * 而地形爬出水面的那条线就是岸。
 */
const WATER_LEVEL = -1.6 * 6.5 * 0.55;
/**
 * 相机站多远。
 *
 * 正交相机站多远都不改变取景（那是 zoom 的事），
 * 它只影响裁剪面与**雾**。定死一个数，雾才好配。
 */
const CAM_DIST = 340;
/**
 * 相机的仰角系数（y = CAM_DIST × 这个数）。
 *
 * 0.72 大致是二十七度 —— 太低，战场在画面里被压成中间窄窄一条，
 * 上下全是天。抬到 1.05（约三十六度）之后，
 * 军阵铺得开，同时还留得住地平线。
 */
const CAM_LIFT = 1.05;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * 地貌的染色。
 *
 * 这些颜色是**乘在草地贴图上**的，不是直接涂上去 ——
 * 所以林子是暗下去的草地，坡是泛土色的草地，肌理还在。
 */
const TINT: Record<string, [number, number, number]> = {
  // 平地不给固定色 —— 由下面的 meadow() 按大尺度的青黄变化来定
  plain: [1.00, 1.00, 0.94],
  road: [1.12, 0.99, 0.78],
  forest: [0.34, 0.52, 0.30],
  hill: [0.96, 0.86, 0.64],
  marsh: [0.58, 0.74, 0.52],
  water: [0.40, 0.56, 0.74],
};

/**
 * 草色。
 *
 * 上一版整片地是一个色，看着像沙漠 —— 而中原的野地是**斑驳**的：
 * 洼处水足，草是青的；坡上向阳，草是黄的；中间还有半青半黄的。
 * 用两层大尺度的噪声在青与黄之间揉，这一下地才活过来。
 */
function meadow(wx: number, wz: number): [number, number, number] {
  const n =
    Math.sin(wx * 0.0061 + 0.4) * Math.cos(wz * 0.0053 - 1.1) * 0.5
    + Math.sin((wx - wz) * 0.0029 + 2.2) * 0.35
    + Math.cos(wx * 0.0017 + wz * 0.0023) * 0.25;
  // -1 是枯黄，+1 是青绿
  const t = clamp((n + 0.55) / 1.4, 0, 1);
  return [
    1.06 - t * 0.42,
    0.98 - t * 0.06,
    0.72 - t * 0.14,
  ];
}

export interface TheatreCallbacks {
  onPickCell: (col: number, row: number) => void;
  onHoverCell: (col: number, row: number) => void;
}

interface UnitVisual {
  group: THREE.Group;
  x: number;
  y: number;
  facing: number;
  figures: number;
  ranks: { dx: number; dz: number }[];
  ring: THREE.Mesh;
  flag: THREE.Object3D | null;
  label: THREE.Sprite;
  labelMen: number;
  routed: boolean;
  flee: number;
}

export class TheatreView {
  private readonly host: HTMLElement;
  private readonly cb: TheatreCallbacks;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly sun: THREE.DirectionalLight;

  private readonly groundRoot = new THREE.Group();
  private readonly propRoot = new THREE.Group();
  private readonly wallRoot = new THREE.Group();
  private readonly unitRoot = new THREE.Group();
  private readonly markRoot = new THREE.Group();
  private readonly fxRoot = new THREE.Group();
  /**
   * 场上的动静：倒下的人、扬起的尘、交锋的火星。
   *
   * 这一层非有不可 —— 上一版打起来「什么反馈都没有」，
   * 玩家只看见几个数字慢慢变小。仗打得再对，看不出在打，
   * 那就等于没打。
   */
  private readonly effects: {
    obj: THREE.Object3D; life: number; age: number;
    rise: number; grow: number; spin: number;
  }[] = [];
  /** 上一次同步时各队还剩多少人。用来算这一拍死了几个 */
  private readonly lastMen = new Map<string, number>();
  private army: Army;

  private readonly units = new Map<string, UnitVisual>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private pickPlane: THREE.Mesh | null = null;
  private wallGaps: THREE.Object3D[] = [];

  private cols = 0;
  private rows = 0;
  private heights: number[] = [];

  private panX = 0;
  private panZ = 0;
  /** 镜头要推去的地方。null 表示不推 */
  private panTo: [number, number] | null = null;
  private zoom = 130;
  private raf = 0;
  private lastFrame = 0;
  private built = '';
  private sim: Theatre | null = null;

  constructor(host: HTMLElement, cb: TheatreCallbacks) {
    this.host = host;
    this.cb = cb;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: import.meta.env.DEV,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    host.appendChild(this.renderer.domElement);

    /**
     * 天。
     *
     * 上一版这里是一块死灰色，而低仰角的战场画面里天要占七成 ——
     * 于是屏幕上七成是一片均匀的灰。那不是「空旷」，是**没画完**。
     *
     * 这里用一张画出来的渐变贴图直接做背景，而不是天穹那个球：
     * 天穹的球只有一个单位大，在正交相机下投影出来也就一个点 ——
     * 透视相机里它铺满全屏，正交里不行。
     * 顶上深、近地平线浅而暖，这道渐变本身就把远山与军阵的轮廓托出来。
     */
    const horizon = new THREE.Color(0xd8cfb8);
    this.scene.background = skyTexture();
    /**
     * 雾。
     *
     * **雾是按到相机的真实距离算的**，而正交相机站得很远 ——
     * 这一条坑过一次：相机在一千四百单位外，雾的远端设在一千一，
     * 于是场上每一样东西都在雾外，整片战场被涂成一片灰。
     * 屏幕上看是「什么都没有」，其实什么都在，只是全被雾吃了。
     *
     * 所以这两个数必须跟着 CAM_DIST 走：
     * 相机到战场中心约 CAM_DIST×1.59，战场本身还要向外铺两百，
     * 雾要从那之后才起。
     */
    // 雾色必须与地平线一色，否则远山会从天上脱出来一块
    this.scene.fog = new THREE.Fog(horizon.getHex(), 820, 1750);

    this.camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 2400);

    this.scene.add(new THREE.HemisphereLight(0xc6d8e2, 0x5f5a44, 0.82));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.18));
    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.05);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.05;
    const sc = this.sun.shadow.camera;
    sc.left = -340; sc.right = 340; sc.top = 340; sc.bottom = -340;
    sc.near = 1; sc.far = 1000;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.scene.add(this.groundRoot);
    this.scene.add(this.propRoot);
    this.scene.add(this.wallRoot);
    this.scene.add(this.unitRoot);
    this.scene.add(this.markRoot);
    this.scene.add(this.fxRoot);
    this.army = new Army(this.scene);

    this.bindInput();
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  // ───────────────────────────────────────────────────────────
  // 地
  // ───────────────────────────────────────────────────────────

  private buildScene(t: Theatre): void {
    this.groundRoot.clear();
    this.propRoot.clear();
    this.wallRoot.clear();
    this.markRoot.clear();
    this.wallGaps = [];
    this.cols = t.cols;
    this.rows = t.rows;

    this.buildGround(t);
    this.buildProps(t);
    this.buildCamp(t, t.ownCamp, true);
    if (t.kind === 'siege') this.buildCity(t);
    else this.buildCamp(t, t.foeCamp, false);
    this.buildHorizon();
    this.frameAll();
  }

  /**
   * 地表。
   *
   * 一整张连绵的地，不是一格一格的面片 ——
   * 格子直接建面片会得到一张棋盘，那是数据的样子，不是地的样子。
   * 高度先平滑几遍，颜色按地貌乘在草地贴图上。
   */
  private buildGround(t: Theatre): void {
    const m = materials();

    /**
     * 地。
     *
     * 上一版这里是一块**四方板子飘在天上** —— 地表只比战场大一圈，
     * 边缘一刀切在天空上，一眼就看出是块道具。
     *
     * 两条改正：
     *
     * 一、**地要铺出画面之外**。城池那张图之所以像个地方，
     *    是因为郊野的地一直铺到看不见的地方去。这里也一样：
     *    地表铺到一千六，战场只占中间一小块，
     *    玩家永远看不到边。
     *
     * 二、**平地也不是平板**。中原是平的，但不是桌面 ——
     *    起伏是有的，只是缓。所以在格子给的高度之外，
     *    再叠一层大尺度的缓坡，让光有得打、地有得读。
     */
    const raw: number[] = [];
    for (let r = 0; r < t.rows; r++) {
      for (let c = 0; c < t.cols; c++) {
        const cell = t.cells[r * t.cols + c]!;
        // 水要挖得够深，岸才立得起来
        raw.push(cell.ground === 'water' ? -1.6 : cell.height);
      }
    }
    let h = raw.slice();
    for (let pass = 0; pass < 4; pass++) {
      const next = h.slice();
      for (let r = 0; r < t.rows; r++) {
        for (let c = 0; c < t.cols; c++) {
          let sum = 0;
          let n = 0;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const rr = r + dr;
              const cc = c + dc;
              if (rr < 0 || rr >= t.rows || cc < 0 || cc >= t.cols) continue;
              sum += h[rr * t.cols + cc]!;
              n += 1;
            }
          }
          next[r * t.cols + c] = sum / n;
        }
      }
      h = next;
    }
    this.heights = h;

    // 铺到看不见的地方去。战场只占正中的一小块
    const SPAN = 1700;
    const SEG = 170;
    const geo = new THREE.PlaneGeometry(SPAN, SPAN, SEG, SEG);
    const pos = geo.attributes['position'] as THREE.BufferAttribute;
    const colors: number[] = [];
    const wide = SEG + 1;
    const fieldW = (t.cols - 1) * CELL;
    const fieldD = (t.rows - 1) * CELL;

    for (let i = 0; i < pos.count; i++) {
      const gx = i % wide;
      const gy = Math.floor(i / wide);
      // 这一点在世界里的位置
      const wx = (gx / SEG - 0.5) * SPAN;
      const wz = (gy / SEG - 0.5) * SPAN;
      // 换算回格子坐标
      const col = wx / CELL + (t.cols - 1) / 2;
      const row = wz / CELL + (t.rows - 1) / 2;

      let y = rollAt(wx, wz);
      // 底色一律是斑驳的草，地貌只在它上面再染一道
      let tint = meadow(wx, wz);
      const inside = col >= -1 && col <= t.cols && row >= -1 && row <= t.rows;
      if (inside) {
        const c = clamp(Math.round(col), 0, t.cols - 1);
        const r = clamp(Math.round(row), 0, t.rows - 1);
        y += h[r * t.cols + c]! * RISE;
        const ground = t.cells[r * t.cols + c]!.ground;
        if (ground !== 'plain') {
          const g = TINT[ground]!;
          tint = [tint[0] * g[0], tint[1] * g[1], tint[2] * g[2]];
        }
      } else {
        const n2 = Math.sin(wx * 0.011) * Math.cos(wz * 0.013);
        if (n2 > 0.32) {
          const g = TINT['forest']!;
          tint = [tint[0] * g[0], tint[1] * g[1], tint[2] * g[2]];
        }
      }

      pos.setZ(i, y);
      const n = (((gx * 37 + gy * 61) % 19) / 19 - 0.5) * 0.09;
      colors.push(tint[0] + n, tint[1] + n, tint[2] + n);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = m.grass.clone();
    mat.vertexColors = true;
    const map = (m.grass.map as THREE.Texture).clone();
    map.repeat.set(180, 180);
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.needsUpdate = true;
    mat.map = map;
    if (m.grass.bumpMap) {
      const bump = (m.grass.bumpMap as THREE.Texture).clone();
      bump.repeat.copy(map.repeat);
      bump.wrapS = THREE.RepeatWrapping;
      bump.wrapT = THREE.RepeatWrapping;
      bump.needsUpdate = true;
      mat.bumpMap = bump;
    }

    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.groundRoot.add(ground);

    // 拾取用的一层不可见平面，只盖住战场本身 ——
    // 点到战场外面去是没有意义的
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(fieldW, fieldD),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0;
    this.groundRoot.add(plane);
    this.pickPlane = plane;

    /**
     * 水。
     *
     * **一整张水面，不是一格一格的方块。**
     *
     * 上一版按水格铺小方块，河就成了一串台阶 —— 一眼假。
     * 这里的做法是：地形在水格处已经凹下去了，
     * 那就在水位高度铺一整张面，凹进去的地方自然被水盖住，
     * **岸线是地形与水面相交出来的**，弯弯曲曲，不用画。
     *
     * 这也是真实世界里岸线的成因。
     */
    const hasWater = t.cells.some((c) => c.ground === 'water');
    if (hasWater) {
      const WSEG = 90;
      const wgeo = new THREE.PlaneGeometry(fieldW * 1.3, fieldD * 1.3, WSEG, WSEG);
      const wpos = wgeo.attributes['position'] as THREE.BufferAttribute;
      for (let i = 0; i < wpos.count; i++) {
        const gx = i % (WSEG + 1);
        const gy = Math.floor(i / (WSEG + 1));
        const wx = (gx / WSEG - 0.5) * fieldW * 1.3;
        const wz = (gy / WSEG - 0.5) * fieldD * 1.3;
        // 水面跟着大地势走，不然河会在坡上横着躺
        wpos.setZ(i, rollAt(wx, wz) + WATER_LEVEL);
      }
      wgeo.computeVertexNormals();
      const wmat = m.water.clone();
      wmat.transparent = true;
      wmat.opacity = 0.86;
      const surface = new THREE.Mesh(wgeo, wmat);
      surface.rotation.x = -Math.PI / 2;
      this.groundRoot.add(surface);
    }
  }

  /** 树、苇、石。地貌要一眼看得出是什么地貌 */
  private buildProps(t: Theatre): void {
    const m = materials();
    const props = new THREE.Group();
    const r = seeded(1234);

    for (let row = 0; row < t.rows; row++) {
      for (let col = 0; col < t.cols; col++) {
        const cell = t.cells[row * t.cols + col]!;
        const [wx, wz] = this.cellToWorld(col, row);
        const y = this.heightAt(col, row);

        if (cell.ground === 'forest') {
          // 密到看不见地面 —— 林子的全部意义是藏得住人
          for (let i = 0; i < 9; i++) {
            const tr = tree(2.6 + r() * 2.4, ((col * 31 + row * 17 + i) | 0) + 1);
            tr.position.set(wx + (r() - 0.5) * CELL, y, wz + (r() - 0.5) * CELL);
            tr.rotation.y = r() * Math.PI * 2;
            props.add(tr);
          }
        } else if (cell.ground === 'marsh') {
          for (let i = 0; i < 12; i++) {
            const reed = new THREE.Mesh(
              new THREE.ConeGeometry(0.22, 1.6 + r() * 1.5, 4),
              new THREE.MeshStandardMaterial({ color: 0x7d8256, roughness: 1 }),
            );
            reed.position.set(wx + (r() - 0.5) * CELL, y + 0.8, wz + (r() - 0.5) * CELL);
            props.add(reed);
          }
        } else if (cell.ground === 'hill') {
          if (r() < 0.45) {
            const rock = new THREE.Mesh(
              new THREE.DodecahedronGeometry(0.7 + r() * 1.5, 0), m.stone,
            );
            rock.position.set(wx + (r() - 0.5) * CELL, y + 0.4, wz + (r() - 0.5) * CELL);
            rock.rotation.set(r() * 3, r() * 3, r() * 3);
            props.add(rock);
          }
          if (r() < 0.3) {
            const tr = tree(1.9 + r() * 1.4, ((col * 13 + row * 7) | 0) + 1);
            tr.position.set(wx + (r() - 0.5) * CELL, y, wz + (r() - 0.5) * CELL);
            props.add(tr);
          }
        } else if (cell.ground === 'plain' && r() < 0.24) {
          const tuft = new THREE.Mesh(
            new THREE.ConeGeometry(0.42, 0.6, 4),
            new THREE.MeshStandardMaterial({ color: 0x7f8a4e, roughness: 1 }),
          );
          tuft.position.set(wx + (r() - 0.5) * CELL, y + 0.3, wz + (r() - 0.5) * CELL);
          props.add(tuft);
        }
      }
    }
    /**
     * 战场之外的野地。
     *
     * 这一片是「四方板子」与「一片地方」的分野：
     * 地铺出去了，上面却光秃秃的，看着还是块板子。
     * 撒上成片的林、零星的树、几处小丘，一直撒到看不见的地方，
     * 战场才像是从这片野地里**框出来的一块**，而不是浮在上面的一张纸。
     */
    const far = new THREE.Group();
    const fr = seeded(8823);
    const halfW = ((t.cols - 1) * CELL) / 2;
    const halfD = ((t.rows - 1) * CELL) / 2;
    for (let i = 0; i < 1400; i++) {
      const wx = (fr() - 0.5) * 1500;
      const wz = (fr() - 0.5) * 1500;
      // 战场里面不撒 —— 那儿的地貌是模拟层说了算的
      if (Math.abs(wx) < halfW + CELL && Math.abs(wz) < halfD + CELL) continue;
      const y = rollAt(wx, wz);
      // 成团的林子，不是均匀的噪点
      const clump = Math.sin(wx * 0.011) * Math.cos(wz * 0.013);
      if (clump > 0.32) {
        for (let k = 0; k < 3; k++) {
          const tr = tree(2.4 + fr() * 2.6, (i * 5 + k) | 0);
          tr.position.set(wx + (fr() - 0.5) * 14, y, wz + (fr() - 0.5) * 14);
          tr.rotation.y = fr() * 6.28;
          far.add(tr);
        }
      } else if (fr() < 0.22) {
        const tr = tree(2 + fr() * 2, i | 0);
        tr.position.set(wx, y, wz);
        far.add(tr);
      }
    }
    // 远处几座小丘，把地势撑起来
    for (let i = 0; i < 26; i++) {
      const a = fr() * Math.PI * 2;
      const d = 340 + fr() * 380;
      const wx = Math.cos(a) * d;
      const wz = Math.sin(a) * d;
      const hh = 16 + fr() * 34;
      const knoll = new THREE.Mesh(
        new THREE.ConeGeometry(34 + fr() * 40, hh, 6 + Math.floor(fr() * 3)),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(0x7f8258).lerp(new THREE.Color(0x9aa07a), fr()),
          roughness: 1, flatShading: true,
        }),
      );
      knoll.position.set(wx, rollAt(wx, wz) + hh / 2 - 6, wz);
      knoll.rotation.y = fr() * Math.PI;
      knoll.castShadow = true;
      far.add(knoll);
    }
    this.propRoot.add(mergeStatic(far));

    if (props.children.length) this.propRoot.add(mergeStatic(props));
  }

  /**
   * 一座营寨。
   *
   * 不是随手撒一圈锥体 —— 汉军扎营是有规矩的：
   * 外面一圈鹿角，正面开辕门，帐篷成排，中军帐居中立大旗，
   * 后面堆粮车与草料。照这个摆出来，一眼就认得出是座营。
   */
  private buildCamp(_t: Theatre, at: [number, number], mine: boolean): void {
    const m = materials();
    const g = new THREE.Group();
    const r = seeded(mine ? 77 : 131);
    const R = 30;

    // 鹿角：一圈斜插的尖桩，正面留出辕门
    const stakes = new THREE.Group();
    for (let i = 0; i < 54; i++) {
      const a = (i / 54) * Math.PI * 2;
      // 辕门朝着对面
      const facing = mine ? 0 : Math.PI;
      const da = Math.abs(((a - facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (da > Math.PI - 0.34) continue;
      for (const rr of [R, R - 1.6]) {
        const stake = new THREE.Mesh(new THREE.ConeGeometry(0.34, 3.0, 4), m.wood);
        stake.position.set(Math.cos(a) * rr, 1.5, Math.sin(a) * rr);
        stake.rotation.z = 0.26 * (i % 2 === 0 ? 1 : -1);
        stake.rotation.y = a;
        stake.castShadow = true;
        stakes.add(stake);
      }
    }
    // 辕门：两根高柱加一道横梁
    {
      const facing = mine ? 0 : Math.PI;
      const gx = Math.cos(facing) * R;
      const gz = Math.sin(facing) * R;
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 8, 6), m.woodDark);
        post.position.set(gx - Math.sin(facing) * s * 3.4, 4, gz + Math.cos(facing) * s * 3.4);
        post.castShadow = true;
        stakes.add(post);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 7.6), m.woodDark);
      beam.position.set(gx, 7.6, gz);
      beam.rotation.y = facing;
      beam.castShadow = true;
      stakes.add(beam);
    }
    g.add(mergeStatic(stakes));

    // 帐篷：成排，不是撒开
    const camp = new THREE.Group();
    for (let row = -2; row <= 2; row++) {
      for (let col = -2; col <= 2; col++) {
        if (Math.abs(row) <= 0 && Math.abs(col) <= 0) continue;
        const x = col * 8.8 + (r() - 0.5) * 1.6;
        const z = row * 8.4 + (r() - 0.5) * 1.6;
        if (Math.hypot(x, z) > R - 4) continue;
        const tt = tent((row * 5 + col + 20) | 0);
        tt.scale.setScalar(2.1);
        tt.position.set(x, 0, z);
        camp.add(tt);
      }
    }
    // 后营：粮车、草料、柴堆、水瓮
    for (let i = 0; i < 4; i++) {
      const c = cart();
      c.scale.setScalar(1.5);
      c.position.set((mine ? -1 : 1) * (12 + r() * 5), 0, -12 + i * 7);
      c.rotation.y = r() * 0.6;
      camp.add(c);
      const hay = haystack(i + 3);
      hay.scale.setScalar(1.6);
      hay.position.set((mine ? -1 : 1) * (16 + r() * 4), 0, -14 + i * 8);
      camp.add(hay);
    }
    for (let i = 0; i < 5; i++) {
      const f = firewood(i + 1);
      f.scale.setScalar(1.5);
      f.position.set((r() - 0.5) * 26, 0, (r() - 0.5) * 26);
      camp.add(f);
      const rack = weaponRack();
      rack.scale.setScalar(1.5);
      rack.position.set((r() - 0.5) * 24, 0, (r() - 0.5) * 24);
      rack.rotation.y = r() * Math.PI;
      camp.add(rack);
      const j = jar();
      j.scale.setScalar(1.6);
      j.position.set((r() - 0.5) * 20, 0, (r() - 0.5) * 20);
      camp.add(j);
    }
    g.add(mergeStatic(camp));

    // 中军帐 —— 比别的帐大一圈，立着大旗
    const chief = tent(9);
    chief.scale.setScalar(3.6);
    g.add(chief);
    const flag = banner(22);
    flag.position.set(0, 0, mine ? 4 : -4);
    tintFlag(flag, mine ? 0xc8a45c : 0x8a3b32);
    g.add(flag);

    const [wx, wz] = this.cellToWorld(at[0], at[1]);
    g.position.set(wx, this.heightAt(Math.round(at[0]), Math.round(at[1])), wz);
    this.groundRoot.add(g);
  }

  /**
   * 攻城时对面那座城。
   *
   * 夯土墙 + 城楼 + 角楼，墙里能看见屋顶。
   * 墙**会塌** —— 砸开之后现出缺口，那是玩家等的那一刻，
   * 所以每一段墙都留着引用（见 wallGaps）。
   */
  private buildCity(t: Theatre): void {
    const g = new THREE.Group();
    const r = seeded(555);
    const half = 26;

    // 四面墙。朝着我军的那一面是正面，开城门
    const segs = 7;
    for (const side of [0, 1, 2, 3]) {
      const a = (side * Math.PI) / 2;
      for (let i = 0; i < segs; i++) {
        const t0 = (i + 0.5) / segs - 0.5;
        // 正面中间留给城门
        if (side === 2 && Math.abs(t0) < 0.1) continue;
        const run = wallRun((half * 2) / segs);
        run.scale.setScalar(2.4);
        const px = Math.cos(a) * half - Math.sin(a) * (t0 * half * 2);
        const pz = Math.sin(a) * half + Math.cos(a) * (t0 * half * 2);
        run.position.set(px, 0, pz);
        run.rotation.y = -a;
        g.add(run);
        this.wallGaps.push(run);
      }
    }
    // 城门楼
    {
      const gate = gateTower();
      gate.scale.setScalar(2.4);
      gate.position.set(-half, 0, 0);
      gate.rotation.y = Math.PI / 2;
      g.add(gate);
      this.wallGaps.push(gate);
    }
    // 四角
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const tw = cornerTower();
      tw.scale.setScalar(2.4);
      tw.position.set(sx * half, 0, sz * half);
      g.add(tw);
    }
    // 城里的屋顶。看得见人烟，才像一座城
    const inside = new THREE.Group();
    for (let i = 0; i < 26; i++) {
      const h = hut((i * 7 + 1) | 0);
      h.scale.setScalar(2.2);
      h.position.set((r() - 0.5) * 38, 0, (r() - 0.5) * 38);
      h.rotation.y = r() * Math.PI;
      inside.add(h);
    }
    g.add(mergeStatic(inside));

    // 城头一面大旗 —— 一眼看得出这城是谁的
    const { group: cityFlag } = bannerFlag('敌', 16, 4);
    cityFlag.position.set(0, 14, 0);
    tintFlag(cityFlag, 0x8a3b32);
    g.add(cityFlag);

    const [wx, wz] = this.cellToWorld(t.foeCamp[0], t.foeCamp[1]);
    g.position.set(wx, this.heightAt(Math.round(t.foeCamp[0]), Math.round(t.foeCamp[1])), wz);
    this.wallRoot.add(g);
  }

  /**
   * 地平线上的远山。
   *
   * 退到七百开外、压得很扁、罩进雾里 ——
   * 它的职责只有一个：把地平线关住，让战场不至于浮在灰色里。
   * 上一版摆在两三百外，结果整屏都是山，那是喧宾夺主。
   */
  private buildHorizon(): void {
    const g = new THREE.Group();
    const r = seeded(2024);
    for (let i = 0; i < 34; i++) {
      const a = (i / 34) * Math.PI * 2 + r() * 0.2;
      const d = 720 + r() * 260;
      const h = 46 + r() * 78;
      const hill = new THREE.Mesh(
        new THREE.ConeGeometry(120 + r() * 90, h, 5 + Math.floor(r() * 3)),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(0x76838a).lerp(new THREE.Color(0xa2b0b6), r() * 0.8),
          roughness: 1, flatShading: true, fog: true,
        }),
      );
      hill.position.set(Math.cos(a) * d, h / 2 - 22, Math.sin(a) * d);
      hill.rotation.y = r() * Math.PI;
      g.add(hill);
    }
    this.groundRoot.add(mergeStatic(g));
  }

  // ───────────────────────────────────────────────────────────
  // 兵
  // ───────────────────────────────────────────────────────────

  sync(t: Theatre): void {
    const key = t.targetNodeId + ':' + t.kind + ':' + t.cols + 'x' + t.rows
      + ':' + Math.round(t.ownCamp[0] * 10) + ',' + Math.round(t.ownCamp[1] * 10);
    if (this.built !== key) {
      this.built = key;
      this.units.clear();
      this.unitRoot.clear();
      this.buildScene(t);
    }
    this.sim = t;
    this.apply(t);

    // 同步完立刻摆人、画一帧，不必等下一次 rAF。
    // 这样「派了一支兵」是当场看得见的，而不是下一帧才出现
    this.placeArmy();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 把战场的现状搬到画面上。
   *
   * **这一段必须每帧跑一次，不能只在界面重渲染时跑。**
   *
   * 原先它只挂在 React 的 `sync()` 上，而 React 只在**有事件**的时候重渲染 ——
   * 引擎里那一行 `if (result.events.length > 0)` 决定了这件事。
   * 一场仗从击鼓到接战有九十多拍，这九十多拍里一条日志都不出，
   * 于是整整几秒钟：人数不动、尸首不出、旗子不变，
   * 屏幕上只有两团兵默默地滑过去。
   *
   * 玩家看到的就是「开战后啥反馈都没有，莫名其妙等一会儿」——
   * 仗打得好好的，只是没人告诉画面。
   */
  private apply(t: Theatre): void {
    // 墙塌了就现出缺口
    if (t.kind === 'siege') {
      const share = t.wall / 1000;
      this.wallGaps.forEach((seg, i) => {
        seg.visible = (i / this.wallGaps.length) < share + 0.001;
      });
    }

    const seen = new Set<string>();
    for (const u of t.units) {
      // 看不见的就是看不见。画出来等于作弊
      if (u.side === 'foe' && u.hidden && !u.revealed) continue;
      seen.add(u.id);
      let vis = this.units.get(u.id);
      if (!vis) {
        vis = this.makeUnit(u);
        this.units.set(u.id, vis);
      }
      vis.routed = u.routed;
      // 死了人就在那儿留下痕迹 —— 尸首与扬尘
      const was = this.lastMen.get(u.id);
      if (was !== undefined && u.men < was) {
        this.spawnCasualties(vis.group.position, was - u.men, u.side === 'foe');
      }
      this.lastMen.set(u.id, u.men);

      const want = figuresFor(u.men);
      if (want !== vis.figures) {
        vis.figures = want;
        vis.ranks = ranksOf(want, jitterAt);
      }
      if (u.men !== vis.labelMen) {
        vis.labelMen = u.men;
        retagLabel(vis.label, KIND_NAME[u.kind], u.men, u.side === 'own');
      }
      const hiding = u.hidden && !u.revealed;
      vis.ring.visible = !u.routed;
      (vis.ring.material as THREE.MeshBasicMaterial).opacity = hiding ? 0.3 : 0.85;
      vis.label.visible = !u.routed;
      if (vis.flag) vis.flag.visible = !u.routed && !hiding;
    }

    for (const [id, vis] of this.units) {
      if (seen.has(id)) continue;
      this.unitRoot.remove(vis.group);
      this.units.delete(id);
    }
  }

  private makeUnit(u: Unit): UnitVisual {
    const g = new THREE.Group();
    const color = new THREE.Color(u.side === 'own' ? 0xc8a45c : 0x8a3b32);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(CELL * 0.46, CELL * 0.58, 28),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.85,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.5;
    g.add(ring);

    const flag = banner(10);
    tintFlag(flag, u.side === 'own' ? 0xc8a45c : 0x8a3b32);
    g.add(flag);

    const label = makeLabel(KIND_NAME[u.kind], u.men, color, u.side === 'own');
    label.position.y = 16;
    g.add(label);

    const [wx, wz] = this.cellToWorld(u.x, u.y);
    g.position.set(wx, this.heightAt(Math.round(u.x), Math.round(u.y)), wz);
    this.unitRoot.add(g);

    const n = figuresFor(u.men);
    return {
      group: g, x: u.x, y: u.y, facing: u.facing,
      figures: n, ranks: ranksOf(n, jitterAt),
      ring, flag, label, labelMen: u.men, routed: u.routed, flee: 0,
    };
  }

  /**
   * 倒下的人与扬起的尘。
   *
   * 死多少人就倒多少个（封顶），外加一团土。
   * 这是「看得出在打」最直接的一件事 ——
   * 数字变小是看不见的，人倒下去是看得见的。
   */
  private spawnCasualties(at: THREE.Vector3, lost: number, foe: boolean): void {
    const n = Math.min(7, 1 + Math.floor(lost / 6));
    const r = seeded((at.x * 13 + at.z * 7 + lost) | 0);
    for (let i = 0; i < n; i++) {
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.5, 1.5, 3, 5),
        new THREE.MeshStandardMaterial({
          color: foe ? 0x6b3b34 : 0x8a7448, roughness: 1,
          transparent: true, opacity: 0.95,
        }),
      );
      body.rotation.z = Math.PI / 2;
      body.rotation.y = r() * 6.28;
      body.position.set(
        at.x + (r() - 0.5) * 9, at.y + 0.5, at.z + (r() - 0.5) * 9,
      );
      this.fxRoot.add(body);
      this.effects.push({ obj: body, life: 9, age: 0, rise: 0, grow: 0, spin: 0 });
    }
    // 一团土
    for (let i = 0; i < 3; i++) {
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(1.6 + r() * 1.4, 7, 5),
        new THREE.MeshBasicMaterial({
          color: 0xc9bda2, transparent: true, opacity: 0.5, depthWrite: false,
        }),
      );
      puff.position.set(
        at.x + (r() - 0.5) * 8, at.y + 1.5, at.z + (r() - 0.5) * 8,
      );
      this.fxRoot.add(puff);
      this.effects.push({
        obj: puff, life: 1.5, age: 0, rise: 5 + r() * 5, grow: 1.7, spin: 0,
      });
    }
  }

  /** 把场上的动静往前推一帧 */
  private stepEffects(dt: number): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i]!;
      fx.age += dt;
      const t = fx.age / fx.life;
      if (t >= 1) {
        this.fxRoot.remove(fx.obj);
        this.effects.splice(i, 1);
        continue;
      }
      if (fx.rise) fx.obj.position.y += fx.rise * dt;
      if (fx.grow) fx.obj.scale.setScalar(1 + t * fx.grow);
      const mat = (fx.obj as THREE.Mesh).material as THREE.Material;
      if ('opacity' in mat) {
        // 尸首躺着不动，只在最后化掉；尘土一路淡出去
        (mat as THREE.MeshBasicMaterial).opacity =
          fx.rise > 0 ? 0.5 * (1 - t) : 0.95 * Math.min(1, (1 - t) * 4);
      }
    }
  }

  private placeArmy(): void {
    const t = this.sim;
    if (!t) return;
    this.army.begin();
    for (const [id, vis] of this.units) {
      const u = t.units.find((x) => x.id === id);
      if (!u || vis.routed) continue;
      const g = vis.group.position;
      const cos = Math.cos(vis.facing);
      const sin = Math.sin(vis.facing);
      const scale = u.kind === 'horse' ? 1.75 : 2.0;
      for (let i = 0; i < vis.ranks.length; i++) {
        const rk = vis.ranks[i]!;
        const dx = rk.dx * 2.3;
        const dz = rk.dz * 2.3;
        this.army.place(
          u.kind, u.side === 'foe',
          g.x + dx * cos + dz * sin,
          g.y + Math.sin(this.lastFrame / 460 + i * 1.7) * 0.06,
          g.z - dx * sin + dz * cos,
          vis.facing + Math.PI / 2, scale,
        );
      }
    }
    this.army.commit();
  }

  // ───────────────────────────────────────────────────────────

  private cellToWorld(col: number, row: number): [number, number] {
    return [
      (col - (this.cols - 1) / 2) * CELL,
      (row - (this.rows - 1) / 2) * CELL,
    ];
  }

  /**
   * 这一格的地面高度。
   *
   * 两层加起来：格子给的地形高度，加上铺到天边的那层缓坡。
   * 少了后一层，营寨和树会浮在起伏的地面上方或陷进去。
   */
  private heightAt(col: number, row: number): number {
    const c = clamp(Math.round(col), 0, this.cols - 1);
    const r = clamp(Math.round(row), 0, this.rows - 1);
    const [wx, wz] = this.cellToWorld(col, row);
    return (this.heights[r * this.cols + c] ?? 0) * RISE + rollAt(wx, wz);
  }

  /**
   * 把整片战场框进画面。
   *
   * 这是上一版最要命的一处：镜头对着自家营寨，
   * 敌营在三十二格外，玩家根本看不见要打的是谁。
   * 开局就该看得见全局，要看细节再自己推近。
   */
  frameAll(): void {
    this.panX = 0;
    this.panZ = 0;
    const w = ((this.cols - 1) * CELL) / 2;
    const d = ((this.rows - 1) * CELL) / 2;
    const aspect = this.host.clientWidth / Math.max(1, this.host.clientHeight);

    /**
     * 按**真实的投影范围**算，横竖分开。
     *
     * 四十五度方位角下，战场在屏幕上是一个菱形：
     * 横里是 (宽 + 深)/√2，竖里还要再乘一个 sin(仰角) ——
     * 竖里比横里小得多。
     *
     * 上一版横竖用了同一个数，于是竖直方向大幅过量，
     * 战场缩在中间一条，上下留着大片空白。
     */
    const halfX = (w + d) / Math.SQRT2;
    const sinLift = CAM_LIFT / Math.hypot(Math.SQRT2, CAM_LIFT);
    const halfY = halfX * sinLift + 30;

    // 取景以**横向铺满**为准 —— 战场要顶到画面两边，那才叫宏大。
    // 竖直方向留出来的地方给天与远山，不当浪费
    const byWidth = halfX / aspect;
    this.zoom = clamp(Math.max(byWidth, halfY) * 1.04, 60, 400);
    this.resize();
  }

  focusOn(at: [number, number]): void {
    const [wx, wz] = this.cellToWorld(at[0], at[1]);
    this.panX = wx;
    this.panZ = wz;
    this.updateCamera();
  }

  private updateCamera(): void {
    // 正交相机的取景由 zoom 决定，站多远只影响裁剪与雾 ——
    // 所以距离固定，不跟着缩放跑。跟着跑的话雾会随缩放忽浓忽淡
    const dist = CAM_DIST;
    this.camera.position.set(this.panX + dist, dist * CAM_LIFT, this.panZ + dist);
    this.camera.lookAt(this.panX, 4, this.panZ);
    this.camera.updateMatrixWorld();
    this.sun.target.position.set(this.panX, 0, this.panZ);
    this.sun.position.set(this.panX + 210, 360, this.panZ + 140);
  }

  private bindInput(): void {
    const el = this.renderer.domElement;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let moved = 0;

    el.addEventListener('pointerdown', (e) => {
      dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
    });
    window.addEventListener('pointerup', () => { dragging = false; });
    el.addEventListener('pointermove', (e) => {
      const rect = el.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      if (dragging) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        moved += Math.abs(dx) + Math.abs(dy);
        lastX = e.clientX; lastY = e.clientY;
        const k = this.zoom / 240;
        // 屏幕上的拖动换算到 45° 俯视的世界方向
        this.panX -= (dx + dy) * k;
        this.panZ -= (dy - dx) * k;
        this.updateCamera();
        return;
      }
      const cell = this.pickCell();
      if (cell) this.cb.onHoverCell(cell[0], cell[1]);
    });
    el.addEventListener('click', () => {
      // 拖过画面就不算点击 —— 否则一拖就误下命令
      if (moved > 6) return;
      const cell = this.pickCell();
      if (cell) this.cb.onPickCell(cell[0], cell[1]);
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = clamp(this.zoom * (e.deltaY > 0 ? 1.12 : 0.89), 55, 340);
      this.resize();
    }, { passive: false });
  }

  private pickCell(): [number, number] | null {
    if (!this.pickPlane) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.pickPlane, false)[0];
    if (!hit) return null;
    const col = hit.point.x / CELL + (this.cols - 1) / 2;
    const row = hit.point.z / CELL + (this.rows - 1) / 2;
    if (col < -0.5 || col > this.cols - 0.5) return null;
    if (row < -0.5 || row > this.rows - 0.5) return null;
    return [clamp(col, 0, this.cols - 1), clamp(row, 0, this.rows - 1)];
  }

  /**
   * 出事了 —— 把镜头推过去。
   *
   * 这是「看得出在打」最要紧的一件事。上一版打起来只有右下角几行字，
   * 而那片地上真正的动静 —— 伏兵从林子里杀出来、某一路崩了、
   * 大营起火 —— 玩家全都错过了，因为镜头压根没朝那边。
   *
   * 但**不是每件事都值得推**。每一次接触都推一下，画面会抽搐。
   * 只推那几个真正的关口（见 App 那边的筛选）。
   */
  pushTo(col: number, row: number, tone: 'good' | 'bad'): void {
    const [wx, wz] = this.cellToWorld(col, row);
    this.panTo = [wx, wz];

    // 那一处闪一下。镜头推过去的时候，眼睛要知道看哪儿
    const y = this.heightAt(col, row);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(CELL * 0.5, CELL * 0.72, 32),
      new THREE.MeshBasicMaterial({
        color: tone === 'good' ? 0x9fd08a : 0xd8705a,
        transparent: true, opacity: 0.95,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(wx, y + 0.8, wz);
    this.fxRoot.add(ring);
    this.effects.push({ obj: ring, life: 1.6, age: 0, rise: 2, grow: 2.6, spin: 0 });
  }

  /** 在地上画一个记号：你要派兵去的地方 */
  showMark(col: number, row: number, tone: 'good' | 'warn'): void {
    this.markRoot.clear();
    const [wx, wz] = this.cellToWorld(col, row);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(CELL * 0.52, CELL * 0.8, 32),
      new THREE.MeshBasicMaterial({
        color: tone === 'good' ? 0x9fd08a : 0xd8b06a,
        transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(wx, this.heightAt(col, row) + 0.7, wz);
    this.markRoot.add(ring);
  }

  clearMark(): void {
    this.markRoot.clear();
  }

  private resize = (): void => {
    const w = this.host.clientWidth;
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    // 竖屏时按宽度反过来定，整片战场才总在画面里 —— 同 camp.ts 那一处
    const fit = aspect < 1 ? this.zoom / aspect : this.zoom;
    this.camera.left = -fit * aspect;
    this.camera.right = fit * aspect;
    this.camera.top = fit;
    this.camera.bottom = -fit;
    this.camera.updateProjectionMatrix();
    this.updateCamera();
  };

  start(): void {
    const loop = (now: number): void => {
      this.raf = requestAnimationFrame(loop);
      const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0.016;
      this.lastFrame = now;

      // 镜头往出事的地方慢慢推。硬切会让人晕，也看不清是从哪儿推过去的
      if (this.panTo) {
        const [tx, tz] = this.panTo;
        const k = Math.min(1, dt * 2.6);
        this.panX = lerp(this.panX, tx, k);
        this.panZ = lerp(this.panZ, tz, k);
        if (Math.hypot(this.panX - tx, this.panZ - tz) < 1.5) this.panTo = null;
        this.updateCamera();
      }

      const t = this.sim;
      if (t) {
        // 每帧把现状搬过来 —— 见 apply() 上头那段
        this.apply(t);
        for (const [id, vis] of this.units) {
          const u = t.units.find((x) => x.id === id);
          if (!u) continue;
          vis.x = lerp(vis.x, u.x, Math.min(1, dt * 7));
          vis.y = lerp(vis.y, u.y, Math.min(1, dt * 7));
          vis.facing = lerpAngle(vis.facing, u.facing, Math.min(1, dt * 6));
          const [wx, wz] = this.cellToWorld(vis.x, vis.y);
          let y = this.heightAt(Math.round(vis.x), Math.round(vis.y));
          if (vis.routed) {
            vis.flee += dt;
            y -= vis.flee * 2.4;
            vis.group.visible = vis.flee < 3;
          }
          vis.group.position.set(wx, y, wz);
        }
        this.placeArmy();
      }

      this.stepEffects(dt);
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  probe(): unknown {
    let meshes = 0;
    this.scene.traverse((o) => { if (o instanceof THREE.Mesh) meshes++; });
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(
        this.camera.projectionMatrix, this.camera.matrixWorldInverse,
      ),
    );
    const inView = (at: [number, number]): boolean => {
      const [wx, wz] = this.cellToWorld(at[0], at[1]);
      return frustum.containsPoint(new THREE.Vector3(wx, 2, wz));
    };
    const t = this.sim;
    return {
      meshes,
      figures: this.army.drawn(),
      units: this.units.size,
      wallSegments: this.wallGaps.length,
      wallVisible: this.wallGaps.filter((s) => s.visible).length,
      ownCampInView: t ? inView(t.ownCamp) : null,
      foeCampInView: t ? inView(t.foeCamp) : null,
      zoom: Math.round(this.zoom),
      canvas: [this.renderer.domElement.width, this.renderer.domElement.height],
    };
  }

  /** 开发期自检：把画面读回来看看有没有东西 */
  pixels(): number[][] {
    const gl = this.renderer.getContext();
    const w = this.renderer.domElement.width;
    const h = this.renderer.domElement.height;
    const buf = new Uint8Array(4 * 25);
    const out: number[][] = [];
    for (let i = 0; i < 25; i++) {
      const x = Math.floor(((i % 5) + 0.5) * (w / 5));
      const y = Math.floor((Math.floor(i / 5) + 0.5) * (h / 5));
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      out.push([buf[0]!, buf[1]!, buf[2]!]);
    }
    return out;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.army.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

// ─────────────────────────────────────────────────────────────

const FIG_PER_MAN = 4;
const FIG_MAX = 90;
const FIG_MIN = 5;

function figuresFor(men: number): number {
  return Math.min(FIG_MAX, Math.max(FIG_MIN, Math.round(men / FIG_PER_MAN)));
}

function jitterAt(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * 铺到天边的那层缓坡。
 *
 * 中原是平的，但不是桌面 —— 起伏是有的，只是缓。
 * 这一层与格子给的地形无关，管的是「这片地看着像不像一片地」。
 * 地表、营寨、树、兵，全都要按它落位，否则会有东西浮在半空。
 */
function rollAt(wx: number, wz: number): number {
  return Math.sin(wx * 0.0043 + 1.7) * 5.4
    + Math.cos(wz * 0.0037 - 0.6) * 6.1
    + Math.sin((wx + wz) * 0.0021) * 4.2;
}

function seeded(n: number): () => number {
  let s = n >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function lerpAngle(a: number, b: number, t: number): number {
  const d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
}

/** 把旗面染成本方的颜色 */
function tintFlag(g: THREE.Object3D, hex: number): void {
  g.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o.geometry.type !== 'PlaneGeometry') return;
    const mat = (o.material as THREE.Material).clone() as THREE.MeshStandardMaterial;
    mat.color.setHex(hex);
    o.material = mat;
  });
}

function makeLabel(
  kind: string, men: number, color: THREE.Color, mine: boolean,
): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 72;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas),
    depthTest: false, transparent: true,
  }));
  sprite.scale.set(18, 5.1, 1);
  sprite.userData['canvas'] = canvas;
  sprite.userData['color'] = color;
  retagLabel(sprite, kind, men, mine);
  return sprite;
}

function retagLabel(sprite: THREE.Sprite, kind: string, men: number, mine: boolean): void {
  const canvas = sprite.userData['canvas'] as HTMLCanvasElement;
  const color = sprite.userData['color'] as THREE.Color;
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = 'rgba(16,13,10,.84)';
  g.beginPath();
  g.roundRect(6, 8, canvas.width - 12, 56, 5);
  g.fill();
  g.fillStyle = '#' + color.getHexString();
  g.fillRect(6, 8, 6, 56);
  g.font = '30px "Noto Serif SC", serif';
  g.fillStyle = mine ? '#f0e2c8' : '#f0d2c8';
  g.textBaseline = 'middle';
  g.fillText(kind, 26, 36);
  g.font = '28px "Noto Serif SC", serif';
  g.fillText(String(men), 118, 36);
  (sprite.material.map as THREE.CanvasTexture).needsUpdate = true;
}

/** 地面的性子，界面要用来告诉玩家这块地能不能伏兵 */
export function groundInfo(ground: string): { cover: number; fight: number } {
  const g = GROUND[ground as keyof typeof GROUND] ?? GROUND.plain;
  return { cover: g.cover, fight: g.fight };
}
