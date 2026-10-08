/**
 * 两地之间隔着什么。
 *
 * 这个文件是「出兵与地形有关」这句话的落脚点。
 *
 * 从这里到那里画一条直线，看它穿过哪几片山、哪几片林、哪几片泽，
 * 再由此决定：有没有小道可绕、有没有山道可翻、每条道要走几天、藏不藏得住人。
 *
 * 所以同一支兵，从雍丘往东打是一回事，往西翻着秦岭打是另一回事 ——
 * 不是因为我给它们配了不同的数，是因为**中间真的隔着一座山**。
 */
import type { TerrainRegion } from './content.ts';

export interface Crossing {
  region: TerrainRegion;
  /** 这条路有多长一截压在这片地形里（图上单位） */
  span: number;
}

export interface RouteSurvey {
  /** 直线距离（图上单位） */
  distance: number;
  crossings: Crossing[];
  /** 山地占了这条路的几成（千分数） */
  mountain: number;
  forest: number;
  marsh: number;
}

const SAMPLES = 40;

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

/** 一个点落在这片地形里没有 */
function inside(region: TerrainRegion, x: number, y: number): boolean {
  const half = region.width / 2;
  for (let i = 0; i < region.path.length - 1; i++) {
    const a = region.path[i]!;
    const b = region.path[i + 1]!;
    if (distToSeg(x, y, a[0], a[1], b[0], b[1]) <= half) return true;
  }
  // 只有一个点的地形（小山头）按圆算
  if (region.path.length === 1) {
    const a = region.path[0]!;
    return Math.hypot(x - a[0], y - a[1]) <= half;
  }
  return false;
}

/**
 * 走一遍这条路，看它经过什么。
 *
 * 用等距采样而不是求解析交点：地形是折线加宽度，交点算起来又碎又容易错，
 * 而这里要的只是「大致占了几成」—— 四十个采样点足够，
 * 而且换成更复杂的地形形状时这段代码不用动。
 */
export function surveyRoute(
  from: [number, number], to: [number, number], regions: TerrainRegion[],
): RouteSurvey {
  const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const hit = new Map<string, number>();
  let mountain = 0;
  let forest = 0;
  let marsh = 0;

  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const x = from[0] + (to[0] - from[0]) * t;
    const y = from[1] + (to[1] - from[1]) * t;
    let m = false, f = false, s = false;
    for (const region of regions) {
      if (!inside(region, x, y)) continue;
      hit.set(region.id, (hit.get(region.id) ?? 0) + 1);
      if (region.kind === 'mountain') m = true;
      else if (region.kind === 'forest') f = true;
      else s = true;
    }
    if (m) mountain++;
    if (f) forest++;
    if (s) marsh++;
  }

  const per = (n: number): number => Math.round((n * 1000) / (SAMPLES + 1));
  const byId = new Map(regions.map((r) => [r.id, r]));
  const crossings: Crossing[] = [...hit.entries()]
    .map(([id, n]) => ({
      region: byId.get(id)!,
      span: Math.round((distance * n) / (SAMPLES + 1)),
    }))
    .sort((a, b) => b.span - a.span);

  return {
    distance: Math.round(distance),
    crossings,
    mountain: per(mountain),
    forest: per(forest),
    marsh: per(marsh),
  };
}

/**
 * 这条路走起来有多费劲（千分数，1000 = 一马平川）。
 *
 * 山最费，泽次之，林再次之。
 * 这个数直接乘进行军日数 —— 翻秦岭的那一路，兵是真的要多走十天。
 */
export function paceOf(survey: RouteSurvey): number {
  return 1000
    + Math.round(survey.mountain * 1.5)
    + Math.round(survey.marsh * 1.1)
    + Math.round(survey.forest * 0.5);
}

/**
 * 这一路藏不藏得住人（0~100）。
 *
 * 山与林是伏兵的家。一马平川上没有伏兵这回事 ——
 * 这一条必须硬：否则玩家会在平原上设伏，而那本来就不该成立。
 */
export function coverOf(survey: RouteSurvey): number {
  const raw = Math.round(
    (survey.mountain * 0.075) + (survey.forest * 0.065) + (survey.marsh * 0.04),
  );
  return Math.max(0, Math.min(100, raw));
}

/** 这一路上最像样的那片地形，用来给道起名字 */
export function landmarkOf(survey: RouteSurvey): TerrainRegion | null {
  return survey.crossings[0]?.region ?? null;
}
