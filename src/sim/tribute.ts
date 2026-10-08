/**
 * 上计与考课 —— 太仓的进项，和帐下人的升贬。
 *
 * ── 这个文件在补哪两个窟窿 ──────────────────────────
 *
 * **一、主公的太仓原先没有进项。**
 *
 * 治所自己那点日产，要供全境的告急、兴修、募兵、立营、修驿、
 * 遣使、养天子 —— 于是玩家看到的永远是「粮不够」，
 * 而他找不到任何一个可以去挣粮的动作。
 *
 * 可这件事在另一条线上早就写好了：当文官的时候，
 * 你每季要给主公缴一笔粮（见 `issueQuota`）。那笔粮进了谁的仓？
 * **进的正是这里。** 三条线跑同一套逻辑 ——
 * 所以当主公的时候，各城的守官也一样，季末把余粮解到治所。
 *
 * **二、帐下的人一辈子是同一个头衔。**
 *
 * 当文官有功绩、有升迁；当武将有军功、有品秩。
 * 只有当主公的时候，替你连下三城的人和丢了两座城的人待遇一样 ——
 * 「用人」这件事只剩下派去哪座城，没有别的分量。
 *
 * 现在他们跑的是和玩家同一套账。而且升要你点头，**贬不用** ——
 * 办砸了自己就掉下去，那是考课，不是恩典。
 */
import type { ContentIndex, PersonDef } from './content.ts';
import type { WorldState } from './state.ts';
import type { SimEvent } from './commands.ts';
import { civilPermille, isMartial, wardenOf } from './people.ts';
import { addDeed, bumpHeart, heartPermille, ownPeople } from './court.ts';
import {
  CIVIL_RANKS, MARTIAL_RANKS, MERIT_AFTER_DEMOTE, MERIT_BAD_MORALE,
  MERIT_DEMOTE, MERIT_DISMISS, MERIT_PER_TRIBUTE, RANK_MERIT,
  TRIBUTE_KEEP_BASE, TRIBUTE_KEEP_PER_TROOP, TRIBUTE_SHARE,
  rankPermille,
} from './lord_types.ts';

// ─────────────────────────────────────────────────────────────
// 品秩
// ─────────────────────────────────────────────────────────────

/** 这个人现在是第几秩 */
export function rankOf(state: WorldState, personId: string): number {
  return state.court?.rank[personId] ?? 0;
}

/** 他这个位子叫什么 */
export function rankName(state: WorldState, who: PersonDef): string {
  return titleAt(who, rankOf(state, who.id));
}

/** 再升一级叫什么。到顶了就还是原来那个 */
export function nextRankName(state: WorldState, who: PersonDef): string {
  return titleAt(who, rankOf(state, who.id) + 1);
}

/** 文官走文官那一列，武将走武将那一列 —— 分职分到名号上 */
function titleAt(who: PersonDef, rank: number): string {
  const list = isMartial(who) ? MARTIAL_RANKS : CIVIL_RANKS;
  return list[Math.max(0, Math.min(list.length - 1, rank))] ?? list[0]!;
}

/**
 * 他这个位子顶多少事（千分数，一为轴）。
 *
 * **这是品秩唯一的出口** —— 不新开公式，只乘在三个现成的地方：
 * 守备、文治、以及一座营养得起多少人。
 */
export function rankBoost(state: WorldState, personId: string | null): number {
  if (!personId) return 1000;
  return rankPermille(rankOf(state, personId));
}

/** 攒功。折功也走这里（传负数） */
export function bumpMerit(state: WorldState, personId: string, delta: number): void {
  const court = state.court;
  if (!court) return;
  court.merit[personId] = (court.merit[personId] ?? 0) + delta;
}

/** 攒够了没有 —— 够了才会有人替他上叙功那道表 */
export function readyToRise(state: WorldState, personId: string): boolean {
  const court = state.court;
  if (!court) return false;
  const rank = rankOf(state, personId);
  const need = RANK_MERIT[rank + 1];
  if (need === undefined) return false;
  return (court.merit[personId] ?? 0) >= need;
}

/** 升一秩。功清零重算，心气大涨 —— 名位是最便宜的赏赐 */
export function promote(state: WorldState, idx: ContentIndex, personId: string): void {
  const court = state.court;
  if (!court) return;
  const rank = Math.min(4, rankOf(state, personId) + 1);
  court.rank[personId] = rank;
  court.merit[personId] = 0;
  bumpHeart(state, personId, 12);
  court.tally['rank.up'] = (court.tally['rank.up'] ?? 0) + 1;
  const who = idx.person.get(personId);
  if (who) {
    addDeed(state, 'deed.promote', { name: who.name, rank: rankName(state, who) }, 'good');
  }
}

/**
 * 考课。
 *
 * **贬不用你点头。** 一年年办砸下去，位子自己就没了 ——
 * 这一条要是也做成呈报，主公就成了一个只会说「准」的人。
 *
 * 免官的人不是走了，是**成了闲人**：他还在你帐下，
 * 只是那座城空了出来 —— 于是案头会摞上一件「无人主事」。
 * 这条线上所有的东西最后都会流回案头，这是对的。
 */
