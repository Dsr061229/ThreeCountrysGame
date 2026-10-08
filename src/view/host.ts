/**
 * 军阵的渲染。
 *
 * 战场看着像过家家，根子只有一条：**人太少**。
 * 上一版每队最多画十六个小人，一支两百人的队伍摆成一个四乘四的方块 ——
 * 那不是军队，那是棋子。
 *
 * 而画不多的原因是每个小人都是一个独立的 Group，
 * 五六个网格起步；八队人满打满算一百二十八个小人，
 * 就是七百多个 draw call。再多画面就垮了。
 *
 * 所以这里把小人改成**实例化**：
 * 每个兵种按材质压成几片几何，全场同兵种同材质的人共用一次绘制。
 * 一千五百个小人也只有十来个 draw call ——
 * 于是「一片矛林」「黑压压一大片」这种话才有可能在画面上成立。
 */
import * as THREE from 'three';
import { soldier } from './build.ts';

export type SoldierKind = 'foot' | 'bow' | 'horse';

/** 一个兵种拆出来的一片几何：同材质的部件压在一起 */
interface Part {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
}

/** 全场最多画这么多小人。超了就只能一个顶几个 */
const CAP = 2400;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * 把一个 `soldier()` 拆成「按材质分组的几何」。
 *
 * 不能整个压成一片 —— 那样袍子、皮肤、矛杆就全成一个颜色了，
 * 而剪影之外，颜色是第二道辨识。
 */
function partsOf(kind: SoldierKind, alt: boolean): Part[] {
  const group = soldier(kind, alt);
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();

  group.updateMatrixWorld(true);
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    const mat = o.material as THREE.Material;
    const list = byMat.get(mat) ?? [];
    list.push(geo);
    byMat.set(mat, list);
  });

  const out: Part[] = [];
  for (const [mat, geos] of byMat) {
    out.push({ geo: mergeSimple(geos), mat });
  }
  return out;
}

/**
 * 把几片几何拼成一片。
 *
 * 刻意不走 BufferGeometryUtils —— 这里的几何全是自己造的基本体，
 * 属性齐整，手拼一次比引进一层通用逻辑更好懂，也更好查错。
 */
function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  for (const g of geos) {
    const src = g.index ? g.toNonIndexed() : g;
    const p = src.attributes['position'] as THREE.BufferAttribute;
    const n = src.attributes['normal'] as THREE.BufferAttribute | undefined;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      if (n) nor.push(n.getX(i), n.getY(i), n.getZ(i));
      else nor.push(0, 1, 0);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}

/** 一个兵种一方的一整套实例网格 */
interface Bank {
  meshes: THREE.InstancedMesh[];
  used: number;
}

/**
 * 一整片战场的小人。
 *
 * 用法是每帧（或每次同步）重来一遍：`begin()` 清零，
 * 一个个 `place()`，最后 `commit()`。
 * 不做增量维护 —— 军阵每一轮都在变，
 * 想把「谁死了谁挪了」增量地记下来，代码会比重画贵得多。
 */
export class Army {
  private readonly root = new THREE.Group();
  private readonly banks = new Map<string, Bank>();

  constructor(scene: THREE.Scene) {
    scene.add(this.root);
    for (const kind of ['foot', 'bow', 'horse'] as SoldierKind[]) {
      for (const alt of [false, true]) {
        const parts = partsOf(kind, alt);
        const meshes = parts.map((p) => {
          const im = new THREE.InstancedMesh(p.geo, p.mat, CAP);
          im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          im.castShadow = true;
          im.receiveShadow = false;
          im.count = 0;
          // 阵中的人一直在动，包围盒每帧都不对。
          // 让它别自己剔除 —— 一支队伍整个消失比多画几笔糟得多
          im.frustumCulled = false;
          this.root.add(im);
          return im;
        });
        this.banks.set(key(kind, alt), { meshes, used: 0 });
      }
    }
  }

  begin(): void {
    for (const b of this.banks.values()) b.used = 0;
  }

  /** 摆一个人 */
  place(
    kind: SoldierKind, alt: boolean,
    x: number, y: number, z: number,
    facing: number, scale: number,
  ): void {
    const bank = this.banks.get(key(kind, alt));
    if (!bank || bank.used >= CAP) return;
    _p.set(x, y, z);
    _e.set(0, facing, 0);
    _q.setFromEuler(_e);
    _s.setScalar(scale);
    _m.compose(_p, _q, _s);
    for (const im of bank.meshes) im.setMatrixAt(bank.used, _m);
    bank.used += 1;
  }

  commit(): void {
    for (const b of this.banks.values()) {
      for (const im of b.meshes) {
        im.count = b.used;
        im.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** 现在场上画了多少个人。开发期自检用 */
  drawn(): number {
    let n = 0;
    for (const b of this.banks.values()) n += b.used;
    return n;
  }

  dispose(): void {
    for (const b of this.banks.values()) {
      for (const im of b.meshes) {
        im.geometry.dispose();
        this.root.remove(im);
      }
    }
    this.banks.clear();
    this.root.removeFromParent();
  }
}

function key(kind: SoldierKind, alt: boolean): string {
  return kind + (alt ? '_b' : '_a');
}

/**
 * 一队人站成什么样。
 *
 * 真正的军阵是**宽的**：横里排开、纵里只有几列。
 * 上一版按 `ceil(sqrt(n))` 摆成正方形，于是每支队伍
 * 都是一个整整齐齐的小方块 —— 那是棋盘上的棋子，不是列阵的兵。
 *
 * 再加一点点参差。完全对齐的队列在这个尺度下看着像印刷品，
 * 而人站不了那么齐。
 */
export function ranksOf(n: number, jitter: (i: number) => number): {
  dx: number; dz: number;
}[] {
  // 横宽是纵深的两倍半上下 —— 汉代的方阵大致就是这个比例
  const depth = Math.max(1, Math.round(Math.sqrt(n / 2.6)));
  const width = Math.ceil(n / depth);
  const out: { dx: number; dz: number }[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / width);
    const col = i % width;
    // 最后一排站不满时居中，免得阵尾缺一角
    const inRow = Math.min(width, n - row * width);
    out.push({
      dx: (col - (inRow - 1) / 2) + jitter(i) * 0.34,
      dz: (row - (depth - 1) / 2) + jitter(i + 977) * 0.26,
    });
  }
  return out;
}
