/**
 * 挟天子 —— 主公手里唯一一根能拧动整张图的杠杆。
 *
 * ── 它为什么值得单开一层 ────────────────────────────
 *
 * 主公别的动作都只动一座城：拨一次粮、派一个人、发一支兵。
 * 诏书不一样 —— **一道诏下去，动的是别人的兵。**
 *
 * 而且它是全局**唯一一个让进攻行为涨望**的开关：
 * 平时你打谁都是「无故兴兵」，要折望；
 * 打一个抗诏不从的人，那叫奉诏讨逆，打赢了望还涨。
 * 那句「挟天子以令诸侯」的分量，全在这一句话上。
 *
 * ── 代价必须够重 ────────────────────────────────────
 *
 * 天子在你城里是一个麻烦，不是一件宝贝：
 *
 *   一、**每年要供养。** 行在的排场不是白摆的。
 *   二、**帐下重义的人跟你离心。** 他忠的是汉，不是你。
 *   三、**衣带诏。** 某一年会有人告发某某与天子密谋 ——
 *      杀、查、还是不理，三条路都不好走。
 *
 * 还有一条软的：诏书**下多了就不灵**。一年两道之内还有人听，
 * 第三道第四道下去，天下就知道那玩意儿是你写的了。
 */
import { chance, nextInt } from './rng.ts';
import type { ContentIndex } from './content.ts';
import type { WorldState } from './state.ts';
import type { Command, CommandResult, SimEvent } from './commands.ts';
import { dayToDate, DAYS_PER_YEAR } from './time.ts';
import { addDeed, bumpHeart, bumpRenown, ownPeople, tally } from './court.ts';
import type { EdictKind } from './lord_types.ts';
import {
  EDICT_PER_YEAR, EDICT_NAME, EMPEROR_UPKEEP,
} from './lord_types.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function ok(...events: SimEvent[]): CommandResult {
  return { ok: true, events };
}
function reject(cmd: Command['t'], reasonId: string): CommandResult {
  return { ok: false, events: [{ t: 'rejected', cmd, reasonId }] };
}

// ─────────────────────────────────────────────────────────────
// 迎天子
// ─────────────────────────────────────────────────────────────

/** 天子到了你这儿。由「天子东归」那件时局的「奉迎」触发 */
export function receiveEmperor(state: WorldState, idx: ContentIndex): void {
  const court = state.court;
  if (!court || court.emperor) return;
  court.emperor = true;
  court.edictYear = -1;
  court.edictCount = 0;
  tally(court, 'emperor');
  addDeed(state, 'deed.emperor', {}, 'good');

  /**
   * 帐下重义的人当场就凉了一半。
   *
   * **他忠的是汉，不是你。** 你把天子接进自己的城，
   * 在他眼里那不是尊王，是挟持。
   */
  for (const p of ownPeople(state, idx)) {
    if (p.loyalty >= 88) bumpHeart(state, p.id, -14);
  }
}

// ─────────────────────────────────────────────────────────────
// 下诏
// ─────────────────────────────────────────────────────────────

/**
 * 这一道诏还剩几分力气。
 *
 * 一年头两道还像回事，之后一道不如一道 ——
 * **诏书下多了，天下就知道那玩意儿是你写的了。**
 */
export function edictWeight(state: WorldState): number {
  const court = state.court;
  if (!court) return 0;
  const { year } = dayToDate(state.day);
  const used = court.edictYear === year ? court.edictCount : 0;
  if (used >= EDICT_PER_YEAR + 2) return 0;
  return Math.max(0.25, 1 - used * 0.32);
}

/**
 * 那一家会不会从。
 *
 * 看三样：他离你远近（弱的怕你）、他对你什么态度、以及你有多少望。
 * **诏书本身不带兵** —— 它只是给了肯听的人一个台阶。
 */
function willObey(
  state: WorldState, idx: ContentIndex, to: string, kind: EdictKind,
): boolean {
  const court = state.court!;
  const mine = Object.values(state.nodes)
    .filter((n) => n.factionId === state.official.lordId).length;
  const theirs = Object.values(state.nodes)
    .filter((n) => n.factionId === to).length;
  const att = state.factions[to]?.attitude[state.official.lordId] ?? 0;

  let p = 22;
  p += (mine - theirs) * 6;             // 你比他大多少
  p += att * 0.35;                      // 他跟你交不交好
  p += (court.renown - 45) * 0.5;       // 你的名分值几分
  p *= edictWeight(state);
  // 让地是要人割肉的，几乎没人肯
  if (kind === 'yield') p *= 0.25;
  if (kind === 'disband') p *= 0.9;
  // 好战的人不吃这一套
  p -= (idx.faction.get(to)?.aggression ?? 40) * 0.12;

  return chance(state.rng, clamp(Math.round(p), 2, 88));
}

