/**
 * 武将的命令。
 *
 * 都围着同一件事转：粮从哪来。
 * 请粮看主公脸色，屯田拿训练度换，征粮拿驻地民心换 ——
 * 三条路各有各的账，没有一条是白拿的。
 */
import { chancePermille, nextInt } from './rng.ts';
import type { WorldState } from './state.ts';
import type { Command, CommandResult, SimEvent } from './commands.ts';
import {
  busyOn, campOutput, canStart, facilityCost, facilityCount,
  forageReported, forageYield, grantOf, lordGrainPool, rationCapOf,
} from './camp.ts';
import type { ContentIndex } from './content.ts';
import { wardenOf } from './people.ts';
import {
  COURT_BASE, COURT_DAYS, COURT_GRAIN,
  DRILL_DAYS, FACILITY_SLOTS, FORAGE_MORALE_HIT, FORAGE_REPORT_BASE,
  FORAGE_REPORT_STEP, FORAGE_TAKE_PERMILLE, FORAGE_TRUST_HIT,
  GEAR_DAYS, GEAR_GRAIN, LEVIES, RATION_REPLY_DAYS,
  RECOMMEND_MERIT, RECOMMEND_TRUST, STARTING_CAMP, trackOf,
} from './general_types.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function ok(...events: SimEvent[]): CommandResult {
  return { ok: true, events };
}
function reject(cmd: Command['t'], reasonId: string): CommandResult {
  return { ok: false, events: [{ t: 'rejected', cmd, reasonId }] };
}

/** 在营里开一项工 */
export function cmdCampWork(
  state: WorldState, cmd: Extract<Command, { t: 'camp_work' }>, idx: ContentIndex,
): CommandResult {
  if (state.role !== 'general') return reject('camp_work', 'not_general');
  const camp = state.camps[cmd.campId];
  if (!camp) return reject('camp_work', 'no_camp');

  const why = canStart(camp, cmd.job, cmd.levy ?? null);
  if (why) return reject('camp_work', why);

  const out = campOutput(camp, idx);

  if (cmd.job === 'build') {
    // 修营。这是武将的「发育」——
    // 城里盖房子是为了多收粮，修营是为了改变自己军队的形状
    const def = cmd.facilityId ? idx.facility.get(cmd.facilityId) : undefined;
    if (!def) return reject('camp_work', 'no_such_facility');
    const have = camp.works[def.id] ?? 0;
    if (have >= def.maxLevel) return reject('camp_work', 'maxed');
    if (have === 0 && facilityCount(camp) >= FACILITY_SLOTS) {
      return reject('camp_work', 'no_room');
    }
    const cost = facilityCost(def, have + 1);
    if (camp.grain < cost.grain) return reject('camp_work', 'no_grain');
    camp.grain -= cost.grain;
    camp.jobs.push({
      job: 'build', levy: null, facilityId: def.id, toLevel: have + 1,
      daysLeft: cost.days, days: cost.days,
    });
    return ok({
      t: 'work_started', plot: -1, buildingId: def.id,
      toLevel: have + 1, days: cost.days,
    });
  }

  let days: number;
  if (cmd.job === 'court') {
    // 招揽：摆酒送礼，请人来投。请不动也是要花钱的
    if (camp.grain < COURT_GRAIN) return reject('camp_work', 'no_grain');
    if (courtPool(state, idx).length === 0) {
      return reject('camp_work', 'no_one_left');
    }
    camp.grain -= COURT_GRAIN;
    camp.jobs.push({
      job: 'court', levy: null, facilityId: null, toLevel: 0,
      daysLeft: COURT_DAYS, days: COURT_DAYS,
    });
    return ok({
      t: 'work_started', plot: -1, buildingId: 'court', toLevel: 0, days: COURT_DAYS,
    });
  }

  if (cmd.job === 'levy') {
    const def = LEVIES[cmd.levy!];
    camp.grain -= Math.ceil((def.men * def.grainPer100) / 100);
    days = def.days;
    camp.jobs.push({
      job: 'levy', levy: cmd.levy!, facilityId: null, toLevel: 0,
      daysLeft: days, days,
    });
  } else if (cmd.job === 'drill') {
    days = DRILL_DAYS;
    camp.jobs.push({
      job: 'drill', levy: null, facilityId: null, toLevel: 0, daysLeft: days, days,
    });
  } else {
    // 器械的上限由工坊决定 —— 没有工坊，一架井阑就是极限
    if (camp.gear >= out.gearCap) return reject('camp_work', 'gear_capped');
    if (camp.grain < GEAR_GRAIN) return reject('camp_work', 'no_grain');
    camp.grain -= GEAR_GRAIN;
    days = GEAR_DAYS;
    camp.jobs.push({
      job: 'gear', levy: null, facilityId: null, toLevel: 0, daysLeft: days, days,
    });
  }
  return ok({
    t: 'work_started', plot: -1, buildingId: cmd.job, toLevel: 0, days,
  });
}

