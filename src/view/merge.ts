/**
 * 几何合并。
 *
 * 为什么必须有：天下图上四十四座城，每座城由几百个独立网格拼成，
 * 一帧要发一万两千多个 draw call —— 实测 271 毫秒一帧，不到 4 FPS。
 *
 * 这些东西建好之后就不再单独动了，所以可以按材质压成几个大网格。
 * 合并之后 draw call 从一万两千降到两位数，几何总量一点没少。
 *
 * 代价：合并后的网格不能再单独拾取或单独改颜色。
 * 所以会变的东西（旗面、行军队列、围城营盘）不参与合并，
 * 拾取也另有一套不可见的热区（见各场景的 pickTargets）。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** 合并时统一保留的顶点属性。缺哪个补哪个，否则 mergeGeometries 会拒绝 */
const ATTRS = ['position', 'normal', 'uv'] as const;

function normalize(geo: THREE.BufferGeometry): THREE.BufferGeometry | null {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  const count = g.attributes['position']?.count;
  if (!count) return null;
  for (const name of ATTRS) {
    if (g.attributes[name]) continue;
    const size = name === 'uv' ? 2 : 3;
    g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(count * size), size));
  }
  // 多余的属性会让合并失败，一律去掉
  for (const name of Object.keys(g.attributes)) {
    if (!(ATTRS as readonly string[]).includes(name)) g.deleteAttribute(name);
  }
  return g;
}

/**
 * 把一个组里的静态网格按材质压成几个大网格。
 *
 * @param root 会被就地清空，返回的新组请自行加入场景
 * @param skip 返回 true 的节点原样保留（会变的东西）
 */
export function mergeStatic(
  root: THREE.Object3D,
  skip?: (o: THREE.Mesh) => boolean,
): THREE.Group {
  root.updateMatrixWorld(true);

  const buckets = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; sample: THREE.Mesh }>();
  const keep: THREE.Object3D[] = [];

  root.traverse((o) => {
    // 非网格的东西（炊烟的粒子、文字贴片、线）原样保留。
    // 少了这一句，合并会把它们悄悄吃掉 —— 炊烟就没了。
    if (o instanceof THREE.Points || o instanceof THREE.Sprite || o instanceof THREE.Line) {
      keep.push(o);
      return;
    }
    if (!(o instanceof THREE.Mesh)) return;
    if (Array.isArray(o.material)) { keep.push(o); return; }
    if (skip?.(o)) { keep.push(o); return; }

    const g = normalize(o.geometry);
    if (!g) return;
    g.applyMatrix4(o.matrixWorld);

    const b = buckets.get(o.material);
    if (b) b.geos.push(g);
    else buckets.set(o.material, { geos: [g], sample: o });
  });

  const out = new THREE.Group();

  for (const [mat, { geos, sample }] of buckets) {
    const merged = geos.length === 1 ? geos[0]! : mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = sample.castShadow;
    mesh.receiveShadow = sample.receiveShadow;
    mesh.renderOrder = sample.renderOrder;
    // 顶点已经烘进世界坐标，网格本身不再有变换
    mesh.matrixAutoUpdate = false;
    out.add(mesh);
    for (const g of geos) if (g !== merged) g.dispose();
  }

  // 需要保留的节点，连同它们的世界变换一起挪过来
  for (const m of keep) {
    m.matrix.copy(m.matrixWorld);
    m.matrix.decompose(m.position, m.quaternion, m.scale);
    out.add(m);
  }

  return out;
}