export function cmdLordEdict(
  state: WorldState, cmd: Extract<Command, { t: 'lord_edict' }>, idx: ContentIndex,
): CommandResult {
  if (state.role !== 'lord') return reject('lord_edict', 'not_lord');
  if (state.ending) return reject('lord_edict', 'game_over');
  const court = state.court;
  if (!court) return reject('lord_edict', 'no_court');
  if (!court.emperor) return reject('lord_edict', 'no_emperor');
  if (cmd.to === state.official.lordId) return reject('lord_edict', 'same_place');
  if (!state.factions[cmd.to]) return reject('lord_edict', 'no_such_place');
  const alive = Object.values(state.nodes).some((n) => n.factionId === cmd.to);
  if (!alive) return reject('lord_edict', 'not_ours');
  if (edictWeight(state) <= 0) return reject('lord_edict', 'edict_spent');

  const { year } = dayToDate(state.day);
  if (court.edictYear !== year) { court.edictYear = year; court.edictCount = 0; }
  court.edictCount += 1;
  tally(court, 'edict');
  tally(court, 'edict.' + cmd.kind);

  const obey = willObey(state, idx, cmd.to, cmd.kind);
  const name = idx.faction.get(cmd.to)?.name ?? cmd.to;
  const events: SimEvent[] = [];

  if (obey) {
    applyObey(state, idx, cmd.to, cmd.kind, events);
    // 从了诏的人心里未必舒服
    const fs = state.factions[cmd.to];
    if (fs) {
      fs.attitude[state.official.lordId] =
        clamp((fs.attitude[state.official.lordId] ?? 0) - 8, -100, 100);
    }
    tally(court, 'edict.obeyed');
    addDeed(state, 'deed.edict_obeyed', { who: name, what: EDICT_NAME[cmd.kind] }, 'good');
  } else {
    /**
     * 抗诏。
     *
     * **这才是下诏真正的用处。**
     * 从了固然好，不从的那一家从此背着一个「逆」字 ——
     * 你打他名正言顺，打赢望还涨（见 `isDefiant`）。
     * 所以「让地」这种明知没人肯从的诏，反而是拿来立名目的。
     */
    if (!court.defiant.includes(cmd.to)) court.defiant.push(cmd.to);
    const fs = state.factions[cmd.to];
    if (fs) {
      fs.attitude[state.official.lordId] =
        clamp((fs.attitude[state.official.lordId] ?? 0) - 16, -100, 100);
    }
    // 天下看着：抗诏的那一家名声要掉
    for (const other of Object.keys(state.factions)) {
      if (other === cmd.to) continue;
      const of_ = state.factions[other];
      if (of_) {
        of_.attitude[cmd.to] = clamp((of_.attitude[cmd.to] ?? 0) - 10, -100, 100);
      }
    }
    tally(court, 'edict.defied');
    addDeed(state, 'deed.edict_defied', { who: name, what: EDICT_NAME[cmd.kind] }, 'plain');
  }

  events.push({ t: 'edict_sent', to: cmd.to, kind: cmd.kind, obeyed: obey });
  return ok(...events);
}

function applyObey(
  state: WorldState, idx: ContentIndex, to: string, kind: EdictKind, events: SimEvent[],
): void {
  const me = state.official.lordId;
  const theirs = Object.values(state.nodes)
    .filter((n) => n.factionId === to)
    .sort((a, b) => a.id.localeCompare(b.id));

  if (kind === 'disband') {
    // 罢兵：他围着的城都撤围，路上扑向你的兵也掉头
    for (const [cityId, sg] of Object.entries(state.sieges)) {
      if (sg.factionId !== to) continue;
      delete state.sieges[cityId];
      const n = state.nodes[cityId];
      if (n) n.lastSiegeDay = state.day;
      events.push({ t: 'siege_lifted', cityId, factionId: to, taken: false });
    }
    for (const a of Object.values(state.armies)) {
      if (a.factionId === to && a.intent === 'attack') a.intent = 'reinforce';
    }
    const fs = state.factions[to];
    if (fs) fs.cooldown = Math.max(fs.cooldown, 150);
    return;
  }

  if (kind === 'tribute') {
    // 输粮：他各城凑一份，粮车真的往你治所走
    let sum = 0;
    for (const n of theirs) {
      const give = Math.floor(n.grain * 0.22);
      if (give < 40) continue;
      n.grain -= give;
      sum += give;
    }
    const seat = state.nodes[state.official.cityId];
    if (seat && sum > 0) seat.grain += sum;
    events.push({ t: 'notice', textId: 'notice.edict_tribute', vars: { grain: sum }, tone: 'good' });
    return;
  }

  if (kind === 'yield') {
    // 让地：交出最小的一座城
    const give = [...theirs].sort((a, b) =>
      (idx.node.get(a.id)?.scale ?? 1) - (idx.node.get(b.id)?.scale ?? 1))[0];
    if (!give || theirs.length <= 1) return;
    give.factionId = me;
    give.takenDay = state.day;
    give.unrest = Math.min(70, give.unrest + 30);
    delete state.posts[give.id];
    events.push({ t: 'city_fell', cityId: give.id, from: to, to: me });
    return;
  }

  // 讨逆：天下一齐视他为逆
  for (const other of Object.keys(state.factions)) {
    if (other === to) continue;
    const of_ = state.factions[other];
    if (of_) of_.attitude[to] = clamp((of_.attitude[to] ?? 0) - 24, -100, 100);
  }
}

