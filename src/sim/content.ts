/**
 * 内容库 —— 全部游戏内容的只读数据，由外部注入。
 *
 * 模拟层不加载文件，这样它保持纯净，联机时也能校验两端内容是否一致。
 */
import type { BuildingId, CityId } from './types.ts';
import type { BattleEffect, DecisionWhen } from './battle_types.ts';
import type { FieldEffect } from './field_types.ts';
import type { Temper } from './officer_types.ts';

/** 解锁条件。全部满足才出现在可建列表里 —— 这是「渐进暴露」的实现 */
export interface UnlockCond {
  /** 需要已建成某建筑 */ has?: BuildingId;
  /** 需要某建筑达到某级 */ hasLevel?: { id: BuildingId; level: number };
  households?: number;
  coin?: number;
  grain?: number;
  morale?: number;
}

export interface BuildingDef {
  id: BuildingId;
  name: string;
  /** 一句话说明，玩家看的就是这句 */
  desc: string;
  maxLevel: number;
  /**
   * 一城之内最多可有几处。省略为不限。
   *
   * 这不是为了限制玩家，而是为了让「多样化」压过「堆单一建筑」：
   * 一个县有三口井有用，有十八口井没有意义。
   */
  maxCount?: number;

  /** 一级的造价与工期。更高级按 costGrowth 逐级放大 */
  costCoin: number;
  costGrain: number;
  costDays: number;
  /** 每级造价倍率，千分数。1600 = 每级 ×1.6 */
  costGrowth: number;

  /** 每级每日产出 */
  grain?: number;
  coin?: number;

  /** 每级提供的容量 */
  capGrain?: number;
  capCoin?: number;
  capHouse?: number;

  /** 每级占用的劳力（户） */
  labour: number;
  /** 每级提供的守军（人） */
  garrison?: number;
  /** 每级对民心的影响 */
  morale?: number;

  /** 每级为某类建筑提供的产量加成，千分数 */
  boost?: { target: BuildingId; permille: number };

  unlock?: UnlockCond;
  /** 渲染用的形制标识 */
  art: string;
}

export interface CityDef {
  id: CityId;
  name: string;
  commandery: string;
  grain: number;
  coin: number;
  households: number;
  morale: number;
  desc: string;
}

export interface LordDef {
  id: string;
  name: string;
  courtesy: string;
  /** 性格，影响指标严苛程度与猜忌速度 */
  temper: string;
  /** 指标严苛度，千分数。1000 为标准 */
  demandRate: number;
  desc: string;
}

/** 天下图上的一座城 */
export interface MapNodeDef {
  id: string;
  name: string;
  commandery: string;
  /** 初始归属 */ faction: string;
  /** 图上坐标 */ at: [number, number];
  links: string[];
  /** 城的大小 1~3，影响图上的画法与初始实力 */ scale: number;
  /** 是否为势力治所 */ seat?: boolean;
  /**
   * 名分之地值多少分。省略为零。
   *
   * 洛阳与长安是旧都新都，各值五分；邺、许、寿春、襄阳、成都这一档三分；
   * 其余名城一到二分；寻常小县一分不值。
   *
   * **主公「开国」三根柱子里的「土」数的就是这个，不是数城。**
   * 若拿「占满全图」当胜利，那整套防滚雪球的机制就从
   * 「让局面有来有回」变成了「拖延你赢的障碍」—— 含义正好反过来。
   */
  fame?: number;
  desc: string;
}

export interface FactionDef {
  id: string;
  name: string;
  /** 旗号上的那个字 */ banner: string;
  color: string;
  /** 治理水平 0~100。决定它的城长得多快 */ governance: number;
  /** 好战 0~100。决定出兵频率，也决定它肯不肯打没有压倒性优势的仗 */ aggression: number;
  /**
   * 起兵时募得的部曲，开局摊到自家各城头上。
   *
   * 有它才能表达「兵多而地少」这种局面 —— 曹操散尽家财募了五千人，
   * 却连一座自己的城都没有。没有这个字段，他会永远卡在出兵门槛之下。
   */
  levy?: number;
  /** 这家的主在初平元年多大 */
  age?: number;
  /** 史实卒于哪一年（公元）。主公的寿数按它推，再抖 ±3 年 */
  until?: number;
  /** 起兵时的望 0~100。孔融名满天下，董卓人人得而诛之 */
  renown?: number;
  desc: string;
}

