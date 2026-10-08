/**
 * 营内图 —— 武将的地方。
 *
 * 文官有一座城：五乘五的地块，你在上面盖房子。
 * 武将有一座营，**模式是另一回事**：营里没有地块可盖，
 * 营的样子完全由那几个数长出来 ——
 *
 *   兵多，帐就多，一排排铺开去
 *   练兵，校场上就有人在列队操演
 *   屯田，营外的地里就有人在弯腰
 *   器械造出来，辕门旁就多几架井阑与投石
 *   粮少，粮囤就空一截
 *
 * 所以这张图不是让你点的，是让你**看的**：
 * 走进营门那一眼，你就知道自己这一年过得怎么样。
 * 这也是它和城内图最大的分别 —— 城是你摆出来的，营是你带出来的。
 */
import * as THREE from 'three';
import {
  banner, granaryBin, person, soldier, tree, wellHead,
} from './build.ts';
import { materials } from './textures.ts';
import { SkyDome, skyTexture } from './sky.ts';
import { mergeStatic } from './merge.ts';
import { Army, ranksOf } from './host.ts';
import type { Camp } from '../sim/general_types.ts';

const CAM_DIST = 96;
const CAM_ELEVATION = 0.62;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** 帐幕排布：一排排铺开，兵越多排得越远 */
const TENT_ROWS = 4;
const TENT_GAP = 7.4;
const ROW_GAP = 9.5;
/** 一顶帐住多少人 */
/**
 * 一顶帐篷住多少人。
 *
 * 汉军一什十人共一帐 —— 二十二人一帐是把营画瘦了：
 * 二百人的营只支得起九顶帐篷，看着像个哨所，不像一营兵。
 * 起手那一眼就该像座营，否则「发育」从第一天起就没有参照。
 */
const MEN_PER_TENT = 11;
const TENT_MAX = 48;

export class CampView {
  private readonly host: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly sun: THREE.DirectionalLight;
  private readonly sky: SkyDome;

  private readonly tents: THREE.Object3D[] = [];
  private readonly engines: THREE.Object3D[] = [];
  private readonly farmers: THREE.Group[] = [];
  private readonly grainBins: THREE.Object3D[] = [];
  /** 修出来的设施。营里有什么，一眼看得见 */
  private readonly facilities = new Map<string, THREE.Group>();
  private readonly army: Army;
  private readonly flag: THREE.Mesh | null = null;

  /**
   * 取景。
   *
   * 40 的时候整座营框不进画面，玩家看到的是一角空地 ——
   * 而营是这条线上唯一「看得见自己长大」的地方，
   * 框不全等于把发育感也框掉了。
   */
  private zoom = 66;
  private panX = 0;
  private panZ = 0;
  private raf = 0;
  private lastFrame = 0;
  private paused = false;
  private dragging = false;
  private dragAt: [number, number] = [0, 0];

  private camp: Camp | null = null;
  private skyTime = 0.32;
  private drillRanks: { dx: number; dz: number }[] = [];

