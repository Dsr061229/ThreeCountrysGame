/**
 * 战场的命令。
 *
 * 一场仗走五步：
 *
 *   出兵 —— 全营开拔，指定要打哪一处
 *   派将 —— 在图上点位置，一支一支地派出去
 *   击鼓 —— 派完了才开打。开打之后就收不回来了
 *   推进 —— 一拍一拍地打，界面按实时时钟连发
 *   收兵 —— 结算战功、缴获、折损
 *
 * 「派将」与「击鼓」分开，和野战那边「布阵」与「开打」分开是同一个道理：
 * 凡是「摆」与「动」，一律分开。
 */
import type { ContentIndex } from './content.ts';
import type { WorldState } from './state.ts';
import type { Command, CommandResult, SimEvent } from './commands.ts';
import { makeTheatre, newUnit } from './theatre_setup.ts';
import { closeDuel, stepTheatre } from './theatre.ts';
import { cellAt } from './theatre_map.ts';
import {
  CAMPAIGN_REST, MAX_UNITS, MIN_MEN,
  DUEL_REFUSE_MORALE, HURT_DAYS, HURT_DAYS_SELF,
  SCOUT_GAIN, SCOUT_GRAZE, SCOUT_LIE, SCOUT_MAX, SCOUT_MEN,
  SPOILS_PER_FOE, type Theatre,
} from './theatre_types.ts';
import { STARTING_CAMP } from './general_types.ts';
import { campOutput } from './camp.ts';
import { chancePermille, nextInt } from './rng.ts';
import { orderProgress } from './handlers_order.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function ok(...events: SimEvent[]): CommandResult {
  return { ok: true, events };
}
function reject(cmd: Command['t'], reasonId: string): CommandResult {
  return { ok: false, events: [{ t: 'rejected', cmd, reasonId }] };
}

function theCamp(state: WorldState) {
  return state.camps[STARTING_CAMP] ?? Object.values(state.camps)[0];
}

/**
 * 出兵。
 *
 * **全营出动** —— 不是「派多少人去」，是整座营开拔。
 * 分兵是到了战场上才做的事，那时你才看得见地形。
 */
/**
 * 这一趟兵出不出得了。出得了返回 null，出不了返回理由。
 *
 * **界面和命令必须问同一个函数。**
 *
 * 原先这两头是各写各的：命令这边查了屯田、兵力、休整期、是不是自家的城；
 * 而天下图上那颗按钮只看了一句 `!c && !camp.farming`。
 * 于是按钮说「出兵」，点下去却被挡回来 ——
 * 玩家看到的就是「按了没反应」。
 *
 * 分成两处写的判定，迟早会分岔。
 */
export function whyNotMarch(state: WorldState, targetNodeId: string): string | null {
  if (state.role !== 'general') return 'not_general';
  if (state.theatre) return 'already_open';
  if (state.field || state.battle) return 'in_battle';
  if (state.campaign) return 'marching';

  const camp = theCamp(state);
  if (!camp) return 'no_camp';
  if (camp.farming) return 'farming';
  if (camp.troops < MIN_MEN * 2) return 'too_few';
  // 刚打完一仗的军队没法第二天又出现在另一座城下
  if (state.day < (state.flags['campaignRest'] ?? 0)) return 'resting';

  const target = state.nodes[targetNodeId];
  if (!target) return 'no_such_place';
  // 自家的城只有被围时才去 —— 那是去救，打的是城下那支兵
  if (target.factionId === state.official.lordId && !state.sieges[targetNodeId]) {
    return 'own_city';
  }
  return null;
}

export function cmdTheatreOpen(
  state: WorldState, cmd: Extract<Command, { t: 'theatre_open' }>, idx: ContentIndex,
): CommandResult {
  const no = whyNotMarch(state, cmd.targetNodeId);
  if (no) return reject('theatre_open', no);

  const camp = theCamp(state)!;
  const target = state.nodes[cmd.targetNodeId]!;
  const t = makeTheatre(state, idx, camp, cmd.targetNodeId);
  if (!t) return reject('theatre_open', 'no_such_place');
  state.theatre = t;

  return ok({
    t: 'theatre_opened', targetNodeId: cmd.targetNodeId, foeTroops: target.troops,
  });
}

