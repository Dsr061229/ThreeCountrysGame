/**
 * 命令处理器 —— 一城之治的全部规则。
 *
 * 处理器就地修改状态并返回事件。
 * 一切随机必须走 state.rng，一切 id 必须走 mintId，否则模拟不再确定。
 */
import { chance, chancePermille, nextInt, nextRange } from './rng.ts';
import { currentCity, type WorldState } from './state.ts';
import { totalInvested, upgradeCost, type BuildingDef, type ContentIndex } from './content.ts';
import { ok, reject, type Command, type CommandResult, type SimEvent } from './commands.ts';
import {
  availableBuildings, canPlaceMore, computeOutput, isPlotOpen, moraleTarget, unlockedBuildings,
} from './city.ts';
import {
  DEMOLISH_REFUND, MERIT_TO_PROMOTE, POP_GROWTH_DIVISOR, POP_TICK_DAYS, RANKS,
  WALL_COST, YAMEN_PLOT,
  type AfflictionKind, type City, type Quota,
} from './types.ts';
import { garrisonOf, tickWorld } from './worldtick.ts';
import {
  advanceRound, applyDecision, applyDeploy, dismissBattle, startAssault,
} from './battle.ts';
import {
  advanceFieldRound, applyFieldDecision, applyFieldDeploy, beginField,
  dismissField, startSortie,
} from './field.ts';
import { FIRST_ASSAULT_DAY } from './battle_types.ts';
import {
  BANDIT_ASSAULT_AFTER, BANDIT_FIRST_DAY, BANDIT_ID, BANDIT_INTERVAL,
} from './world_types.ts';
import { STARTING_CAMP } from './general_types.ts';
import { pickCampSite } from './campsite.ts';
import {
  checkLordEnding, cmdLordAppoint, cmdLordEnvoy, cmdLordInvest, cmdLordMarch,
  cmdLordMuster,
} from './handlers_lord.ts';
import { noteWorldEvents, openCourt, tickCourt } from './court.ts';
import {
  answerSituation, closeSituation, lapseSituation, maybeSituation, settleOthers,
} from './situation.ts';
import {
  cmdCampClose, cmdCampMarch, cmdCampOpen, cmdDraft, tickBarracks,
} from './barracks.ts';
import { cmdLordEdict, cmdPlot, tickEmperor } from './edict.ts';
import { cmdSucceed } from './succession.ts';
import {
  cmdCourtNext, cmdCourtRelief, cmdCourtReply, cmdLordClaim, cmdLordLevy, cmdLordRoad,
} from './handlers_court.ts';
import { ADJOURN_FAR, ADJOURN_MAX } from './lord_types.ts';
import { campOutput, tickCamp } from './camp.ts';
import {
  cmdCampCancel, cmdCampFarm, cmdCampWork, cmdForage, cmdRationAsk, cmdRecommend,
  issueRation, settleCourt, settleRation,
} from './handlers_general.ts';
import {
  cmdCampaignClose, cmdCampaignGo, cmdCampaignOpen, cmdCampaignPlan, tickCampaign,
} from './handlers_campaign.ts';
import {
  cmdTheatreBegin,
  cmdTheatreWithdraw, cmdTheatreClose, cmdTheatreDismiss, cmdTheatreOpen,
  cmdTheatreScout, cmdDuelAccept, cmdDuelRefuse,
  cmdTheatreRecall, cmdTheatreSend, cmdTheatreStep,
} from './handlers_theatre.ts';
import {
  cmdOrderAccept, cmdOrderDefy, cmdOrderTribute, maybeOrder, tickOrder,
} from './handlers_order.ts';
import { DISMISS_AFTER_MISSES, WALL_MAX } from './world_types.ts';
import {
  DAYS_PER_MONTH, quarterEndDay, quarterOf, quarterStartDay, seasonOf, type Season,
} from './time.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 扩建外圈的门槛与代价 */
const EXPAND_DEV = 12;
const EXPAND_COIN = 420;
const EXPAND_GRAIN = 300;

// ─────────────────────────────────────────────────────────────
// begin
// ─────────────────────────────────────────────────────────────

function cmdBegin(
  state: WorldState, cmd: Extract<Command, { t: 'begin' }>, idx: ContentIndex,
): CommandResult {
  if (state.started) return reject('begin', 'already_begun');
  /**
   * 当主公不必在 `lords.json` 里有条目。
   *
   * 那张表写的是「你侍奉的是谁」—— 文官武将要靠它取主公的名号、
   * 性子、给的份例。而当主公时你**就是**那面旗号：
   * 只要天下图上这一家真的占着城，你就当得了。
   *
   * 少了这一层分辨，十二家诸侯里只有曹操开得了局，
   * 其余的 `begin` 直接被拒 —— 而返回的 role 还停在「文官」，
   * 于是推演里那几家看着像是「什么都不做」，其实是压根没上场。
   */
  const asLord = cmd.role === 'lord';
  if (!asLord && !idx.city.get(cmd.cityId)) return reject('begin', 'unknown_city');
  if (!asLord && !idx.lord.get(cmd.lordId)) return reject('begin', 'unknown_lord');
  if (asLord && !state.factions[cmd.lordId]) return reject('begin', 'unknown_lord');

  state.started = true;
  state.role = cmd.role ?? 'official';
  state.official = {
    name: cmd.playerName,
    rank: 0,
    merit: 0,
    trust: 50,
    cityId: cmd.cityId,
    lordId: cmd.lordId,
  };

  const events: SimEvent[] = [{ t: 'began' }];

  if (state.role === 'lord') {
    /**
     * 主公开局。
     *
     * 他不领一座城，也不领一支营 —— 他**就是**那面旗号。
     * `official.lordId` 是他自己那一家，`cityId` 是他的治所。
     * 剩下的事全在天下图上：地盘、人、兵，都已经由 createWorld 摆好了。
     */
    const seat = Object.values(state.nodes)
      .find((n) => n.factionId === cmd.lordId && idx.node.get(n.id)?.seat)
      ?? Object.values(state.nodes).find((n) => n.factionId === cmd.lordId);
    if (!seat) return reject('begin', 'unknown_lord');
    /**
     * **主公不亲手治一座城 —— 所以他不该有那个城。**
     *
     * `createWorld` 给每一局都摆好了玩家那座雍丘（跑完整的地块模型）。
     * 主公这一局它没被清掉，于是 `syncPlayerNodes` 每天都拿那份
     * 「城墙裂了三处、田荒了大半」的小县去覆盖天下图上的同一个节点：
     * 治所开局一千四百兵，三十天后只剩五十八 —— 而且一声不响。
     * 玩家看到的是自己的都城凭空塌了。
     *
     * 又一条「有数据、没人管」的东西。清掉它，治所就跟别家的城
     * 走同一套 `growNodes`，这本来就是主公线的立意：
     * 他的城和董卓的城吃的是同一份规则。
     */
    state.cities = {};
    state.official.cityId = seat.id;
    /**
     * 朝堂开张。
     *
     * 主公的寿数在这一刻就定下了 —— 暗的，带抖动。
     * 从这天起，整局的问题不再是「我要打到什么时候」，
     * 而是「我还剩多少年，够不够」。
     */
    openCourt(state, idx);
    return ok(...events);
  }

  if (state.role === 'general') {
    // 武将不治民，所以没有季度指标，也就没有「交不上差」这条死法。
    // 他的压力来自另一头：营里的粮。
    //
    // 营不在城里 —— 在城外几里的一处山边水边。位置是在真地形上挑的
    const here = idx.node.get(cmd.cityId);
    const others = idx.db.map
      .filter((n) => n.id !== cmd.cityId)
      .map((n) => n.at as [number, number]);
    const spot = pickCampSite(
      state.rng, (here?.at ?? [0, 0]) as [number, number], idx.terrain, others,
    );
    state.camps[STARTING_CAMP] = {
      id: STARTING_CAMP,
      nodeId: cmd.cityId,
      at: spot.at,
      site: spot.site,
      ownerId: null,
      troops: 200,
      training: 25,
      grain: 600,
      morale: 55,
      gear: 0,
      farming: false,
      retainers: 0,
      works: {},
      jobs: [],
    };
    // 主公麾下不止你一个带兵的。
    //
    // 别的武将也各有屯兵地，画在图上 —— 于是天下图对武将不再是
    // 「一堆城加我一个」，而是看得见「我们这一路」摆在哪儿。
    // 将来主公要你去增援某座城，那些营就是你的邻居。
    seedAlliedCamps(state, idx);
    return ok(...events);
  }

  events.push(...issueQuota(state, idx, quarterOf(state.day)));
  events.push(...detectUnlocks(state, idx));
  return ok(...events);
}