/** 战中决断的定义 */
export interface BattleDecisionDef {
  id: string;
  textId: string;
  when: DecisionWhen;
  options: { textId: string; hintId: string; effect: BattleEffect }[];
}

/** 野战决断的出现条件 */
export interface FieldWhen {
  minRound?: number;
  maxRound?: number;
  /** 我方还剩几成（千分数）以下才出现 */ maxOwnLeft?: number;
  maxFoeLeft?: number;
  ownRouted?: boolean;
  foeRouted?: boolean;
  onHill?: boolean;
}

export interface FieldDecisionDef {
  id: string;
  textId: string;
  when: FieldWhen;
  options: { textId: string; hintId: string; effect: FieldEffect }[];
}

export type TextDB = Record<string, string>;

export interface ContentDB {
  buildings: BuildingDef[];
  cities: CityDef[];
  lords: LordDef[];
  map: MapNodeDef[];
  factions: FactionDef[];
  battle: BattleDecisionDef[];
  field: FieldDecisionDef[];
  facilities: FacilityDef[];
  terrain: TerrainRegion[];
  /**
   * 人物库。
   *
   * **天下所有叫得出名字的人都在这一张表里**，按出身分属各家。
   *
   * 这是 M4 的地基：任命要有人可任，势力 AI 要有人可用，
   * 遣使要有人可遣。而它对现在能玩的两条线也立刻管用 ——
   * 敌城从此有个守将的名字，阵前搦战的也是**这一家的人**。
   *
   * 上一版的 foes.json 是一份没有归属的名单，随手抽一个当敌将，
   * 于是会出现「攻孔融的城，董卓帐下的华雄出来单挑」这种事。
   */
  people: PersonDef[];
  /**
   * 时局。
   *
   * **全天下同一时刻答同一道题** —— 讨董、天子东归、兴平大饥。
   * 这是唯一一个让玩家看得见「别人也在做选择」的机制，
   * 而且它是纯内容：写多少条都不用动代码。
   */
  situations?: import('./lord_types.ts').SituationDef[];
  text: TextDB;
}

/**
 * 天下的一个人。
 *
 * 统／勇／智是**模拟层用的**，界面上不摆这三条杠 ——
 * 玩家看到的是评语与擅长（见设计方案 2.3）：
 * 「万人敌，可当一面」比「武力 92」告诉你的多。
 */
export interface PersonDef {
  id: string;
  name: string;
  courtesy: string;
  /** 出身哪一家。空串表示在野 */
  faction: string;
  command: number;
  valor: number;
  wit: number;
  temper: Temper;
  loyalty: number;
  /** 一句评语 */
  praise: string;
  /** 擅长什么 */
  good: string[];
  /** 忌什么。用错人会真的出事 */
  flaw: string;
  note: string;
}

/**
 * 营中的一处设施。
 *
 * 与城里的建筑是同一个路子，但**账不一样**：
 * 城里的建筑用钱造，产出的是粮与钱；
 * 营里的设施用**粮**造，产出的是**能打什么样的仗** ——
 * 有厩栏才有骑兵，有弓弩坊才有弓弩，有工坊才有攻城的家伙什。
 *
 * 这一条是武将发育与文官发育真正的分别：
 * 文官盖房子是为了多收粮，武将修营是为了改变自己军队的**形状**。
 */
export interface FacilityDef {
  id: string;
  name: string;
  desc: string;
  maxLevel: number;
  /** 一级的用粮与工期。更高级按 costGrowth 逐级放大 */
  costGrain: number;
  costDays: number;
  /** 每级造价倍率，千分数 */
  costGrowth: number;

  /** 每级把训练度的上限抬高多少 */
  trainCap?: number;
  /** 每级让一次操练多涨多少训练度 */
  drillBonus?: number;
  /** 每级能多养多少骑兵（千分数上限） */
  horse?: number;
  /** 每级能多配多少弓弩（千分数上限） */
  bow?: number;
  /** 每级把器械上限抬高多少 */
  gearCap?: number;
  /** 每级把存粮上限抬高多少 */
  grainCap?: number;
  /** 每级让屯田每百人多打多少粮 */
  tuntian?: number;
  /** 每级多坐得下几个部将 */
  officers?: number;
  /** 每级守营时加多少防御（千分数） */
  defence?: number;

