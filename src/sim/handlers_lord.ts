/**
 * 主公。
 *
 * 这一身份和另外两条线最根本的分别是：**你不亲手做任何一件事。**
 *
 * 文官亲手种田修墙，武将亲手排兵布阵；主公只做四件事 ——
 * 任命、调兵、兴修、遣使 —— 然后看着天下自己往下走。
 * 你下的每一道令都汇进 NPC 势力跑的同一套世界规则里：
 * 你派去守城的人吃的是和别人一样的守备公式，
 * 你发出去的兵和董卓的兵在图上按同样的速度走同样的路。
 *
 * 所以这一层代码很薄。厚的地方在世界那边，早就写好了。
 */
import type { ContentIndex } from './content.ts';
import type { WorldState } from './state.ts';
import type { Command, CommandResult, SimEvent } from './commands.ts';
import { mintId } from './state.ts';
import { servesFaction, wardenOf } from './people.ts';
import { bumpRenown, marchWait, ownPeople, tally } from './court.ts';
import { isDefiant } from './edict.ts';
import { payBorrow, planMarch, supplyFor } from './march.ts';
import type { Army } from './world_types.ts';
import { CITY_DEV_PER_SCALE } from './world_types.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function ok(...events: SimEvent[]): CommandResult {
  return { ok: true, events };
}
function reject(cmd: Command['t'], reasonId: string): CommandResult {
  return { ok: false, events: [{ t: 'rejected', cmd, reasonId }] };
}

/** 兴修一次要多少粮，按现有的开发度递增 —— 越厚的城越难再厚 */
export function investCost(dev: number): number {
  return 260 + dev * 22;
}
/** 遣使一次的花费 */
export const ENVOY_COST = 320;
/** 遣使能拉回多少 */
export const ENVOY_SHIFT = 18;
/** 一座城至少要留多少兵，不能调空 */
export const KEEP_GARRISON = 80;
/** 征调时每座城留下看家的兵。抽空一座城不叫征调，叫弃守 */
export const MUSTER_KEEP = 110;

/** 这一道令是不是主公发得出来的 */
function notLord(state: WorldState): string | null {
  if (state.role !== 'lord') return 'not_lord';
  if (state.ending) return 'game_over';
  return null;
}

/** 这座城是不是你的 */
function mine(state: WorldState, cityId: string): boolean {
  return state.nodes[cityId]?.factionId === state.official.lordId;
}

// ─────────────────────────────────────────────────────────────

/**
 * 任命一位守将。
 *
 * 主公真正的玩法在这里。人是有限的：一个人只能守一处，
 * 而你的城会越来越多 —— 「城多了管不过来」是这条线的核心张力。
 */
export function cmdLordAppoint(
  state: WorldState, cmd: Extract<Command, { t: 'lord_appoint' }>, idx: ContentIndex,
): CommandResult {
  const no = notLord(state);
  if (no) return reject('lord_appoint', no);
  if (!mine(state, cmd.cityId)) return reject('lord_appoint', 'not_ours');

  const who = idx.person.get(cmd.personId);
  if (!who) return reject('lord_appoint', 'no_such_person');
  if (!servesFaction(state, who.id, state.official.lordId, who.faction)) {
    return reject('lord_appoint', 'not_yours');
  }

  // 一将不能分身。要调他去别处，先把原来那处腾出来
  const heldElsewhere = Object.entries(state.posts)
    .find(([city, pid]) => pid === cmd.personId && city !== cmd.cityId);
  if (heldElsewhere) delete state.posts[heldElsewhere[0]];

  state.posts[cmd.cityId] = cmd.personId;
  return ok({ t: 'lord_appointed', cityId: cmd.cityId, personId: cmd.personId });
}

/**
 * 调兵。
 *
 * **兵在图上真的走。** 走要时间、要吃粮，路上还可能被截 ——
 * 这些全是世界那边现成的规则（见 marchArmies），
 * 主公这一道令只是往里放一支军队。
 *
 * 派去自家的城是增援，派去别人的城是出兵。两者只差一个 intent。
 */