/**
 * 给主公麾下别的武将也安上屯兵地。
 *
 * 挑主公手上除你之外的城，每座城边扎一座营，配一个部将。
 * 这些营现在还只是图上的邻居 —— 但它们是「主公派兵支援」
 * 与「叛逃时谁会跟你走」这两件事将来要用的骨架。
 */
function seedAlliedCamps(state: WorldState, idx: ContentIndex): void {
  const mine = state.camps[STARTING_CAMP];
  // 主公手下的人，去掉正在守城的 —— 剩下的才是带兵在外的
  const posted = new Set(Object.values(state.posts));
  const roster = (idx.byFaction.get(state.official.lordId) ?? [])
    .filter((o) => !posted.has(o.id));
  const others = Object.values(state.nodes)
    .filter((n) => n.factionId === state.official.lordId && n.id !== mine?.nodeId);

  const cities = idx.db.map.map((n) => n.at as [number, number]);
  let k = 0;
  for (const node of others) {
    const def = idx.node.get(node.id);
    if (!def) continue;
    const officer = roster[(k * 3 + 1) % roster.length];
    if (!officer) break;
    const spot = pickCampSite(state.rng, def.at as [number, number], idx.terrain, cities);
    const id = 'camp_ally_' + node.id;
    state.camps[id] = {
      id,
      nodeId: node.id,
      at: spot.at,
      site: spot.site,
      ownerId: officer.id,
      troops: 260 + nextInt(state.rng, 240),
      training: 35 + nextInt(state.rng, 30),
      grain: 900 + nextInt(state.rng, 700),
      morale: 55 + nextInt(state.rng, 15),
      gear: nextInt(state.rng, 2),
      farming: false,
      retainers: 0,
      works: {},
      jobs: [],
    };
    k += 1;
  }
}

// ─────────────────────────────────────────────────────────────
// build / cancel / expand
// ─────────────────────────────────────────────────────────────

function cmdBuild(
  state: WorldState, cmd: Extract<Command, { t: 'build' }>, idx: ContentIndex,
): CommandResult {
  const city = currentCity(state);
  const plot = city.plots[cmd.plot];
  if (!plot) return reject('build', 'no_such_plot');
  if (cmd.plot === YAMEN_PLOT && cmd.buildingId !== 'yamen') return reject('build', 'yamen_plot');
  if (!isPlotOpen(city, cmd.plot)) return reject('build', 'plot_locked');
  if (plot.work) return reject('build', 'already_working');

  const def = idx.building.get(cmd.buildingId);
  if (!def) return reject('build', 'unknown_building');

  // 已有别的建筑就不能改建（M1 不做拆除）
  if (plot.buildingId && plot.buildingId !== cmd.buildingId) return reject('build', 'occupied');
  if (!plot.buildingId) {
    if (!availableBuildings(city, idx).some((d) => d.id === def.id)) {
      return reject('build', canPlaceMore(city, def) ? 'locked' : 'too_many');
    }
  }

  const toLevel = plot.level + 1;
  if (toLevel > def.maxLevel) return reject('build', 'max_level');

  const cost = upgradeCost(def, toLevel);
  if (city.coin < cost.coin) return reject('build', 'no_coin');
  if (city.grain < cost.grain) return reject('build', 'no_grain');

  city.coin -= cost.coin;
  city.grain -= cost.grain;
  plot.work = {
    buildingId: def.id, toLevel, daysLeft: cost.days, totalDays: cost.days,
  };

  return ok({
    t: 'work_started', plot: cmd.plot, buildingId: def.id, toLevel, days: cost.days,
  });
}

function cmdCancelWork(
  state: WorldState, cmd: Extract<Command, { t: 'cancel_work' }>, idx: ContentIndex,
): CommandResult {
  const city = currentCity(state);
  const plot = city.plots[cmd.plot];
  if (!plot?.work) return reject('cancel_work', 'no_work');

  const def = idx.building.get(plot.work.buildingId);
  // 拆除半途停手，只是把房子留着，本来也没付过钱
  if (def && !plot.work.demolish) {
    // 退一半。已经动了工的料是收不回来的
    const cost = upgradeCost(def, plot.work.toLevel);
    city.coin += Math.floor(cost.coin / 2);
    city.grain += Math.floor(cost.grain / 2);
  }
  plot.work = null;
  return ok({ t: 'work_cancelled', plot: cmd.plot });
}

/**
 * 拆除。
 *
 * 地块是这个游戏里最稀缺的东西，所以「建错了能不能改」必须有答案。
 * 但拆除要工期、只退三成 —— 让它是一个有代价的决定，而不是免费的撤销键。
 */