/**
 * 这一家是不是抗过诏的。
 *
 * **打他就是奉诏讨逆** —— 全局唯一一处让进攻涨望的地方，
 * 而且天下不会因此忌惮你（跳过 diplomacy 里那条「强邻可畏」）。
 */
export function isDefiant(state: WorldState, factionId: string): boolean {
  return state.court?.defiant.includes(factionId) ?? false;
}

// ─────────────────────────────────────────────────────────────
// 天子在你城里的日子
// ─────────────────────────────────────────────────────────────

/**
 * 每年一次的账。
 *
 * 供养、离心、以及某一年会来的那一道衣带诏。
 */
export function tickEmperor(state: WorldState, idx: ContentIndex): SimEvent[] {
  const court = state.court;
  if (!court?.emperor || state.ending) return [];
  const events: SimEvent[] = [];

  // 供养。行在的排场不是白摆的
  if (state.day % DAYS_PER_YEAR === 0) {
    const seat = state.nodes[state.official.cityId];
    if (seat) seat.grain = Math.max(0, seat.grain - EMPEROR_UPKEEP);
  }
  // 忠汉的人一季凉一点
  if (state.day % 90 === 0) {
    for (const p of ownPeople(state, idx)) {
      if (p.loyalty >= 88) bumpHeart(state, p.id, -1);
    }
  }

  /**
   * 衣带诏。
   *
   * 每年抽一回。查、杀、还是不理 —— 三条路都不好走，
   * 而且**没有正确答案**。这正是它该有的样子。
   */
  if (state.day % DAYS_PER_YEAR === 120 && !court.plotDay && chance(state.rng, 22)) {
    const suspects = ownPeople(state, idx).filter((p) => p.loyalty >= 85);
    const who = suspects[nextInt(state.rng, Math.max(1, suspects.length))];
    if (who) {
      court.plotDay = state.day;
      court.plotWho = who.id;
      events.push({ t: 'plot_found', personId: who.id, name: who.name });
    }
  }
  return events;
}

/**
 * 衣带诏怎么办。
 *
 *   杀 —— 一了百了，但望崩、帐下集体寒心
 *   查 —— 花时间，可能查错人，得罪一整派
 *   不理 —— 什么也不付，但那件事不会自己过去
 */
export function cmdPlot(
  state: WorldState, cmd: Extract<Command, { t: 'lord_plot' }>, idx: ContentIndex,
): CommandResult {
  const court = state.court;
  if (state.role !== 'lord' || !court) return reject('lord_plot', 'not_lord');
  if (!court.plotWho) return reject('lord_plot', 'no_plot');
  const who = idx.person.get(court.plotWho);
  const name = who?.name ?? '';

  if (cmd.how === 'kill') {
    court.gone.push(court.plotWho);
    delete court.heart[court.plotWho];
    for (const [city, pid] of Object.entries(state.posts)) {
      if (pid === court.plotWho) delete state.posts[city];
    }
    bumpRenown(state, -18);
    for (const p of ownPeople(state, idx)) bumpHeart(state, p.id, -7);
    tally(court, 'plot.kill');
    addDeed(state, 'deed.plot_kill', { name }, 'bad');
  } else if (cmd.how === 'probe') {
    // 查。多半查不出什么，而被查的那个从此记着你
    bumpHeart(state, court.plotWho, -16);
    for (const p of ownPeople(state, idx)) {
      if (p.loyalty >= 85) bumpHeart(state, p.id, -3);
    }
    bumpRenown(state, -4);
    tally(court, 'plot.probe');
    addDeed(state, 'deed.plot_probe', { name }, 'plain');
  } else {
    /**
     * 不理。
     *
     * 眼下什么也不付 —— 但**那件事不会自己过去**：
     * 天子还在你城里，那个人还在你帐下，
     * 而下一次告发只会来得更急。
     */
    bumpRenown(state, 3);
    court.plotIgnored += 1;
    /**
     * 装第二次看不见，那件事就自己爆了。
     *
     * **爆完要清零** —— 原先这个计数从不归零，于是第二次之后
     * 每一回「不问」都再爆一次，一局下来爆四五回，
     * 城城离心、忠汉的人凉透。那不是「后果」，那是复利。
     * 一桩案子发过了就是发过了，下一桩重新算。
     */
    if (court.plotIgnored >= 2) {
      // 第二次装看不见，就真的出事了
      const node = state.nodes[
        Object.entries(state.posts).find(([, p]) => p === court.plotWho)?.[0] ?? ''
      ];
      if (node) node.unrest = Math.min(90, node.unrest + 34);
      for (const p of ownPeople(state, idx)) {
        if (p.loyalty >= 88) bumpHeart(state, p.id, -8);
      }
      addDeed(state, 'deed.plot_burst', { name }, 'bad');
      court.plotIgnored = 0;
    }
    tally(court, 'plot.ignore');
  }

  court.plotWho = null;
  court.plotDay = 0;
  return ok({ t: 'plot_settled', how: cmd.how });
}