/**
 * 招揽有没有请动人。
 *
 * 一个有本事的人凭什么跟着你？只有两样：**你打过的仗**（战功），
 * 和**主公看重你**（信任）。所以这一条把「发育」与「用人」拴在了一起：
 * 想要好将，先得自己立得住。
 *
 * 请不动也要付出去的粮 —— 那是你摆的酒、送的礼。
 */
/**
 * 你请得动谁。
 *
 * **是你主公手下的人**，不是一份写死的名单。
 *
 * 上一版这里读的是 officers.json —— 曹操帐下那八位，
 * 无论你投的是哪一家，招来招去都是那八个人。
 * 而人物库按出身分家之后，这件事就自然而然是对的：
 * 你在袁绍手下，请得动的就是颜良文丑麴义。
 *
 * 还要去掉两种人：已经在你帐下的，和**正在替主公守着一座城的** ——
 * 张郃守着邺城，他就不可能同时来做你的部将。
 */
function courtPool(state: WorldState, idx: ContentIndex) {
  const posted = new Set(Object.values(state.posts));
  return (idx.byFaction.get(state.official.lordId) ?? []).filter(
    (o) => !state.retinue.includes(o.id) && !posted.has(o.id),
  );
}

export function settleCourt(state: WorldState, idx: ContentIndex): SimEvent {
  const pool = courtPool(state, idx);
  if (pool.length === 0) return { t: 'officer_joined', officerId: null };

  const fame = Math.min(400, Math.floor(state.official.merit / 2));
  const favour = Math.floor(state.official.trust * 3);
  const odds = clamp(COURT_BASE + fame + favour, 0, 900);
  if (!chancePermille(state.rng, odds)) {
    return { t: 'officer_joined', officerId: null };
  }

  // 越有本事的人越难请。先按本事排，再按名望决定够得着谁
  const sorted = [...pool].sort(
    (a, b) => (a.command + a.valor + a.wit) - (b.command + b.valor + b.wit),
  );
  const reach = clamp(
    Math.floor((sorted.length * (fame + favour)) / 700), 0, sorted.length - 1,
  );
  const pick = sorted[nextInt(state.rng, reach + 1)]!;
  state.retinue.push(pick.id);
  return { t: 'officer_joined', officerId: pick.id };
}

/**
 * 撂下手上的一件事。
 *
 * 修了一半的营、招了一半的兵，说停就停 —— 已经花掉的粮退一半。
 * 有了并行的几摊活，这条就成了必需：
 * 否则玩家会被一件二十天的差事按在原地，什么也改不了。
 */
export function cmdCampCancel(
  state: WorldState, cmd: Extract<Command, { t: 'camp_cancel' }>,
): CommandResult {
  const camp = state.camps[cmd.campId];
  if (!camp) return reject('camp_cancel', 'no_camp');
  const i = camp.jobs.findIndex((j) => trackOf(j.job) === cmd.track);
  if (i < 0) return reject('camp_cancel', 'nothing_there');
  const w = camp.jobs[i]!;
  camp.jobs.splice(i, 1);

  // 退一半。已经吃下去的那一半算是打了水漂
  let back = 0;
  if (w.job === 'levy' && w.levy) {
    const def = LEVIES[w.levy];
    back = Math.floor(Math.ceil((def.men * def.grainPer100) / 100) / 2);
  } else if (w.job === 'gear') {
    back = Math.floor(GEAR_GRAIN / 2);
  }
  camp.grain += back;
  return ok({ t: 'work_cancelled', plot: -1 });
}

