/**
 * 城池产出的推导。
 *
 * 全部是纯函数：给定城的状态和建筑表，算出日产、上限、劳力。
 * **推导值绝不存进状态** —— 一旦缓存，就会出现「拆了粮仓但容量还在」这类对不上的 bug。
 *
 * 比率一律用千分数，最后一步才取整，避免浮点进入判定。
 */
import type { BuildingDef, ContentIndex } from './content.ts';
import {
  BASE_CAP_COIN, BASE_CAP_GRAIN, BASE_CAP_HOUSE, HOUSEHOLDS_PER_GRAIN,
  TAX_PER_1000_HOUSEHOLDS, type City, type CityOutput,
} from './types.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 遍历已建成的建筑 */
export function eachBuilt(
  city: City, idx: ContentIndex,
  fn: (def: BuildingDef, level: number, plotIndex: number) => void,
): void {
  for (let i = 0; i < city.plots.length; i++) {
    const p = city.plots[i]!;
    if (!p.buildingId || p.level <= 0) continue;
    const def = idx.building.get(p.buildingId);
    if (def) fn(def, p.level, i);
  }
}

/** 某建筑在城中已有几处（含在建） */
export function countOf(city: City, buildingId: string): number {
  let n = 0;
  for (const p of city.plots) {
    if (p.buildingId === buildingId || p.work?.buildingId === buildingId) n++;
  }
  return n;
}

/** 是否还能再起一处。已建成的那几处仍可继续升级，只是不能再新开 */
export function canPlaceMore(city: City, def: BuildingDef): boolean {
  return def.maxCount === undefined || countOf(city, def.id) < def.maxCount;
}

/** 某建筑在城中的总等级（可能有多块地建同一种） */
export function totalLevelOf(city: City, idx: ContentIndex, buildingId: string): number {
  let n = 0;
  eachBuilt(city, idx, (def, level) => { if (def.id === buildingId) n += level; });
  return n;
}

/**
 * 民心系数，千分数 500~1200。
 * 民心 0 → 0.5 倍产出；民心 100 → 1.2 倍。民心不是装饰品。
 */
export function moraleFactorOf(morale: number): number {
  return 500 + Math.floor((clamp(morale, 0, 100) * 700) / 100);
}

export function computeOutput(city: City, idx: ContentIndex): CityOutput {
  let grainBase = 0, coinBase = 0;
  let capGrain = BASE_CAP_GRAIN, capCoin = BASE_CAP_COIN, capHouse = BASE_CAP_HOUSE;
  let labourNeed = 0, dev = 0;
  /** 各类建筑受到的加成，千分数增量 */
  const boosts = new Map<string, number>();

  eachBuilt(city, idx, (def, level) => {
    dev += level;
    grainBase += (def.grain ?? 0) * level;
    coinBase += (def.coin ?? 0) * level;
    capGrain += (def.capGrain ?? 0) * level;
    capCoin += (def.capCoin ?? 0) * level;
    capHouse += (def.capHouse ?? 0) * level;
    labourNeed += def.labour * level;
    if (def.boost) {
      boosts.set(def.boost.target, (boosts.get(def.boost.target) ?? 0) + def.boost.permille * level);
    }
  });

  const labourHave = city.households;
  // 人不够，田就种不完 —— 人口因此成为真正的瓶颈，而不是一个装饰数字
  const labourRatio = labourNeed <= 0 ? 1000 : clamp(Math.floor((labourHave * 1000) / labourNeed), 0, 1000);
  const moraleFactor = moraleFactorOf(city.morale);
  let irrigation = 1000 + (boosts.get('farm') ?? 0);
  // 天灾压在田上。陂塘的加成也救不回一场蝗灾
  for (const a of city.afflictions) {
    irrigation = Math.floor((irrigation * a.farmPermille) / 1000);
  }

  const grainPerDay = Math.floor(
    (grainBase * irrigation * labourRatio * moraleFactor) / 1_000_000_000,
  );
  // 工商之利要人手去做，因此吃劳力；算赋口钱是按户征的，不吃劳力。
  // 两者都受民心影响 —— 民不聊生的地方，税也收不上来。
  const coinFromTrade = Math.floor((coinBase * labourRatio * moraleFactor) / 1_000_000);
  const taxBase = Math.floor((city.households * TAX_PER_1000_HOUSEHOLDS) / 1000);
  const coinFromTax = Math.floor((taxBase * moraleFactor) / 1000);
  const coinPerDay = coinFromTrade + coinFromTax;
  const grainUpkeep = Math.floor(city.households / HOUSEHOLDS_PER_GRAIN);

  return {
    grainPerDay,
    coinPerDay,
    coinFromTax,
    grainUpkeep,
    grainNet: grainPerDay - grainUpkeep,
    labourNeed,
    labourHave,
    labourRatio,
    moraleFactor,
    irrigation,
    capGrain,
    capCoin,
    capHouse,
    dev,
  };
}