export function assess(state: WorldState, idx: ContentIndex): SimEvent[] {
  const court = state.court;
  if (!court) return [];
  const events: SimEvent[] = [];

  for (const p of ownPeople(state, idx)) {
    const m = court.merit[p.id] ?? 0;
    if (m > MERIT_DEMOTE) continue;
    const rank = rankOf(state, p.id);

    if (rank > 0) {
      court.rank[p.id] = rank - 1;
      court.merit[p.id] = MERIT_AFTER_DEMOTE;
      bumpHeart(state, p.id, -10);
      addDeed(state, 'deed.demote', { name: p.name, rank: rankName(state, p) }, 'bad');
      court.tally['rank.down'] = (court.tally['rank.down'] ?? 0) + 1;
      events.push({
        t: 'rank_changed', personId: p.id, name: p.name,
        rank: rank - 1, title: rankName(state, p), up: false,
      });
      continue;
    }

    if (m <= MERIT_DISMISS) {
      // 已经在最低一秩还往下折 —— 免官。城就此空了出来
      let where: string | null = null;
      for (const [city, pid] of Object.entries(state.posts)) {
        if (pid === p.id) { where = city; delete state.posts[city]; }
      }
      for (const [cid, camp] of Object.entries(court.camps)) {
        if (camp.officerId === p.id) {
          const node = state.nodes[camp.cityId];
          if (node) node.troops += camp.troops;
          delete court.camps[cid];
          where = where ?? camp.cityId;
        }
      }
      court.merit[p.id] = 0;
      bumpHeart(state, p.id, -14);
      addDeed(state, 'deed.dismiss', { name: p.name }, 'bad');
      court.tally['rank.dismiss'] = (court.tally['rank.dismiss'] ?? 0) + 1;
      events.push({
        t: 'rank_changed', personId: p.id, name: p.name,
        rank: -1, title: '免官', up: false,
      });
      void where;
    }
  }
  return events;
}

// ─────────────────────────────────────────────────────────────
// 上计
// ─────────────────────────────────────────────────────────────

export interface TributeLine {
  cityId: string;
  personId: string | null;
  grain: number;
  /** 一句话说明为什么是这个数 */
  why: string;
}

/**
 * 这一季各城该解上来多少 —— **纯函数，界面直接拿它去画那张账。**
 *
 * 一座城要留下自己吃的（守军的口粮加一个底数），
 * 余下的解走一半多一点。而那个数上还乘着三样东西：
 *
 *   **文治** —— 派个纯武人去守，墙是牢的，账是糊涂的
 *   **心气** —— 一个心气跌到底的太守，账照做，解上来的一年比一年少
 *   **品秩** —— 一个太守办得动的事，比一个县丞多
 *
 * 无人主事的城一粒也解不上来。被围的城送不出来。
 */
export function tributeDue(state: WorldState, idx: ContentIndex): TributeLine[] {
  const lines: TributeLine[] = [];
  const seat = state.official.cityId;

  for (const id of Object.keys(state.nodes).sort()) {
    const node = state.nodes[id]!;
    if (node.factionId !== state.official.lordId) continue;
    if (id === seat) continue; // 治所自己就是太仓
    const who = wardenOf(state, idx, id);
    if (!who) { lines.push({ cityId: id, personId: null, grain: 0, why: '无人主事' }); continue; }
    if (state.sieges[id]) {
      lines.push({ cityId: id, personId: who.id, grain: 0, why: '正被围，运不出来' });
      continue;
    }
    const keep = TRIBUTE_KEEP_BASE + node.troops * TRIBUTE_KEEP_PER_TROOP;
    const spare = node.grain - keep;
    if (spare <= 0) {
      lines.push({ cityId: id, personId: who.id, grain: 0, why: '城中自给尚且不足' });
      continue;
    }
    const factor = (civilPermille(who) * heartPermille(state, who.id)
      * rankBoost(state, who.id)) / 1_000_000;
    const grain = Math.max(0, Math.floor((spare * TRIBUTE_SHARE * factor) / 100 / 1000));
    lines.push({
      cityId: id, personId: who.id, grain,
      why: heartPermille(state, who.id) < 960 ? '心不在此，解得不足'
        : civilPermille(who) >= 1100 ? '文治明练，账目齐整'
          : civilPermille(who) <= 940 ? '武人守之，账是糊涂的' : '',
    });
  }
  return lines;
}

/**
 * 季末，粮真的进太仓。
 *
 * **不走图上的粮车。** 上计本来就是一年一次、按郡整批解送的账，
 * 拆成十几支粮车在图上爬，屏幕上只会多十几个没人看的小点。
 * （而告急的那种拨粮是走图的 —— 那一笔是有去向、会被截的。）
 */
export function collectTribute(state: WorldState, idx: ContentIndex): SimEvent[] {
  const court = state.court;
  if (!court) return [];
  const seat = state.nodes[state.official.cityId];
  if (!seat || seat.factionId !== state.official.lordId) return [];

  let sum = 0;
  let bare = 0;
  for (const line of tributeDue(state, idx)) {
    if (!line.personId) { bare++; continue; }
    const node = state.nodes[line.cityId];
    if (!node || line.grain <= 0) continue;
    node.grain -= line.grain;
    seat.grain += line.grain;
    sum += line.grain;
    // 解得上来就是政绩。这是文官那条线上「完成指标」的同一笔账
    bumpMerit(state, line.personId, Math.floor(line.grain / MERIT_PER_TRIBUTE));
    if (node.morale < 30) bumpMerit(state, line.personId, MERIT_BAD_MORALE);
  }

  court.tally['tribute'] = (court.tally['tribute'] ?? 0) + sum;
  court.tally['tribute.times'] = (court.tally['tribute.times'] ?? 0) + 1;
  court.tally['tribute.bare'] = (court.tally['tribute.bare'] ?? 0) + bare;
  return [{
    t: 'tribute_collected', grain: sum, bare,
  }];
}
