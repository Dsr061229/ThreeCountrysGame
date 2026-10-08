/**
 * 时局 —— 天下同时答一道题。
 *
 * ── 这个文件要解决的那一件事 ────────────────────────
 *
 * 主公这条线一直缺的是**「别人也在做选择」的实感**。
 * 呈报是自家人找你，出兵是你戳地图 ——
 * 那十几家诸侯从头到尾都是背景板上会变色的方块。
 *
 * 时局把他们拉到台前：讨董、天子东归、兴平大饥，
 * 一道题，天下每一家都要答，**而你看得见他们答了什么**。
 *
 * ── 分两批揭晓 ──────────────────────────────────────
 *
 * 这是整套东西的关键，也是它和「随机事件」的分界线：
 *
 *   一、时局降临 → 先亮三四家的底（「袁绍已出兵」「刘表按兵不动」）
 *   二、**轮到你答** —— 你是看着风向做的决定
 *   三、你答完，剩下的跟着揭晓
 *
 * 一次亮完就只是一张公告；分两批，它才是一场博弈。
 *
 * ── 效果只拧现成的旋钮 ──────────────────────────────
 *
 * 望、态度、粮、兵、民心、离心，全是既有的量。
 * 「结盟」也不是一个新系统 —— 是**这件事上大家站了同一边**，
 * 于是彼此的 attitude 一齐往上、对指名那一家一齐往下。
 * 合纵连横本来就该长成这样。
 */
import { chance, nextInt } from './rng.ts';
import type { ContentIndex } from './content.ts';
import type { WorldState } from './state.ts';
import type { SimEvent } from './commands.ts';
import { dayToDate } from './time.ts';
import { addDeed, bumpRenown, tally } from './court.ts';
import { receiveEmperor } from './edict.ts';
import {
  SITUATION_PREVIEW,
  type SituationDef, type SituationEffect, type SituationOption,
} from './lord_types.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 眼下还活着的几家（流寇不算） */
function powers(state: WorldState): string[] {
  const set = new Set<string>();
  for (const n of Object.values(state.nodes)) {
    if (n.factionId !== 'bandit') set.add(n.factionId);
  }
  return [...set].sort();
}

// ─────────────────────────────────────────────────────────────
// 降临
// ─────────────────────────────────────────────────────────────

/**
 * 到日子了没有。
 *
 * 时局按年月降临，**不看玩家的进度** —— 天下的事不等人，
 * 这正是它和「随机事件」最要紧的分别：
 * 随机事件是发生在你身上的，时局是发生在天下的，你只是其中一家。
 */
