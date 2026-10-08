/**
 * 批复。
 *
 * 主公不再有按钮，他只有答复 —— 这个文件就是那些答复的后果。
 *
 * 三条纪律写在这里，不许破：
 *
 * 一、**每一种答复都要有后果，「留中」也是。**
 *    压下去不是免费的中立选项：请援的城会破，请战的人会自己动手，
 *    求去的人会不告而别。没有「等下回再说」这一档。
 *
 * 二、**允了不一定就办得成。** 治所没粮就发不出粮车，
 *    邻城无兵就派不出援军。答应一件办不到的事，比驳回还伤人心。
 *
 * 三、**后果落在现成的机制上。** 允了请战就往 state.armies 里放一支军队，
 *    走的是和董卓的兵一模一样的那条路。这一层薄，厚的地方在世界那边。
 */
import type { ContentIndex } from './content.ts';
import type { WorldState } from './state.ts';
import { mintId } from './state.ts';
import type { Command, CommandResult, SimEvent } from './commands.ts';
import {
  CONVOY_ESCORT, SEAT_RESERVE, bestGranary, reliefOffers,
  addDeed, bumpHeart, bumpRenown, fameHeld, HEART_BY_ANSWER, heartOf, ownPeople, tally,
} from './court.ts';
import { payBorrow, planMarch, supplyFor } from './march.ts';
import { KEEP_GARRISON } from './handlers_lord.ts';
import { bumpMerit, promote, rankName, rankOf } from './tribute.ts';
import {
  FAME_FOR_FORCE, HEART_DENY, LEDGER_KEEP, LEVY_CEIL, LEVY_COOLDOWN,
  LEVY_GRAIN_PER_MAN, LEVY_MIN_MORALE, LEVY_MORALE, LEVY_PER_DEV, LEVY_UNREST,
  reactionOf, ROAD_COST, roadKeyOf,
  type Answer, type Memorial,
} from './lord_types.ts';
import { CITY_DEV_PER_SCALE } from './world_types.ts';
import { isDefiant } from './edict.ts';
import { seasonOf } from './time.ts';
import type { Army } from './world_types.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function ok(...events: SimEvent[]): CommandResult {
  return { ok: true, events };
}
function reject(cmd: Command['t'], reasonId: string): CommandResult {
  return { ok: false, events: [{ t: 'rejected', cmd, reasonId }] };
}

/** 押送粮车的兵。粮不会自己走路 */
/** 拨粮那些常数和「哪个仓满调哪个」都在 court.ts —— 这里再导出一次，旧的引用不动 */
export { CONVOY_ESCORT, SEAT_RESERVE, bestGranary } from './court.ts';

// ─────────────────────────────────────────────────────────────

/**
 * 批一件。
 *
 * 允 / 留中 / 不许 —— 劝进那一件上叫受 / 辞 / 斥，是同三个键。
 */
export function cmdCourtReply(
  state: WorldState, cmd: Extract<Command, { t: 'court_reply' }>, idx: ContentIndex,
): CommandResult {
  if (state.role !== 'lord') return reject('court_reply', 'not_lord');
  if (state.ending) return reject('court_reply', 'game_over');
  const court = state.court;
  if (!court) return reject('court_reply', 'no_court');

  const at = court.memorials.findIndex((m) => m.id === cmd.memorialId);
  const m = court.memorials[at];
  if (!m) return reject('court_reply', 'no_such_memorial');

  const events: SimEvent[] = [];
  let done = true;

  switch (m.kind) {
    case 'war': done = doWar(state, idx, m, cmd.answer, events); break;
    case 'grain': done = doGrain(state, idx, m, cmd.answer, events); break;
    case 'relief': done = doRelief(state, idx, m, cmd.answer, events); break;
    case 'recommend': done = doRecommend(state, idx, m, cmd.answer, events); break;
    case 'leave': done = doLeave(state, idx, m, cmd.answer, events); break;
    case 'submit': done = doSubmit(state, idx, m, cmd.answer, events); break;
    case 'vacancy': done = doVacancy(state, idx, m, cmd.answer, events); break;
    case 'urge': done = doUrge(state, idx, m, cmd.answer, events); break;
    case 'merit': done = doMerit(state, idx, m, cmd.answer, events); break;
    // 露布不要你批，只要你知道。没有后果，也不动心气
    case 'dispatch': break;
  }

  // 允了却办不成 —— 帖子留在案上，人心还是要掉
  if (!done) {
    bumpHeart(state, m.personId, -HEART_DENY);
    return reject('court_reply', 'cannot_do');
  }

  /**
   * 他行的是**进来时那份**礼数。
   *
   * 先扣心气再算反应，等于让你这一句话当场改掉他的教养 ——
   * 一个平日恭谨的人被驳一次就转身走了，那不是人，是弹簧。
   * 你这一下对他的影响，要到**下一次**他站在堂上时才看得出来。
   */
  const heartWas = heartOf(state, m.personId);

  // 劝进自己算心气账；露布根本不动心气
  if (m.kind !== 'urge' && m.kind !== 'dispatch') {
    bumpHeart(state, m.personId, HEART_BY_ANSWER[cmd.answer]);
  }

  /**
   * 记一笔旧账。
   *
   * 你对他说过的话，他记着 —— 下次上堂会引用：
   * 「主公前年许某取濮阳，至今未发一兵。」
   */
  if (m.kind !== 'dispatch') {
    const book = court.ledger[m.personId] ?? [];
    book.push({ day: state.day, kind: m.kind, answer: cmd.answer, aboutId: m.aboutId });
    while (book.length > LEDGER_KEEP) book.shift();
    court.ledger[m.personId] = book;
  }

  court.memorials.splice(at, 1);
  if (court.onStage === m.id) court.onStage = null;
  tally(court, 'answer.' + cmd.answer);

  /**
   * 他的反应。**礼数是心气的函数，不是答复的函数** ——
   * 心气高的人被驳了也还躬身，心气低的人你允了他也只是颔首。
   */
  const react = reactionOf(heartWas, cmd.answer, m.kind);
  tally(court, 'react.' + react);
  events.push({
    t: 'memorial_answered', kind: m.kind, personId: m.personId, answer: cmd.answer,
  });
  events.push({
    t: 'memorial_reacted', personId: m.personId,
    name: idx.person.get(m.personId)?.name ?? '', reaction: react,
  });
  return ok(...events);
}

