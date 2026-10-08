/**
 * 领域类型 —— 一城之治。
 *
 * 硬性约定：
 *  1. 逻辑判定中不出现浮点。比率一律用**千分数**表示（0~1000），最后一步再取整。
 *  2. 这里定义的是「状态」，不是「表现」。像素、颜色、模型一概不属于这里。
 *  3. 产出、上限、消耗都是**推导值**，不存进状态 —— 存了就会和建筑对不上。
 */

export type CityId = string;
export type BuildingId = string;
export type PersonId = string;

// ─────────────────────────────────────────────────────────────
// 城
// ─────────────────────────────────────────────────────────────

/** 城内地块。5×5 共 25 格，中心固定为官署 */
export interface Plot {
  /** 已建成的建筑；null 为空地 */
  buildingId: BuildingId | null;
  /** 已建成的等级。0 表示尚未建成 */
  level: number;
  /** 在建（或在拆）的工程 */
  work: {
    buildingId: BuildingId;
    /** 拆除时为 0 */ toLevel: number;
    daysLeft: number;
    totalDays: number;
    /** 这是拆除，不是营造 */ demolish?: boolean;
  } | null;
}

export const CITY_SIZE = 5;
export const PLOT_COUNT = CITY_SIZE * CITY_SIZE;
/** 中心格：官署，不可建造 */
export const YAMEN_PLOT = 12;

export interface City {
  id: CityId;
  name: string;
  /** 所属郡 */
  commandery: string;
  plots: Plot[];
  /** 已开放的范围。0 = 中心 3×3，1 = 全部 5×5 */
  ring: number;

  /** 存粮（石） */ grain: number;
  /** 库钱（缗） */ coin: number;
  /** 户口 */ households: number;
  /** 民心 0~100 */ morale: number;

  /**
   * 征敛压力 0~100。每次向上缴纳都会推高，之后逐日消退。
   * 它压着民心 —— 所以「把粮全交上去」是有后果的。
   */
  taxPressure: number;

  /** 正在生效的天灾人祸 */
  afflictions: Affliction[];

  /**
   * 城墙等级 0~3。
   *
   * 它不占地块 —— 城墙本来也不在坊里。修城是一件城一级的事，
   * 所以做成独立的 fortify 命令，而不是又一栋要摆位置的建筑。
   */
  wall: number;
  /** 城墙正在修葺，剩余日数 */
  wallWork: number;
}

/**
 * 天灾人祸。
 *
 * 这是文官路线的**威胁节奏**。没有它，发育就只是看着数字往上爬，
 * 攒下的粮永远没有用武之地 —— 而「攒的东西有地方用」正是发育好玩的前提。
 */
export interface Affliction {
  kind: AfflictionKind;
  daysLeft: number;
  /** 对田庄产量的乘数，千分数。1000 为无影响 */
  farmPermille: number;
}

export type AfflictionKind =
  /** 春旱 */ | 'drought'
  /** 大水 */ | 'flood'
  /** 蝗 */   | 'locust'
  /** 疫疠 */ | 'plague'
  /** 溃兵劫掠 */ | 'raid'
  /** 流民涌入 */ | 'refugees';

export const AFFLICTION_NAME: Record<AfflictionKind, string> = {
  drought: '春旱', flood: '大水', locust: '蝗', plague: '疫疠', raid: '溃兵', refugees: '流民',
};

// ─────────────────────────────────────────────────────────────
// 玩家：文官
// ─────────────────────────────────────────────────────────────

/** 官阶。M1 只到县令，后续里程碑向上打通 */
export const RANKS = ['县令', '郡丞', '郡守', '州别驾', '州牧'] as const;
export type Rank = (typeof RANKS)[number];

export interface Official {
  name: string;
  /** RANKS 的下标 */ rank: number;
  /** 功绩。达到阈值可升迁 */ merit: number;
  /** 主公对你的信任 0~100。太低会被调查、被撤换 */ trust: number;
  cityId: CityId;
  lordId: string;
}

/** 升迁所需功绩 */
export const MERIT_TO_PROMOTE = [100, 260, 520, 900] as const;

// ─────────────────────────────────────────────────────────────
// 季度指标 —— 文官的威胁节奏
// ─────────────────────────────────────────────────────────────

export type QuotaOutcome = 'pending' | 'met' | 'missed';

export interface Quota {
  /** 季度序号 */ quarter: number;
  /** 截止日（含） */ dueDay: number;
  demandGrain: number;
  demandCoin: number;
  paidGrain: number;
  paidCoin: number;
  outcome: QuotaOutcome;
}

// ─────────────────────────────────────────────────────────────
// 推导值 —— 每次都从状态算，不缓存
// ─────────────────────────────────────────────────────────────

export interface CityOutput {
  /** 日产粮（已计入所有系数） */ grainPerDay: number;
  /** 日产钱 */ coinPerDay: number;
  /** 其中来自算赋口钱的部分 */ coinFromTax: number;
  /** 日耗粮（人吃马嚼） */ grainUpkeep: number;
  /** 净增粮 */ grainNet: number;

  /** 所需劳力（户） */ labourNeed: number;
  /** 可用劳力（户） */ labourHave: number;
  /** 劳力满足度 千分数 0~1000 */ labourRatio: number;
  /** 民心系数 千分数 500~1200 */ moraleFactor: number;
  /** 水利加成 千分数，1000 为无加成 */ irrigation: number;

  /** 粮仓容量 */ capGrain: number;
  /** 府库容量 */ capCoin: number;
  /** 户口上限 */ capHouse: number;

  /** 已建总等级，衡量城池发展水平 */ dev: number;
}

/** 基础容量：没有粮仓府库时也能存一点 */
export const BASE_CAP_GRAIN = 800;
export const BASE_CAP_COIN = 400;
export const BASE_CAP_HOUSE = 200;

/** 修城的造价：第 n 级需要的钱、粮、工期 */
export const WALL_COST = [
  { coin: 260, grain: 120, days: 14 },
  { coin: 520, grain: 260, days: 20 },
  { coin: 980, grain: 520, days: 28 },
] as const;

/** 每多少户消耗一石粮／日 */
export const HOUSEHOLDS_PER_GRAIN = 20;

/**
 * 算赋口钱：每千户每日入库多少缗。
 *
 * 这一条是整个经济的枢纽。没有它，钱只出不进，玩家花光起始盘缠就彻底卡死；
 * 有了它，人口同时是**赋税、劳力、吃饭的嘴**三重身份，
 * 「盖民居」才从纯粹的负担变成核心决策。
 */
export const TAX_PER_1000_HOUSEHOLDS = 50;

/**
 * 拆除能收回多少成本，千分数。
 *
 * 木料砖石能拆下来再用，人工和夯土是收不回来的。
 * 不做全额退还 —— 否则「先随便建，不合适再拆」没有代价，
 * 地块稀缺这个核心取舍就废了。
 */
export const DEMOLISH_REFUND = 350;

/** 人口结算周期（日） */
export const POP_TICK_DAYS = 7;

/**
 * 人口增长的阻尼：每次只补足空缺户数的 1/N。
 * 调大它整条曲线就变缓 —— 这是控制 M1 长度最有效的一个旋钮。
 */
export const POP_GROWTH_DIVISOR = 22;