export function cmdTheatreClose(state: WorldState): CommandResult {
  const t = state.theatre;
  if (!t) return reject('theatre_close', 'no_theatre');
  if (t.phase !== 'orders') return reject('theatre_close', 'already_fighting');
  state.theatre = null;
  return ok();
}

/**
 * 派一支兵上去。
 *
 * 位置是玩家在图上点的，所以这里要挡住不合理的位置 ——
 * 站在水里的伏兵不叫伏兵，叫送死。
 */
export function cmdTheatreSend(
  state: WorldState, cmd: Extract<Command, { t: 'theatre_send' }>, idx: ContentIndex,
): CommandResult {
  const t = state.theatre;
  if (!t) return reject('theatre_send', 'no_theatre');
  if (t.phase !== 'orders') return reject('theatre_send', 'already_fighting');

  const mine = t.units.filter((u) => u.side === 'own');
  if (mine.length >= MAX_UNITS) return reject('theatre_send', 'too_many');

  const men = Math.floor(cmd.men);
  if (men < MIN_MEN) return reject('theatre_send', 'too_few');
  if (men > t.pool[cmd.kind]) return reject('theatre_send', 'not_enough');

  const col = clamp(cmd.col, 0, t.cols - 1);
  const row = clamp(cmd.row, 0, t.rows - 1);
  const cell = cellAt(t.cells, col, row);
  if (cell.ground === 'water') return reject('theatre_send', 'in_water');
  // 平地上伏不了人。这一条要挡在命令层，不能只写在提示里
  if (cmd.stance === 'ambush' && cell.ground !== 'forest'
    && cell.ground !== 'hill' && cell.ground !== 'marsh') {
    return reject('theatre_send', 'no_cover');
  }

  t.pool[cmd.kind] -= men;
  const u = newUnit(state, 'own', cmd.kind, men, t.ownCamp[0] + 1.2, t.ownCamp[1]);
  u.toX = col;
  u.toY = row;
  u.stance = cmd.stance;
  u.officerId = cmd.officerId;
  // 战报上叫得出名字。没有名字的部队，打赢打输都只是一行数字
  // 挂了彩的人上不了阵。伤是要养的
  if (cmd.officerId) {
    const well = state.hurt[cmd.officerId] ?? 0;
    if (state.day < well) return reject('theatre_send', 'officer_hurt');
  }
  const led = cmd.officerId ? idx.person.get(cmd.officerId) : null;
  u.name = cmd.officerId ? (led?.name ?? '偏将') + '部' : '你亲领';
  // 领这一路的人叫什么。敌将搦战要指名道姓，没有名字就斗不起来
  u.leader = led?.name ?? state.official.name;
  if (led) {
    // 带兵的人是谁，在刀口上是要算数的 —— 见 Unit.valor 上面那段
    u.valor = led.valor;
    u.command = led.command;
    u.wit = led.wit;
    // 部将的性子跟着走。走样、抗命都看它
    u.temper = led.temper;
  } else {
    /**
     * 你亲领的那一路。
     *
     * 你自己的本事跟着军职走 —— 一个当了四年校尉的人，
     * 带出来的兵和开局那个裨将不是一回事。
     * 这也是「升迁」除了粮额之外的第二样实处。
     */
    const step = state.official.rank * 9;
    u.valor = clamp(52 + step, 0, 96);
    u.command = clamp(56 + step, 0, 96);
    u.wit = clamp(50 + step, 0, 96);
  }
  // 伏兵开打前就该在位上藏好 —— 一路走过去早被看见了
  if (cmd.stance === 'ambush') {
    u.x = col;
    u.y = row;
    u.hidden = true;
  }
  t.units.push(u);

  return ok({ t: 'theatre_sent', unitId: u.id, men, kind: cmd.kind });
}

