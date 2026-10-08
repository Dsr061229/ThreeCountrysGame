/**
 * 出征的命令。
 *
 * 一次出征走四步，每一步都是一条命令：
 *
 *   开军议 —— 指定要打谁，摆出几条道，报出斥候探来的敌情
 *   定计   —— 分几路、每路多少兵、谁领、走哪条道、干什么
 *   发兵   —— 计定了才发得了。发出去就收不回来
 *   行军   —— 每天走一程，走到了就接战
 *
 * 「定计」与「发兵」拆成两条是有前车之鉴的：
 * 野战那边曾经把「选阵型」和「开打」塞进同一条命令，
 * 结果玩家点一下阵型按钮，布阵阶段就结束了，看起来像卡死。
 * 凡是「摆」与「动」，一律分开。
 */
import { nextInt } from './rng.ts';
import type { ContentIndex } from './content.ts';
import type { WorldState } from './state.ts';
import type { Command, CommandResult, SimEvent } from './commands.ts';
import {
  makeRoutes, pickFoeRoute, resolveSetup, rollDeviations, validatePlan,
} from './campaign.ts';
import { campOutput } from './camp.ts';
import { MAX_COLUMNS, type Column } from './campaign_types.ts';
import { startCampaignBattle } from './field_campaign.ts';
import { SPOILS_PER_FOE_100, STARTING_CAMP } from './general_types.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function ok(...events: SimEvent[]): CommandResult {
  return { ok: true, events };
}
function reject(cmd: Command['t'], reasonId: string): CommandResult {
  return { ok: false, events: [{ t: 'rejected', cmd, reasonId }] };
}

/** 手上这座营 */
function theCamp(state: WorldState) {
  return state.camps[STARTING_CAMP] ?? Object.values(state.camps)[0];
}

/**
 * 开军议。
 *
 * 敌情是**斥候探来的**，所以给玩家看的是一个估计值，不是真值。
 * 探得越清楚，估得越准 —— 这也是「侦察」这项在出征这一层的意义：
 * 你按着一个错的数字去分兵，分错了怪不得别人。
 */
export function cmdCampaignOpen(
  state: WorldState, cmd: Extract<Command, { t: 'campaign_open' }>, idx: ContentIndex,
): CommandResult {
  if (state.role !== 'general') return reject('campaign_open', 'not_general');
  if (state.campaign) return reject('campaign_open', 'already_open');
  if (state.field || state.battle) return reject('campaign_open', 'in_battle');

  const camp = theCamp(state);
  if (!camp) return reject('campaign_open', 'no_camp');
  // 修营、造械可以撂下，招兵练兵也可以停 —— 出征是全营的事。
  // 但地里的庄稼不能扔，所以屯着的时候不发兵
  if (camp.farming) return reject('campaign_open', 'farming');

  const target = state.nodes[cmd.targetNodeId];
  if (!target) return reject('campaign_open', 'no_such_place');
  if (target.factionId === state.official.lordId) {
    return reject('campaign_open', 'own_city');
  }

  const here = idx.node.get(camp.nodeId);
  const there = idx.node.get(cmd.targetNodeId);
  if (!here || !there) return reject('campaign_open', 'no_such_place');

  // 斥候：训练度高的营，探子也出得去
  const scouting = clamp(30 + Math.floor(camp.training / 2) + nextInt(state.rng, 20), 0, 100);

  state.campaign = {
    targetNodeId: cmd.targetNodeId,
    foeFactionId: target.factionId,
    foeTroops: target.troops,
    scouting,
    routes: makeRoutes(state.rng, here.at, there.at, idx.terrain),
    columns: [],
    phase: 'planning',
    startDay: state.day,
    foeRouteId: null,
    ambushSprung: false,
    log: [],
  };

  return ok({
    t: 'campaign_opened',
    targetNodeId: cmd.targetNodeId,
    foeTroops: target.troops,
  });
}

/** 散会。还没发兵之前随时可以不打 */
export function cmdCampaignClose(state: WorldState): CommandResult {
  const c = state.campaign;
  if (!c) return reject('campaign_close', 'no_campaign');
  if (c.phase !== 'planning') return reject('campaign_close', 'already_marching');
  state.campaign = null;
  return ok();
}

/**
 * 定计。
 *
 * 只摆，不动 —— 摆完还能改，直到你击鼓发兵。
 */
export function cmdCampaignPlan(
  state: WorldState, cmd: Extract<Command, { t: 'campaign_plan' }>,
): CommandResult {
  const c = state.campaign;
  if (!c) return reject('campaign_plan', 'no_campaign');
  if (c.phase !== 'planning') return reject('campaign_plan', 'already_marching');
  if (cmd.columns.length > MAX_COLUMNS) return reject('campaign_plan', 'too_many_columns');

  const camp = theCamp(state);
  if (!camp) return reject('campaign_plan', 'no_camp');

  const columns: Column[] = cmd.columns.map((x, i) => ({
    id: 'col_' + i,
    officerId: x.officerId,
    men: Math.max(0, Math.floor(x.men)),
    routeId: x.routeId,
    mission: x.mission,
    progress: 0,
    state: 'marching',
    deviated: null,
  }));

  const why = validatePlan(columns, camp.troops, c.routes);
  if (why) return reject('campaign_plan', why);

  c.columns = columns;
  return ok();
}