function cmdDemolish(
  state: WorldState, cmd: Extract<Command, { t: 'demolish' }>, idx: ContentIndex,
): CommandResult {
  const city = currentCity(state);
  const plot = city.plots[cmd.plot];
  if (!plot) return reject('demolish', 'no_such_plot');
  if (cmd.plot === YAMEN_PLOT) return reject('demolish', 'cannot_demolish_yamen');
  if (plot.work) return reject('demolish', 'already_working');
  if (!plot.buildingId || plot.level <= 0) return reject('demolish', 'nothing_to_demolish');

  const def = idx.building.get(plot.buildingId);
  if (!def) return reject('demolish', 'unknown_building');

  // 拆比建快，但也要人工
  const build = upgradeCost(def, plot.level);
  const days = Math.max(2, Math.ceil(build.days / 2));
  plot.work = {
    buildingId: plot.buildingId, toLevel: 0, daysLeft: days, totalDays: days, demolish: true,
  };

  return ok({ t: 'demolish_started', plot: cmd.plot, buildingId: def.id, days });
}

function cmdExpand(state: WorldState, idx: ContentIndex): CommandResult {
  const city = currentCity(state);
  if (city.ring >= 1) return reject('expand', 'already_expanded');
  const out = computeOutput(city, idx);
  if (out.dev < EXPAND_DEV) return reject('expand', 'too_small');
  if (city.coin < EXPAND_COIN) return reject('expand', 'no_coin');
  if (city.grain < EXPAND_GRAIN) return reject('expand', 'no_grain');

  city.coin -= EXPAND_COIN;
  city.grain -= EXPAND_GRAIN;
  city.ring = 1;
  return ok(
    { t: 'expanded', ring: 1 },
    { t: 'notice', textId: 'notice.expanded', vars: { city: city.name }, tone: 'good' },
  );
}

/**
 * 修葺城墙。
 *
 * 城墙是守城强度的**乘数**：同样的兵，墙高一级就能多挡三四成的敌人。
 * 它不占地块，因为城墙本来也不在坊里 —— 做成城一级的工程，
 * 而不是又一栋要摆位置的建筑。
 */
function cmdFortify(state: WorldState, _idx: ContentIndex): CommandResult {
  const city = currentCity(state);
  if (city.wallWork > 0) return reject('fortify', 'wall_working');
  if (city.wall >= WALL_MAX) return reject('fortify', 'wall_max');

  const cost = WALL_COST[city.wall];
  if (!cost) return reject('fortify', 'wall_max');
  if (city.coin < cost.coin) return reject('fortify', 'no_coin');
  if (city.grain < cost.grain) return reject('fortify', 'no_grain');

  city.coin -= cost.coin;
  city.grain -= cost.grain;
  city.wallWork = cost.days;
  return ok({ t: 'wall_started', toLevel: city.wall + 1, days: cost.days });
}

// ─────────────────────────────────────────────────────────────
// pay —— 向主公缴纳
// ─────────────────────────────────────────────────────────────

function cmdPay(
  state: WorldState, cmd: Extract<Command, { t: 'pay' }>,
): CommandResult {
  const quota = state.quota;
  if (!quota) return reject('pay', 'no_quota');
  const city = currentCity(state);
  const grain = Math.max(0, Math.floor(cmd.grain));
  const coin = Math.max(0, Math.floor(cmd.coin));
  if (grain === 0 && coin === 0) return reject('pay', 'nothing');
  if (city.grain < grain) return reject('pay', 'no_grain');
  if (city.coin < coin) return reject('pay', 'no_coin');

  // 征敛压力按「掏空了多大比例」计，而不是绝对数。
  // 所以把家底全交上去一定伤民心，交得多少无所谓的做法是行不通的。
  const grainShare = city.grain > 0 ? Math.floor((grain * 100) / city.grain) : 0;
  const coinShare = city.coin > 0 ? Math.floor((coin * 100) / city.coin) : 0;

  city.grain -= grain;
  city.coin -= coin;
  quota.paidGrain += grain;
  quota.paidCoin += coin;
  city.taxPressure = clamp(
    city.taxPressure + Math.floor((grainShare * 30) / 100) + Math.floor((coinShare * 15) / 100),
    0, 100,
  );

  return ok({ t: 'paid', grain, coin });
}

// ─────────────────────────────────────────────────────────────
// day —— 一日结算。世界在此运转
// ─────────────────────────────────────────────────────────────

function cmdDay(state: WorldState, idx: ContentIndex): CommandResult {
  if (!state.started) return reject('day', 'not_begun');
  if (state.ending) return reject('day', 'game_over');
  // 一场仗是分秒之间的事，不该让日历在旁边继续翻
  if (state.battle || state.field || state.theatre) return reject('day', 'in_battle');
  /**
   * 大丧也一样。
   *
   * 先主没了、新主还没继位的那几日，日子是停住的 ——
   * 那一屏要留给玩家看完他的一生，不该在他还没看完的时候
   * 让天下自己往前跑（见 succession.ts）。
   */
  if (state.court?.mourning) return reject('day', 'in_mourning');

  const events: SimEvent[] = [];
  const prevQuarter = quarterOf(state.day);

  state.day += 1;
  events.push({ t: 'day_passed', day: state.day });

  // 手里握着什么，这一天就过什么。
  // 文官过的是一座城的一天：产出、民心、灾害、季度指标；
  // 武将过的是一座营的一天：吃粮、操练、逃兵。
  // 底下那半截 —— 天下在转、流寇会来、城会被强攻 —— 两条线是同一个乱世
  if (state.role === 'lord') {
    /**
     * 主公的一天。
     *
     * 上一版这里是空的，注释写着「他自己什么也不做」——
     * 那句话当时是设计意图，后来成了病因：一条没有心跳的线。
     *
     * 现在这里跑的是朝堂：案上的事会过期、人心会凉、
     * 天下会往鼎立收、而他自己的日子在一天天少。
     */
    events.push(...tickCourt(state, idx));
    // 营的一天：吃粮、操练。养不起的会自己饿散
    events.push(...tickBarracks(state, idx));
    // 天子在你城里的日子：供养、离心、以及那一道衣带诏
    events.push(...tickEmperor(state, idx));
    /**
     * 时局。**天下的事不等人** —— 到日子就摆上来，
     * 你不表态，到期按最不出格的那一项算，天下照走。
     */
    events.push(...maybeSituation(state, idx));
    events.push(...lapseSituation(state, idx));
  } else if (state.role === 'general') {
    events.push(...tickCamps(state, idx));
    events.push(...settleRation(state, idx));
    events.push(...tickCampaign(state, idx));
    // 份例按季自动拨下来 —— 不必玩家开口
    if (quarterOf(state.day) !== prevQuarter) {
      events.push(...issueRation(state, idx));
    }
    events.push(...tickOrder(state));
    events.push(...maybeOrder(state, idx));
  } else {
    events.push(...tickPlayerCity(state, idx, prevQuarter));
  }

  if (state.day % DAYS_PER_MONTH === 0) events.push({ t: 'month_passed', day: state.day });

  // 天下自己在转：别处的城在长，别人的兵在路上
  events.push(...tickWorld(state, idx));
  events.push(...maybeBandits(state, idx));
  events.push(...maybeAssault(state, idx));

  /**
   * 前方的事，得有人来报。
   *
   * 放在 tickWorld 之后，因为露布报的就是刚刚发生的那些事 ——
   * 城破、城守住了。放在前面就永远慢一天。
   */
  if (state.role === 'lord') events.push(...noteWorldEvents(state, idx, events));

  if (state.role === 'official') events.push(...detectUnlocks(state, idx));
  // 地盘丢光就出局。这是主公唯一一条败法
  events.push(...checkLordEnding(state));
  events.push(...checkEnding(state));
  return ok(...events);
}