/** 收回一支还没出发的兵 */
export function cmdTheatreRecall(
  state: WorldState, cmd: Extract<Command, { t: 'theatre_recall' }>,
): CommandResult {
  const t = state.theatre;
  if (!t) return reject('theatre_recall', 'no_theatre');
  if (t.phase !== 'orders') return reject('theatre_recall', 'already_fighting');
  const i = t.units.findIndex((u) => u.id === cmd.unitId && u.side === 'own');
  if (i < 0) return reject('theatre_recall', 'no_such_unit');
  const u = t.units[i]!;
  t.pool[u.kind] += u.men;
  t.units.splice(i, 1);
  return ok();
}

/**
 * 派一拨细作。
 *
 * 四种下场，一种比一种糟：
 *
 *   **探明** —— 敌情清楚了一大截，而且能把对面藏着的那一支指出来。
 *              这是这条线上唯一能提前看破埋伏的办法。
 *   **只摸到边** —— 加一点点，聊胜于无。
 *   **没回来** —— 三十个人白搭，什么也没带回来。
 *   **中了计** —— 最坏的一种：他带回来一个**言之凿凿的假数目**，
 *                而界面上它和真的长得一模一样。
 *                你要到击鼓之后才知道自己信错了话。
 *
 * 探得成不成，看的是营里练得怎么样、扎在什么地方 ——
 * 和开局那个 `intel` 是同一套东西（见 makeTheatre）。
 * 这一条要紧：细作不是一个独立的骰子，
 * 它是「你把营经营成什么样」在战场上的又一次兑现。
 */
export function cmdTheatreScout(
  state: WorldState, idx: ContentIndex,
): CommandResult {
  const t = state.theatre;
  if (!t) return reject('theatre_scout', 'no_theatre');
  if (t.phase !== 'orders') return reject('theatre_scout', 'already_fighting');
  if (t.scouts >= SCOUT_MAX) return reject('theatre_scout', 'no_more_scouts');
  if (t.pool.foot < SCOUT_MEN) return reject('theatre_scout', 'too_few');

  const camp = theCamp(state);
  if (!camp) return reject('theatre_scout', 'no_camp');

  t.pool.foot -= SCOUT_MEN;
  t.scouts += 1;

  // 本事：练得好的探得出去，扎在林中的探子回得来。
  // 已经探过一遍之后，剩下的都是难啃的 —— 一拨比一拨难
  const out = campOutput(camp, idx);
  const skill = clamp(
    26 + Math.floor(camp.training / 2) + Math.floor(out.cover / 3)
    - (t.scouts - 1) * 12,
    5, 92,
  );

  // 探明 / 中计 / 没回来 / 只摸到边
  if (chancePermille(state.rng, skill * 10)) {
    t.intel = clamp(t.intel + SCOUT_GAIN, 0, 100);
    // 探明了就该看得见他藏的那一支 —— 这是提前看破埋伏的唯一门路
    const hidden = t.units.find((u) => u.side === 'foe' && u.hidden && !u.revealed);
    if (hidden) { hidden.hidden = false; hidden.revealed = true; }
    t.report = { men: trueFoeMen(t), sound: true, wave: t.scouts };
    return ok(
      { t: 'theatre_scouted', kind: 'clear', men: SCOUT_MEN },
      {
        t: 'notice',
        textId: hidden ? 'notice.scout_ambush' : 'notice.scout_clear',
        vars: { men: t.report.men },
        tone: 'good',
      },
    );
  }

  // 探不明白的时候，坏事各占一份
  const roll = nextInt(state.rng, 3);
  if (roll === 0) {
    // 中了计：一份说得有鼻子有眼的假数目
    const real = trueFoeMen(t);
    const off = chancePermille(state.rng, 500) ? SCOUT_LIE : -SCOUT_LIE;
    const said = Math.max(40, Math.round((real * (1000 + off)) / 1000 / 10) * 10);
    t.intel = clamp(t.intel + SCOUT_GAIN, 0, 100);
    t.report = { men: said, sound: false, wave: t.scouts };
    return ok(
      { t: 'theatre_scouted', kind: 'duped', men: SCOUT_MEN },
      { t: 'notice', textId: 'notice.scout_clear', vars: { men: said }, tone: 'good' },
    );
  }
  if (roll === 1) {
    // 没回来。三十个人就这么没了
    return ok(
      { t: 'theatre_scouted', kind: 'lost', men: SCOUT_MEN },
      { t: 'notice', textId: 'notice.scout_lost', vars: {}, tone: 'bad' },
    );
  }
  t.intel = clamp(t.intel + SCOUT_GRAZE, 0, 100);
  return ok(
    { t: 'theatre_scouted', kind: 'graze', men: SCOUT_MEN },
    { t: 'notice', textId: 'notice.scout_graze', vars: {}, tone: 'plain' },
  );
}