// ─────────────────────────────────────────────────────────────
// 各种呈报的后果
// ─────────────────────────────────────────────────────────────

/** 请战：允了他就真的带兵出去，走的是和别家一样的那条路 */
function doWar(
  state: WorldState, idx: ContentIndex, m: Memorial, answer: Answer, events: SimEvent[],
): boolean {
  if (answer !== 'allow') return true;

  const src = state.nodes[m.fromId];
  const dst = state.nodes[m.aboutId];
  if (!src || !dst) return false;
  if (src.factionId !== state.official.lordId) return false;
  if (dst.factionId === state.official.lordId) return false;
  if (state.sieges[m.fromId]) return false;
  /**
   * **请战不吃「出师」那条闸。**
   *
   * 那条闸管的是主公自己下的令 —— 从辖境调兵、亲自指着一处打。
   * 边将拿自家城里那点余兵去打隔壁，本来就受他自己的兵和粮限制，
   * 再压一道冷却，结果是请战大面积「办不成」：
   * 推演里开国从七局掉到三局，身死业分二十三局 ——
   * 玩家眼睁睁看着人来请战，允了却什么也不发生，而人心照掉。
   */

  /**
   * 粮定人数，不定成败 —— 同 `cmdLordMarch` 上面那一段。
   *
   * 呈报是几十天前发出来的，等它到你案上，那座城的粮早变了。
   * 「允」了却发不出兵，玩家吃到的是一句「办不成」，而人心照掉。
   */
  const canFeed = Math.floor(src.grain / 2);
  const troops = Math.floor(
    Math.min(m.amount, Math.max(0, src.troops - 110), canFeed),
  );
  if (troops < 100) return false;
  const supply = Math.min(src.grain, troops * 2 + 150);

  src.troops -= troops;
  src.grain -= supply;
  const id = mintId(state, 'army');
  const army: Army = {
    id, factionId: state.official.lordId, troops, supply,
    fromId: m.fromId, toId: m.aboutId, progress: 0, intent: 'attack',
    // 是他请的战，功过都记在他头上
    officerId: m.personId,
  };
  state.armies[id] = army;

  /**
   * 无故兴兵是要折望的 —— **除非那一家抗过诏**。
   *
   * 打一个背着「逆」字的人叫奉诏讨逆，那是名正言顺的事。
   * 这是全局唯一一处让进攻行为不折望的地方（见 edict.ts）。
   */
  const att = state.factions[dst.factionId]?.attitude[state.official.lordId] ?? 0;
  if (att > -20 && !isDefiant(state, dst.factionId)) bumpRenown(state, -4);

  addDeed(state, 'deed.war', {
    name: idx.person.get(m.personId)?.name ?? '',
    city: idx.node.get(m.aboutId)?.name ?? m.aboutId,
  }, 'plain');
  events.push({
    t: 'lord_marched', fromId: m.fromId, toId: m.aboutId, troops, attack: true,
  });
  return true;
}

