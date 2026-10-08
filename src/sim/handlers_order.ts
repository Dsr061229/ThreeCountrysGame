/**
 * 军令的发、接、办、拒。
 *
 * 命令是从**天下图的实况**里长出来的：
 * 他让你救的城，是真的正被围着；他让你打的城，是真的挨着你。
 * 这一条要紧 —— 随口指一座城的命令，玩家一眼就看出是任务栏。
 */
import { chancePermille, nextInt } from './rng.ts';
import type { ContentIndex } from './content.ts';
import type { WorldState } from './state.ts';
import type { Command, CommandResult, SimEvent } from './commands.ts';
import { mintId } from './state.ts';
import {
  MERIT_TO_PROMOTE_MIL, MILITARY_RANKS, STARTING_CAMP,
} from './general_types.ts';
import { rationCapOf } from './camp.ts';
import { atWar } from './diplomacy.ts';
import {
  DISMISS_AFTER_DAYS, ORDER_DAYS, ORDER_DEFY_TRUST, ORDER_EVERY, ORDER_FAIL_TRUST,
  ORDER_FIRST, ORDER_MERIT, ORDER_TRUST, TRUST_DANGER,
  type LordOrder, type OrderKind,
} from './order_types.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function ok(...events: SimEvent[]): CommandResult {
  return { ok: true, events };
}
function reject(cmd: Command['t'], reasonId: string): CommandResult {
  return { ok: false, events: [{ t: 'rejected', cmd, reasonId }] };
}

/**
 * 该不该来一道新令。
 *
 * 隔些日子来一道 —— 但**自家的城被围了**是要紧事，那就立刻来。
 * 主公不会等到下一个周期才想起有座城快丢了。
 */
export function maybeOrder(state: WorldState, idx: ContentIndex): SimEvent[] {
  if (state.role !== 'general' || state.ending) return [];
  if (state.order && state.order.outcome === 'pending') return [];

  const camp = state.camps[STARTING_CAMP];
  if (!camp) return [];

  // 自家的城被围 —— 这一条压过周期
  const besieged = Object.keys(state.sieges).find(
    (id) => state.nodes[id]?.factionId === state.official.lordId,
  );

  const due = state.flags['nextOrder'] ?? ORDER_FIRST;
  if (!besieged && state.day < due) return [];
  state.flags['nextOrder'] = state.day + ORDER_EVERY;

  const order = pickOrder(state, idx, besieged);
  if (!order) return [];
  state.order = order;
  return [{
    t: 'order_issued',
    kind: order.kind,
    targetNodeId: order.targetNodeId,
    amount: order.amount,
    dueDay: order.dueDay,
  }];
}

function pickOrder(
  state: WorldState, idx: ContentIndex, besieged: string | undefined,
): LordOrder | null {
  const camp = state.camps[STARTING_CAMP]!;
  const base = {
    id: mintId(state, 'ord'),
    issuedDay: state.day,
    dueDay: state.day + ORDER_DAYS,
    outcome: 'pending' as const,
    accepted: false,
    amount: 0,
  };

  // 一、有城被围，先救城
  if (besieged) {
    return { ...base, kind: 'relieve', targetNodeId: besieged };
  }

  // 二、挑一座**挨着你**的敌城去打。远在天边的城不该出现在命令里
  const here = idx.node.get(camp.nodeId);
  if (here) {
    const near = Object.values(state.nodes)
      .filter((n) => n.factionId !== state.official.lordId)
      .map((n) => {
        const def = idx.node.get(n.id);
        return {
          id: n.id,
          d: def
            ? Math.hypot(def.at[0] - here.at[0], def.at[1] - here.at[1])
            : Infinity,
        };
      })
      .filter((x) => x.d < 34)
      /**
       * 近的先打，**但结了仇的更先打**。
       *
       * 天下的恩怨现在是会变的（见 diplomacy.ts）——
       * 主公让你去打的，该是他真正记恨的那一家，
       * 而不是单纯离得最近的那座城。
       */
      .sort((a, b) => {
        const wa = atWar(state, state.official.lordId, state.nodes[a.id]?.factionId ?? '');
        const wb = atWar(state, state.official.lordId, state.nodes[b.id]?.factionId ?? '');
        if (wa !== wb) return wa ? -1 : 1;
        return a.d - b.d;
      });
    if (near.length > 0 && chancePermille(state.rng, 620)) {
      const pick = near[nextInt(state.rng, Math.min(3, near.length))]!;
      return { ...base, kind: 'assault', targetNodeId: pick.id };
    }
  }

  // 三、没仗可打的时候，主公要粮
  const want = Math.max(200, Math.round(camp.grain * 0.35));
  if (camp.grain > 400) {
    return { ...base, kind: 'tribute', targetNodeId: null, amount: want };
  }

  // 四、实在没事，就让你守着
  return { ...base, kind: 'garrison', targetNodeId: null };
}