/** 城下真有多少人。细作说的那个数不一定是它 */
function trueFoeMen(t: Theatre): number {
  return Math.round(
    t.units.filter((u) => u.side === 'foe').reduce((a, u) => a + u.men, 0) / 10,
  ) * 10;
}

/**
 * 出马应战。
 *
 * 这一下是**押上去的**：赢了三军振奋，输了三军夺气，
 * 而且很可能就此折掉一员好将 —— 或者你自己躺回营里养两个月。
 */
export function cmdDuelAccept(state: WorldState): CommandResult {
  const t = state.theatre;
  if (!t) return reject('theatre_duel_accept', 'no_theatre');
  const d = t.duel;
  if (!d || d.state !== 'offered') return reject('theatre_duel_accept', 'no_duel');
  d.state = 'fighting';
  // 从这一拍起数合数
  d.offeredAt = t.tick;
  t.log.push({
    tick: t.tick, textId: 'th.duel_on', tone: 'plain',
    vars: { who: d.ownName, foe: d.foeName },
  });
  return ok({ t: 'theatre_event', textId: 'th.duel_on', tone: 'plain' });
}

/**
 * 不理他。
 *
 * 「将在外」不是什么都得接。避战是一个正当的选择 ——
 * 但两军都看着，拒战就是示弱，本方当场夺气。
 * 人还在，气没了。
 */
export function cmdDuelRefuse(state: WorldState): CommandResult {
  const t = state.theatre;
  if (!t) return reject('theatre_duel_refuse', 'no_theatre');
  const d = t.duel;
  if (!d || d.state !== 'offered') return reject('theatre_duel_refuse', 'no_duel');
  d.state = 'done';
  d.outcome = 'refused';
  for (const u of t.units) {
    if (u.routed) continue;
    if (u.side === 'own') u.morale = clamp(u.morale - DUEL_REFUSE_MORALE, 0, 100);
    else u.morale = clamp(u.morale + Math.round(DUEL_REFUSE_MORALE / 2), 0, 100);
  }
  t.log.push({
    tick: t.tick, textId: 'th.duel_refused', tone: 'bad',
    vars: { who: d.ownName, foe: d.foeName },
  });
  const evs = settleDuelAftermath(state, t);
  return ok(
    {
      t: 'duel_settled', outcome: 'refused', fatal: false,
      who: d.ownName, foe: d.foeName,
      rounds: d.round, ownWins: d.ownWins, foeWins: d.foeWins,
    },
    ...evs,
  );
}

/**
 * 斗将在**战场之外**留下的东西。
 *
 * 场上的士气涨落在 theatre.ts 里算完了；这里管的是带得回营的账：
 * 折了的部将从帐下除名，负伤的要将养一段日子。
 * 少了这一段，斗将就只是一次性的士气波动 ——
 * 而它真正的分量恰恰在于**你可能永远失去这个人**。
 */