/** 请粮：粮车从治所出发，**在图上真的走**。到了才入库 */
function doGrain(
  state: WorldState, _idx: ContentIndex, m: Memorial, answer: Answer, events: SimEvent[],
): boolean {
  const node = state.nodes[m.aboutId];
  if (answer !== 'allow') {
    // 不给粮，那座城自己往下滑
    if (node) node.morale = Math.max(6, node.morale - 6);
    return true;
  }

  if (!node) return false;
  /**
   * **粮不是只从治所出的。**
   *
   * 早先一律从治所拨，于是治所是一个必然的瓶颈：
   * 一座城的产出要养全境的告急，太仓永远见底 ——
   * 玩家看到的是「每次请粮都拨不出」。
   *
   * 现实里转运本来就是就近调：哪个仓满调哪个。
   * 所以这里挑**自家存粮最多的那一座**（治所同等条件下优先，它本来就是总仓），
   * 粮车从那儿出发，路也就近了。
   */
  const seat = bestGranary(state, m.aboutId);
  if (!seat) return false;
  if (seat.troops < CONVOY_ESCORT + 80) return false;

  /**
   * **能拨多少拨多少，不是「凑不齐整数就一粒不给」。**
   *
   * 头一版要求治所存粮至少是所求之数加两百，差二十石就整件办不成 ——
   * 而玩家点的是「允」，吃到的是一句「办不成」，人心还照掉。
   * 那不是一个决定，那是个陷阱。
   *
   * 这和 `cmdLordMuster` 里那条一模一样：粮决定**征得动多少人**，
   * 而不是征不征得成。拨粮也一样 —— 拨少了是拨少了，
   * 但一个开口求粮的人，收到七百石总好过收到一句空话。
   */
  const spare = seat.grain - SEAT_RESERVE;
  const amount = Math.min(Math.floor(m.amount), spare);
  if (amount < 200) return false;

  seat.grain -= amount;
  seat.troops -= CONVOY_ESCORT;
  const id = mintId(state, 'army');
  state.armies[id] = {
    id, factionId: state.official.lordId, troops: CONVOY_ESCORT, supply: amount,
    fromId: seat.id, toId: m.aboutId, progress: 0, intent: 'reinforce',
  };
  // 开仓活人是恩信。天下人看的是这个，不是你打下了几座城
  bumpRenown(state, 1);
  events.push({
    t: 'convoy_sent', toId: m.aboutId, grain: amount,
  });
  return true;
}

/**
 * 准某一路去援。
 *
 * ── 为什么这一件要单开一道命令 ──────────────────────
 *
 * 原先「允」了请援，是代码替你在挨着那座城的邻城里挑一个 ——
 * 挑不出来就一句「邻城派不出援兵」。
 * 于是玩家眼看着自己还有两座营、四座城，却被告知没人能去；
 * 而且他从头到尾没有做过任何一个选择。
 *
 * 真实的样子是几个人**同时出列请缨**，各自报上兵数和路程，
 * 你挑一路，或者几路都发 —— 这一道命令就是「挑」那一下。
 * 挑完再按「允」，那一下的意思变成「就这些，退下」。
 */
export function cmdCourtRelief(
  state: WorldState, cmd: Extract<Command, { t: 'court_relief' }>, idx: ContentIndex,
): CommandResult {
  if (state.role !== 'lord') return reject('court_relief', 'not_lord');
  if (state.ending) return reject('court_relief', 'game_over');
  const court = state.court;
  if (!court) return reject('court_relief', 'no_court');
  const m = court.memorials.find((x) => x.id === cmd.memorialId);
  if (!m || m.kind !== 'relief') return reject('court_relief', 'no_such_memorial');

  const offer = reliefOffers(state, idx, m.aboutId)
    .find((o) => o.key === cmd.sourceKey);
  if (!offer) return reject('court_relief', 'no_such_force');
  if (offer.refused) return reject('court_relief', 'refused');

  const plan = planMarch(state, idx, offer.fromId, m.aboutId, state.official.lordId);
  if (!plan) return reject('court_relief', 'no_route');
  const src = state.nodes[offer.fromId];
  if (!src) return reject('court_relief', 'no_such_place');

  const supply = Math.min(src.grain, supplyFor(offer.troops, plan.days));
  // 带得出口粮就走得了。**带多少人由粮定，走不走得成不由它定** ——
  // 这条教训在 `cmdLordMarch` 上面记过一次了
  if (supply < 100) return reject('court_relief', 'no_grain');

  if (cmd.sourceKey.startsWith('camp:')) {
    const camp = court.camps[cmd.sourceKey.slice(5)];
    if (!camp || camp.troops < offer.troops) return reject('court_relief', 'no_such_force');
    camp.troops -= offer.troops;
  } else {
    if (src.troops - offer.troops < KEEP_GARRISON) return reject('court_relief', 'too_few');
    src.troops -= offer.troops;
  }
  src.grain -= supply;
  payBorrow(state, state.official.lordId, plan.borrow);

  const id = mintId(state, 'army');
  state.armies[id] = {
    id, factionId: state.official.lordId, troops: offer.troops, supply,
    fromId: offer.fromId, toId: plan.path[1]!, progress: 0, intent: 'reinforce',
    route: plan.path.slice(2), waste: plan.legWaste, finalId: m.aboutId,
    ...(offer.personId ? { officerId: offer.personId } : {}),
  };
  m.sent = (m.sent ?? 0) + 1;
  tally(court, 'relief.force');
  return ok(
    { t: 'lord_marched', fromId: offer.fromId, toId: m.aboutId, troops: offer.troops, attack: false },
    {
      t: 'notice', textId: 'notice.relief_sent',
      vars: {
        who: offer.personId ? idx.person.get(offer.personId)?.name ?? '' : '偏将',
        troops: offer.troops, days: plan.days,
        to: idx.node.get(m.aboutId)?.name ?? m.aboutId,
      },
      tone: 'good',
    },
  );
}