/**
 * 散朝。
 *
 * 天下自己往前走，走到下一件要你拍板的事为止。
 *
 * **会让它停下来的只有真的大事**：案上摞了新帖子、自家城被围了、
 * 城易了主、有人不告而别、大限到了。
 * 别的都不停 —— 主公不该为「某座城的粮涨了三石」被叫醒。
 */
function cmdAdjourn(state: WorldState, idx: ContentIndex): CommandResult {
  if (state.role !== 'lord') return reject('court_adjourn', 'not_lord');
  if (state.ending) return reject('court_adjourn', 'game_over');

  const STOP = new Set([
    'memorial_raised', 'memorial_defied', 'person_left', 'faction_absorbed',
    'city_fell', 'game_over', 'throne', 'situation_open',
  ]);

  /**
   * 一按要走到**下一件事**，不是走满四十五天就停。
   *
   * 堂下没人的时候，玩家做的事是一遍遍点「退朝」，
   * 屏幕上一次次回到「堂下无人」—— 那不是节奏，那是空转。
   *
   * 所以：案上还有人（你自己没批完）就短走；
   * 案上空了、路上也没有骑手，就一直走到真出事为止。
   */
  const court = state.court;
  const pending = (court?.memorials.length ?? 0) + Object.keys(state.couriers).length;
  const cap = pending > 0 ? ADJOURN_MAX : ADJOURN_FAR;

  const events: SimEvent[] = [];
  let days = 0;
  for (; days < cap; days++) {
    const step = cmdDay(state, idx);
    events.push(...step.events);
    if (!step.ok) break;
    if (state.ending) { days += 1; break; }

    let stop = false;
    for (const ev of step.events) {
      if (STOP.has(ev.t)) { stop = true; break; }
      // 自家的城被围了要停。别人家的不必
      if (ev.t === 'siege_started'
        && state.nodes[ev.cityId]?.factionId === state.official.lordId) stop = true;
    }
    if (stop) { days += 1; break; }
  }

  events.push({ t: 'adjourned', days });
  return ok(...events);
}

/** 文官的一天：一座城的产出、民心、灾害与季度指标 */
function tickPlayerCity(
  state: WorldState, idx: ContentIndex, prevQuarter: number,
): SimEvent[] {
  const events: SimEvent[] = [];
  const city = currentCity(state);

  events.push(...advanceWorks(city, events, idx));

  const out = computeOutput(city, idx);

  // 产出与消耗
  const grainBefore = city.grain;
  city.grain += out.grainPerDay;
  if (city.grain > out.capGrain) {
    city.grain = out.capGrain;
    if (grainBefore < out.capGrain) events.push({ t: 'granary_full' });
  }
  city.grain -= out.grainUpkeep;
  if (city.grain < 0) {
    city.grain = 0;
    events.push({ t: 'famine' });
  }

  const coinBefore = city.coin;
  city.coin += out.coinPerDay;
  if (city.coin > out.capCoin) {
    city.coin = out.capCoin;
    if (coinBefore < out.capCoin) events.push({ t: 'treasury_full' });
  }

  // 城墙工期
  if (city.wallWork > 0) {
    city.wallWork -= 1;
    if (city.wallWork === 0) {
      city.wall += 1;
      events.push({ t: 'wall_done', level: city.wall });
    }
  }

  // 灾害倒计时
  for (let i = city.afflictions.length - 1; i >= 0; i--) {
    const a = city.afflictions[i]!;
    a.daysLeft -= 1;
    if (a.daysLeft <= 0) {
      city.afflictions.splice(i, 1);
      events.push({ t: 'affliction_ended', kind: a.kind });
    }
  }

  // 征敛压力逐日消退
  if (city.taxPressure > 0) city.taxPressure -= 1;

  // 民心每日向目标靠拢一点。不做瞬变 —— 治理是慢的
  const target = moraleTarget(city, idx, out);
  if (city.morale < target) city.morale += 1;
  else if (city.morale > target) city.morale -= 1;

  // 人口
  if (state.day % POP_TICK_DAYS === 0) {
    events.push(...settlePopulation(city, out));
  }

  // 天灾每日抽一次，不再全堆在季头那一天
  events.push(...rollAfflictions(state, idx));

  // 指标的发与结仍旧落在季交 —— 税期本来就是定的，这一项规律反而是真实的
  const nowQuarter = quarterOf(state.day);
  if (nowQuarter !== prevQuarter) {
    events.push(...settleQuota(state, idx));
    events.push(...issueQuota(state, idx, nowQuarter));
  }
  return events;
}

/**
 * 武将的一天：营里的兵吃饭、干活、跑路。
 *
 * 这里没有「产出」这一项 —— 营是**只吃不产**的。
 * 这正是这条线的立身之处：粮得从别处来，
 * 要么向主公请，要么就地征，要么打赢了抢。
 */
function tickCamps(state: WorldState, idx: ContentIndex): SimEvent[] {
  const events: SimEvent[] = [];

  /**
   * **只有你自己的营跑这一套。**
   *
   * 图上还扎着主公别的武将的营（见 seedAlliedCamps）。
   * 上一版把它们和你的营一视同仁地推进 —— 而它们既不屯田也不请粮，
   * 坐吃山空，两三个月就饿垮，然后触发 `camp_broke`，
   * 判定成**你**的兵散了。
   *
   * 玩家看到的是「粮总是不够，一会儿就兵营散了」，
   * 而他自己的仓里还有一百石、一天都没断过粮 —— 那是别人的营垮了算在他头上。
   *
   * 友军的营是天下图上的邻居，不是你的账本。它们另有一套粗略的过法。
   */
  const mine = state.camps[STARTING_CAMP];
  if (mine) {
    for (const ev of tickCamp(mine, state.rng, state.day, campOutput(mine, idx))) {
      if (ev.t === 'camp_courted') {
        // 招揽的成败要看名望与信任，那些数在 state 上
        events.push(settleCourt(state, idx));
        continue;
      }
      if (ev.t === 'camp_broke') {
        if (!state.ending) {
          state.ending = { kind: 'scattered', day: state.day };
          events.push({ t: 'game_over', kind: 'scattered' });
        }
        continue;
      }
      events.push(ev);
    }
  }

  events.push(...tickAlliedCamps(state));
  return events;
}

