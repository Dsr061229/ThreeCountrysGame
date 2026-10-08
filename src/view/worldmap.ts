/**
 * 天下图 —— 中原十二城。
 *
 * 与城内图共用一套美术语言（同样的 45° 正交、同样的程序化材质），
 * 只是尺度换了：一座城在这里只有几个单位大，所以画法要退到**剪影与旗号**——
 * 玩家在这张图上要一眼看出的只有三件事：谁的城、多大、有没有兵在路上。
 */
import * as THREE from 'three';
import {
  bannerFlag, gateTower, glyphTexture, granaryBin, hall, hut, person, tree, wallRun,
} from './build.ts';
import { materials } from './textures.ts';
import { SkyDome } from './sky.ts';
import { mergeStatic } from './merge.ts';
import type { ContentIndex, MapNodeDef } from '../sim/content.ts';
import type { WorldState } from '../sim/state.ts';

/**
 * 图上坐标 → 世界坐标的放大倍数。
 *
 * 图上坐标本身是按真实经纬度投影出来的（见 content/map.json 的 lonlat），
 * 所以这个倍数只决定「看起来多大」，不影响地理关系。
 * 取 7 是因为最近的一对城（许与阳翟，实际相距约四十公里）在图上只有 2.2，
 * 放大之后要留得下两圈城墙。
 */
/**
 * 图上一个经纬单位摊开多少。
 *
 * 从七加到十一：**东西挤在一起了。**
 * 许与阳翟、彭城与下邳这些近邻，城池的轮廓、地界的圈、路和河
 * 全糊成一团，谁挨着谁都看不出来 —— 而「谁挨着谁」正是这张图上
 * 最要紧的信息（兵和信使都只走相邻）。
 *
 * 摊开之后城之间空得下一段路，圈也不再互相压。
 */
const SCALE = 11;
const CAM_DIST = 420;
const PAN_LIMIT = 540;
const KEY_PAN_SPEED = 1.15;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const PAN_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function xzOf(n: MapNodeDef): [number, number] {
  return [n.at[0] * SCALE, n.at[1] * SCALE];
}

export interface WorldMapCallbacks {
  onPickCity: (id: string) => void;
}

interface CityVisual {
  group: THREE.Group;
  /** 旗面，颜色随归属变 */
  flags: THREE.Mesh[];
  /**
   * 城下那一圈势力色。
   *
   * **旗子太小了。** 图拉远一点，那面旗只有几个像素，
   * 玩家分不出这一片房子是谁的 —— 而「谁的地」是天下图上第一要紧的信息。
   * 一圈染色的地界，隔着半个屏幕都读得出来。
   */
  plate: THREE.Mesh;
  /** 名都多一道金圈。占着几座名都是「开国」那根柱子，得看得见 */
  fameRing: THREE.Mesh | null;
  label: THREE.Sprite;
  name: string;
  scale: number;
  factionId: string;
}

interface ArmyVisual {
  group: THREE.Group;
  flag: THREE.Mesh;
}

export class WorldMap {
  private readonly host: HTMLElement;
  private readonly cb: WorldMapCallbacks;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly ambient: THREE.AmbientLight;

  private readonly cities = new Map<string, CityVisual>();
  private readonly armies = new Map<string, ArmyVisual>();
  /** 屯兵地。营不在城里，有自己的位置 */
  private readonly campMarks = new Map<string, THREE.Group>();
  private readonly siegeCamps = new Map<string, THREE.Group>();
  private ownCamp: THREE.Group | null = null;
  private readonly pickTargets: THREE.Mesh[] = [];
  private readonly hoverRing: THREE.Mesh;
  private readonly sky: SkyDome;

  private readonly keys = new Set<string>();
  private zoom = 250;
  private panX = 0;
  private panZ = 0;
  private raf = 0;
  private lastFrame = 0;
  private paused = false;
  private hovered: string | null = null;

  constructor(host: HTMLElement, idx: ContentIndex, cb: WorldMapCallbacks) {
    this.host = host;
    this.cb = cb;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    host.appendChild(this.renderer.domElement);

    // 渐变天穹。纯色背景会让青瓦屋顶沉进去，这是「背景与城池分不开」的根源
    this.sky = new SkyDome();
    this.sky.set(0x74909f, 0xcac5b8, 0x8c8576);
    this.scene.add(this.sky.mesh);
    this.scene.fog = new THREE.Fog(this.sky.horizon.getHex(), 620, 1500);

    const aspect = host.clientWidth / Math.max(1, host.clientHeight);
    this.camera = new THREE.OrthographicCamera(
      -this.zoom * aspect, this.zoom * aspect, this.zoom, -this.zoom, 0.1, 2400,
    );

    // 补光压低、直射光加强：立体感靠光比，不靠提亮
    this.hemi = new THREE.HemisphereLight(0xc4d8e6, 0x6d6350, 0.48);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.16);
    this.scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
    this.sun.position.set(260, 420, 170);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.04;
    const sc = this.sun.shadow.camera;
    sc.left = -430; sc.right = 430; sc.top = 430; sc.bottom = -430; sc.near = 1; sc.far = 1300;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.buildTerrain(idx);
    this.buildRoads(idx);