/** 开屯 / 收屯 */
export function cmdCampFarm(
  state: WorldState, cmd: Extract<Command, { t: 'camp_farm' }>,
): CommandResult {
  if (state.role !== 'general') return reject('camp_farm', 'not_general');
  const camp = state.camps[cmd.campId];
  if (!camp) return reject('camp_farm', 'no_camp');
  if (camp.farming === cmd.on) return reject('camp_farm', 'no_change');
  // 兵不能一边下地一边操练。开屯就得把校场上的人撤回来 ——
  // 匠人和招兵的不受影响，那不是同一批人
  if (cmd.on && busyOn(camp, 'train')) return reject('camp_farm', 'drilling');
  camp.farming = cmd.on;
  return ok({ t: 'camp_farming', on: cmd.on });
}

/**
 * 按季拨下来的粮饷。
 *
 * **不必你开口。**
 *
 * 上一版要玩家每季点一次「请粮」，忘了点就活活饿死 ——
 * 那不是难度，是罚你没读说明书。
 * 现实里辎重是按份例定期发的，有趣的地方在于**够不够**，
 * 不在于你有没有递那张条子。
 *
 * 所以份例自动到；玩家的杠杆是屯田、征粮、缴获，
 * 以及在份例之外**另行请增拨**（见 cmdRationAsk）。
 */
export function issueRation(state: WorldState, idx: ContentIndex): SimEvent[] {
  if (state.role !== 'general') return [];
  const camp = state.camps[STARTING_CAMP] ?? Object.values(state.camps)[0];
  if (!camp) return [];

  const cap = rationCapOf(state.official.rank);
  const pool = lordGrainPool(state, state.official.lordId);
  const granted = grantOf(cap, pool, state.official.trust, state.official.rank, state.rng);
  if (granted <= 0) {
    return [{ t: 'ration_replied', asked: cap, granted: 0, outcome: 'refused' }];
  }
  const room = campOutput(camp, idx).grainCap - camp.grain;
  const took = Math.max(0, Math.min(granted, room));
  camp.grain += took;
  return [{
    t: 'ration_replied',
    asked: cap,
    granted: took,
    outcome: took >= cap ? 'granted' : 'partial',
  }];
}

/**
 * 向主公请粮 —— 份例之外，另行增拨。
 *
 * 不是当场给 —— 公文要走，粮车更要走。
 * 你在营里等的那十二天，是这条线上最难熬的十二天。
 */
export function cmdRationAsk(
  state: WorldState, cmd: Extract<Command, { t: 'ration_ask' }>,
): CommandResult {
  if (state.role !== 'general') return reject('ration_ask', 'not_general');
  if (state.ration && state.ration.outcome === 'pending') {
    return reject('ration_ask', 'already_asked');
  }
  const amount = Math.max(0, Math.floor(cmd.amount));
  if (amount <= 0) return reject('ration_ask', 'zero');

  state.ration = {
    quarter: -1,
    replyDay: state.day + RATION_REPLY_DAYS,
    asked: amount,
    granted: 0,
    outcome: 'pending',
  };
  return ok({ t: 'ration_asked', amount, replyDay: state.ration.replyDay });
}

/** 到日子了，批复下来 */
export function settleRation(state: WorldState, idx: ContentIndex): SimEvent[] {
  const r = state.ration;
  if (!r || r.outcome !== 'pending' || state.day < r.replyDay) return [];

  const pool = lordGrainPool(state, state.official.lordId);
  const granted = grantOf(r.asked, pool, state.official.trust, state.official.rank, state.rng);
  r.granted = granted;
  r.outcome = granted <= 0 ? 'refused'
    : granted >= Math.min(r.asked, rationCapOf(state.official.rank)) ? 'granted'
      : 'partial';

  // 粮送到哪座营？现在只有一座
  const camp = Object.values(state.camps)[0];
  if (camp) {
    // 仓小的营接不住 —— 多出来的会烂在露天里。这是修廪仓的理由
    camp.grain = Math.min(campOutput(camp, idx).grainCap, camp.grain + granted);
  }

  // 请了却没要到，主公自己也不好受 —— 这不该记在你头上
  return [{ t: 'ration_replied', asked: r.asked, granted, outcome: r.outcome }];
}