/**
 * 友军的营，粗略地过。
 *
 * 他们不是玩家的账本，所以不跑那一整套粮草模型 ——
 * 但也不能是静止的布景：兵会慢慢练起来、慢慢补上，
 * 城丢了营也就散了。这样天下图上那些营才是活的。
 */
function tickAlliedCamps(state: WorldState): SimEvent[] {
  if (state.day % 30 !== 0) return [];
  for (const [id, camp] of Object.entries(state.camps)) {
    if (id === STARTING_CAMP) continue;
    const node = state.nodes[camp.nodeId];
    // 依托的城丢了，这座营也就散了
    if (!node || node.factionId !== state.official.lordId) {
      delete state.camps[id];
      continue;
    }
    camp.troops = Math.min(900, camp.troops + 8 + nextInt(state.rng, 14));
    camp.training = clamp(camp.training + nextInt(state.rng, 3) - 1, 20, 78);
    camp.morale = clamp(camp.morale + nextInt(state.rng, 3) - 1, 35, 85);
  }
  return [];
}

/**
 * 结局判定。
 *
 * M1 没有失败条件，压力因此是假的 —— 交不上差只是数字难看而已。
 * 两种输法：城破被俘，或者连着几季交不上差被撤职。
 */
function checkEnding(state: WorldState): SimEvent[] {
  if (state.ending) return [];
  // 主公的败法只有一条（地盘丢光，见 checkLordEnding）。
  // 治所换了旗号对他不是出局 —— 他还有别的城，那正是要打回来的理由
  if (state.role === 'lord') return [];

  const node = state.nodes[state.official.cityId];
  if (node && node.factionId !== state.official.lordId) {
    state.ending = { kind: 'captured', day: state.day };
    return [{ t: 'game_over', kind: 'captured' }];
  }

  if (state.consecutiveMisses >= DISMISS_AFTER_MISSES && state.official.trust <= 8) {
    state.ending = { kind: 'dismissed', day: state.day };
    return [{ t: 'game_over', kind: 'dismissed' }];
  }

  return [];
}

/** 推进在建（或在拆）的工程 */
function advanceWorks(city: City, _events: SimEvent[], idx: ContentIndex): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < city.plots.length; i++) {
    const p = city.plots[i]!;
    if (!p.work) continue;
    p.work.daysLeft -= 1;
    if (p.work.daysLeft > 0) continue;

    const def = idx.building.get(p.work.buildingId);

    if (p.work.demolish) {
      const spent = def ? totalInvested(def, p.level) : { coin: 0, grain: 0 };
      const refundCoin = Math.floor((spent.coin * DEMOLISH_REFUND) / 1000);
      const refundGrain = Math.floor((spent.grain * DEMOLISH_REFUND) / 1000);
      city.coin += refundCoin;
      city.grain += refundGrain;
      const wasId = p.work.buildingId;
      p.buildingId = null;
      p.level = 0;
      p.work = null;
      out.push({ t: 'demolished', plot: i, buildingId: wasId, refundCoin, refundGrain });
      if (def) {
        out.push({
          t: 'notice', textId: 'notice.demolished',
          vars: { name: def.name, coin: refundCoin, grain: refundGrain }, tone: 'plain',
        });
      }
      continue;
    }

    p.buildingId = p.work.buildingId;
    p.level = p.work.toLevel;
    p.work = null;
    out.push({ t: 'built', plot: i, buildingId: p.buildingId, level: p.level });
    if (def) {
      out.push({
        t: 'notice', textId: 'notice.built',
        vars: { name: def.name, level: p.level }, tone: 'good',
      });
    }
  }
  return out;
}

/**
 * 人口结算。
 *
 * 增长速度取决于**还有多少房子空着** —— 所以民居是人口的真正闸门，
 * 而人口又是产出的乘数。这条链让「盖房子」有了实感，而不是一个抽象数字。
 */
function settlePopulation(city: City, out: ReturnType<typeof computeOutput>): SimEvent[] {
  const before = city.households;

  if (city.morale < 32 || city.grain <= 0) {
    // 逃荒
    const loss = Math.max(2, Math.floor(city.households / 40));
    city.households = Math.max(20, city.households - loss);
    if (city.households !== before) {
      return [{ t: 'pop_changed', from: before, to: city.households, reason: 'flight' }];
    }
    return [];
  }

  if (city.morale < 48) return [];
  const headroom = out.capHouse - city.households;
  if (headroom <= 0) return [];

  const growth = Math.min(headroom, Math.max(2, Math.floor(headroom / POP_GROWTH_DIVISOR)));
  city.households += growth;
  return [{ t: 'pop_changed', from: before, to: city.households, reason: 'growth' }];
}

// ─────────────────────────────────────────────────────────────
// 季度指标
// ─────────────────────────────────────────────────────────────

function issueQuota(state: WorldState, idx: ContentIndex, quarter: number): SimEvent[] {
  const city = currentCity(state);
  const out = computeOutput(city, idx);
  const lord = idx.lord.get(state.official.lordId);
  const rate = lord?.demandRate ?? 1000;

  // 指标随城池发展水平上升 —— 城越大，主公要得越多。
  // 这是防止中后期躺赢的主要手段。
  // 主公要的是这座城**一季产能的四成**，另有一个随发展缓慢抬升的底数保底。
  // 用比例而不是固定值，是为了避免中后期指标沦为摆设 —— 城越大要得越多，
  // 但你留下的绝对量同样在涨，所以发育始终是划算的。
  const seasonGrain = Math.max(0, out.grainNet) * 90;
  const demandGrain = Math.floor((
    Math.max(180 + out.dev * 22, Math.floor((seasonGrain * 380) / 1000))
  ) * rate / 1000);

  const seasonCoin = Math.max(0, out.coinPerDay) * 90;
  // 第一季只要粮，让新上任的人一次只面对一件事
  const demandCoin = quarter <= quarterOf(0) ? 0 : Math.floor((
    Math.max(80 + out.dev * 10, Math.floor((seasonCoin * 330) / 1000))
  ) * rate / 1000);

  const quota: Quota = {
    quarter,
    dueDay: quarterEndDay(quarter),
    demandGrain,
    demandCoin,
    paidGrain: 0,
    paidCoin: 0,
    outcome: 'pending',
  };
  state.quota = quota;

  return [{
    t: 'quota_issued', quarter, grain: demandGrain, coin: demandCoin, dueDay: quota.dueDay,
  }];
}