export function cmdLordMarch(
  state: WorldState, cmd: Extract<Command, { t: 'lord_march' }>, idx: ContentIndex,
): CommandResult {
  const no = notLord(state);
  if (no) return reject('lord_march', no);
  if (!mine(state, cmd.fromId)) return reject('lord_march', 'not_ours');
  if (cmd.fromId === cmd.toId) return reject('lord_march', 'same_place');

  const src = state.nodes[cmd.fromId];
  const dst = state.nodes[cmd.toId];
  if (!src || !dst) return reject('lord_march', 'no_such_place');
  if (state.sieges[cmd.fromId]) return reject('lord_march', 'besieged');

  /**
   * **远处也去得，只是路上要付账。**
   *
   * 原先这里是一句「不挨着就过不去」—— 天下图上大半座城点开
   * 都是那一行字，而它既不合地理也不合史实（见 march.ts 开头）。
   *
   * 现在算的是一条真的路：走几天、经谁的地界、要不要借道、
   * 一路散掉多少人。走不通只有一个理由 —— **有人不肯借道**，
   * 而那句话是指得出名字的。
   */
  const plan = planMarch(state, idx, cmd.fromId, cmd.toId, state.official.lordId);
  if (!plan) return reject('lord_march', 'no_route');
  if (plan.refused) return reject('lord_march', 'refused');

  /**
   * **往外打有间歇，守土没有。**
   *
   * 和 NPC 那条闸同一套（见 marchWait）：摊子越大，重整旗鼓越慢。
   * 自家的城被围了还要等，那不叫难度，那叫刁难 —— 所以增援不受这一条。
   */
  const attacking = dst.factionId !== state.official.lordId;
  if (attacking && marchWait(state) > 0) return reject('lord_march', 'march_soon');

  /**
   * **粮决定带得动多少人，不是带不带得成。**
   *
   * 原先是「凑不出随军的口粮就整支兵发不出去」——
   * 于是一座一千四百人、八百石粮的城，点「出兵」什么也不会发生，
   * 而且一声不响：玩家看到的是按钮坏了。
   *
   * 这和 `cmdLordMuster` 里那条一模一样，当时已经栽过一次。
   * 喂得起几个就带几个 —— 这才是那句「兵马未动，粮草先行」。
   */
  /**
   * 粮定人数：**走得越远，同样一石粮带得动的人越少。**
   * 这是「兵马未动，粮草先行」在远征上的样子。
   */
  const per = Math.max(2, Math.round(supplyFor(1000, plan.days) / 1000));
  const canFeed = Math.floor(src.grain / per);
  const troops = Math.min(Math.floor(cmd.troops), canFeed, src.troops - KEEP_GARRISON);
  if (troops < 60) {
    return reject('lord_march', canFeed < 60 ? 'no_grain' : 'too_few');
  }

  // 随军的口粮从出发地带走。远征要带够走完全程的
  const supply = Math.min(src.grain, supplyFor(troops, plan.days));

  src.troops -= troops;
  src.grain -= supply;
  // 过境是要打招呼的，而人家记着（见 payBorrow）
  payBorrow(state, state.official.lordId, plan.borrow);
  if (state.court) {
    if (plan.path.length > 2) tally(state.court, 'march.far');
    if (plan.borrow.length > 0) tally(state.court, 'march.borrow');
  }

  const attack = attacking;
  if (attack && state.court) {
    state.court.marchedDay = state.day;
    // 无故兴兵折望，奉诏讨逆不折
    const att = state.factions[dst.factionId]?.attitude[state.official.lordId] ?? 0;
    if (att > -20 && !isDefiant(state, dst.factionId)) bumpRenown(state, -4);
  }
  const id = mintId(state, 'army');
  const army: Army = {
    id,
    factionId: state.official.lordId,
    troops,
    supply,
    fromId: cmd.fromId,
    toId: plan.path[1]!,
    progress: 0,
    intent: attack ? 'attack' : 'reinforce',
    route: plan.path.slice(2),
    waste: plan.legWaste,
    finalId: cmd.toId,
    // 领这一路的是出发那座城的守将。破城之日，功记在他头上
    ...(wardenOf(state, idx, cmd.fromId) ? { officerId: wardenOf(state, idx, cmd.fromId)!.id } : {}),
  };
  state.armies[id] = army;

  return ok(
    { t: 'lord_marched', fromId: cmd.fromId, toId: cmd.toId, troops, attack },
    {
      t: 'notice',
      textId: attack ? 'notice.lord_attack' : 'notice.lord_reinforce',
      vars: {
        troops,
        from: idx.node.get(cmd.fromId)?.name ?? cmd.fromId,
        to: idx.node.get(cmd.toId)?.name ?? cmd.toId,
      },
      tone: 'plain',
    },
  );
}