/**
 * 发兵。
 *
 * 这一刻定三件事，之后玩家再也改不了：
 * 敌军走哪条道、各路部将有没有走样、路上要走几天。
 *
 * **先定敌军的道，再判部将走样** —— 顺序不能反。
 * 「马谡改走大道」这件事，得先有「敌军会不会走大道」这个局面，
 * 才谈得上是不是坏了事。
 */
export function cmdCampaignGo(
  state: WorldState, idx: ContentIndex,
): CommandResult {
  const c = state.campaign;
  if (!c) return reject('campaign_go', 'no_campaign');
  if (c.phase !== 'planning') return reject('campaign_go', 'already_marching');
  if (c.columns.length === 0) return reject('campaign_go', 'no_columns');

  const camp = theCamp(state);
  if (!camp) return reject('campaign_go', 'no_camp');

  c.foeRouteId = pickFoeRoute(c, state.rng);
  rollDeviations(c, idx, state.rng);
  c.phase = 'marching';

  // 出征的兵从营里带走。这段日子营里只剩看家的
  const sent = c.columns.reduce((a, x) => a + x.men, 0);
  state.flags['campaignSent'] = sent;

  return ok({ t: 'campaign_marched', columns: c.columns.length });
}

/**
 * 各路人马走一天。
 *
 * 走完各自那条道就算到了；**所有该到的都到了**才接战 ——
 * 侧击那一路要是走的山道，正兵就得在那儿等他。
 * 这是「道有远近」在玩法上的分量：你挑了一条更隐蔽的道，
 * 就得接受它更慢。
 */
export function tickCampaign(state: WorldState, idx: ContentIndex): SimEvent[] {
  const c = state.campaign;
  if (!c || c.phase !== 'marching') return [];

  let allThere = true;
  for (const col of c.columns) {
    const route = c.routes.find((r) => r.id === col.routeId);
    if (!route) continue;
    // 逡巡不前的那一路，路上要多耗几天
    const need = route.days + (col.deviated === 'late' ? 3 : 0);
    if (col.progress < need) {
      col.progress += 1;
      if (col.progress >= need) col.state = 'arrived';
      else allThere = false;
    }
  }
  if (!allThere) return [];

  // 到齐了。把这份计划算成一场仗
  const setup = resolveSetup(c, idx);
  const camp = theCamp(state);

  c.phase = 'battle';
  for (const note of setup.notes) {
    c.log.push({
      day: state.day, textId: note.textId, tone: note.tone,
      ...(note.vars ? { vars: note.vars } : {}),
    });
  }

  // 一个人都没带到场 —— 这仗打不起来，各路收兵
  if (setup.ownMen <= 0 && setup.late.length === 0) {
    return finishCampaign(state, false, 0);
  }

  const out = camp ? campOutput(camp, idx) : null;
  return startCampaignBattle(state, setup, {
    foeFactionId: c.foeFactionId,
    targetNodeId: c.targetNodeId,
    training: camp?.training ?? 40,
    gear: camp?.gear ?? 0,
    morale: camp?.morale ?? 55,
    scouting: c.scouting,
    bowCap: out?.bowCap ?? 120,
    horseCap: out?.horseCap ?? 0,
  });
}

/**
 * 收场。
 *
 * 打赢了有三样：战功、缴获、以及**敌军那座城的守军实打实地少了**。
 * 缴获这一条要紧 —— 它是武将这条线的第三条粮道，
 * 少了它，玩家就只能在「求主公」和「害百姓」之间二选一。
 */
export function finishCampaign(
  state: WorldState, won: boolean, foeLost: number,
): SimEvent[] {
  const c = state.campaign;
  if (!c) return [];

  const camp = theCamp(state);
  const sent = state.flags['campaignSent'] ?? 0;
  delete state.flags['campaignSent'];

  let merit = 0;
  let spoils = 0;

  if (won) {
    merit = 20 + Math.floor(foeLost / 12);
    // 因粮于敌
    spoils = Math.floor((foeLost * SPOILS_PER_FOE_100) / 100);
    if (camp) camp.grain += spoils;
    state.official.merit += merit;
    state.official.trust = clamp(state.official.trust + 4, 0, 100);

    const node = state.nodes[c.targetNodeId];
    if (node) node.troops = Math.max(0, node.troops - foeLost);
  } else {
    state.official.trust = clamp(state.official.trust - 3, 0, 100);
    if (camp) camp.morale = clamp(camp.morale - 8, 0, 100);
  }

  // 活着回来的人归营。战场上死的那些已经从 camp.troops 里扣过了
  void sent;
  state.campaign = null;
  return [{ t: 'campaign_done', won, merit, spoils }];
}