export function settleDuelAftermath(state: WorldState, t: Theatre): SimEvent[] {
  const d = t.duel;
  if (!d || d.state !== 'done') return [];
  const events: SimEvent[] = [];

  if (d.outcome === 'lost') {
    if (d.ownOfficerId) {
      const name = d.ownName;
      if (d.fatal) {
        state.retinue = state.retinue.filter((id) => id !== d.ownOfficerId);
        delete state.hurt[d.ownOfficerId];
        events.push({
          t: 'notice', textId: 'notice.officer_slain', vars: { name }, tone: 'bad',
        });
      } else {
        state.hurt[d.ownOfficerId] = state.day + HURT_DAYS;
        events.push({
          t: 'notice', textId: 'notice.officer_hurt',
          vars: { name, days: HURT_DAYS }, tone: 'bad',
        });
      }
    } else {
      /**
       * 输的是你自己。
       *
       * 让玩家在一次单挑里直接出局太粗暴 —— 一局打了几年，
       * 折在一个随机数上，那不叫难，叫扫兴。
       * 所以是重伤：亲兵把你抢回来，这一仗当场就得收，
       * 然后躺两个月。够疼，而且这两个月里天下是会变的。
       */
      state.flags['campaignRest'] = state.day + HURT_DAYS_SELF;
      t.pullingAt = t.tick;
      events.push({
        t: 'notice', textId: 'notice.self_hurt',
        vars: { days: HURT_DAYS_SELF }, tone: 'bad',
      });
    }
  }

  closeDuel(t);
  return events;
}

/** 击鼓。派完了才开打 */
export function cmdTheatreBegin(state: WorldState): CommandResult {
  const t = state.theatre;
  if (!t) return reject('theatre_begin', 'no_theatre');
  if (t.phase !== 'orders') return reject('theatre_begin', 'already_fighting');
  const mine = t.units.filter((u) => u.side === 'own');
  if (mine.length === 0) return reject('theatre_begin', 'no_units');

  // 没派出去的人留在营里看家 —— 他们不参战，但也不会死
  t.phase = 'fighting';
  const own = mine.reduce((a, u) => a + u.men, 0);
  const foe = t.units.filter((u) => u.side === 'foe').reduce((a, u) => a + u.men, 0);
  return ok({ t: 'theatre_begun', own, foe });
}

/**
 * 打若干拍。
 *
 * 界面按实时时钟连发这条命令，一次几拍 ——
 * 一拍一条命令会把命令流撑爆（一场仗好几百拍），
 * 一次打完又看不见过程。几拍一发是两头的折中。
 */
export function cmdTheatreStep(
  state: WorldState, cmd: Extract<Command, { t: 'theatre_step' }>,
): CommandResult {
  const t = state.theatre;
  if (!t) return reject('theatre_step', 'no_theatre');
  if (t.phase !== 'fighting') return reject('theatre_step', 'not_fighting');

  const events: SimEvent[] = [];
  const n = clamp(Math.floor(cmd.ticks), 1, 30);
  for (let i = 0; i < n; i++) {
    if (t.phase !== 'fighting') break;
    for (const line of stepTheatre(t, state.rng)) {
      events.push({
        t: 'theatre_event',
        textId: line.textId,
        tone: line.tone,
        ...(line.at ? { at: line.at } : {}),
        ...(line.vars ? { vars: line.vars } : {}),
      });
    }
  }
  // 斗将收了场，战场之外的账在这儿结：折的除名，伤的将养
  if (t.duel && t.duel.state === 'done') {
    const d = t.duel;
    events.push({
      t: 'duel_settled',
      outcome: d.outcome ?? 'draw',
      fatal: d.fatal, who: d.ownName, foe: d.foeName,
      rounds: d.round, ownWins: d.ownWins, foeWins: d.foeWins,
    });
    events.push(...settleDuelAftermath(state, t));
  }
  if (t.outcome !== null) events.push(...settleTheatre(state, t));
  return ok(...events);
}

