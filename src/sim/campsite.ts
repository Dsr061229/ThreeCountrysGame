/**
 * 营扎在哪儿。
 *
 * 「安营下寨」在汉末是一件有讲究的事，不是在地图上随手插一根钉子：
 * 要靠水（几百人马每天都要喝），要有山或林遮着一面（不能四面受敌），
 * 又不能压在城头底下（那样你就成了守城的，不是带兵的）。
 *
 * 所以这里的选址是**在真地形上找**的：
 * 沿着离城若干里的一圈打点，挨个看那儿是什么地方，挑一个最像样的。
 * 于是同一座城边上的营，每一局扎的位置都不一样，
 * 而那个位置是有理由的 —— 它旁边真的有那片林子。
 */
import { nextInt, nextRange } from './rng.ts';
import type { RngState } from './rng.ts';
import type { TerrainRegion } from './content.ts';
import type { CampSite } from './general_types.ts';

/** 离依托的那座城多远。太近就成了守城的，太远接不上补给 */
const NEAR = 7;
const FAR = 16;

/** 点到线段的距离 */
function distToSeg(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 <= 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** 这个点离这片地形多近。在里头是 0 */
function nearness(region: TerrainRegion, x: number, y: number): number {
  const half = region.width / 2;
  let best = Infinity;
  if (region.path.length === 1) {
    const a = region.path[0]!;
    best = Math.hypot(x - a[0], y - a[1]);
  }
  for (let i = 0; i < region.path.length - 1; i++) {
    const a = region.path[i]!;
    const b = region.path[i + 1]!;
    best = Math.min(best, distToSeg(x, y, a[0], a[1], b[0], b[1]));
  }
  return Math.max(0, best - half);
}

export interface Site {
  at: [number, number];
  site: CampSite;
}

/**
 * 在这座城周围找一处下寨的地方。
 *
 * 打分的原则是「靠着点什么，但别压在城上，也别扎进别人家门口」：
 * 挨着山林水泽的加分，离别的城太近的减分。
 */
export function pickCampSite(
  rng: RngState,
  city: [number, number],
  regions: TerrainRegion[],
  otherCities: [number, number][],
): Site {
  let best: Site | null = null;
  let bestScore = -Infinity;

  // 绕着城转一圈，每隔一段试一个点
  const spokes = 16;
  const start = nextInt(rng, spokes);
  for (let i = 0; i < spokes; i++) {
    const a = (((start + i) % spokes) / spokes) * Math.PI * 2;
    const d = NEAR + nextRange(rng, 0, FAR - NEAR);
    const x = city[0] + Math.cos(a) * d;
    const y = city[1] + Math.sin(a) * d;

    let score = nextRange(rng, 0, 6);
    let site: CampSite = 'plain';
    let bestNear = Infinity;

    for (const region of regions) {
      const near = nearness(region, x, y);
      // 挨着才算数。隔着二十里的山不能替你挡箭
      if (near > 5) continue;
      if (near < bestNear) {
        bestNear = near;
        site = region.kind === 'mountain' ? 'hill'
          : region.kind === 'forest' ? 'forest' : 'water';
      }
      // 靠得越紧越好，但扎进山里去也不行 —— 那是没地方屯田的
      score += near === 0 ? 14 : 22 - near * 2;
    }

    // 别扎在别人家门口
    for (const other of otherCities) {
      const od = Math.hypot(x - other[0], y - other[1]);
      if (od < 12) score -= (12 - od) * 3;
    }

    if (score > bestScore) {
      bestScore = score;
      best = { at: [Math.round(x * 10) / 10, Math.round(y * 10) / 10], site };
    }
  }

  return best ?? {
    at: [city[0] + NEAR, city[1]],
    site: 'plain',
  };
}