function settleQuota(state: WorldState, idx: ContentIndex): SimEvent[] {
  const quota = state.quota;
  if (!quota || quota.outcome !== 'pending') return [];

  const met = quota.paidGrain >= quota.demandGrain && quota.paidCoin >= quota.demandCoin;
  quota.outcome = met ? 'met' : 'missed';

  let meritDelta: number;
  let trustDelta: number;
  if (met) {
    // 超额完成有额外功绩，但收益递减 —— 免得玩家只做交差这一件事
    const over = quota.demandGrain > 0
      ? Math.floor(((quota.paidGrain - quota.demandGrain) * 100) / quota.demandGrain)
      : 0;
    meritDelta = 30 + Math.min(20, Math.floor(over / 5));
    trustDelta = 5;
  } else {
    const short = quota.demandGrain > 0
      ? Math.floor(((quota.demandGrain - quota.paidGrain) * 100) / quota.demandGrain)
      : 100;
    meritDelta = -(10 + Math.floor(short / 8));
    trustDelta = -(6 + Math.floor(short / 10));
  }

  state.consecutiveMisses = met ? 0 : state.consecutiveMisses + 1;
  state.official.merit = Math.max(0, state.official.merit + meritDelta);
  state.official.trust = clamp(state.official.trust + trustDelta, 0, 100);
  state.quotaHistory.push({ ...quota });

  const events: SimEvent[] = [{
    t: 'quota_settled', quarter: quota.quarter, met, meritDelta, trustDelta,
  }];

  const lord = idx.lord.get(state.official.lordId);
  events.push({
    t: 'notice',
    textId: met ? 'notice.quota_met' : 'notice.quota_missed',
    vars: { lord: lord?.name ?? '主公' },
    tone: met ? 'good' : 'bad',
  });

  if (state.official.trust <= 20) {
    events.push({ t: 'notice', textId: 'notice.trust_low', vars: {}, tone: 'bad' });
  }

  // 升迁
  const need = MERIT_TO_PROMOTE[state.official.rank];
  if (need !== undefined && state.official.merit >= need && state.official.rank < RANKS.length - 1) {
    state.official.rank += 1;
    events.push({ t: 'promoted', rank: state.official.rank });
    events.push({
      t: 'notice', textId: 'notice.promoted',
      vars: { rank: RANKS[state.official.rank] ?? '' }, tone: 'good',
    });
  }

  return events;
}

// ─────────────────────────────────────────────────────────────
// 天灾人祸 —— 发育之外的另一半节奏
// ─────────────────────────────────────────────────────────────

/** 各季节特有的灾，以及一年四季都可能发生的祸 */
const SEASONAL: Record<Season, { kind: AfflictionKind; pct: number }> = {
  spring: { kind: 'drought', pct: 22 },
  summer: { kind: 'flood', pct: 18 },
  autumn: { kind: 'locust', pct: 16 },
  winter: { kind: 'plague', pct: 15 },
};

/**
 * 每季开头各抽一次天灾与人祸。
 *
 * 存在的意义不是「惩罚」，而是给攒下来的粮和钱一个用武之地 ——
 * 没有灾荒，仓廪充实就只是一个好看的数字。
 */
function rollAfflictions(state: WorldState, idx: ContentIndex): SimEvent[] {
  const city = currentCity(state);
  const events: SimEvent[] = [];
  const season = seasonOf(state.day);

  const add = (kind: AfflictionKind, days: number, farmPermille: number,
               grainLost: number, popLost: number): void => {
    city.afflictions.push({ kind, daysLeft: days, farmPermille });
    events.push({ t: 'affliction', kind, days, grainLost, popLost });
  };

  // 天灾
  const s = SEASONAL[season];
  if (chancePermille(state.rng, Math.max(1, Math.round((s.pct * 10) / 90)))) {
    switch (s.kind) {
      case 'drought':
        add('drought', nextRange(state.rng, 50, 80), 600, 0, 0);
        city.morale = clamp(city.morale - 6, 0, 100);
        break;
      case 'flood': {
        const lost = Math.floor((city.grain * nextRange(state.rng, 10, 20)) / 100);
        city.grain -= lost;
        city.morale = clamp(city.morale - 10, 0, 100);
        add('flood', nextRange(state.rng, 30, 50), 780, lost, 0);
        break;
      }
      case 'locust':
        add('locust', nextRange(state.rng, 40, 60), 450, 0, 0);
        city.morale = clamp(city.morale - 8, 0, 100);
        break;
      case 'plague': {
        const dead = Math.floor((city.households * nextRange(state.rng, 6, 12)) / 100);
        city.households = Math.max(20, city.households - dead);
        city.morale = clamp(city.morale - 14, 0, 100);
        add('plague', nextRange(state.rng, 25, 45), 900, 0, dead);
        break;
      }
    }
  }

  // 人祸：乱世里的溃兵，和被别处赶来的流民
  if (chancePermille(state.rng, 2)) {
    const g = Math.floor((city.grain * nextRange(state.rng, 12, 25)) / 100);
    const c = Math.floor((city.coin * nextRange(state.rng, 15, 30)) / 100);
    city.grain -= g;
    city.coin -= c;
    city.morale = clamp(city.morale - 9, 0, 100);
    add('raid', nextRange(state.rng, 10, 20), 950, g, 0);
  } else if (chancePermille(state.rng, 3)) {
    // 流民是双刃的：人手多了，嘴也多了，还挤着住。
    // 城里塞得下多少是有限的 —— 挤进来的人会让民心付账（见 moraleTarget 的拥挤惩罚）
    const out = computeOutput(city, idx);
    const room = Math.max(0, Math.floor((out.capHouse * 125) / 100) - city.households);
    const want = nextRange(state.rng, 20, Math.max(30, Math.floor(city.households / 5)));
    const count = Math.min(want, room);
    if (count > 0) {
      city.households += count;
      city.morale = clamp(city.morale - 5, 0, 100);
      events.push({ t: 'refugees_arrived', count });
    }
  }

  return events;
}

// ─────────────────────────────────────────────────────────────
// 解锁播报
// ─────────────────────────────────────────────────────────────

function detectUnlocks(state: WorldState, idx: ContentIndex): SimEvent[] {
  const city = currentCity(state);
  const events: SimEvent[] = [];
  for (const def of unlockedBuildings(city, idx)) {
    if (state.seenUnlocks.includes(def.id)) continue;
    state.seenUnlocks.push(def.id);
    events.push({ t: 'unlocked', buildingId: def.id });
  }
  return events;
}