    // 四十四座城一次性合并。
    // 逐城合并会留下四十四组网格（每组按材质若干个），仍然是上千个 draw call；
    // 整批压在一起之后只剩下按材质分的那么几个。
    const allCities = new THREE.Group();
    const allFlags = new Set<THREE.Mesh>();
    for (const n of idx.db.map) {
      const built = this.buildCity(n);
      for (const f of built.flags) allFlags.add(f);
      allCities.add(built.group);
    }
    this.scene.add(mergeStatic(allCities, (o) => allFlags.has(o)));

    const ringGeo = new THREE.RingGeometry(13, 15, 30);
    this.hoverRing = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffe9b0, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      }),
    );
    this.hoverRing.rotation.x = -Math.PI / 2;
    this.hoverRing.position.y = 0.3;
    this.hoverRing.visible = false;
    this.scene.add(this.hoverRing);

    this.bindInput();
    this.resize();
    this.updateCamera();
  }

  // ───────────────────────────────────────────────────────────
  // 地形
  // ───────────────────────────────────────────────────────────

  private buildTerrain(idx: ContentIndex): void {
    const m = materials();
    // 郊野用耕地材质，土黄的城墙才有剪影
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(2200, 2200, 90, 90), m.grass);
    /**
     * 起伏。**要有，但不能大。**
     *
     * 原先的幅度是上下十来个单位，而河、路、城下的地界都贴在 y≈0 上 ——
     * 于是黄河有一半沉在土里、驿路只剩几截、势力色的地界压根看不见。
     * 一张看不清的地图，起伏做得再好也没用。
     *
     * 现在压到三个单位上下：斜射光还读得出地势，而地面上的东西全露着。
     */
    const pos = ground.geometry.attributes['position'] as THREE.BufferAttribute;
    const r = rng(7);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      pos.setZ(i, Math.sin(x * 0.006) * 0.55 + Math.cos(y * 0.0075) * 0.45 + (r() - 0.5) * 0.22);
    }
    ground.geometry.computeVertexNormals();
    ground.rotation.x = -Math.PI / 2;
    // 压到底：贴地的东西（河、路、城下的地界）全在 y≈0.2~0.6，
    // 地面只要有一处冒过它们，那一段就没了
    ground.position.y = -1.1;
    ground.receiveShadow = true;
    (m.grass.map as THREE.Texture).repeat.set(90, 90);
    (m.grass.bumpMap as THREE.Texture).repeat.set(90, 90);
    this.scene.add(ground);

    /**
     * 三条大水。控制点按真实地理取，再乘同一个 SCALE。
     *
     * **这三条线是整张图的骨架。** 一个人认不认得出这是汉末的中原，
     * 全看黄河在不在该在的地方 —— 比几十座城的位置都管用。
     * 所以画得宽、画得亮，还各带一道浅滩的岸：
     * 一条细蓝线在土黄的地上是看不见的。
     */
    // 河水（黄河）：陇上 → 潼关 → 洛阳北 → 荥阳 → 濮阳 → 入海
    this.addRiver([[-67, -14], [-28, 0], [-11, -4], [-5, -4], [8, -11], [37, -28]], 10 * SCALE / 7);
    // 江水（长江）：江州 → 江陵 → 江夏 → 柴桑 → 秣陵 → 入海
    this.addRiver([[-56, 44], [-14, 37], [7, 37], [15, 43], [36, 22], [56, 27]], 12 * SCALE / 7);
    // 淮水：桐柏 → 汝南 → 寿春 → 淮阴
    this.addRiver([[-5, 19], [5, 17], [21, 17], [38, 8]], 7 * SCALE / 7);
    // 渭水：陇上 → 长安 → 潼关。关中之所以是关中，靠的就是这一条
    this.addRiver([[-62, -6], [-46, -2], [-33, -1], [-28, 0]], 5.5 * SCALE / 7);

    // 山川林泽。
    //
    // 这些不是布景 —— 它们**真的在起作用**：
    // 翻秦岭的那一路要多走七天，太行山里藏得住伏兵，
    // 云梦泽里骑兵施展不开。既然有分量，就得看得见。
    this.buildRegions(idx);

    // 散在旷野里的疏林。只为了让空地不空，不参与任何判定
    const r2 = rng(99);
    const occupied = idx.db.map.map((n) => xzOf(n));
    const woods = new THREE.Group();
    for (let i = 0; i < 420; i++) {
      const x = (r2() - 0.5) * 1500;
      const z = (r2() - 0.5) * 1300;
      if (occupied.some(([cx, cz]) => Math.hypot(cx - x, cz - z) < 34)) continue;
      const t = tree(2.6 + r2() * 3.0, i * 13 + 5);
      t.position.set(x, 0, z);
      woods.add(t);
    }
    this.scene.add(mergeStatic(woods));
  }

  /**
   * 有名有姓的那几片地形。
   *
   * 山画成一列压扁的峰，沿着山脊排开 —— 太行是南北一道，
   * 秦岭是东西一横，形状本身就说明了它挡着谁。
   * 林画成密到看不见地面的树，泽画成一片浅水加芦苇。
   *
   * 全部压成静态网格：这些东西建好之后再也不动，
   * 而一座山就是几十个峰，不压的话光是山就要几百个 draw call。
   */
  private buildRegions(idx: ContentIndex): void {
    const m = materials();
    const group = new THREE.Group();
    const r = rng(4231);

    for (const region of idx.terrain) {
      const pts = region.path.map(([x, y]) => new THREE.Vector3(x * SCALE, 0, y * SCALE));
      const curve = pts.length > 1
        ? new THREE.CatmullRomCurve3(pts)
        : null;
      const span = curve ? curve.getLength() : region.width * SCALE;
      const half = (region.width * SCALE) / 2;

      if (region.kind === 'mountain') {
        /**
         * 沿脊排峰，两侧再散几个矮的，让山有厚度。
         *
         * **峰要多、要矮。** 早先是稀疏的几个大圆锥，四十来个单位高，
         * 比城墙高出一个数量级 —— 于是一座山比一座城还抢眼，
         * 而且圆锥太大，一眼就看得出是个几何体，不是山。
         * 改成密而矮的一列，轮廓碎了，才像山脊。
         */
        const n = Math.max(10, Math.round(span / 12));
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const p = curve ? curve.getPoint(t) : pts[0]!;
          const rows = 4;
          for (let k = 0; k < rows; k++) {
            const off = (k - (rows - 1) / 2) * half * 0.72 + (r() - 0.5) * half * 0.5;
            const tan = curve
              ? curve.getTangent(t)
              : new THREE.Vector3(1, 0, 0);
            const side = new THREE.Vector3(-tan.z, 0, tan.x).multiplyScalar(off);
            // 脊上的峰高，两侧的矮
            const edge = 1 - Math.abs(k - (rows - 1) / 2) / rows;
            const h = (8 + r() * 14) * region.height * (0.45 + edge * 0.8);
            const peak = new THREE.Mesh(
              // 底放宽、高压低 —— 是山脊，不是一排锥子
              new THREE.ConeGeometry(h * (0.85 + r() * 0.6), h, 5 + Math.floor(r() * 3)),
              new THREE.MeshStandardMaterial({
                // 暖石色，深浅拉开一点，远看才有明暗
                color: new THREE.Color(0x5f5849)
                  .lerp(new THREE.Color(0xa89c86), r() * 0.85),
                roughness: 1, flatShading: true,
              }),
            );
            peak.position.set(p.x + side.x, h / 2 - 2, p.z + side.z);
            peak.rotation.y = r() * Math.PI;
            peak.castShadow = true;
            peak.receiveShadow = true;
            group.add(peak);
          }
        }
        continue;
      }

      if (region.kind === 'forest') {
        const n = Math.max(40, Math.round((span * region.width) / 26));
        for (let i = 0; i < n; i++) {
          const t = r();
          const p = curve ? curve.getPoint(t) : pts[0]!;
          const a = r() * Math.PI * 2;
          const d = Math.sqrt(r()) * half;
          const t2 = tree(3.4 + r() * 3.6, i * 17 + 3);
          t2.position.set(p.x + Math.cos(a) * d, 0, p.z + Math.sin(a) * d);
          group.add(t2);
        }
        continue;
      }

      // 泽：一片浅水加成丛的芦苇
      const n = Math.max(5, Math.round(span / 26));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const p = curve ? curve.getPoint(t) : pts[0]!;
        const pool = new THREE.Mesh(
          new THREE.CircleGeometry(half * (0.6 + r() * 0.55), 14), m.water,
        );
        pool.rotation.x = -Math.PI / 2;
        pool.position.set(p.x + (r() - 0.5) * half, 0.12, p.z + (r() - 0.5) * half);
        group.add(pool);
        for (let k = 0; k < 16; k++) {
          const reed = new THREE.Mesh(
            new THREE.ConeGeometry(0.8, 5 + r() * 4, 4),
            new THREE.MeshStandardMaterial({ color: 0x7f8354, roughness: 1 }),
          );
          const a = r() * Math.PI * 2;
          const d = Math.sqrt(r()) * half;
          reed.position.set(p.x + Math.cos(a) * d, 2.5, p.z + Math.sin(a) * d);
          group.add(reed);
        }
      }
    }

    this.scene.add(mergeStatic(group));
  }

  private addRiver(pts: [number, number][], width: number): void {
    const m = materials();
    const curve = new THREE.CatmullRomCurve3(
      pts.map(([x, z]) => new THREE.Vector3(x * SCALE, 0, z * SCALE)),
    );
    const samples = curve.getPoints(90);

    /** 沿着曲线铺一条带子。宽度随位置微微起伏 —— 河不是一根等宽的管子 */
    const ribbon = (w: number, y: number, mat: THREE.Material): THREE.Mesh => {
      const verts: number[] = [];
      const idxs: number[] = [];
      for (let i = 0; i < samples.length; i++) {
        const p = samples[i]!;
        const next = samples[Math.min(i + 1, samples.length - 1)]!;
        const dir = new THREE.Vector3().subVectors(next, p).normalize();
        const wob = 1 + Math.sin(i * 0.7) * 0.13 + Math.sin(i * 0.23) * 0.08;
        const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar((w * wob) / 2);
        verts.push(p.x - side.x, y, p.z - side.z, p.x + side.x, y, p.z + side.z);
        if (i < samples.length - 1) {
          const a = i * 2;
          idxs.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geo.setIndex(idxs);
      geo.computeVertexNormals();
      return new THREE.Mesh(geo, mat);
    };

    // 岸：一道比水面宽的浅滩。有它，河才是嵌在地里的，不是浮在上面的贴纸
    const bank = ribbon(width * 1.55, 0.3, new THREE.MeshBasicMaterial({
      color: 0xb9a179, transparent: true, opacity: 0.55, depthWrite: false,
    }));
    bank.renderOrder = 1;
    this.scene.add(bank);

    const mesh = ribbon(width, 0.38, m.water);
    mesh.renderOrder = 2;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  private buildRoads(idx: ContentIndex): void {
    const m = materials();
    const drawn = new Set<string>();
    const roads = new THREE.Group();
    for (const n of idx.db.map) {
      const [ax, az] = xzOf(n);
      for (const to of n.links) {
        const other = idx.node.get(to);
        if (!other) continue;
        const key = n.id < to ? n.id + to : to + n.id;
        if (drawn.has(key)) continue;
        drawn.add(key);
        const [bx, bz] = xzOf(other);
        const len = Math.hypot(bx - ax, bz - az);
        const ang = -Math.atan2(bx - ax, bz - az);
        /**
         * 路要画得看得见。
         *
         * 四点六个单位宽的土路压在土黄的地上，等于没画 ——
         * 而「哪两座城挨着」现在是要紧信息：兵只走相邻，信使也只走相邻。
         * 底下垫一道深色的路肩，上面铺一条亮些的路面，对比就出来了。
         */
        const shoulder = new THREE.Mesh(
          new THREE.PlaneGeometry(10.5, len),
          new THREE.MeshBasicMaterial({
            color: 0x6b5636, transparent: true, opacity: 0.46, depthWrite: false,
          }),
        );
        shoulder.rotation.x = -Math.PI / 2;
        shoulder.rotation.z = ang;
        shoulder.position.set((ax + bx) / 2, 0.16, (az + bz) / 2);
        shoulder.renderOrder = 1;
        roads.add(shoulder);

        const road = new THREE.Mesh(new THREE.PlaneGeometry(6.4, len), m.road);
        road.rotation.x = -Math.PI / 2;
        road.rotation.z = ang;
        road.position.set((ax + bx) / 2, 0.24, (az + bz) / 2);
        road.receiveShadow = true;
        roads.add(road);
      }
    }
    this.scene.add(mergeStatic(roads));
  }

  // ───────────────────────────────────────────────────────────
  // 城
  // ───────────────────────────────────────────────────────────

  private buildCity(n: MapNodeDef): { group: THREE.Group; flags: THREE.Mesh[] } {
    const [x, z] = xzOf(n);
    const g = new THREE.Group();
    g.position.set(x, 0, z);

    const r = rng(n.id.length * 977 + n.at[0] * 31 + n.at[1] * 17);
    // 图幅变大之后城要画得相对紧凑，否则许与阳翟这样的近邻会糊在一起
    // 图幅摊开之后城反而要收一点：城与城之间那段空地才是「距离」
    const size = 4.2 + n.scale * 1.9;
    const flags: THREE.Mesh[] = [];

    // 城垣。围一圈，缺口朝南当城门
    for (const [axis, sign] of [['x', 1], ['x', -1], ['z', 1], ['z', -1]] as const) {
      const run = wallRun(size * 2);
      run.scale.setScalar(0.8 + n.scale * 0.14);
      if (axis === 'x') run.position.set(0, 0, sign * size);
      else { run.position.set(sign * size, 0, 0); run.rotation.y = Math.PI / 2; }
      g.add(run);
    }

    // 城内。
    //
    // 城墙圈起来的地方有十几二十个单位见方，只摆六间小屋当然是空的。
    // 这里按里坊铺满：中间一条南北向的街，两侧成排的屋舍，
    // 治所另加正堂与廊庑。密度才是「这是一座城」的关键。
    const inner = size * 1.55;
    const bldScale = 1.5 + n.scale * 0.15;

    const main = hall({
      w: 3.4 + n.scale * 1.1, d: 2.4 + n.scale * 0.7, h: 2.2 + n.scale * 0.35,
      eave: 0.85, podium: 0.35, columns: 4 + n.scale, seed: 3,
    });
    main.scale.setScalar(bldScale);
    main.position.set(0, 0, -inner * 0.32);
    g.add(main);

    if (n.seat || n.scale >= 3) {
      // 治所加两列廊庑，围出一个院子
      for (const sx of [-1, 1]) {
        const wing = hall({
          w: 2.4, d: 3.6, h: 1.8, eave: 0.6, podium: 0.22, columns: 3, seed: 11 + sx,
        });
        wing.scale.setScalar(bldScale);
        wing.position.set(sx * inner * 0.34, 0, -inner * 0.04);
        wing.rotation.y = Math.PI / 2;
        g.add(wing);
      }
    }

    // 民居：分左右两片，中间留出一条街
    const rows = 2 + n.scale;
    const cols = 3 + n.scale;
    const stepX = (inner * 0.86) / cols;
    const stepZ = (inner * 0.62) / rows;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        // 中轴留空当街
        const t = col / (cols - 1) - 0.5;
        if (Math.abs(t) < 0.09) continue;
        const h = hut(row * 31 + col * 7 + n.scale);
        h.scale.setScalar(bldScale);
        h.position.set(
          t * inner * 0.86 + (r() - 0.5) * stepX * 0.3,
          0,
          inner * 0.12 + row * stepZ + (r() - 0.5) * stepZ * 0.3,
        );
        h.rotation.y = (r() - 0.5) * 0.35;
        g.add(h);
      }
    }

    // 粮囤与树，把边角填起来
    for (let i = 0; i < 1 + n.scale; i++) {
      const bin = granaryBin(i * 13 + n.scale);
      bin.scale.setScalar(bldScale * 1.1);
      bin.position.set(-inner * 0.42 + i * 2.6 * bldScale, 0, -inner * 0.44);
      g.add(bin);
    }
    for (let i = 0; i < 3; i++) {
      const t = tree(1.6 + r() * 1.2, i * 17 + n.scale);
      t.position.set((r() - 0.5) * inner * 1.1, 0, inner * 0.5 + r() * 2);
      g.add(t);
    }

    // 南门
    const gate = gateTower();
    gate.scale.setScalar(0.75 + n.scale * 0.12);
    gate.position.set(0, 0, size);
    g.add(gate);

    // 旗号。这是玩家在图上辨认归属的**唯一**依据，所以立得高、给得大，
    // 而且旗上要有字 —— 纯色的小旗在这个尺度上根本认不出是谁的。
    const { group: pole, flag } = bannerFlag('？', 15 + n.scale * 3.5, 4.4 + n.scale * 1.1);
    pole.position.set(size * 0.55, 0, -size * 0.72);
    g.add(pole);
    flags.push(flag);

    /**
     * 城下的地界。
     *
     * 一圈实色压在地上，外加一道亮边 —— 这是**远看时唯一读得出归属的东西**。
     * 城越大圈越大，所以「谁占着大城」也是一眼的事。
     */
    /**
     * 圈有个**下限**：小县的圈也得看得见。
     * 按城的大小等比缩，雍丘那样的小县就只剩一道细边，
     * 而「谁占着哪儿」这件事跟城大不大没关系 —— 每一座都得读得出。
     */
    /**
     * 一道**细环**，不是一块色盘。
     *
     * 太粗太实的一圈会把城本身盖过去 —— 整张图变成一堆彩色圆饼。
     * 归属这件事只要读得出来就够了，不必喊。
     */
    const ringIn = Math.max(12, size * 1.7);
    const ringOut = ringIn + 2.4 + size * 0.12;

    // 底下先垫一道暗边。淡色的旗号（曹是土黄）压在土黄的地上是看不见的
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(ringIn - 0.9, ringOut + 0.9, 44),
      new THREE.MeshBasicMaterial({
        color: 0x241a10, transparent: true, opacity: 0.42,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.45;
    rim.renderOrder = 1;
    g.add(rim);

    const plate = new THREE.Mesh(
      new THREE.RingGeometry(ringIn, ringOut, 44),
      new THREE.MeshBasicMaterial({
        color: 0x888888, transparent: true, opacity: 0.72,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = 0.5;
    plate.renderOrder = 2;
    g.add(plate);

    // 名都多一道金圈
    let fameRing: THREE.Mesh | null = null;
    if ((n.fame ?? 0) >= 2) {
      fameRing = new THREE.Mesh(
        new THREE.RingGeometry(ringOut + 2.2, ringOut + 3.4, 48),
        new THREE.MeshBasicMaterial({
          color: (n.fame ?? 0) >= 5 ? 0xf0c96a : 0xc9a45c,
          transparent: true, opacity: 0.68, depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      fameRing.rotation.x = -Math.PI / 2;
      fameRing.position.y = 0.55;
      fameRing.renderOrder = 3;
      g.add(fameRing);
    }

    // 点击热区
    const pick = new THREE.Mesh(
      new THREE.CircleGeometry(size + 7, 22),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    pick.rotation.x = -Math.PI / 2;
    pick.position.set(x, 0.2, z);
    pick.userData['city'] = n.id;
    this.scene.add(pick);
    this.pickTargets.push(pick);

    const label = makeLabel(n.name, '#8a7a5e', n.scale, (n.fame ?? 0) >= 2);
    label.position.set(x, 22 + n.scale * 4, z);
    this.scene.add(label);

    this.cities.set(n.id, {
      group: g, flags, plate, fameRing, label,
      name: n.name, scale: n.scale, factionId: '',
    });
    return { group: g, flags };
  }

  // ───────────────────────────────────────────────────────────
  // 状态同步
  // ───────────────────────────────────────────────────────────

  sync(state: Readonly<WorldState>, idx: ContentIndex): void {
    // 旗色 = 归属
    for (const [id, vis] of this.cities) {
      const node = state.nodes[id];
      if (!node || node.factionId === vis.factionId) continue;
      vis.factionId = node.factionId;
      const def = idx.faction.get(node.factionId);
      const color = new THREE.Color(def?.color ?? '#999999');
      for (const f of vis.flags) {
        const mat = (f.material as THREE.MeshStandardMaterial).clone();
        mat.color.copy(color);
        mat.map = glyphTexture(def?.banner ?? '？');
        mat.needsUpdate = true;
        f.material = mat;
      }
      // 城下那一圈地界，和城名牌上的色点，一起换成新主人的颜色
      (vis.plate.material as THREE.MeshBasicMaterial).color.copy(color);
      relabel(vis.label, vis.name, def?.color ?? '#8a7a5e', vis.scale, !!vis.fameRing);
    }

    // 行军中的部队
    const seen = new Set<string>();
    for (const id of Object.keys(state.armies)) {
      const army = state.armies[id]!;
      seen.add(id);
      let vis = this.armies.get(id);
      if (!vis) {
        vis = makeMarchingColumn();
        this.scene.add(vis.group);
        this.armies.set(id, vis);
      }
      const from = idx.node.get(army.fromId);
      const to = idx.node.get(army.toId);
      if (!from || !to) continue;
      const [ax, az] = xzOf(from);
      const [bx, bz] = xzOf(to);
      const t = army.progress / 1000;
      vis.group.position.set(lerp(ax, bx, t), 0, lerp(az, bz, t));
      vis.group.rotation.y = Math.atan2(bx - ax, bz - az);
      const fdef = idx.faction.get(army.factionId);
      const fmat = vis.flag.material as THREE.MeshStandardMaterial;
      fmat.color.set(fdef?.color ?? '#999999');
      fmat.map = glyphTexture(fdef?.banner ?? '？');
      fmat.needsUpdate = true;
    }
    for (const [id, vis] of this.armies) {
      if (seen.has(id)) continue;
      this.scene.remove(vis.group);
      this.armies.delete(id);
    }

    // 屯兵地。
    //
    // **只画看得见的那些** —— 自己的营，和主公麾下别的武将的营。
    // 敌国的营在哪儿是要派细作去探的，不该白白摆在图上。
    const campSeen = new Set<string>();
    for (const camp of Object.values(state.camps)) {
      // 别人家的营：不知道就是不知道
      const node = state.nodes[camp.nodeId];
      if (node && node.factionId !== state.official.lordId) continue;
      campSeen.add(camp.id);
      let g = this.campMarks.get(camp.id);
      if (!g) {
        g = makeCampMark(camp.ownerId === null);
        this.scene.add(g);
        this.campMarks.set(camp.id, g);
      }
      g.position.set(camp.at[0] * SCALE, 0, camp.at[1] * SCALE);
      // 兵多帐篷多。一眼看得出哪座营是主力
      const size = 0.7 + Math.min(1.1, camp.troops / 1400);
      g.scale.setScalar(size);
    }
    for (const [id, g] of this.campMarks) {
      if (campSeen.has(id)) continue;
      this.scene.remove(g);
      this.campMarks.delete(id);
    }

    // 围城的营盘
    const sieged = new Set(Object.keys(state.sieges));
    for (const cityId of sieged) {
      if (this.siegeCamps.has(cityId)) continue;
      const def = idx.node.get(cityId);
      if (!def) continue;
      const [x, z] = xzOf(def);
      const camp = makeSiegeCamp();
      camp.position.set(x, 0, z + 4.6 + def.scale * 2.2 + 14);
      this.scene.add(camp);
      this.siegeCamps.set(cityId, camp);
    }
    for (const [cityId, camp] of this.siegeCamps) {
      if (sieged.has(cityId)) continue;
      this.scene.remove(camp);
      this.siegeCamps.delete(cityId);
    }

    this.syncOwnCamp(state, idx);
  }

  /**
   * 自家的屯兵地。
   *
   * 武将在图上得有个**看得见的家**。它挨着依托的那座城，
   * 但样子和城是两回事：营是辕门、帐幕、校场、望楼，没有墙。
   * 一眼就该分得出来 —— 城是守的，营是出兵的。
   */
  private syncOwnCamp(state: Readonly<WorldState>, idx: ContentIndex): void {
    const camp = Object.values(state.camps)[0];
    if (!camp) {
      if (this.ownCamp) {
        this.scene.remove(this.ownCamp);
        this.ownCamp = null;
      }
      return;
    }
    const def = idx.node.get(camp.nodeId);
    if (!def) return;

    if (!this.ownCamp) {
      this.ownCamp = makeGarrisonCamp();
      this.scene.add(this.ownCamp);
    }
    const [x, z] = xzOf(def);
    // 摆在城的西侧，别和围城的营盘挤在一处
    this.ownCamp.position.set(x - 4.6 - def.scale * 2.2 - 16, 0, z);

    // 兵多帐就多。营的大小要跟得上你练出来的兵 ——
    // 七百人的营和两百人的营在图上一样大，那这张图就没在说实话
    const want = Math.max(4, Math.min(14, Math.round(camp.troops / 70)));
    this.ownCamp.children.forEach((o) => {
      const n = o.userData['tentIndex'];
      if (typeof n === 'number') o.visible = n < want;
    });
  }

  /** 把镜头挪到某座城 */
  focus(id: string, idx: ContentIndex): void {
    const def = idx.node.get(id);
    if (!def) return;
    const [x, z] = xzOf(def);
    this.panX = x;
    this.panZ = z;
    this.updateCamera();
  }

  // ───────────────────────────────────────────────────────────
  // 输入。与城内图同一套：抓着地图拖、滚轮对准缩放、WASD 平移
  // ───────────────────────────────────────────────────────────

  private updateCamera(): void {
    this.panX = clamp(this.panX, -PAN_LIMIT, PAN_LIMIT);
    this.panZ = clamp(this.panZ, -PAN_LIMIT, PAN_LIMIT);
    this.camera.position.set(this.panX + CAM_DIST, CAM_DIST * 0.85, this.panZ + CAM_DIST);
    this.camera.lookAt(this.panX, 0, this.panZ);
    this.camera.updateMatrixWorld();
    this.sun.position.set(this.panX + 260, 420, this.panZ + 170);
    this.sun.target.position.set(this.panX, 0, this.panZ);
    this.sun.target.updateMatrixWorld();
  }

  private groundPointAt(nx: number, ny: number, out: THREE.Vector3): boolean {
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    return this.raycaster.ray.intersectPlane(this.groundPlane, out) !== null;
  }

  private bindInput(): void {
    const el = this.renderer.domElement;
    let dragging = false, dragged = false, dragButton = 0;
    const anchor = new THREE.Vector3(), now = new THREE.Vector3();

    const setPointer = (e: PointerEvent | WheelEvent): void => {
      const rect = el.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };

    el.addEventListener('pointerdown', (e) => {
      setPointer(e);
      if (!this.groundPointAt(this.pointer.x, this.pointer.y, anchor)) return;
      dragging = true; dragged = false; dragButton = e.button;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
    });

    el.addEventListener('pointermove', (e) => {
      setPointer(e);
      if (dragging) {
        if (this.groundPointAt(this.pointer.x, this.pointer.y, now)) {
          const dx = anchor.x - now.x, dz = anchor.z - now.z;
          if (Math.abs(dx) + Math.abs(dz) > 0.3) dragged = true;
          this.panX += dx; this.panZ += dz;
          this.updateCamera();
        }
        this.hoverRing.visible = false;
        return;
      }
      this.updateHover();
    });

    const endDrag = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      el.style.cursor = 'default';
      try { el.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
      if (!dragged && dragButton === 0) {
        const hit = this.pickCity();
        if (hit) this.cb.onPickCity(hit);
      }
      this.updateHover();
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      setPointer(e);
      const before = new THREE.Vector3();
      const had = this.groundPointAt(this.pointer.x, this.pointer.y, before);
      this.zoom = clamp(this.zoom * (e.deltaY > 0 ? 1.12 : 1 / 1.12), 60, 640);
      this.resize();
      this.updateCamera();
      if (had) {
        const after = new THREE.Vector3();
        if (this.groundPointAt(this.pointer.x, this.pointer.y, after)) {
          this.panX += before.x - after.x;
          this.panZ += before.z - after.z;
          this.updateCamera();
        }
      }
    }, { passive: false });

    const track = (e: KeyboardEvent, down: boolean): void => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
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

  private pickCity(): string | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickTargets, false);
    return (hits[0]?.object.userData['city'] as string | undefined) ?? null;
  }

  private updateHover(): void {
    const hit = this.pickCity();
    if (hit === this.hovered) return;
    this.hovered = hit;
    if (!hit) {
      this.hoverRing.visible = false;
      this.renderer.domElement.style.cursor = 'default';
      return;
    }
    const target = this.pickTargets.find((p) => p.userData['city'] === hit);
    if (target) {
      this.hoverRing.position.set(target.position.x, 0.3, target.position.z);
      this.hoverRing.visible = true;
    }
    this.renderer.domElement.style.cursor = 'pointer';
  }

  private applyKeyPan(dt: number): void {
    if (this.keys.size === 0) return;
    let sx = 0, sy = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) sy -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) sy += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) sx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) sx += 1;
    if (sx === 0 && sy === 0) return;
    const c = Math.SQRT1_2;
    const speed = KEY_PAN_SPEED * this.zoom * dt;
    const len = Math.hypot(sx, sy) || 1;
    const nx = (sx / len) * speed, ny = (sy / len) * speed;
    this.panX += nx * c + ny * c;
    this.panZ += -nx * c + ny * c;
    this.updateCamera();
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
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

// ─────────────────────────────────────────────────────────────

/**
 * 城名牌。
 *
 * 牌子上除了名字，左边还有**一小块势力色** —— 图拉远之后，
 * 一排牌子上的色点就是整张形势图。
 * 名都的牌子描一道金边、字也大一号：占着哪几座名都是「开国」那根柱子。
 */
function paintLabel(
  canvas: HTMLCanvasElement, text: string, color: string, scale: number, fame: boolean,
): void {
  const ctx = canvas.getContext('2d')!;
  const dpr = 2;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(dpr, dpr);
  const size = 30 + scale * 3;
  ctx.font = `600 ${size}px "Songti SC", "SimSun", serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  const w = tw + 40;
  const x0 = 128 - w / 2;

  ctx.fillStyle = 'rgba(18,14,10,0.82)';
  ctx.fillRect(x0, 10, w, 50);
  ctx.strokeStyle = fame ? 'rgba(232,196,110,0.9)' : 'rgba(180,152,96,0.42)';
  ctx.lineWidth = fame ? 2 : 1;
  ctx.strokeRect(x0, 10, w, 50);

  // 势力色点
  ctx.fillStyle = color;
  ctx.fillRect(x0 + 7, 22, 9, 26);

  ctx.fillStyle = fame ? '#f6e6bd' : '#ece2cf';
  ctx.fillText(text, x0 + 24, 35);
}

function makeLabel(text: string, color: string, scale: number, fame: boolean): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256 * 2; canvas.height = 76 * 2;
  paintLabel(canvas, text, color, scale, fame);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, depthTest: false, transparent: true,
  }));
  sprite.scale.set(34 + scale * 3, 10 + scale, 1);
  sprite.renderOrder = 20;
  sprite.userData['canvas'] = canvas;
  return sprite;
}

/** 换了主人就重画一次牌子。只在易主那一帧发生，不心疼 */
function relabel(
  sprite: THREE.Sprite, text: string, color: string, scale: number, fame: boolean,
): void {
  const canvas = sprite.userData['canvas'] as HTMLCanvasElement | undefined;
  if (!canvas) return;
  paintLabel(canvas, text, color, scale, fame);
  const mat = sprite.material as THREE.SpriteMaterial;
  (mat.map as THREE.CanvasTexture).needsUpdate = true;
}

/** 行军的队列：几个人 + 一面旗。小得很，但在图上一眼能认出来 */
/**
 * 图上的一座营。
 *
 * 与城池要拉得开距离 —— 城是夯土墙加门楼，营是几顶帐篷加一根旗杆。
 * 自己的那座旗杆更高、多两顶帐，好在一堆友军营里一眼认出来。
 */
function makeCampMark(mine: boolean): THREE.Group {
  const m = materials();
  const g = new THREE.Group();
  const r = rng(mine ? 61 : 97);

  const n = mine ? 7 : 4;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.4;
    const d = 3.4 + r() * 2.6;
    const tent = new THREE.Mesh(new THREE.ConeGeometry(1.7, 2.6, 6), m.cloth);
    tent.position.set(Math.cos(a) * d, 1.3, Math.sin(a) * d);
    tent.rotation.y = r() * Math.PI;
    tent.castShadow = true;
    g.add(tent);
  }

  // 辕门：两根柱子，一眼看出这是个营
  for (const dx of [-2.6, 2.6]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 5, 5), m.wood);
    post.position.set(dx, 2.5, 7.2);
    post.castShadow = true;
    g.add(post);
  }

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.36, mine ? 13 : 9, 6), m.wood,
  );
  pole.position.y = (mine ? 13 : 9) / 2;
  pole.castShadow = true;
  g.add(pole);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 2.8), m.banner);
  flag.position.set(2.4, mine ? 11 : 7.6, 0);
  flag.castShadow = true;
  g.add(flag);

  return g;
}

function makeMarchingColumn(): ArmyVisual {
  const g = new THREE.Group();
  for (let i = 0; i < 8; i++) {
    const p = person(i % 2 === 1);
    p.scale.setScalar(4.2);
    p.position.set(((i % 2) - 0.5) * 4.4, 0, -i * 4.0);
    g.add(p);
  }
  const { group: pole, flag } = bannerFlag('？', 15, 4.2);
  pole.position.set(0, 0, 5.5);
  g.add(pole);
  const mat = (flag.material as THREE.MeshStandardMaterial).clone();
  flag.material = mat;
  return { group: g, flag };
}

/** 围城的营盘：一圈帐篷压在城外 */
/**
 * 自家的屯兵地：辕门、帐幕、校场、望楼。
 *
 * 帐幕按人数增减（见 syncOwnCamp），所以每一顶都记着自己的序号。
 */
function makeGarrisonCamp(): THREE.Group {
  const g = new THREE.Group();
  const m = materials();
  const r = rng(577);

  // 辕门：两根柱子架一道横木。汉军营门就是这个样子
  for (const dx of [-7, 7]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 13, 6), m.wood);
    post.position.set(dx, 6.5, 15);
    post.castShadow = true;
    g.add(post);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(17, 1.4, 1.4), m.wood);
  lintel.position.set(0, 12.4, 15);
  lintel.castShadow = true;
  g.add(lintel);

  // 望楼：营里最高的那一处
  const tower = new THREE.Group();
  for (const [px, pz] of [[-2.4, -2.4], [2.4, -2.4], [-2.4, 2.4], [2.4, 2.4]] as const) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 16, 5), m.wood);
    leg.position.set(px, 8, pz);
    leg.castShadow = true;
    tower.add(leg);
  }
  const deck = new THREE.Mesh(new THREE.BoxGeometry(8, 1, 8), m.wood);
  deck.position.y = 16.4;
  deck.castShadow = true;
  tower.add(deck);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(6.4, 5, 4), m.tile);
  roof.position.y = 19.4;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  tower.add(roof);
  tower.position.set(-16, 0, -8);
  g.add(tower);

  // 帐幕。分两排，中间空出校场
  for (let i = 0; i < 14; i++) {
    const row = i % 2 === 0 ? -1 : 1;
    const tent = new THREE.Mesh(new THREE.ConeGeometry(3.6, 5.4, 6), m.cloth);
    tent.position.set(
      -20 + Math.floor(i / 2) * 6.4 + (r() - 0.5) * 1.6,
      2.7,
      row * (9 + r() * 3),
    );
    tent.castShadow = true;
    tent.userData['tentIndex'] = i;
    g.add(tent);
  }

  // 校场上走动的人
  for (let i = 0; i < 7; i++) {
    const soldier = person(false);
    soldier.scale.setScalar(4.0);
    soldier.position.set((r() - 0.5) * 30, 0, (r() - 0.5) * 6);
    g.add(soldier);
  }

  return g;
}

function makeSiegeCamp(): THREE.Group {
  const g = new THREE.Group();
  const m = materials();
  const r = rng(31);
  for (let i = 0; i < 9; i++) {
    const tent = new THREE.Mesh(new THREE.ConeGeometry(3.4, 5.0, 6), m.cloth);
    tent.position.set((r() - 0.5) * 34, 2.5, (r() - 0.5) * 15);
    tent.castShadow = true;
    g.add(tent);
  }
  for (let i = 0; i < 6; i++) {
    const p = person(true);
    p.scale.setScalar(4.0);
    p.position.set((r() - 0.5) * 34, 0, (r() - 0.5) * 15);
    g.add(p);
  }
  return g;
}
