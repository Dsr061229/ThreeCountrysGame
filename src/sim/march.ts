/**
 * 远征 —— 路、借道、损耗。
 *
 * ── 这一层要治的病 ──────────────────────────────────
 *
 * 原先出兵只有一条规矩：**「隔着别人的地界，兵过不去。」**
 * 于是天下图上大半座城点开都是同一句话，玩家什么也做不了。
 *
 * 但那句话既不合地理，也不合史实。汉末的兵天天在走远路：
 * 曹操从许都打到官渡，孙策从历阳一路下江东，
 * 没有哪一支军队因为「不挨着」就掉头回家。
 *
 * 真实世界里拦住一支远征军的从来不是相邻不相邻，是三样东西：
 *
 *   **一、路。** 走多远，要多少天。远征的第一个代价是时间 ——
 *        你出去的这两个月，后方是空的。
 *
 *   **二、借道。** 中间那几个郡是别人的。你得跟人家打招呼，
 *        人家肯不肯是另一回事 —— 交恶的不会借，正在打的更不会。
 *        借了也要还：**过一次境，那一家对你冷一分。**
 *        （假道伐虢这件事，从来就不是白来的。）
 *
 *   **三、损耗。** 走一路散一路。逃亡、疾病、掉队，
 *        千里而袭人者，必蹶上将军 —— 这句话在这儿是一个乘数。
 *        再加上随军的粮按日吃（那是图上现成的规则），
 *        走得太远的兵，到地方已经不是出发时那支兵了。
 *
 * ── 硬规矩三：只拧现成的旋钮 ────────────────────────
 *
 * 这一层没有新增任何资源、任何状态机。它只做两件事：
 * 给 `Army` 多一串**还要走的路**，以及**到站时按比例减员**。
 * 行军速度、口粮、围城、被截 —— 全是原来那一套。
 */
import type { ContentIndex } from './content.ts';
import { roadKey } from './content.ts';
import type { WorldState } from './state.ts';
import { atWar } from './diplomacy.ts';
import { MARCH_PER_DAY, type FactionId, type NodeId } from './world_types.ts';

// ─────────────────────────────────────────────────────────────
// 借道
// ─────────────────────────────────────────────────────────────

/** 借一次道，那一家对你冷多少 */
export const BORROW_ATTITUDE = 8;
/** 肯不肯借道的那条线。比这个低就是不肯 */
export const BORROW_MIN_ATTITUDE = -20;

/**
 * 途经的每一程要折多少人（千分数）。
 *
 * 只算**中途**那几程 —— 第一程是从自家城出发，不折；
 * 之后每落一次脚，散一批人。
 */
export const WASTE_PER_LEG = 40;
/** 走别人的地界，另外再折这么多。人家不给你安顿，也不给你补给 */
export const WASTE_BORROWED = 25;
/** 走一趟最多折成什么样。再远也留一半 —— 剩下的由口粮去收拾 */
export const WASTE_MAX = 500;

export type Pass =
  /** 自家地界 */
  | 'own'
  /** 得跟人家借 */
  | 'borrow'
  /** 借不着 */
  | 'no';

/**
 * 从这一家的地界上过得去吗。
 *
 * 正在交兵的当然过不去 —— 那不叫借道，那叫送上门。
 * 流寇没有可以谈的人。
 */
export function passageOf(
  state: WorldState, mine: FactionId, through: FactionId,
): Pass {
  if (through === mine) return 'own';
  if (through === 'bandit') return 'no';
  if (atWar(state, mine, through)) return 'no';
  const att = state.factions[through]?.attitude[mine] ?? 0;
  return att >= BORROW_MIN_ATTITUDE ? 'borrow' : 'no';
}

// ─────────────────────────────────────────────────────────────
// 找路
// ─────────────────────────────────────────────────────────────

export interface MarchPlan {
  /** 整条路，含起点，末一个是目标 */
  path: NodeId[];
  /** 大约要走多少天 */
  days: number;
  /** 走完全程一共要折多少人（千分数）。界面上说的是这个数 */
  wastePermille: number;
  /** 摊到中途每一次落脚上是多少（千分数）。军队身上带的是这个数 */
  legWaste: number;
  /** 要向这几家借道 */
  borrow: FactionId[];
  /** 挡在半路上的那一家。有它就说明这条路走不通 */
  refused: FactionId | null;
}