  constructor(host: HTMLElement) {
    this.host = host;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: import.meta.env.DEV,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    host.appendChild(this.renderer.domElement);

    // 天。少了它，地表之外就是清屏的黑 —— 画面下缘会出现一道黑边
    this.scene.background = skyTexture();
    this.scene.fog = new THREE.Fog(0xd8cfb8, CAM_DIST * 2.2, CAM_DIST * 5.5);

    const aspect = host.clientWidth / Math.max(1, host.clientHeight);
    this.camera = new THREE.OrthographicCamera(
      -this.zoom * aspect, this.zoom * aspect, this.zoom, -this.zoom, 0.1, 520,
    );

    this.scene.add(new THREE.HemisphereLight(0xbdd0dd, 0x5f5a44, 0.72));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.2));
    this.sun = new THREE.DirectionalLight(0xfff0d8, 1.8);
    this.sun.position.set(60, 96, 44);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0007;
    this.sun.shadow.normalBias = 0.03;
    const sc = this.sun.shadow.camera;
    sc.left = -80; sc.right = 80; sc.top = 80; sc.bottom = -80; sc.near = 1; sc.far = 280;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.sky = new SkyDome();
    this.scene.add(this.sky.mesh);
    this.army = new Army(this.scene);

    this.flag = this.build();
    this.updateCamera();
    this.resize();

    window.addEventListener('resize', this.resize);
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointerleave', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
  }

  // ───────────────────────────────────────────────────────────

  /**
   * 把营立起来。
   *
   * 建好之后就不再动的（地面、辕门、望楼、栅栏）一律压成静态网格；
   * 会变的（帐幕、器械、粮囤、田里的人）单独留着，
   * 由 sync 按营中的数改它们的可见与否。
   */
  private build(): THREE.Mesh | null {
    const m = materials();
    const r = rng(8821);
    const still = new THREE.Group();

    /**
     * 地。
     *
     * **营内是夯实的土，营外是野草。**
     *
     * 上一版整片地都是夯土色，一望无际一片沙黄 —— 营扎在戈壁上似的。
     * 而营是扎在野地里的：踩实的只有帐篷之间那一块，
     * 出了鹿角就是草。
     *
     * 做法与战场那张图一致：顶点色乘在草地贴图上，
     * 中间一圈揉成土色，往外渐次转青。铺得比画面大得多，看不见边。
     */
    const SPAN = 900;
    const SEG = 96;
    const geo = new THREE.PlaneGeometry(SPAN, SPAN, SEG, SEG);
    const pos = geo.attributes['position'] as THREE.BufferAttribute;
    const colors: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const d = Math.hypot(x, y);
      // 营内平，营外起伏
      const far = Math.max(0, d - 70) / 90;
      /**
       * 营内是**平的**，起伏只在营外。
       *
       * 这一条踩过坑：给整片地叠了一层缓坡，营地中心被抬高七个单位，
       * 而帐篷才五个单位高 —— 十八顶帐篷全被埋进土里，
       * 只剩十三单位高的中军帐露着个尖。
       * 夯实的营地本来就该是平的，那是它「夯实」的意思。
       */
      const outside = Math.min(1, far);
      pos.setZ(
        i,
        far * (Math.sin(x * 0.05) * 3 + Math.cos(y * 0.06) * 2.6)
        + outside * (Math.sin(x * 0.011 + 1.3) * 4.2 + Math.cos(y * 0.009 - 0.4) * 4.8),
      );
      // 踩实的那一圈是土，往外化成草。中间还有青黄的斑驳
      const packed = 1 - Math.min(1, Math.max(0, (d - 46) / 34));
      const n = Math.sin(x * 0.0072 + 0.6) * Math.cos(y * 0.0064 - 0.9);
      const green = Math.max(0, 1 - packed) * (0.55 + n * 0.3);
      colors.push(
        1.04 - green * 0.40,
        0.96 - green * 0.02,
        0.70 - green * 0.10,
      );
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const gmat = m.grass.clone();
    gmat.vertexColors = true;
    const gmap = (m.grass.map as THREE.Texture).clone();
    gmap.repeat.set(110, 110);
    gmap.wrapS = THREE.RepeatWrapping;
    gmap.wrapT = THREE.RepeatWrapping;
    gmap.needsUpdate = true;
    gmat.map = gmap;
    if (m.grass.bumpMap) {
      const gb = (m.grass.bumpMap as THREE.Texture).clone();
      gb.repeat.copy(gmap.repeat);
      gb.wrapS = THREE.RepeatWrapping;
      gb.wrapT = THREE.RepeatWrapping;
      gb.needsUpdate = true;
      gmat.bumpMap = gb;
    }
    const ground = new THREE.Mesh(geo, gmat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // 辕门。汉军营门就是两根柱子架一道横木，上面挂旗
    for (const dx of [-9, 9]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.25, 17, 7), m.wood);
      post.position.set(dx, 8.5, 44);
      post.castShadow = true;
      still.add(post);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(22, 1.7, 1.7), m.wood);
    lintel.position.set(0, 16.4, 44);
    lintel.castShadow = true;
    still.add(lintel);

    // 栅栏：只围三面，正面留着辕门
    const fence = (x0: number, z0: number, x1: number, z1: number): void => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.round(len / 3.4);
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const stake = new THREE.Mesh(
          new THREE.CylinderGeometry(0.42, 0.5, 6.4 + r() * 1.2, 5), m.wood,
        );
        stake.position.set(x0 + (x1 - x0) * t, 3.2, z0 + (z1 - z0) * t);
        stake.rotation.z = (r() - 0.5) * 0.09;
        stake.castShadow = true;
        still.add(stake);
      }
    };
    fence(-46, 44, -46, -40);
    fence(46, 44, 46, -40);
    fence(-46, -40, 46, -40);
    fence(-46, 44, -13, 44);
    fence(13, 44, 46, 44);

    // 望楼
    const tower = new THREE.Group();
    for (const [px, pz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]] as const) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.85, 22, 5), m.wood);
      leg.position.set(px, 11, pz);
      leg.castShadow = true;
      tower.add(leg);
    }
    const deck = new THREE.Mesh(new THREE.BoxGeometry(10, 1.2, 10), m.wood);
    deck.position.y = 22.6;
    deck.castShadow = true;
    tower.add(deck);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(8, 6, 4), m.tile);
    roof.position.y = 26.4;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    tower.add(roof);
    tower.position.set(-38, 0, 34);
    still.add(tower);

    // 中军帐：比别的帐大一圈，摆在最里面
    const hq = new THREE.Mesh(new THREE.ConeGeometry(9.5, 13, 8), m.cloth);
    hq.position.set(0, 6.5, -26);
    hq.castShadow = true;
    still.add(hq);

    // 营外的树
    for (let i = 0; i < 40; i++) {
      const a = r() * Math.PI * 2;
      const d = 78 + r() * 90;
      const t = tree(2.4 + r() * 2.6, i * 11 + 3);
      t.position.set(Math.cos(a) * d, 0, Math.sin(a) * d);
      still.add(t);
    }
    still.add(wellHead());
    (still.children[still.children.length - 1] as THREE.Object3D).position.set(22, 0, 30);

    this.scene.add(mergeStatic(still));

    // ── 会变的东西 ──────────────────────────────────────

    // 帐幕
    for (let i = 0; i < TENT_MAX; i++) {
      const row = i % TENT_ROWS;
      const col = Math.floor(i / TENT_ROWS);
      const tent = new THREE.Mesh(new THREE.ConeGeometry(3.2, 5.0, 6), m.cloth);
      tent.position.set(
        -40 + col * TENT_GAP + (r() - 0.5) * 1.1,
        2.5,
        -16 + row * ROW_GAP + (r() - 0.5) * 1.1,
      );
      tent.castShadow = true;
      tent.visible = false;
      this.scene.add(tent);
      this.tents.push(tent);
    }

    // 器械：井阑与投石，摆在辕门内侧
    for (let i = 0; i < 5; i++) {
      const e = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(5, 9, 5), m.wood);
      frame.position.y = 4.5;
      frame.castShadow = true;
      e.add(frame);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 11, 5), m.wood);
      arm.position.set(0, 9, 0);
      arm.rotation.z = -0.7;
      arm.castShadow = true;
      e.add(arm);
      e.position.set(-26 + i * 13, 0, 34);
      e.visible = false;
      this.scene.add(e);
      this.engines.push(e);
    }

    // 粮囤：满的时候六个，空了只剩一两个
    for (let i = 0; i < 6; i++) {
      const bin = granaryBin(1);
      bin.position.set(30 + (i % 2) * 9, 0, -4 - Math.floor(i / 2) * 9);
      bin.visible = false;
      this.scene.add(bin);
      this.grainBins.push(bin);
    }

    // 屯田：营外那片地里弯腰的人
    for (let i = 0; i < 22; i++) {
      const f = person(i % 2 === 0);
      f.scale.setScalar(2.4);
      f.position.set(-90 + (i % 11) * 8, 0, 56 + Math.floor(i / 11) * 9);
      f.rotation.x = 0.42;
      f.visible = false;
      this.scene.add(f);
      this.farmers.push(f);
    }

    // 营中设施。修出来的东西要立在营里 ——
    // 「我这一年修了什么」不该只写在面板上
    this.buildFacilities();

    // 中军的大旗
    const b = banner(20);
    b.position.set(0, 0, -38);
    this.scene.add(b);
    let flag: THREE.Mesh | null = null;
    b.traverse((o) => {
      if (o instanceof THREE.Mesh && o.geometry.type === 'PlaneGeometry') flag = o;
    });
    return flag;
  }

  /**
   * 各处设施长什么样。
   *
   * 都建好摆在各自的位置上，一律先藏起来 ——
   * sync 时按营里实际修了什么决定谁露面。
   * 级数高的多摆几件，所以每一处都是一小组东西而不是一个物件。
   */
  private buildFacilities(): void {
    const m = materials();
    const r = rng(1717);
    const put = (id: string, g: THREE.Group, x: number, z: number): void => {
      g.position.set(x, 0, z);
      g.visible = false;
      this.scene.add(g);
      this.facilities.set(id, g);
    };

    // 校场：一片夯平的空地，四角立旗，边上一排兵器架
    {
      const g = new THREE.Group();
      const pad = new THREE.Mesh(new THREE.CircleGeometry(15, 20), m.dirt);
      pad.rotation.x = -Math.PI / 2;
      pad.position.y = 0.05;
      pad.receiveShadow = true;
      g.add(pad);
      for (const [px, pz] of [[-13, -13], [13, -13], [-13, 13], [13, 13]] as const) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 9, 5), m.wood);
        pole.position.set(px, 4.5, pz);
        pole.castShadow = true;
        g.add(pole);
      }
      for (let i = 0; i < 5; i++) {
        const rack = new THREE.Mesh(new THREE.BoxGeometry(4, 0.5, 0.6), m.wood);
        rack.position.set(-8 + i * 4, 3.4, -16);
        rack.castShadow = true;
        g.add(rack);
        for (let k = 0; k < 4; k++) {
          const spear = new THREE.Mesh(
            new THREE.CylinderGeometry(0.11, 0.11, 7, 4), m.wood,
          );
          spear.position.set(-9.4 + i * 4 + k * 0.9, 3.5, -16);
          spear.rotation.z = 0.12;
          spear.castShadow = true;
          g.add(spear);
        }
      }
      put('jiaochang', g, 0, 10);
    }

    // 厩栏：一排马槽与栅栏
    {
      const g = new THREE.Group();
      for (let i = 0; i < 8; i++) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 5, 5), m.wood);
        post.position.set(-14 + i * 4, 2.5, 0);
        post.castShadow = true;
        g.add(post);
      }
      const rail = new THREE.Mesh(new THREE.BoxGeometry(30, 0.5, 0.5), m.wood);
      rail.position.set(-0.5, 3.6, 0);
      rail.castShadow = true;
      g.add(rail);
      const trough = new THREE.Mesh(new THREE.BoxGeometry(28, 1.4, 2.4), m.woodDark);
      trough.position.set(-0.5, 0.8, 3.4);
      trough.castShadow = true;
      g.add(trough);
      const shed = new THREE.Mesh(new THREE.BoxGeometry(32, 0.9, 9), m.thatch);
      shed.position.set(-0.5, 6.4, 1.6);
      shed.castShadow = true;
      g.add(shed);
      put('jiuli', g, 30, 26);
    }

    // 弓弩坊：工棚加几张靶
    {
      const g = new THREE.Group();
      const shed = new THREE.Mesh(new THREE.BoxGeometry(14, 6, 9), m.earth);
      shed.position.y = 3;
      shed.castShadow = true;
      g.add(shed);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(16, 1, 11), m.thatch);
      roof.position.y = 6.4;
      roof.castShadow = true;
      g.add(roof);
      for (let i = 0; i < 3; i++) {
        const target = new THREE.Mesh(
          new THREE.CylinderGeometry(2.2, 2.2, 0.6, 12), m.cloth,
        );
        target.rotation.z = Math.PI / 2;
        target.position.set(-6 + i * 6, 3, 14);
        target.castShadow = true;
        g.add(target);
      }
      put('gongnufang', g, -30, 22);
    }

    // 工坊：料堆、锯木架、半成的器械
    {
      const g = new THREE.Group();
      const shed = new THREE.Mesh(new THREE.BoxGeometry(16, 7, 11), m.earth);
      shed.position.y = 3.5;
      shed.castShadow = true;
      g.add(shed);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(18, 1, 13), m.tile);
      roof.position.y = 7.4;
      roof.castShadow = true;
      g.add(roof);
      for (let i = 0; i < 9; i++) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 11, 6), m.wood);
        log.rotation.z = Math.PI / 2;
        log.position.set(12, 0.9 + Math.floor(i / 3) * 1.7, -6 + (i % 3) * 1.8);
        log.castShadow = true;
        g.add(log);
      }
      put('gongfang', g, -30, -6);
    }

    // 廪仓：一排粮囤加一间仓房
    {
      const g = new THREE.Group();
      const house = new THREE.Mesh(new THREE.BoxGeometry(13, 8, 10), m.earth);
      house.position.y = 4;
      house.castShadow = true;
      g.add(house);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(15, 1, 12), m.tile);
      roof.position.y = 8.4;
      roof.castShadow = true;
      g.add(roof);
      put('lincang', g, 34, -18);
    }

    // 屯所：农具棚与耕牛
    {
      const g = new THREE.Group();
      const shed = new THREE.Mesh(new THREE.BoxGeometry(11, 5, 8), m.thatch);
      shed.position.y = 2.5;
      shed.castShadow = true;
      g.add(shed);
      for (let i = 0; i < 6; i++) {
        const tool = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 5, 4), m.wood);
        tool.position.set(-4 + i * 1.6, 2.5, 5);
        tool.rotation.z = 0.2 + r() * 0.2;
        g.add(tool);
      }
      put('tunsuo', g, 36, 34);
    }

    // 帅帐加大：修了帅帐就在中军帐旁再立两顶偏帐与一道屏风
    {
      const g = new THREE.Group();
      for (const dx of [-13, 13]) {
        const t = new THREE.Mesh(new THREE.ConeGeometry(6, 9, 7), m.cloth);
        t.position.set(dx, 4.5, 0);
        t.castShadow = true;
        g.add(t);
      }
      put('shuaizhang', g, 0, -26);
    }

    // 橹楼：营角上的箭橹
    {
      const g = new THREE.Group();
      for (const [bx, bz] of [[-42, -34], [42, -34]] as const) {
        const t = new THREE.Group();
        for (const [px, pz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]] as const) {
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.65, 15, 5), m.wood);
          leg.position.set(px, 7.5, pz);
          leg.castShadow = true;
          t.add(leg);
        }
        const deck = new THREE.Mesh(new THREE.BoxGeometry(7, 1, 7), m.wood);
        deck.position.y = 15.4;
        deck.castShadow = true;
        t.add(deck);
        const rail = new THREE.Mesh(new THREE.BoxGeometry(7.4, 2, 0.5), m.wood);
        rail.position.set(0, 17, 3.4);
        t.add(rail);
        t.position.set(bx, 0, bz);
        g.add(t);
      }
      put('lulou', g, 0, 0);
    }
  }

  // ───────────────────────────────────────────────────────────

  /**
   * 营中的数变了，营的样子跟着变。
   *
   * 这是这张图存在的全部理由：你不需要读顶栏上那五个数字，
   * 走进营门看一眼就知道 —— 帐排到第几列、校场上有没有人在操演、
   * 粮囤空了几个、地里有没有人。
   */
  sync(camp: Camp, color: string, skyTime: number): void {
    this.camp = camp;
    this.skyTime = skyTime;

    const tents = clamp(Math.round(camp.troops / MEN_PER_TENT), 1, TENT_MAX);
    this.tents.forEach((t, i) => { t.visible = i < tents; });

    this.engines.forEach((e, i) => { e.visible = i < camp.gear; });

    // 粮囤按「还够吃多久」空，不按绝对数 ——
    // 两千石对两百人是满仓，对两千人是见底
    const per = Math.max(1, Math.ceil((camp.troops * 2) / 100));
    const days = camp.grain / per;
    const bins = clamp(Math.round((days / 200) * this.grainBins.length), 0, this.grainBins.length);
    this.grainBins.forEach((b, i) => { b.visible = i < bins; });

    this.farmers.forEach((f) => { f.visible = camp.farming; });

    // 修出来的设施立在营里。级数高的立得更满
    for (const [id, g] of this.facilities) {
      const level = camp.works[id] ?? 0;
      g.visible = level > 0;
      const scale = 0.86 + Math.min(3, level) * 0.07;
      g.scale.setScalar(scale);
    }

    if (this.flag) {
      (this.flag.material as THREE.MeshStandardMaterial).color.set(color);
    }

    // 操练时校场上列队。人数按实际的兵折算，与战场同一个比例
    const drilling = camp.jobs.some((j) => j.job === 'drill');
    const n = drilling ? clamp(Math.round(camp.troops / 9), 8, 90) : 0;
    if (n !== this.drillRanks.length) {
      this.drillRanks = ranksOf(n, (i) => {
        const x = Math.sin(i * 12.9898) * 43758.5453;
        return (x - Math.floor(x)) * 2 - 1;
      });
    }

    this.updateSun();
    this.placeDrill();
    this.renderer.render(this.scene, this.camera);
  }

  /** 校场上那一片人 */
  private placeDrill(): void {
    this.army.begin();
    const kind = 'foot' as const;
    for (let i = 0; i < this.drillRanks.length; i++) {
      const p = this.drillRanks[i]!;
      this.army.place(
        kind, false,
        p.dx * 2.6, Math.sin(this.lastFrame / 420 + i * 1.7) * 0.06, p.dz * 2.6 + 8,
        0, 2.4,
      );
    }
    this.army.commit();
  }

  /**
   * 天光。
   *
   * 与城内图同一条曲线：连续、从不全黑 ——
   * 曾经因为把昼夜绑在游戏日上，十倍速下画面一黑一亮像在闪，
   * 那一课这里不能再犯。
   */
  private updateSun(): void {
    const t = this.skyTime;
    const day = Math.max(0, Math.sin(t * Math.PI));
    const lift = 0.34 + day * 0.66;
    this.sun.intensity = 0.6 + lift * 1.45;
    this.sun.position.set(
      Math.cos(t * Math.PI * 2) * 80, 40 + day * 80, Math.sin(t * Math.PI * 2) * 60,
    );
    const warm = 1 - day;
    const hor = this.sky.setRGB(
      [0.40 + lift * 0.12, 0.53 + lift * 0.12, 0.62 + lift * 0.10],
      [0.72 + warm * 0.16, 0.72 + lift * 0.05, 0.66 - warm * 0.10],
      [0.50, 0.48, 0.42],
    );
    (this.scene.fog as THREE.Fog).color.copy(hor);
  }

  // ───────────────────────────────────────────────────────────

  private updateCamera(): void {
    this.panX = clamp(this.panX, -60, 60);
    this.panZ = clamp(this.panZ, -60, 60);
    this.camera.position.set(
      this.panX + CAM_DIST, CAM_DIST * CAM_ELEVATION, this.panZ + CAM_DIST,
    );
    this.camera.lookAt(this.panX, 2, this.panZ);
    this.camera.updateMatrixWorld();
    this.sun.target.position.set(this.panX, 0, this.panZ);
    this.sun.target.updateMatrixWorld();
  }

  private readonly resize = (): void => {
    const w = this.host.clientWidth;
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    /**
     * 竖屏的时候要把镜头拉远。
     *
     * zoom 定的是**竖向**的半高，横向是它乘以宽高比 ——
     * 于是窗口一窄，横着就看不下整座营：
     * 屏幕上只剩几顶巨大的帐篷，营墙、辕门、望楼全在画外。
     * 而这一版的界面面板本来就占掉左边一大条，更窄。
     *
     * 窄过一比一就按宽度反过来定，营才总是整个在画面里。
     */
    const fit = aspect < 1 ? this.zoom / aspect : this.zoom;
    this.camera.left = -fit * aspect;
    this.camera.right = fit * aspect;
    this.camera.top = fit;
    this.camera.bottom = -fit;
    this.camera.updateProjectionMatrix();
  };

  private readonly onDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.dragAt = [e.clientX, e.clientY];
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.dragAt[0];
    const dy = e.clientY - this.dragAt[1];
    this.dragAt = [e.clientX, e.clientY];
    // 抓着地拖 —— 与城内图同一个手感
    const k = this.zoom / 240;
    this.panX -= (dx + dy) * k;
    this.panZ -= (dy - dx) * k;
    this.updateCamera();
  };

  private readonly onUp = (): void => { this.dragging = false; };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.zoom = clamp(this.zoom * (e.deltaY > 0 ? 1.1 : 0.91), 18, 88);
    this.resize();
  };

  // ───────────────────────────────────────────────────────────

  setPaused(p: boolean): void {
    this.paused = p;
    this.renderer.domElement.style.display = p ? 'none' : '';
    if (!p) this.resize();
  }

  start(): void {
    const loop = (now: number): void => {
      this.raf = requestAnimationFrame(loop);
      if (this.paused) { this.lastFrame = now; return; }
      this.lastFrame = now;
      if (this.drillRanks.length > 0) this.placeDrill();
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** 开发期自检 */
  probe(): Record<string, unknown> {
    let meshes = 0;
    this.scene.traverse((o) => { if (o instanceof THREE.Mesh) meshes++; });
    return {
      meshes,
      tents: this.tents.filter((t) => t.visible).length,
      engines: this.engines.filter((e) => e.visible).length,
      bins: this.grainBins.filter((b) => b.visible).length,
      farming: this.farmers[0]?.visible ?? false,
      drilling: this.drillRanks.length,
      figures: this.army.drawn(),
      troops: this.camp?.troops ?? 0,
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.army.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export { soldier };