  /** 一句掌故或说明，点开时看得见 */
  note: string;
}

/**
 * 图上的一片地形。
 *
 * 位置按真实经纬度投影过来（与城池同一套换算），
 * 所以太行山真的横在并州与冀州之间，秦岭真的挡在关中与荆襄之间。
 *
 * 它同时供两处使用：**画出来**给人看，以及**算出行军的难易** ——
 * 后者才是它存在的理由。一片只用来看的山是布景，
 * 一片会让你的兵多走五天的山才是地形。
 */
export interface TerrainRegion {
  id: string;
  name: string;
  kind: 'mountain' | 'forest' | 'marsh';
  /** 山脊或林带的走向，图上坐标 */
  path: [number, number][];
  /** 带宽（图上单位）。路线离它多近才算穿过 */
  width: number;
  /** 起伏的高低。画山用 */
  height: number;
  note: string;
}

/** 渲染文本模板。缺失的 id 直接暴露出来，方便发现漏写的内容 */
export function renderText(db: TextDB, id: string, vars: Record<string, string | number> = {}): string {
  const tpl = db[id];
  if (tpl === undefined) return `⟪缺失文本:${id}⟫`;
  return tpl.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? `{${k}}`));
}

export interface ContentIndex {
  db: ContentDB;
  building: Map<string, BuildingDef>;
  city: Map<string, CityDef>;
  lord: Map<string, LordDef>;
  node: Map<string, MapNodeDef>;
  faction: Map<string, FactionDef>;
  /** 人物库：按 id 查人 */
  person: Map<string, PersonDef>;
  /** 人物库：按出身分家。任命、守将、遣使都从这里取人 */
  byFaction: Map<string, PersonDef[]>;
  facility: Map<string, FacilityDef>;
  terrain: TerrainRegion[];
  /** 两城之间的路程（图上距离），行军耗时按它算 */
  roadLength: Map<string, number>;
}

export function indexContent(db: ContentDB): ContentIndex {
  const by = <T extends { id: string }>(xs: T[]): Map<string, T> => new Map(xs.map((x) => [x.id, x]));
  const node = by(db.map);

  const roadLength = new Map<string, number>();
  for (const n of db.map) {
    for (const to of n.links) {
      const other = node.get(to);
      if (!other) continue;
      const d = Math.round(Math.hypot(other.at[0] - n.at[0], other.at[1] - n.at[1]));
      roadLength.set(roadKey(n.id, to), Math.max(4, d));
    }
  }

  const byFaction = new Map<string, PersonDef[]>();
  for (const p of db.people) {
    const list = byFaction.get(p.faction);
    if (list) list.push(p);
    else byFaction.set(p.faction, [p]);
  }

  return {
    db,
    person: by(db.people),
    byFaction,
    building: by(db.buildings),
    city: by(db.cities),
    lord: by(db.lords),
    facility: by(db.facilities),
    terrain: db.terrain,
    node,
    faction: by(db.factions),
    roadLength,
  };
}

/** 道路是双向的，键要与方向无关 */
export function roadKey(a: string, b: string): string {
  return a < b ? a + '|' + b : b + '|' + a;
}

/** 从无到第 level 级，累计投入了多少。拆除退款按它算 */
export function totalInvested(
  def: BuildingDef, level: number,
): { coin: number; grain: number } {
  let coin = 0, grain = 0;
  for (let i = 1; i <= level; i++) {
    const c = upgradeCost(def, i);
    coin += c.coin;
    grain += c.grain;
  }
  return { coin, grain };
}

/** 某建筑升到第 level 级的造价（level 从 1 起） */
export function upgradeCost(
  def: BuildingDef, level: number,
): { coin: number; grain: number; days: number } {
  let mul = 1000;
  for (let i = 1; i < level; i++) mul = Math.floor((mul * def.costGrowth) / 1000);
  return {
    coin: Math.floor((def.costCoin * mul) / 1000),
    grain: Math.floor((def.costGrain * mul) / 1000),
    // 工期增长放缓，否则后期一个工程要拖几个月，节奏会断
    days: def.costDays + Math.floor((level - 1) * 1.5),
  };
}