/**
 * 请援：从挨着的自家城调兵去解围。
 *
 * 不允的代价不只落在他一个人头上 —— **全帐下都记着你没救。**
 */
function doRelief(
  state: WorldState, idx: ContentIndex, m: Memorial, answer: Answer, events: SimEvent[],
): boolean {
  const court = state.court!;
  /**
   * **已经点过将了。** 那一下的意思是「就这些，退下」——
   * 兵早在路上，这里不必再发一支。
   */
  if (answer === 'allow' && (m.sent ?? 0) > 0) {
    bumpRenown(state, 3);
    addDeed(state, 'deed.relief', {
      city: idx.node.get(m.aboutId)?.name ?? m.aboutId,
    }, 'good');
    return true;
  }
  if (answer !== 'allow') {
    const hit = answer === 'deny' ? 3 : 2;
    for (const pid of Object.keys(court.heart).sort()) {
      if (pid === m.personId) continue;
      bumpHeart(state, pid, -hit);
    }
    bumpRenown(state, answer === 'deny' ? -5 : -3);
    addDeed(state, 'deed.no_relief', {
      city: idx.node.get(m.aboutId)?.name ?? m.aboutId,
    }, 'bad');
    return true;
  }

  /**
   * 没点将就按「允」—— 那就发最快到得了的那一路。
   *
   * 这一条留着是为了让「允」永远有意义：玩家可以不看那几行请缨，
   * 直接说一句「去救」，剩下的帐下自己安排。
   */
  const offer = reliefOffers(state, idx, m.aboutId).find((o) => !o.refused);
  if (!offer) return false;
  const plan = planMarch(state, idx, offer.fromId, m.aboutId, state.official.lordId);
  const src = state.nodes[offer.fromId];
  if (!plan || !src) return false;
  const troops = offer.troops;
  const supply = Math.min(src.grain, supplyFor(troops, plan.days));

  if (offer.key.startsWith('camp:')) {
    const camp = court.camps[offer.key.slice(5)];
    if (!camp || camp.troops < troops) return false;
    camp.troops -= troops;
  } else {
    src.troops -= troops;
  }
  src.grain -= supply;
  payBorrow(state, state.official.lordId, plan.borrow);
  const id = mintId(state, 'army');
  state.armies[id] = {
    id, factionId: state.official.lordId, troops, supply,
    fromId: offer.fromId, toId: plan.path[1]!, progress: 0, intent: 'reinforce',
    route: plan.path.slice(2), waste: plan.legWaste, finalId: m.aboutId,
  };
  // 救得下来的城，比打下来的城更长脸
  bumpRenown(state, 3);
  addDeed(state, 'deed.relief', {
    city: idx.node.get(m.aboutId)?.name ?? m.aboutId,
  }, 'good');
  events.push({
    t: 'lord_marched', fromId: offer.fromId, toId: m.aboutId, troops, attack: false,
  });
  return true;
}

/**
 * 叙功。
 *
 * **名位是主公手上最便宜也最有分量的一样东西。**
 * 一石粮不花，却能让一个人的心气一下涨上去 ——
 * 也能让另一个替你办了同样多事、却没被提到的人记着这件事。
 *
 * 不许的代价落在**被议的那个人**头上，不在上表的人头上：
 * 是他的功白攒了。所以这一件里被伤到的是第三个人，
 * 而你在堂上看不见他 —— 那正是它该有的样子。
 */