// ─────────────────────────────────────────────────────────────
// 守城战
// ─────────────────────────────────────────────────────────────

function cmdDeploy(
  state: WorldState, cmd: Extract<Command, { t: 'deploy' }>,
): CommandResult {
  if (!state.battle) return reject('deploy', 'no_battle');
  if (state.battle.phase !== 'deploy') return reject('deploy', 'not_deploying');
  const evs = applyDeploy(state, { wall: cmd.wall, gate: cmd.gate, reserve: cmd.reserve });
  if (!evs) return reject('deploy', 'bad_deploy');
  return ok(...evs);
}

function cmdBattleRound(state: WorldState, idx: ContentIndex): CommandResult {
  const b = state.battle;
  if (!b) return reject('battle_round', 'no_battle');
  if (b.phase !== 'fighting') return reject('battle_round', 'not_deploying');
  if (b.pending) return reject('battle_round', 'no_decision');
  return ok(...advanceRound(state, idx));
}

function cmdDecide(
  state: WorldState, cmd: Extract<Command, { t: 'decide' }>, idx: ContentIndex,
): CommandResult {
  if (!state.battle?.pending) return reject('decide', 'no_decision');
  const evs = applyDecision(state, idx, cmd.option);
  if (!evs) return reject('decide', 'bad_option');
  return ok(...evs);
}

function cmdBattleDismiss(state: WorldState): CommandResult {
  if (!dismissBattle(state)) return reject('battle_dismiss', 'no_battle');
  return ok();
}

/**
 * 流寇来袭。
 *
 * 这一条管的是**开局那一年的节奏**。太平期里若什么都不发生，
 * 玩家会在二十多分钟里只看着数字涨；而太平期一结束就迎面撞上一支
 * 打不过的正规军，又只会让人莫名其妙地输掉。
 *
 * 流寇给的是低风险的实战：人数跟着城池的规模走，永远打得过，
 * 输了也只是被抢一笔 —— 但足够把「部署与决断」这套东西教会。
 */
function maybeBandits(state: WorldState, idx: ContentIndex): SimEvent[] {
  if (state.battle) return [];
  // 武将没有城。
  //
  // 守城战整套是文官的东西 —— 城头、城门、预备队、城墙完损度，
  // 一样都套不到一座营上。营是野地里的一片帐篷，
  // 真要有人来攻，那也该是一场野战，不是攻城。
  // 在那之前，宁可让它不发生，也不要拿一套错的规则去凑。
  //
  // **主公同理，而且更要紧。** 他治下十几座城，哪一座都不是「他的城」——
  // 守城战那一套只认 `official.cityId` 那一座。
  // 少了这一句，主公会被拖进一场他没有界面、也不该由他亲手打的守城战，
  // 而 `cmdDay` 见了 `state.battle` 就拒绝推进 ——
  // 实测每一局都在第 61 天卡死，日子再也不走。
  if (state.role !== 'official') return [];
  const cityId = state.official.cityId;
  if (state.sieges[cityId]) return [];
  const city = state.cities[cityId];
  if (!city) return [];
  // 排期而不是打拍子。
  // 固定间隔会让每一局的流寇都落在同一天，跑两遍就能背出来 ——
  // 那不叫乱世，叫时刻表。
  const due = state.flags['nextBandit']
    ?? (BANDIT_FIRST_DAY + nextRange(state.rng, -8, 14));
  state.flags['nextBandit'] = due;
  if (state.day < due) return [];
  // 到日子也不一定就来，再抽一把；没来就往后推几天
  if (!chance(state.rng, 34)) {
    state.flags['nextBandit'] = state.day + nextRange(state.rng, 2, 9);
    return [];
  }
  state.flags['nextBandit'] = state.day
    + Math.round((BANDIT_INTERVAL * nextRange(state.rng, 55, 155)) / 100);

  // 流寇的规模**跟着守军走**，而且一波比一波强。
  //
  // 用绝对数字会出两种坏结果：给小了后期毫无威胁，给大了第一场就是当头一棒。
  // 跟着守军走，这一串遭遇就成了一条难度曲线：
  // 头一场是教学（多半守得住），往后逐次加码，逼你去修兵营和城墙。
  const wave = state.flags['banditWave'] ?? 0;
  state.flags['banditWave'] = wave + 1;
  const ratio = Math.min(2.1, 0.85 + wave * 0.22);
  const men = garrisonOf(city, idx);
  const hungry = city.morale < 45 ? 1.15 : 1;
  const troops = Math.max(
    40,
    Math.round(men * ratio * hungry) + nextRange(state.rng, 0, Math.max(6, Math.round(men * 0.2))),
  );

  state.sieges[cityId] = {
    cityId, factionId: BANDIT_ID, troops,
    supply: troops * 3,
    days: 0,
    assaultAfter: BANDIT_ASSAULT_AFTER,
  };
  return [{ t: 'siege_started', cityId, factionId: BANDIT_ID, troops }];
}

/**
 * 该不该擂鼓强攻。
 *
 * 围城本身是耗，中间会有几次强攻 —— 强攻才是玩家真正下场的时刻。
 * 只有玩家亲自守的城会走这条路，别处的围城仍旧自动结算：
 * 算力和玩家的注意力都该花在看得见的地方。
 */
function maybeAssault(state: WorldState, idx: ContentIndex): SimEvent[] {
  if (state.battle) return [];
  // 同上：武将不守城，主公也不亲手守城
  if (state.role !== 'official') return [];
  const cityId = state.official.cityId;
  const siege = state.sieges[cityId];
  if (!siege || !state.cities[cityId]) return [];
  const first = siege.assaultAfter ?? FIRST_ASSAULT_DAY;
  if (siege.days < first) return [];
  // 围到日子之后，每日抽一把。
  // 固定「每十四日一次」会让攻城方变成一张可以背的时刻表，
  // 而围城的一方什么时候下决心强攻，本来就是说不准的。
  const eager = siege.assaultAfter !== undefined ? 42 : 13;
  if (!chance(state.rng, eager)) return [];
  return startAssault(state, idx, cityId);
}

// ─────────────────────────────────────────────────────────────
// 野战
// ─────────────────────────────────────────────────────────────

/**
 * 出城迎击。
 *
 * 一座小城的县令本来只能缩在墙后面挨打。出击给的是另一条路：
 * 赢了当场解围，输了守军折损、接下来的城更难守。
 * 这是取舍，不是更优解 —— 所以它永远只是一个按钮，不是一条必经之路。
 */