/** 接令。接了才算数 */
export function cmdOrderAccept(state: WorldState): CommandResult {
  const o = state.order;
  if (!o || o.outcome !== 'pending') return reject('order_accept', 'no_order');
  if (o.accepted) return reject('order_accept', 'already');
  o.accepted = true;
  return ok({ t: 'order_accepted' });
}

/**
 * 抗命。
 *
 * 「将在外，君命有所不受」—— 这句话必须是一个**真的选项**，
 * 所以抗命不当场出局，只掉信任。
 * 但信任是你的粮饷、你的兵额、你的前程，
 * 一次次不听话，最后一纸调令就把你撤了。
 */
export function cmdOrderDefy(state: WorldState): CommandResult {
  const o = state.order;
  if (!o || o.outcome !== 'pending') return reject('order_defy', 'no_order');
  o.outcome = 'defied';
  state.official.trust = clamp(state.official.trust - ORDER_DEFY_TRUST, 0, 100);
  return ok({ t: 'order_settled', outcome: 'defied', merit: 0 });
}

/** 输粮：当场就办得了 */
export function cmdOrderTribute(state: WorldState): CommandResult {
  const o = state.order;
  if (!o || o.outcome !== 'pending' || o.kind !== 'tribute') {
    return reject('order_tribute', 'no_order');
  }
  const camp = state.camps[STARTING_CAMP];
  if (!camp) return reject('order_tribute', 'no_camp');
  if (camp.grain < o.amount) return reject('order_tribute', 'no_grain');
  camp.grain -= o.amount;
  return ok(...finishOrder(state, true));
}

/** 一道令办完了 */
export function finishOrder(state: WorldState, won: boolean): SimEvent[] {
  const o = state.order;
  if (!o || o.outcome !== 'pending') return [];
  o.outcome = won ? 'done' : 'failed';
  if (won) {
    state.official.merit += ORDER_MERIT;
    state.official.trust = clamp(state.official.trust + ORDER_TRUST, 0, 100);
  } else {
    state.official.trust = clamp(state.official.trust - ORDER_FAIL_TRUST, 0, 100);
  }
  return [{
    t: 'order_settled',
    outcome: won ? 'done' : 'failed',
    merit: won ? ORDER_MERIT : 0,
  }];
}

/**
 * 每日过一遍军令。
 *
 * 到期没办成就算砸了；「按兵」这一道则是熬到期就算办成 ——
 * 它本来就是让你什么都别做。
 */
export function tickOrder(state: WorldState): SimEvent[] {
  const o = state.order;
  const events: SimEvent[] = [];

  if (o && o.outcome === 'pending' && state.day >= o.dueDay) {
    events.push(...finishOrder(state, o.kind === 'garrison' && o.accepted));
  }

  events.push(...checkPromotion(state));

  // 信任见底 —— 主公开始考虑换人
  if (state.official.trust < TRUST_DANGER) {
    const since = state.flags['distrustSince'] ?? state.day;
    state.flags['distrustSince'] = since;
    if (state.day - since >= DISMISS_AFTER_DAYS && !state.ending) {
      state.ending = { kind: 'dismissed', day: state.day };
      events.push({ t: 'game_over', kind: 'dismissed' });
    }
  } else {
    delete state.flags['distrustSince'];
  }

  return events;
}

/**
 * 升迁。
 *
 * **这一段以前根本不存在。**
 *
 * 升迁的代码只写在文官的季度结算里，而武将没有季度结算 ——
 * 所以一个武将无论立多少战功，军职永远是裨将，
 * 份例永远是六百石，帐下永远只坐得下一个人。
 * 「升迁是你军队规模的上限」这条设计链，从头到尾是断的。
 *
 * 玩家的感受就是「发育没什么意思」—— 因为**确实没有**。
 */
export function checkPromotion(state: WorldState): SimEvent[] {
  if (state.role !== 'general') return [];
  const rank = state.official.rank;
  if (rank >= MILITARY_RANKS.length - 1) return [];
  const need = MERIT_TO_PROMOTE_MIL[rank];
  if (need === undefined || state.official.merit < need) return [];

  state.official.rank = rank + 1;
  return [
    { t: 'promoted', rank: state.official.rank },
    {
      t: 'notice',
      textId: 'notice.promoted_mil',
      vars: {
        rank: MILITARY_RANKS[state.official.rank] ?? '',
        ration: rationCapOf(state.official.rank),
      },
      tone: 'good',
    },
  ];
}

/** 打完一仗，看看是不是正好交了差 */
export function orderProgress(state: WorldState, nodeId: string, won: boolean): SimEvent[] {
  const o = state.order;
  if (!o || o.outcome !== 'pending' || !o.accepted) return [];
  if (o.targetNodeId !== nodeId) return [];
  if (o.kind !== 'relieve' && o.kind !== 'assault') return [];
  if (!won) return [];
  return finishOrder(state, true);
}

export type { OrderKind };