function doMerit(
  state: WorldState, idx: ContentIndex, m: Memorial, answer: Answer, events: SimEvent[],
): boolean {
  const court = state.court!;
  const whoId = m.aboutId;
  const who = idx.person.get(whoId);
  if (!who) return false;

  if (answer === 'allow') {
    promote(state, idx, whoId);
    events.push({
      t: 'rank_changed', personId: whoId, name: who.name,
      rank: rankOf(state, whoId), title: rankName(state, who), up: true,
    });
    return true;
  }
  // 驳了、压下了，功还在，但他知道你没准
  bumpHeart(state, whoId, answer === 'deny' ? -10 : -5);
  // 攒到顶还不给位子，功自己会凉一点 —— 免得案头一直有人在提同一件事
  bumpMerit(state, whoId, -Math.floor((court.merit[whoId] ?? 0) / 4));
  return true;
}

/**
 * 自请守城。
 *
 * 呈报本身就是他在毛遂自荐，所以「允」的意思很干净：派他去。
 * **这一件是这条线的安全网** —— 守将走光之后，
 * 玩家靠它把人重新派回城里去。
 */
function doVacancy(
  state: WorldState, idx: ContentIndex, m: Memorial, answer: Answer, events: SimEvent[],
): boolean {
  const node = state.nodes[m.aboutId];
  if (answer !== 'allow') {
    // 空着的城，兵是散的。不派人就一直这样
    if (node) node.morale = Math.max(6, node.morale - 4);
    return true;
  }
  if (!node || node.factionId !== state.official.lordId) return false;
  const who = idx.person.get(m.personId);
  if (!who) return false;

  // 一将不能分身。要调他去别处，先把原来那处腾出来
  for (const [city, pid] of Object.entries(state.posts)) {
    if (pid === m.personId) delete state.posts[city];
  }
  state.posts[m.aboutId] = m.personId;
  addDeed(state, 'deed.posted', {
    name: who.name, city: idx.node.get(m.aboutId)?.name ?? m.aboutId,
  }, 'good');
  events.push({ t: 'lord_appointed', cityId: m.aboutId, personId: m.personId });
  return true;
}

/**
 * 举荐：**这是招人的主要途径。**
 *
 * 帐下有几个人，最后决定有没有人替你上劝进表 ——
 * 所以「望」这根柱子不是装饰。
 */
function doRecommend(
  state: WorldState, idx: ContentIndex, m: Memorial, answer: Answer, events: SimEvent[],
): boolean {
  const court = state.court!;
  if (answer !== 'allow') {
    // 荐而不用，荐的人比被荐的人更寒心
    return true;
  }
  const who = idx.person.get(m.aboutId);
  if (!who) return false;
  if (court.enlisted.includes(who.id)) return false;

  court.enlisted.push(who.id);
  court.heart[who.id] = 66;
  bumpRenown(state, 1);
  addDeed(state, 'deed.enlisted', { who: who.name, praise: who.praise }, 'good');
  tally(court, 'enlisted');
  events.push({ t: 'person_enlisted', personId: who.id, name: who.name });
  return true;
}

/**
 * 求去：放他走，还是不放。
 *
 * 放了少一个人，但不结仇；不放的，某一天会不告而别 ——
 * 而且走的时候把那座城的人心一起带走。
 */
function doLeave(
  state: WorldState, idx: ContentIndex, m: Memorial, answer: Answer, events: SimEvent[],
): boolean {
  const court = state.court!;
  const who = idx.person.get(m.personId);
  if (answer === 'allow') {
    court.gone.push(m.personId);
    delete court.heart[m.personId];
    delete court.silent[m.personId];
    for (const [city, pid] of Object.entries(state.posts)) {
      if (pid === m.personId) delete state.posts[city];
    }
    bumpRenown(state, 1);
    tally(court, 'left');
    addDeed(state, 'deed.left', { name: who?.name ?? '' }, 'plain');
    events.push({ t: 'person_left', personId: m.personId, name: who?.name ?? '', defected: false });
    return true;
  }

  // 不放。心气本来就在底下了，再驳一次多半就走了
  if (heartOf(state, m.personId) - HEART_DENY < 8) {
    court.gone.push(m.personId);
    delete court.heart[m.personId];
    delete court.silent[m.personId];
    const node = state.nodes[m.fromId];
    if (node) node.unrest = Math.min(90, node.unrest + 26);
    for (const [city, pid] of Object.entries(state.posts)) {
      if (pid === m.personId) delete state.posts[city];
    }
    bumpRenown(state, -6);
    tally(court, 'defected');
    addDeed(state, 'deed.defected', { name: who?.name ?? '' }, 'bad');
    events.push({ t: 'person_left', personId: m.personId, name: who?.name ?? '', defected: true });
  }
  return true;
}