function cmdSortie(state: WorldState, idx: ContentIndex): CommandResult {
  if (state.battle || state.field) return reject('sortie', 'in_battle');
  const cityId = state.official.cityId;
  if (!state.sieges[cityId]) return reject('sortie', 'sortie_needs_siege');
  const evs = startSortie(state, idx, cityId);
  if (evs.length === 0) return reject('sortie', 'no_field');
  return ok(...evs);
}

function cmdFieldDeploy(
  state: WorldState, cmd: Extract<Command, { t: 'field_deploy' }>,
): CommandResult {
  if (!state.field) return reject('field_deploy', 'no_field');
  const evs = applyFieldDeploy(state, cmd.places, cmd.formation);
  if (!evs) return reject('field_deploy', 'bad_place');
  return ok(...evs);
}

function cmdFieldBegin(state: WorldState): CommandResult {
  if (!state.field) return reject('field_begin', 'no_field');
  const evs = beginField(state);
  if (!evs) return reject('field_begin', 'not_deploying');
  return ok(...evs);
}

function cmdFieldRound(state: WorldState, idx: ContentIndex): CommandResult {
  const f = state.field;
  if (!f) return reject('field_round', 'no_field');
  if (f.phase !== 'fighting' || f.pending) return reject('field_round', 'no_decision');
  return ok(...advanceFieldRound(state, idx));
}

function cmdFieldDecide(
  state: WorldState, cmd: Extract<Command, { t: 'field_decide' }>, idx: ContentIndex,
): CommandResult {
  if (!state.field?.pending) return reject('field_decide', 'no_decision');
  const evs = applyFieldDecision(state, idx, cmd.option);
  if (!evs) return reject('field_decide', 'bad_option');
  return ok(...evs);
}

function cmdFieldDismiss(state: WorldState): CommandResult {
  if (!dismissField(state)) return reject('field_dismiss', 'no_field');
  return ok();
}

// ─────────────────────────────────────────────────────────────
// 派发
// ─────────────────────────────────────────────────────────────

export function applyCommand(state: WorldState, cmd: Command, idx: ContentIndex): CommandResult {
  switch (cmd.t) {
    case 'begin': return cmdBegin(state, cmd, idx);
    case 'day': return cmdDay(state, idx);
    case 'build': return cmdBuild(state, cmd, idx);
    case 'cancel_work': return cmdCancelWork(state, cmd, idx);
    case 'demolish': return cmdDemolish(state, cmd, idx);
    case 'pay': return cmdPay(state, cmd);
    case 'expand': return cmdExpand(state, idx);
    case 'fortify': return cmdFortify(state, idx);
    case 'deploy': return cmdDeploy(state, cmd);
    case 'battle_round': return cmdBattleRound(state, idx);
    case 'decide': return cmdDecide(state, cmd, idx);
    case 'battle_dismiss': return cmdBattleDismiss(state);
    case 'sortie': return cmdSortie(state, idx);
    case 'field_deploy': return cmdFieldDeploy(state, cmd);
    case 'field_begin': return cmdFieldBegin(state);
    case 'field_round': return cmdFieldRound(state, idx);
    case 'field_decide': return cmdFieldDecide(state, cmd, idx);
    case 'field_dismiss': return cmdFieldDismiss(state);
    case 'camp_work': return cmdCampWork(state, cmd, idx);
    case 'camp_cancel': return cmdCampCancel(state, cmd);
    case 'camp_farm': return cmdCampFarm(state, cmd);
    case 'ration_ask': return cmdRationAsk(state, cmd);
    case 'forage': return cmdForage(state, cmd);
    case 'campaign_open': return cmdCampaignOpen(state, cmd, idx);
    case 'campaign_close': return cmdCampaignClose(state);
    case 'campaign_plan': return cmdCampaignPlan(state, cmd);
    case 'campaign_go': return cmdCampaignGo(state, idx);
    case 'theatre_open': return cmdTheatreOpen(state, cmd, idx);
    case 'theatre_close': return cmdTheatreClose(state);
    case 'theatre_send': return cmdTheatreSend(state, cmd, idx);
    case 'theatre_recall': return cmdTheatreRecall(state, cmd);
    case 'theatre_scout': return cmdTheatreScout(state, idx);
    case 'theatre_duel_accept': return cmdDuelAccept(state);
    case 'theatre_duel_refuse': return cmdDuelRefuse(state);
    case 'theatre_begin': return cmdTheatreBegin(state);
    case 'theatre_withdraw': return cmdTheatreWithdraw(state);
    case 'theatre_step': return cmdTheatreStep(state, cmd);
    case 'theatre_dismiss': return cmdTheatreDismiss(state);
    case 'recommend': return cmdRecommend(state, cmd, idx);
    case 'lord_appoint': return cmdLordAppoint(state, cmd, idx);
    case 'lord_march': return cmdLordMarch(state, cmd, idx);
    case 'lord_muster': return cmdLordMuster(state, cmd, idx);
    case 'lord_invest': return cmdLordInvest(state, cmd, idx);
    case 'lord_envoy': return cmdLordEnvoy(state, cmd, idx);
    case 'court_reply': return cmdCourtReply(state, cmd, idx);
    case 'court_relief': return cmdCourtRelief(state, cmd, idx);
    case 'court_succeed': return cmdSucceed(state, idx);
    case 'court_next': return cmdCourtNext(state);
    case 'court_adjourn': return cmdAdjourn(state, idx);
    case 'lord_claim': return cmdLordClaim(state, idx);
    case 'lord_road': return cmdLordRoad(state, cmd, idx);
    case 'lord_levy': return cmdLordLevy(state, cmd, idx);
    case 'lord_edict': return cmdLordEdict(state, cmd, idx);
    case 'lord_plot': return cmdPlot(state, cmd, idx);
    case 'lord_camp_open': return cmdCampOpen(state, cmd, idx);
    case 'lord_camp_close': return cmdCampClose(state, cmd);
    case 'lord_draft': return cmdDraft(state, cmd);
    case 'lord_camp_march': return cmdCampMarch(state, cmd, idx);
    case 'situation_answer': {
      const evs = answerSituation(state, idx, cmd.option);
      if (evs.length === 0) return reject('situation_answer', 'no_situation');
      settleOthers(state, idx);
      return ok(...evs);
    }
    case 'situation_close': closeSituation(state); return ok();
    case 'order_accept': return cmdOrderAccept(state);
    case 'order_defy': return cmdOrderDefy(state);
    case 'order_tribute': return cmdOrderTribute(state);
  }
}

export { EXPAND_COIN, EXPAND_DEV, EXPAND_GRAIN };
export type { BuildingDef };
/** 季度起始日，UI 显示进度用 */
export { quarterStartDay };