/** 一程路要走几天 */
function legDays(idx: ContentIndex, a: NodeId, b: NodeId): number {
  const len = idx.roadLength.get(roadKey(a, b)) ?? 12;
  const per = Math.max(40, Math.floor((MARCH_PER_DAY * 12) / len));
  return Math.max(1, Math.ceil(1000 / per));
}

/**
 * 从 fromId 打到 toId，这一路怎么走。
 *
 * 用 Dijkstra 找**最省日子**的一条，但给别人的地界加一层权重 ——
 * 同样远近，宁可走自家的地。
 *
 * 走得通就 `refused === null`；走不通也照样返回一条路，
 * 并指出是谁挡着 —— 界面上要说得出「袁绍不肯借道」，
 * 而不是一句干巴巴的「过不去」。
 */
export function planMarch(
  state: WorldState, idx: ContentIndex,
  fromId: NodeId, toId: NodeId, factionId: FactionId,
): MarchPlan | null {
  if (fromId === toId) return null;
  if (!state.nodes[fromId] || !state.nodes[toId]) return null;

  // 代价 = 日子，别人的地界另加一笔「不情愿」
  const cost = new Map<NodeId, number>([[fromId, 0]]);
  const prev = new Map<NodeId, NodeId>();
  const done = new Set<NodeId>();

  for (;;) {
    let cur: NodeId | null = null;
    let best = Infinity;
    // 城池不过百来座，线性挑最小的就够 —— 不值得为它引一个堆进来
    for (const [id, c] of [...cost].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (done.has(id) || c >= best) continue;
      best = c; cur = id;
    }
    if (cur === null) break;
    if (cur === toId) break;
    done.add(cur);

    for (const next of (idx.node.get(cur)?.links ?? []).slice().sort()) {
      const node = state.nodes[next];
      if (!node || done.has(next)) continue;
      // 目标本身不论归属，那是要打的地方，不是要借的道
      let extra = 0;
      if (next !== toId) {
        const pass = passageOf(state, factionId, node.factionId);
        if (pass === 'no') extra = 400;        // 走不通，但仍留在图里，好指出是谁挡的
        else if (pass === 'borrow') extra = 3; // 借得到，只是绕着走更划算
      }
      const c = best + legDays(idx, cur, next) + extra;
      if (c < (cost.get(next) ?? Infinity)) { cost.set(next, c); prev.set(next, cur); }
    }
  }

  if (!cost.has(toId)) return null;

  const path: NodeId[] = [toId];
  for (let at = toId; prev.has(at);) { at = prev.get(at)!; path.unshift(at); }
  if (path.length < 2) return null;

  let days = 0;
  let borrowed = 0;
  const borrow: FactionId[] = [];
  let refused: FactionId | null = null;

  for (let i = 1; i < path.length; i++) {
    days += legDays(idx, path[i - 1]!, path[i]!);
    if (i === path.length - 1) break; // 末一程的落点是目标
    const owner = state.nodes[path[i]!]!.factionId;
    const pass = passageOf(state, factionId, owner);
    if (pass === 'no') { if (!refused) refused = owner; continue; }
    if (pass === 'borrow') {
      borrowed++;
      if (!borrow.includes(owner)) borrow.push(owner);
    }
  }

  const mid = path.length - 2; // 中途落脚几次
  const waste = Math.min(
    WASTE_MAX, mid * WASTE_PER_LEG + borrowed * WASTE_BORROWED,
  );

  return {
    path, days,
    wastePermille: Math.max(0, waste),
    legWaste: mid > 0 ? Math.round(waste / mid) : 0,
    borrow, refused,
  };
}

/**
 * 借道的那一笔账当场就付。
 *
 * **过境是要打招呼的，而打过招呼那一家就记着你。**
 * 一次不算什么，走顺了手一年借三回，人家对你的态度就见底了 ——
 * 于是下一回他不肯借了。远征的路会自己关上，这是对的。
 */
export function payBorrow(
  state: WorldState, mine: FactionId, borrow: readonly FactionId[],
): void {
  for (const f of borrow) {
    const fs = state.factions[f];
    if (!fs) continue;
    fs.attitude[mine] = Math.max(-100, (fs.attitude[mine] ?? 0) - BORROW_ATTITUDE);
  }
}

/** 出兵至少要带够走完全程的口粮，不然人还没到就散了 */
export function supplyFor(troops: number, days: number): number {
  return Math.round(troops * 0.055 * Math.max(6, days) * 1.3) + 150;
}