/**
 * 征调。
 *
 * 辖境各城把余兵一齐往一处调。**这是主公唯一能凑出压倒性优势的办法** ——
 * 也是他和 NPC 打法上唯一对等的地方：那边出兵本来就是从整个辖境征调的。
 *
 * 少了这一条，实测各家十年一城未下、一城未失 —— 一盘冻住的棋。
 *
 * 代价不轻：兵在路上要走好些天，这些日子里你的后方是空的。
 * 而天下别家不会因为你在集结就停下来。
 */
export function cmdLordMuster(
  state: WorldState, cmd: Extract<Command, { t: 'lord_muster' }>, idx: ContentIndex,
): CommandResult {
  const no = notLord(state);
  if (no) return reject('lord_muster', no);
  if (!mine(state, cmd.cityId)) return reject('lord_muster', 'not_ours');
  if (state.sieges[cmd.cityId]) return reject('lord_muster', 'besieged');

  const held = Object.values(state.nodes)
    .filter((n) => n.factionId === state.official.lordId && n.id !== cmd.cityId);

  let sent = 0;
  let from = 0;
  for (const src of held) {
    if (state.sieges[src.id]) continue;
    // 征调也要留下看家的。抽空一座城不叫征调，叫弃守
    let give = Math.floor((src.troops - MUSTER_KEEP) * 0.75);
    /**
     * **粮决定征得动多少人，而不是征不征得成。**
     *
     * 原先是「凑不出随军的口粮就整座城跳过」——
     * 于是曹操那种「兵多而粮少」的开局一个人也调不动：
     * 两座城各一千四百兵、八百多石粮，`begin` 之后当场就是「各城都抽不出兵」。
     * 而那本来是他最该有的处境：人有的是，就是喂不饱。
     *
     * 喂得起几个就带几个 —— 这才是那句「兵马未动，粮草先行」。
     */
    const canFeed = Math.floor(src.grain / 2);
    give = Math.min(give, canFeed);
    if (give < 60) continue;
    const supply = Math.min(src.grain, give * 2);

    src.troops -= give;
    src.grain -= supply;
    const id = mintId(state, 'army');
    state.armies[id] = {
      id,
      factionId: state.official.lordId,
      troops: give,
      supply,
      fromId: src.id,
      toId: cmd.cityId,
      progress: 0,
      intent: 'reinforce',
    };
    sent += give;
    from += 1;
  }

  if (from === 0) return reject('lord_muster', 'nothing_to_muster');
  return ok(
    { t: 'lord_mustered', cityId: cmd.cityId, troops: sent, from },
    {
      t: 'notice',
      textId: 'notice.lord_muster',
      vars: { troops: sent, from, to: idx.node.get(cmd.cityId)?.name ?? cmd.cityId },
      tone: 'plain',
    },
  );
}

/**
 * 兴修。
 *
 * 主公不点一块块地皮修房子 —— 那是城池官长的活。
 * 他做的是把粮拨下去，让一座城厚起来：开发度涨，
 * 粮、兵、守备跟着一起长（见 growNodes）。
 *
 * 越厚的城越难再厚，而且**小县再怎么经营也还是小县**（CITY_DEV_PER_SCALE）。
 */
