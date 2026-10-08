/**
 * 战斗。
 *
 * 设计取舍写在方案里，这里重述一遍，因为它决定了整个数据结构的形状：
 *
 *   **不做即时战术（太难上手），也不做纯数值对撞（不好玩）。**
 *   打法是「战前部署 + 战中两三次决断」——
 *   古代将领在战场上本来也就是在关键时刻做几个决定，
 *   而不是操作每一个士兵。
 *
 * 所以战斗状态只需要记住三件事：兵力怎么分的、打到第几轮、当前在等哪个决断。
 * 它整个活在 WorldState 里，所以同样确定、同样可存档、同样能回放。
 */

export type BattleKind =
  /** 守城 —— 玩家是城里的那一方 */ | 'defend'
  /** 攻城 */ | 'assault'
  /** 野战 */ | 'field';

/** 守方的三处布置。加起来必须等于可用守军 */
export interface DefenceDeploy {
  /** 城头：射住城下，压制蚁附 */ wall: number;
  /** 城门：撞门时的最后一道 */ gate: number;
  /** 预备：哪里破了往哪里堵 */ reserve: number;
}

/** 战中的一次决断 */
export interface BattleDecision {
  /** 内容库里的 id */ id: string;
  /** 文本模板 id */ textId: string;
  vars: Record<string, string | number>;
  options: BattleOption[];
  /** 出现在第几轮 */ round: number;
}

export interface BattleOption {
  textId: string;
  /** 这个选择的后果，见 content/battle.json 的注释 */
  effect: BattleEffect;
  /** 一句话点破它在赌什么。玩家要能读懂自己在做什么选择 */
  hintId: string;
}

/**
 * 决断的后果。全部是**千分数的修正**，不是直接改结果 ——
 * 与楔子同一个道理：玩家改的是形势，不是胜负本身。
 */
export interface BattleEffect {
  /** 守方每轮折损的乘数 */ defLossPermille?: number;
  /** 攻方每轮折损的乘数 */ atkLossPermille?: number;
  /** 守方士气增减 */ defMorale?: number;
  /** 攻方士气增减 */ atkMorale?: number;
  /** 城墙完好度增减 */ wall?: number;
  /** 立刻折损的守军（人） */ defMen?: number;
  /** 立刻折损的攻军（人） */ atkMen?: number;
  /** 落到城本身：民心 */ cityMorale?: number;
  /** 落到城本身：钱（负数为花掉） */ cityCoin?: number;
  /** 落到围城方：随军口粮 */ atkSupply?: number;
  /** 你自己挂了彩 */ wounded?: number;
  /** 赌一把：成的概率（百分数），成与不成分别叠加下面两组 */
  gamble?: { chance: number; win: BattleEffect; lose: BattleEffect };
}

/** 决断出现的条件 */
export interface DecisionWhen {
  minRound?: number;
  maxRound?: number;
  /** 城墙残破到这个程度以下才会出现 */ maxWall?: number;
  minAtkMorale?: number;
  maxAtkMorale?: number;
  maxDefMorale?: number;
}

export interface BattleLogEntry {
  round: number;
  textId: string;
  vars: Record<string, string | number>;
  tone: 'plain' | 'good' | 'bad';
}

export interface Battle {
  kind: BattleKind;
  cityId: string;
  /** 攻方势力 */ attackerId: string;
  /** 打到第几轮（从 1 起） */ round: number;
  /** 一场强攻最多几轮 */ maxRounds: number;
  phase: 'deploy' | 'fighting' | 'done';

  deploy: DefenceDeploy;
  /** 守方可用兵力 */ defMen: number;
  /** 开打时的守军人数。折损 = defMen0 - defMen */ defMen0: number;
  /** 攻方兵力 */ atkMen: number;
  defMorale: number;
  atkMorale: number;
  /** 城墙完好度 0~100。破到 0 就是城陷 */ wallIntegrity: number;

  /** 本轮的修正，决断的后果落在这里，打完一轮清零 */
  defLossMod: number;
  atkLossMod: number;

  pending: BattleDecision | null;
  /** 已经用过的决断，不重复出 */ usedDecisions: string[];
  log: BattleLogEntry[];
  outcome: 'held' | 'fallen' | null;
}

// ─────────────────────────────────────────────────────────────
// 平衡常数
// ─────────────────────────────────────────────────────────────

/** 一场强攻打几轮 */
export const ASSAULT_ROUNDS = 6;

/** 围城多少日之后发起第一次强攻 */
export const FIRST_ASSAULT_DAY = 6;

/** 两次强攻之间隔多少日 */
export const ASSAULT_INTERVAL = 14;

/** 士气跌破此值就崩 */
export const MORALE_BREAK = 20;