/**
 * 就地征粮。
 *
 * 最快的一条路，也是最容易把自己走进死胡同的一条：
 * 你刮的是**自己驻守的那座城**，民心低的城守不住，
 * 而你恰恰站在城里。
 */
export function cmdForage(
  state: WorldState, cmd: Extract<Command, { t: 'forage' }>,
): CommandResult {
  if (state.role !== 'general') return reject('forage', 'not_general');
  const camp = state.camps[cmd.campId];
  if (!camp) return reject('forage', 'no_camp');
  const node = state.nodes[camp.nodeId];
  if (!node) return reject('forage', 'no_node');
  if (node.grain < 60) return reject('forage', 'nothing_left');

  const took = forageYield(node.grain, FORAGE_TAKE_PERMILLE);
  node.grain -= took;
  node.morale = clamp(node.morale - FORAGE_MORALE_HIT, 0, 100);
  node.unrest = clamp(node.unrest + 6, 0, 100);
  camp.grain += took;

  const times = state.flags['forages'] ?? 0;
  state.flags['forages'] = times + 1;

  // 刮得越勤越容易被参。第一次多半没人管，第五次就说不准了
  const reported = forageReported(
    state.rng, times, FORAGE_REPORT_BASE, FORAGE_REPORT_STEP,
  );
  if (reported) {
    state.official.trust = clamp(
      state.official.trust - FORAGE_TRUST_HIT - nextInt(state.rng, 5), 0, 100,
    );
  }
  return ok({ t: 'foraged', took, reported });
}

export { chancePermille };

/**
 * 举荐一位部将去守一座空城。
 *
 * **这是玩家在「任命」这套东西里插得上手的那一头。**
 *
 * 天下有的是没人守的城 —— 一家势力吞得快，就会无人可派。
 * 你手上恰好有人。把他交出去，帐下就少一个人、少分一路兵，
 * 换主公的信任和一份战功；而那个人从此在天下图上有自己的城。
 *
 * 舍不舍得，是你的事。
 */
export function cmdRecommend(
  state: WorldState, cmd: Extract<Command, { t: 'recommend' }>, idx: ContentIndex,
): CommandResult {
  if (state.role !== 'general') return reject('recommend', 'not_general');
  if (!state.retinue.includes(cmd.officerId)) return reject('recommend', 'not_yours');
  if ((state.hurt[cmd.officerId] ?? 0) > state.day) return reject('recommend', 'officer_hurt');

  const who = idx.person.get(cmd.officerId);
  if (!who) return reject('recommend', 'no_such_person');

  const node = state.nodes[cmd.cityId];
  if (!node) return reject('recommend', 'no_such_place');
  if (node.factionId !== state.official.lordId) return reject('recommend', 'not_ours');
  // 已经有人守着的城，轮不到你举荐 —— 那是要把人换下来，不是举荐
  if (wardenOf(state, idx, cmd.cityId)) return reject('recommend', 'already_manned');

  state.retinue = state.retinue.filter((id) => id !== cmd.officerId);
  delete state.hurt[cmd.officerId];
  state.posts[cmd.cityId] = who.id;
  state.official.trust = clamp(state.official.trust + RECOMMEND_TRUST, 0, 100);
  state.official.merit += RECOMMEND_MERIT;

  return ok(
    {
      t: 'recommended', personId: who.id, cityId: cmd.cityId,
      trust: RECOMMEND_TRUST, merit: RECOMMEND_MERIT,
    },
    {
      t: 'notice', textId: 'notice.recommended',
      vars: { name: who.name, city: idx.node.get(cmd.cityId)?.name ?? cmd.cityId },
      tone: 'good',
    },
  );
}

/**
 * 主公治下还有哪些城没人守。
 *
 * 举荐要有地方去 —— 界面拿这个列可选的去处。
 */
export function vacantPosts(state: WorldState, idx: ContentIndex): string[] {
  return Object.values(state.nodes)
    .filter((n) => n.factionId === state.official.lordId && !wardenOf(state, idx, n.id))
    .map((n) => n.id);
}