/**
 * 来附：一家撑不下去的势力愿举州归附。
 *
 * **这是「望」变成地盘的地方**，也是天下往鼎立收的和平那条路。
 */
function doSubmit(
  state: WorldState, idx: ContentIndex, m: Memorial, answer: Answer, events: SimEvent[],
): boolean {
  const court = state.court!;
  const theirs = Object.values(state.nodes)
    .filter((n) => n.factionId === m.aboutId)
    .sort((a, b) => a.id.localeCompare(b.id));

  if (answer !== 'allow') {
    // 拒人于千里之外。天下看着呢
    bumpRenown(state, -4);
    const fs = state.factions[m.aboutId];
    if (fs) {
      fs.attitude[state.official.lordId] =
        clamp((fs.attitude[state.official.lordId] ?? 0) - 30, -100, 100);
    }
    return true;
  }
  if (theirs.length === 0) return false;

  for (const n of theirs) {
    n.factionId = state.official.lordId;
    n.takenDay = state.day;
    // 归附不是打下来的。人心散得轻，但也不是没有
    n.unrest = Math.min(50, n.unrest + 14);
    delete state.posts[n.id];
  }
  // 那一家的人跟着地一起过来
  for (const p of idx.byFaction.get(m.aboutId) ?? []) {
    if (court.enlisted.includes(p.id)) continue;
    court.enlisted.push(p.id);
    court.heart[p.id] = 54;
  }
  bumpRenown(state, 3);
  tally(court, 'submitted');
  addDeed(state, 'deed.submitted', {
    who: idx.faction.get(m.aboutId)?.name ?? m.aboutId, cities: theirs.length,
  }, 'good');
  events.push({
    t: 'faction_absorbed', factionId: m.aboutId,
    intoId: state.official.lordId, cities: theirs.length,
  });
  return true;
}

/**
 * 劝进 —— 三个答复通向三个不同的结局。
 *
 *   受：走进最后一幕。名正言顺，但天下从此都盯着你。
 *   辞：三辞三让是真的加望。但**你在赌你还活着**。
 *   斥：这辈子不称帝了（曹操那条路）。帐下重义的人心气大涨，
 *       而这条路通向「托孤」那个结局。
 */
function doUrge(
  state: WorldState, idx: ContentIndex, _m: Memorial, answer: Answer, events: SimEvent[],
): boolean {
  const court = state.court!;

  if (answer === 'shelve') {
    court.throne = 'declined';
    court.declined += 1;
    bumpRenown(state, 7);
    for (const pid of Object.keys(court.heart).sort()) bumpHeart(state, pid, 3);
    tally(court, 'urge.declined');
    addDeed(state, 'deed.declined', { times: court.declined }, 'good');
    events.push({ t: 'throne', how: 'declined' });
    return true;
  }

  if (answer === 'deny') {
    court.throne = 'refused';
    bumpRenown(state, 12);
    for (const p of ownPeople(state, idx)) {
      if (p.loyalty >= 88) bumpHeart(state, p.id, 14);
    }
    tally(court, 'urge.refused');
    addDeed(state, 'deed.refused', {}, 'good');
    events.push({ t: 'throne', how: 'refused' });
    return true;
  }

  // 受
  court.throne = 'claimed';
  crown(state, idx, false);
  tally(court, 'urge.claimed');
  addDeed(state, 'deed.claimed', { times: court.declined }, 'good');
  events.push({ t: 'throne', how: 'claimed' });
  return true;
}

/**
 * 传下一位。
 *
 * 案上还有人 → 引他上堂，**时间不动**。
 * 案上没人了 → 这一下才是退朝，日子才往前走（那一段在 handlers.ts）。
 */
export function cmdCourtNext(state: WorldState): CommandResult {
  if (state.role !== 'lord') return reject('court_next', 'not_lord');
  if (state.ending) return reject('court_next', 'game_over');
  const court = state.court;
  if (!court) return reject('court_next', 'no_court');
  if (court.memorials.length === 0) return reject('court_next', 'nobody_waiting');

  // 已经站着一个了，别把他撵下去
  if (court.onStage && court.memorials.some((m) => m.id === court.onStage)) {
    return reject('court_next', 'already_standing');
  }
  const next = court.memorials[0]!;
  court.onStage = next.id;
  return ok({
    t: 'memorial_staged', kind: next.kind, personId: next.personId, id: next.id,
  });
}