/**
 * 鸣金收兵。
 *
 * 打起来之后**必须有一条退路** —— 这一条原先根本不存在。
 * 你要是按兵不动，对面又守着工事不出来，两军就这么对望到天黑：
 * 实测九百拍里只写出两行战报，而观战那一屏上一个能点的按钮都没有。
 * 玩家的原话是「游戏卡住走不了」。他说得对。
 *
 * 撤不是白撤：正咬着的人要挨断后的刀（见 REARGUARD），
 * 战功没有，主公那边也不好交代。
 * 但「打不过就走」本来就是将领手里最要紧的一个决定，
 * 它必须是一个**能按下去的按钮**。
 */
export function cmdTheatreWithdraw(state: WorldState): CommandResult {
  const t = state.theatre;
  if (!t) return reject('theatre_withdraw', 'no_theatre');
  if (t.phase !== 'fighting') return reject('theatre_withdraw', 'not_fighting');
  if (t.pullingAt >= 0) return reject('theatre_withdraw', 'already_pulling');
  t.pullingAt = t.tick;
  t.log.push({ tick: t.tick, textId: 'th.gong', tone: 'plain' });
  return ok({ t: 'theatre_event', textId: 'th.gong', tone: 'plain' });
}

/** 看完战报，收兵 */
export function cmdTheatreDismiss(state: WorldState): CommandResult {
  const t = state.theatre;
  if (!t) return reject('theatre_dismiss', 'no_theatre');
  if (t.phase !== 'done') return reject('theatre_dismiss', 'still_fighting');
  state.theatre = null;
  return ok();
}

/**
 * 收场。
 *
 * 折损记在营上，战功记在你身上，缴获进营里的仓。
 * 打赢了，那处的守军实打实地少一批 —— 天下图上看得见。
 */
function settleTheatre(state: WorldState, t: Theatre): SimEvent[] {
  const camp = theCamp(state);
  const sent = t.units
    .filter((u) => u.side === 'own')
    .reduce((a, u) => a + u.men0, 0);
  const left = t.units
    .filter((u) => u.side === 'own' && !u.routed)
    .reduce((a, u) => a + u.men, 0);
  // 溃散的人不是全死了 —— 跑散的过些日子回来一半
  const routedMen = t.units
    .filter((u) => u.side === 'own' && u.routed)
    .reduce((a, u) => a + u.men, 0);
  const back = left + Math.floor(routedMen / 2);
  const lost = Math.max(0, sent - back);

  const foeSent = t.units.filter((u) => u.side === 'foe').reduce((a, u) => a + u.men0, 0);
  const foeLeft = t.units
    .filter((u) => u.side === 'foe' && !u.routed)
    .reduce((a, u) => a + u.men, 0);
  const foeLost = Math.max(0, foeSent - foeLeft);

  // 回营休整。这段日子出不了兵
  state.flags['campaignRest'] = state.day + CAMPAIGN_REST;

  const won = t.outcome === 'won';
  let merit = 0;
  let spoils = 0;

  if (camp) {
    camp.troops = Math.max(0, camp.troops - lost);
    camp.morale = clamp(camp.morale + (won ? 7 : -9), 0, 100);
  }

  if (won) {
    // 战功给得薄一点。上一版一仗能拿七十，十几仗就封顶了
    merit = 12 + Math.floor(foeLost / 26);
    // 因粮于敌 —— 这条线的第三条粮道
    spoils = Math.floor((foeLost * SPOILS_PER_FOE) / 100);
    if (camp) camp.grain += spoils;
    state.official.merit += merit;
    state.official.trust = clamp(state.official.trust + 4, 0, 100);
    const node = state.nodes[t.targetNodeId];
    if (node) node.troops = Math.max(0, node.troops - foeLost);
  } else {
    state.official.trust = clamp(state.official.trust - 3, 0, 100);
  }

  // 账记在战场上，战报才查得到 —— 只发一次事件，界面是接不住的
  t.result = { sent, back, lost, foeLost, merit, spoils };

  // 这一仗要是正好办了主公交代的差，就地交令
  const orderEvents = orderProgress(state, t.targetNodeId, won);

  return [
    {
      t: 'theatre_done',
      outcome: t.outcome ?? 'withdrew',
      lost, foeLost, merit, spoils,
    },
    ...orderEvents,
  ];
}