export function cmdLordInvest(
  state: WorldState, cmd: Extract<Command, { t: 'lord_invest' }>, idx: ContentIndex,
): CommandResult {
  const no = notLord(state);
  if (no) return reject('lord_invest', no);
  if (!mine(state, cmd.cityId)) return reject('lord_invest', 'not_ours');

  const node = state.nodes[cmd.cityId];
  if (!node) return reject('lord_invest', 'no_such_place');
  if (state.sieges[cmd.cityId]) return reject('lord_invest', 'besieged');

  const cap = Math.max(1, idx.node.get(cmd.cityId)?.scale ?? 1) * CITY_DEV_PER_SCALE;
  if (node.dev >= cap) return reject('lord_invest', 'maxed');

  const cost = investCost(node.dev);
  if (node.grain < cost) return reject('lord_invest', 'no_grain');

  node.grain -= cost;
  node.dev += 1;
  node.morale = clamp(node.morale + 1, 0, 100);
  return ok({ t: 'lord_invested', cityId: cmd.cityId, dev: node.dev, cost });
}

/**
 * 遣使。
 *
 * 天下的恩怨是会变的（见 diplomacy.ts），而使者是你唯一能**主动**
 * 拨动它的手：花一笔粮，把一家对你的态度往回拉一点。
 *
 * 拉不了很多 —— 结下的仇不是一趟使节化得开的。
 * 但在「四面受敌」的时候，能少一面就是少一面。
 */
export function cmdLordEnvoy(
  state: WorldState, cmd: Extract<Command, { t: 'lord_envoy' }>, idx: ContentIndex,
): CommandResult {
  const no = notLord(state);
  if (no) return reject('lord_envoy', no);
  if (cmd.factionId === state.official.lordId) return reject('lord_envoy', 'same_place');
  if (!state.factions[cmd.factionId]) return reject('lord_envoy', 'no_such_place');
  // 已经没了地盘的势力，遣使无从谈起
  const alive = Object.values(state.nodes).some((n) => n.factionId === cmd.factionId);
  if (!alive) return reject('lord_envoy', 'not_ours');

  // 使者的盘缠从治所出
  const seat = state.nodes[state.official.cityId];
  if (!seat || seat.factionId !== state.official.lordId) {
    return reject('lord_envoy', 'no_seat');
  }
  if (seat.grain < ENVOY_COST) return reject('lord_envoy', 'no_grain');
  seat.grain -= ENVOY_COST;

  const fs = state.factions[cmd.factionId]!;
  const was = fs.attitude[state.official.lordId] ?? 0;
  fs.attitude[state.official.lordId] = clamp(was + ENVOY_SHIFT, -100, 100);

  return ok(
    {
      t: 'lord_envoy_done', factionId: cmd.factionId,
      shift: ENVOY_SHIFT, cost: ENVOY_COST,
    },
    {
      t: 'notice',
      textId: 'notice.lord_envoy',
      vars: { name: idx.faction.get(cmd.factionId)?.name ?? cmd.factionId },
      tone: 'plain',
    },
  );
}

/**
 * 主公这一局是不是完了。
 *
 * 地盘丢光就出局 —— 这是唯一一条。汉末的诸侯不是被处决的，
 * 是被打成光杆之后就没人再提起了。
 */
export function checkLordEnding(state: WorldState): SimEvent[] {
  if (state.role !== 'lord' || state.ending) return [];
  const held = Object.values(state.nodes)
    .filter((n) => n.factionId === state.official.lordId).length;
  if (held > 0) return [];
  state.ending = { kind: 'scattered', day: state.day };
  return [{ t: 'game_over', kind: 'scattered' }];
}

/** 主公手上还有哪些人没派出去。举荐来的、归附来的都算 */
export function idlePeople(state: WorldState, idx: ContentIndex): string[] {
  const posted = new Set(Object.values(state.posts));
  return ownPeople(state, idx).filter((p) => !posted.has(p.id)).map((p) => p.id);
}

/** 主公治下那些没人守的城 */
export function unheldCities(state: WorldState, idx: ContentIndex): string[] {
  return Object.values(state.nodes)
    .filter((n) => n.factionId === state.official.lordId && !wardenOf(state, idx, n.id))
    .map((n) => n.id);
}