/**
 * 募兵 —— 主公手上**唯一一个能把粮变成兵**的动词。
 *
 * 少了它，推演里玩家的兵会卡在 `dev × 26` 那个硬顶上一动不动
 * （实测刘表五座城七千八百人，第七年到第九年一个人没多），
 * 而粮堆到一万八千石完全没有出口。前期占几座城，之后只能看着别人长。
 *
 * 代价是**民心**：一次募兵伤民心、涨离心，而且一座城九十天只募得了一次。
 * 所以它不是印钞机，是「把一座富庶的城慢慢变厚」的那把慢刀。
 */
export function cmdLordLevy(
  state: WorldState, cmd: Extract<Command, { t: 'lord_levy' }>, _idx: ContentIndex,
): CommandResult {
  if (state.role !== 'lord') return reject('lord_levy', 'not_lord');
  if (state.ending) return reject('lord_levy', 'game_over');
  const court = state.court;
  if (!court) return reject('lord_levy', 'no_court');

  const node = state.nodes[cmd.cityId];
  if (!node) return reject('lord_levy', 'no_such_place');
  if (node.factionId !== state.official.lordId) return reject('lord_levy', 'not_ours');
  if (state.sieges[cmd.cityId]) return reject('lord_levy', 'besieged');

  const last = court.levied[cmd.cityId] ?? -9999;
  if (state.day - last < LEVY_COOLDOWN) return reject('lord_levy', 'levy_soon');
  if (node.morale < LEVY_MIN_MORALE) return reject('lord_levy', 'levy_unwilling');

  // 民心越低应募的越少 —— 「愿意从军」本身就是民心的一部分
  const willing = Math.max(0.3, node.morale / 100);
  const want = Math.floor(node.dev * LEVY_PER_DEV * willing * seasonLevy(state.day));

  // 顶：募兵能把守军堆过被动上限，但不是没边
  const ceil = Math.floor(node.dev * 26 * LEVY_CEIL);
  const room = Math.max(0, ceil - node.troops);
  const canPay = Math.floor(node.grain / LEVY_GRAIN_PER_MAN);
  const men = Math.min(want, room, canPay);
  if (men < 20) {
    return reject('lord_levy', room <= 0 ? 'levy_full' : 'no_grain');
  }

  node.troops += men;
  node.grain -= men * LEVY_GRAIN_PER_MAN;
  // 农忙时抽人，伤的是这一年的收成 —— 民心掉得更狠
  const hurt = Math.round(LEVY_MORALE / seasonLevy(state.day));
  node.morale = Math.max(4, node.morale - hurt);
  node.unrest = Math.min(90, node.unrest + LEVY_UNREST);
  court.levied[cmd.cityId] = state.day;
  tally(court, 'levy');
  return ok({ t: 'lord_levied', cityId: cmd.cityId, men });
}

/**
 * 农时。
 *
 * **兵者，农之余。** 汉家募兵、发兵都在冬天 —— 秋收完了，田里没活，
 * 人闲着，粮也刚进仓。春耕夏耘的时候把壮丁拉走，
 * 伤的不是这一个月，是这一年的收成。
 *
 * 所以：冬募最足，秋次之，春夏两季募得少、民心掉得还更狠。
 * 这一条不新增任何机制，只是让「什么时候做这件事」变得有讲究 ——
 * 而那本来就是农业社会里最要紧的一件事。
 */
export function seasonLevy(day: number): number {
  switch (seasonOf(day)) {
    case 'winter': return 1.35;
    case 'autumn': return 1.0;
    case 'spring': return 0.55;
    default: return 0.45;   // 夏。青黄不接，最不该动人
  }
}

/** 这座城这会儿募得出多少人，以及为什么募不动 */
export function levyLook(
  state: WorldState, idx: ContentIndex, cityId: string,
): { men: number; why: string | null; ready: number } {
  const court = state.court;
  const node = state.nodes[cityId];
  if (!court || !node) return { men: 0, why: '没有这座城', ready: 0 };
  const last = court.levied[cityId] ?? -9999;
  const wait = LEVY_COOLDOWN - (state.day - last);
  if (state.sieges[cityId]) return { men: 0, why: '正被围着', ready: 0 };
  if (wait > 0) return { men: 0, why: `还要 ${wait} 日`, ready: wait };
  if (node.morale < LEVY_MIN_MORALE) return { men: 0, why: '民心太低，无人应募', ready: 0 };

  const willing = Math.max(0.3, node.morale / 100);
  const want = Math.floor(node.dev * LEVY_PER_DEV * willing * seasonLevy(state.day));
  const room = Math.max(0, Math.floor(node.dev * 26 * LEVY_CEIL) - node.troops);
  const canPay = Math.floor(node.grain / LEVY_GRAIN_PER_MAN);
  const men = Math.min(want, room, canPay);
  const cap = Math.max(1, idx.node.get(cityId)?.scale ?? 1) * CITY_DEV_PER_SCALE;
  if (men < 20) {
    return {
      men: 0,
      why: room <= 0 ? (node.dev >= cap ? '城里塞不下更多兵了' : '兵已经够多，先兴修') : '粮不够',
      ready: 0,
    };
  }
  return { men, why: null, ready: 0 };
}