/**
 * 民心的目标值。每日向它靠拢 1 点。
 *
 * 刻意做成「口粮 > 一切」：粮断了，什么德政都留不住人。
 */
export function moraleTarget(city: City, idx: ContentIndex, out: CityOutput): number {
  let t = 50;

  // 口粮
  const daysOfFood = out.grainUpkeep > 0 ? Math.floor(city.grain / out.grainUpkeep) : 99;
  if (city.grain <= 0) t -= 35;
  else if (daysOfFood < 10) t -= 18;
  else if (daysOfFood > 60) t += 14;
  else if (daysOfFood > 25) t += 7;

  // 德政
  eachBuilt(city, idx, (def, level) => { t += (def.morale ?? 0) * level; });

  // 徭役过重：劳力被占满了，百姓没有喘息
  if (out.labourRatio < 700) t -= 8;

  // 过度拥挤：房子不够，人挤在庙檐下。流民涌入之后最容易出这个问题
  if (city.households > out.capHouse) {
    const over = Math.floor(((city.households - out.capHouse) * 100) / Math.max(1, out.capHouse));
    t -= Math.min(30, Math.floor(over / 2));
  }

  // 征敛
  t -= Math.floor(city.taxPressure / 2);

  return clamp(t, 0, 100);
}

/** 某建筑此刻是否已解锁 */
export function isUnlocked(def: BuildingDef, city: City, idx: ContentIndex): boolean {
  const u = def.unlock;
  if (!u) return true;
  if (u.has && totalLevelOf(city, idx, u.has) <= 0) return false;
  if (u.hasLevel && totalLevelOf(city, idx, u.hasLevel.id) < u.hasLevel.level) return false;
  if (u.households !== undefined && city.households < u.households) return false;
  if (u.coin !== undefined && city.coin < u.coin) return false;
  if (u.grain !== undefined && city.grain < u.grain) return false;
  if (u.morale !== undefined && city.morale < u.morale) return false;
  return true;
}

/** 当前可**新建**的建筑。UI 直接用这个列表，因此屏幕上永远只出现「现在真的能建的东西」 */
export function availableBuildings(city: City, idx: ContentIndex): BuildingDef[] {
  return idx.db.buildings.filter(
    (d) => d.id !== 'yamen' && isUnlocked(d, city, idx) && canPlaceMore(city, d),
  );
}

/** 已解锁的建筑（不论是否还能新开），用于图鉴与解锁播报 */
export function unlockedBuildings(city: City, idx: ContentIndex): BuildingDef[] {
  return idx.db.buildings.filter((d) => d.id !== 'yamen' && isUnlocked(d, city, idx));
}

/** 地块是否在已开放范围内 */
export function isPlotOpen(city: City, index: number): boolean {
  const size = 5;
  const x = index % size, y = Math.floor(index / size);
  const edge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
  return edge ? city.ring >= 1 : true;
}