export function maybeSituation(state: WorldState, idx: ContentIndex): SimEvent[] {
  const court = state.court;
  if (!court || state.ending || court.situation) return [];
  const { year, month } = dayToDate(state.day);

  const due = idx.db.situations?.find(
    (s) => s.year === year && s.month === month && !court.pastSituations.includes(s.id),
  );
  if (!due) return [];

  // 天下各家先在心里定了主意 —— 只是还没都说出口
  const answers: Record<string, string> = {};
  for (const f of powers(state)) {
    if (f === state.official.lordId) continue;
    answers[f] = aiPick(state, idx, due, f);
  }

  /**
   * 先亮谁的底。
   *
   * 挑**地盘最大的那几家** —— 风向本来就是强者定的，
   * 而且玩家最想知道的也正是他们的动向。
   */
  const size = new Map<string, number>();
  for (const n of Object.values(state.nodes)) {
    size.set(n.factionId, (size.get(n.factionId) ?? 0) + 1);
  }
  const revealed = Object.keys(answers)
    .sort((a, b) => (size.get(b) ?? 0) - (size.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, SITUATION_PREVIEW);

  court.situation = {
    id: due.id, day: state.day, dueDay: state.day + due.days,
    answers, revealed, mine: null,
  };
  court.pastSituations.push(due.id);
  tally(court, 'situation');
  return [{ t: 'situation_open', id: due.id }];
}

/**
 * 别家怎么答。
 *
 * 按性子来：好战的爱出兵，治理好的爱守成，望高的爱做面子上的事，
 * 而与被指名那一家结着仇的，多半跟着一起上。
 * **不掷骰子决定一切** —— 掷骰子的话，玩家看那张表就看不出道理。
 */
function aiPick(
  state: WorldState, idx: ContentIndex, def: SituationDef, fid: string,
): string {
  const f = idx.faction.get(fid);
  const agg = f?.aggression ?? 40;
  const gov = f?.governance ?? 40;
  const fame = f?.renown ?? 40;

  /**
   * 各项的权重要**互相够得着**。
   *
   * 头一版「花粮」那一项写成 `(粮/100) × (100-治理) × 0.25` ——
   * 讨董要出五百石，光这一项就是 −62 分，把别的全压死了：
   * 推演里十八家有十六家「观望」，两家出兵。
   * 那张天下表态一览就没什么好看的了 —— **一边倒的表不是博弈，是公告。**
   *
   * 现在每一项都压在十分上下，谁也压不死谁；
   * 真正拉开差距的是性子：好战的爱结盟，治理好的惜民力，名高的顾脸面。
   */
  let best = def.options[0]!;
  let bestScore = -1e9;
  for (const o of def.options) {
    const e = o.effect;
    let score = 0;

    // 共举一事：这本身就有吸引力（讨董时天下多半是要去的），好战的更愿意
    if (e.blocAgainst) {
      score += 12 + (agg - 45) * 0.45;
      const att = state.factions[fid]?.attitude[e.blocAgainst] ?? 0;
      score += -att * 0.35;                      // 跟他有仇就更愿意上
      if (e.blocAgainst === fid) score -= 500;   // 没人会去讨伐自己
    }
    // 望：折望的事名高的不做，涨望的事名高的爱做
    const rn = e.renown ?? 0;
    score += rn < 0 ? rn * (0.5 + fame / 90) : rn * (0.4 + fame / 130);
    // 粮：治理差的更舍不得，但不至于一票否决
    const gr = e.grain ?? 0;
    score += (gr / 200) * (1 + (100 - gov) / 120);

    /**
     * **拿不出来的事，不是不想做，是做不了。**
     *
     * 早先只按「舍不舍得」算，于是「奉迎天子」那一件八家一致点了同一项 ——
     * 谁都想要那个名分，而屏上那张天下表态一览就成了一张公告。
     * 可现实里迎驾是要真的出粮出兵的：家底薄的那几家想都不必想。
     *
     * 这一条同时把表拆开了：**富的去迎，穷的遣使，远的不理** ——
     * 那才叫「别人也在做选择」。
     */
    if (gr < 0) {
      let stock = 0;
      for (const n of Object.values(state.nodes)) if (n.factionId === fid) stock += n.grain;
      if (stock < -gr * 3) score -= 45;
      else if (stock < -gr * 6) score -= 15;
    }

    /**
     * **得罪谁，也是要算的。**
     *
     * 早先完全没算这一项，于是「声讨徐州之屠」九家一致 ——
     * 谁都愿意白捡一句公道话的名声，反正没人怕曹操。
     * 现实里恰恰相反：说这句话之前，先看那家有多大。
     */
    /**
     * 这一项对**自己**是好是坏。
     *
     * 少了这一句，讨董那一局里董卓自己会选「观望」——
     * 因为「附董」在他看来只是给别人加好感。
     * 一个诸侯当然认得出哪一项是站在自己这边的。
     */
    score += (e.attitudeFrom?.[fid] ?? 0) * 0.55;

    for (const [tf, d] of Object.entries(e.attitudeFrom ?? {})) {
      if (d >= 0 || tf === fid) continue;
      let cities = 0;
      for (const n of Object.values(state.nodes)) if (n.factionId === tf) cities += 1;
      score += (d / 10) * (0.6 + cities * 0.22);
    }
    // 白得兵，好战的更想要
    score += ((e.troops ?? 0) / 90) * (1 + agg / 130);
    // 伤民心与添离心，治理好的躲得远
    score += (e.morale ?? 0) * (0.25 + gov / 90);
    score -= (e.unrest ?? 0) * (0.15 + gov / 150);

    /**
     * 一点**认人的**偏性。
     *
     * 用势力 id 掺进去，所以刘表在每一件事上都偏保守、孙坚都偏激进 ——
     * 而不是每次重掷。玩家看那张表要能看出「这像是他会做的事」。
     */
    let h = 0;
    for (let i = 0; i < fid.length; i++) h = (h * 31 + fid.charCodeAt(i)) >>> 0;
    score += ((h + o.id.charCodeAt(0) * 7) % 17) - 8;
    score += nextInt(state.rng, 7) - 3;

    if (score > bestScore) { bestScore = score; best = o; }
  }
  return best.id;
}

// ─────────────────────────────────────────────────────────────
// 表态
// ─────────────────────────────────────────────────────────────

/** 你答了 */
export function answerSituation(
  state: WorldState, idx: ContentIndex, optionId: string,
): SimEvent[] {
  const court = state.court;
  const sit = court?.situation;
  if (!court || !sit || sit.mine) return [];
  const def = idx.db.situations?.find((s) => s.id === sit.id);
  const opt = def?.options.find((o) => o.id === optionId);
  if (!def || !opt) return [];

  sit.mine = optionId;
  sit.answers[state.official.lordId] = optionId;
  // 你答完，剩下的才揭晓
  sit.revealed = Object.keys(sit.answers);
  tally(court, 'situation.' + def.id + '.' + optionId);

  applyEffect(state, idx, opt.effect, state.official.lordId);
  applyBloc(state, sit.answers, def);
  /**
   * 奉迎天子那一项，接的不只是一个望的加成 ——
   * **天子真的住进你的城里**，从此你能下诏，也从此要供养他、
   * 忍着帐下重义的人一年年凉下去。见 `edict.ts`。
   */
  if (def.id === 'donggui' && opt.id === 'greet') receiveEmperor(state, idx);
  addDeed(state, 'sit.deed.' + def.id + '.' + opt.id, {}, 'plain');
  return [{ t: 'situation_answered', id: def.id, option: opt.id }];
}

/**
 * 到期没答。
 *
 * 按**最不出格的那一项**结算 —— 天下不会因为你没吭声就停下来，
 * 而一个什么都不表态的诸侯，在别人眼里就是「观望」。
 */
export function lapseSituation(state: WorldState, idx: ContentIndex): SimEvent[] {
  const court = state.court;
  const sit = court?.situation;
  if (!court || !sit || sit.mine || state.day < sit.dueDay) return [];
  const def = idx.db.situations?.find((s) => s.id === sit.id);
  if (!def) { court.situation = null; return []; }

  // 最保守的一项：望上下最小、不花粮、不结盟的那个
  const mild = [...def.options].sort((a, b) => cost(a) - cost(b))[0]!;
  return answerSituation(state, idx, mild.id);
}

function cost(o: SituationOption): number {
  const e = o.effect;
  return Math.abs(e.renown ?? 0) + Math.abs((e.grain ?? 0) / 100)
    + (e.blocAgainst ? 30 : 0) + Math.abs(e.morale ?? 0);
}

/** 看完了，收起来 */
export function closeSituation(state: WorldState): void {
  if (state.court) state.court.situation = null;
}

// ─────────────────────────────────────────────────────────────
// 结算
// ─────────────────────────────────────────────────────────────

function applyEffect(
  state: WorldState, idx: ContentIndex, e: SituationEffect, who: string,
): void {
  const held = Object.values(state.nodes).filter((n) => n.factionId === who);
  if (e.renown && who === state.official.lordId) bumpRenown(state, e.renown);

  if (e.grain) {
    const seat = state.nodes[state.official.cityId];
    if (who === state.official.lordId && seat) {
      seat.grain = Math.max(0, seat.grain + e.grain);
    }
  }
  if (e.troops && held.length > 0) {
    // 摊到各城头上 —— 收来的散兵不会凭空堆在一处
    const each = Math.floor(e.troops / held.length);
    for (const n of held) n.troops += each;
  }
  for (const n of held) {
    if (e.morale) n.morale = clamp(n.morale + e.morale, 4, 100);
    if (e.unrest) n.unrest = clamp(n.unrest + e.unrest, 0, 90);
  }
  if (e.attitudeAll) {
    for (const fid of Object.keys(state.factions)) {
      if (fid === who) continue;
      const fs = state.factions[fid]!;
      fs.attitude[who] = clamp((fs.attitude[who] ?? 0) + e.attitudeAll, -100, 100);
    }
  }
  for (const [fid, d] of Object.entries(e.attitudeFrom ?? {})) {
    const fs = state.factions[fid];
    if (fs) fs.attitude[who] = clamp((fs.attitude[who] ?? 0) + d, -100, 100);
  }
  void idx;
}

/**
 * 合纵。
 *
 * **站在同一边的人彼此拉近，一齐仇视被指名的那一家。**
 * 这不是一个「结盟」按钮 —— 是一件事上大家做了同样的选择，
 * 于是天下的敌友重排了一遍。讨董联军就是这么来的，也是这么散的。
 */
function applyBloc(
  state: WorldState, answers: Record<string, string>, def: SituationDef,
): void {
  for (const o of def.options) {
    const target = o.effect.blocAgainst;
    if (!target) continue;
    const camp = Object.entries(answers)
      .filter(([, pick]) => pick === o.id)
      .map(([fid]) => fid);
    if (camp.length < 2) continue;

    for (const a of camp) {
      for (const b of camp) {
        if (a === b) continue;
        const fs = state.factions[a];
        if (fs) fs.attitude[b] = clamp((fs.attitude[b] ?? 0) + 22, -100, 100);
      }
      // 同盟一齐仇视那一家
      const tf = state.factions[target];
      if (tf) tf.attitude[a] = clamp((tf.attitude[a] ?? 0) - 30, -100, 100);
      const af = state.factions[a];
      if (af) af.attitude[target] = clamp((af.attitude[target] ?? 0) - 30, -100, 100);
    }
  }
}

/** 别家答完之后，他们自己那一份效果也要算 —— 天下不是只有你在动 */
export function settleOthers(
  state: WorldState, idx: ContentIndex,
): void {
  const sit = state.court?.situation;
  const def = sit ? idx.db.situations?.find((s) => s.id === sit.id) : null;
  if (!sit || !def) return;
  for (const [fid, pick] of Object.entries(sit.answers)) {
    if (fid === state.official.lordId) continue;
    const o = def.options.find((x) => x.id === pick);
    if (o) applyEffect(state, idx, o.effect, fid);
  }
}

export { chance };
