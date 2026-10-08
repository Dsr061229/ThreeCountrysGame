/**
 * 军令。
 *
 * 这是武将这条线的**心跳**。
 *
 * 文官被季度指标追着跑：交得上差就升，交不上就滚。
 * 武将上一版什么也没有 —— 你可以在营里屯四年田，
 * 兵不增不减，训练卡在三十，粮满了往外溢。
 * 那不叫发育，那叫挂机。
 *
 * 军令补上的正是这一条：主公隔些日子就要你办件事。
 * 办成了有战功有信任，办砸了掉信任，**抗命也掉**——
 * 但抗命是一个真的选项，因为「将在外，君命有所不受」
 * 本来就是这条线上最有味道的一句话。
 *
 * ── 设计上的两条硬规矩 ────────────────────────────────
 *
 * 一、**军令要能拒**。不能拒的命令不是选择，是任务栏。
 *    拒了要付代价，但代价不该是立刻出局 —— 那样等于不能拒。
 *
 * 二、**军令要有道理**。主公不会随口指一座城 ——
 *    他让你去救的，是**真的正在被围**的那座城；
 *    他让你去打的，是**真的挨着你**的那座敌城。
 *    命令从天下图的实况里长出来，玩家才信。
 */
import type { NodeId } from './world_types.ts';

export type OrderKind =
  /** 去救一座正在被围的城 */
  | 'relieve'
  /** 去打一座敌城 */
  | 'assault'
  /** 送粮到主公那儿 */
  | 'tribute'
  /** 按兵不动，守着你的营 */
  | 'garrison';

export const ORDER_NAME: Record<OrderKind, string> = {
  relieve: '驰援',
  assault: '攻取',
  tribute: '输粮',
  garrison: '按兵',
};

export type OrderOutcome = 'pending' | 'done' | 'failed' | 'defied';

export interface LordOrder {
  id: string;
  kind: OrderKind;
  /** 要去哪儿。输粮与按兵为 null */
  targetNodeId: NodeId | null;
  /** 输粮要多少石 */
  amount: number;
  /** 哪天下的令 */
  issuedDay: number;
  /** 到这天还没办成就算砸了 */
  dueDay: number;
  outcome: OrderOutcome;
  /** 你接了没有。没接之前可以拒 */
  accepted: boolean;
}

// ─────────────────────────────────────────────────────────────
// 平衡常数
// ─────────────────────────────────────────────────────────────

/** 隔多少天来一道军令 */
export const ORDER_EVERY = 110;
/** 头一道军令在第几天。别一上任就派活 */
export const ORDER_FIRST = 70;
/** 给你多少天办 */
export const ORDER_DAYS = 75;

/** 办成了加多少战功、多少信任 */
export const ORDER_MERIT = 26;
export const ORDER_TRUST = 9;
/** 办砸了掉多少信任 */
export const ORDER_FAIL_TRUST = 11;
/**
 * 抗命掉多少信任。
 *
 * 比办砸了重 —— 办砸了是能力问题，抗命是态度问题，
 * 主公介意的从来是后者。
 */
export const ORDER_DEFY_TRUST = 16;

/**
 * 信任跌到这个数以下，主公就要动你了。
 *
 * 这是抗命的**真正代价**：不是当场出局，是你一次次不听话，
 * 到某一天他不再拨粮、不再给你人，最后一纸调令把你撤了。
 */
export const TRUST_DANGER = 18;
/** 信任这么低，连着这么多天，就被撤职 */
export const DISMISS_AFTER_DAYS = 90;