/**
 * 修一段驿路。
 *
 * 只在自家地界上修得起来 —— 两头至少有一头是你的城。
 * 修过之后那一段信使走得快、也不容易被截；
 * **但两头有一头被围，驿就断了**（见 roadWorks）。
 */
export function cmdLordRoad(
  state: WorldState, cmd: Extract<Command, { t: 'lord_road' }>, idx: ContentIndex,
): CommandResult {
  if (state.role !== 'lord') return reject('lord_road', 'not_lord');
  if (state.ending) return reject('lord_road', 'game_over');
  const court = state.court;
  if (!court) return reject('lord_road', 'no_court');

  const a = state.nodes[cmd.fromId];
  const b = state.nodes[cmd.toId];
  if (!a || !b) return reject('lord_road', 'no_such_place');
  if (!idx.node.get(cmd.fromId)?.links.includes(cmd.toId)) {
    return reject('lord_road', 'not_adjacent');
  }
  const me = state.official.lordId;
  if (a.factionId !== me && b.factionId !== me) return reject('lord_road', 'not_ours');
  const key = roadKeyOf(cmd.fromId, cmd.toId);
  if (court.roads[key]) return reject('lord_road', 'already');

  const seat = state.nodes[state.official.cityId];
  if (!seat || seat.factionId !== me) return reject('lord_road', 'no_seat');
  if (seat.grain < ROAD_COST + SEAT_RESERVE) return reject('lord_road', 'no_grain');

  seat.grain -= ROAD_COST;
  court.roads[key] = 1;
  tally(court, 'road');
  addDeed(state, 'deed.road', {
    from: idx.node.get(cmd.fromId)?.name ?? cmd.fromId,
    to: idx.node.get(cmd.toId)?.name ?? cmd.toId,
  }, 'plain');
  return ok({ t: 'road_built', fromId: cmd.fromId, toId: cmd.toId });
}

// ─────────────────────────────────────────────────────────────
// 称帝
// ─────────────────────────────────────────────────────────────

/**
 * 登了那个位子之后，天下怎么看你。
 *
 * 名正言顺的那一种代价轻；**没等劝进就自己称的那一种代价极重** ——
 * 这就是袁术。
 */
function crown(state: WorldState, idx: ContentIndex, forced: boolean): void {
  const me = state.official.lordId;
  const drop = forced ? 45 : 22;

  for (const fid of Object.keys(state.factions).sort()) {
    if (fid === me) continue;
    const fs = state.factions[fid]!;
    fs.attitude[me] = clamp((fs.attitude[me] ?? 0) - drop, -100, 100);
    // 共同的敌人拉近关系 —— 这一条 diplomacy.ts 里本来就有，这里只是把它引爆
    if (forced) {
      for (const other of Object.keys(state.factions)) {
        if (other === me || other === fid) continue;
        fs.attitude[other] = clamp((fs.attitude[other] ?? 0) + 10, -100, 100);
      }
    }
  }

  // 帐下重义的人，忠的是汉不是你
  for (const p of ownPeople(state, idx)) {
    if (p.loyalty >= 88) bumpHeart(state, p.id, forced ? -30 : -12);
  }
  bumpRenown(state, forced ? -25 : -6);
}

/**
 * 不等劝进，自己称。
 *
 * **这是一条真的、可选的、会死人的路。** 赢面小，但赢了是最快的一条。
 * 玩家会清楚自己在赌什么 —— 而这正是它该有的样子。
 */
export function cmdLordClaim(state: WorldState, idx: ContentIndex): CommandResult {
  if (state.role !== 'lord') return reject('lord_claim', 'not_lord');
  if (state.ending) return reject('lord_claim', 'game_over');
  const court = state.court;
  if (!court) return reject('lord_claim', 'no_court');
  if (court.throne === 'claimed' || court.throne === 'forced') {
    return reject('lord_claim', 'already');
  }
  if (fameHeld(state, idx) < FAME_FOR_FORCE) return reject('lord_claim', 'no_seat');

  court.throne = 'forced';
  crown(state, idx, true);
  tally(court, 'forced');
  addDeed(state, 'deed.forced', {}, 'bad');
  return ok({ t: 'throne', how: 'forced' });
}

// ─────────────────────────────────────────────────────────────
