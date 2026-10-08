/**
 * 守城战。
 *
 * 围城原本是全自动结算的 —— 玩家只能看着数字往下掉，
 * 而那恰恰是这条路线上最有戏剧性的时刻。
 *
 * 打法遵循方案里定下的形状：**战前部署 + 战中两三次决断**。
 * 部署决定基础的攻守交换率，决断改的是**修正**而不是结果 ——
 * 与楔子同一个道理：玩家改的是形势，不是胜负本身。
 */
import { chance, nextInt, nextRange } from './rng.ts';
import { currentCity, type WorldState } from './state.ts';
import type { ContentIndex } from './content.ts';
import type { SimEvent } from './commands.ts';
import { garrisonOf } from './worldtick.ts';
import { BANDIT_ID } from './world_types.ts';
import {
  ASSAULT_ROUNDS, MORALE_BREAK,
  type Battle, type BattleDecision, type BattleEffect, type DefenceDeploy,
} from './battle_types.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ─────────────────────────────────────────────────────────────
// 开战
// ─────────────────────────────────────────────────────────────

/** 敌军擂鼓强攻。只有玩家亲自守的城才会走到这里 */
export function startAssault(
  state: WorldState, _idx: ContentIndex, cityId: string,
): SimEvent[] {
  if (state.battle) return [];
  const siege = state.sieges[cityId];
  const node = state.nodes[cityId];
  const city = state.cities[cityId];
  if (!siege || !node || !city) return [];

  const men = Math.max(1, node.troops);
  // 默认布置：一半上城头，其余分给城门与预备。玩家可以在开打前改
  const wall = Math.floor(men * 0.5);
  const gate = Math.floor(men * 0.25);
  const battle: Battle = {
    kind: 'defend',
    cityId,
    attackerId: siege.factionId,
    round: 0,
    maxRounds: ASSAULT_ROUNDS,
    phase: 'deploy',
    deploy: { wall, gate, reserve: men - wall - gate },
    defMen: men,
    /** 开打时有多少人。用来算折损 —— defMen 是会掉的 */
    defMen0: men,
    atkMen: siege.troops,
    // 守军的斗志跟着民心走 —— 一座人心已散的城，守军也没有理由拼命
    defMorale: clamp(38 + Math.floor(city.morale * 0.55), 20, 92),
    atkMorale: clamp(48 + Math.floor((siege.troops * 20) / Math.max(1, men * 4)), 30, 90),
    wallIntegrity: clamp(58 + city.wall * 13, 30, 100),
    defLossMod: 1000,
    atkLossMod: 1000,
    pending: null,
    usedDecisions: [],
    log: [],
    outcome: null,
  };
  state.battle = battle;

  return [{
    t: 'assault_begun',
    cityId,
    factionId: siege.factionId,
    attackers: siege.troops,
    defenders: men,
  }];
}

// ─────────────────────────────────────────────────────────────
// 部署
// ─────────────────────────────────────────────────────────────

export function applyDeploy(state: WorldState, d: DefenceDeploy): SimEvent[] | null {
  const b = state.battle;
  if (!b || b.phase !== 'deploy') return null;
  const wall = Math.max(0, Math.floor(d.wall));
  const gate = Math.max(0, Math.floor(d.gate));
  const reserve = Math.max(0, Math.floor(d.reserve));
  if (wall + gate + reserve !== b.defMen) return null;

  b.deploy = { wall, gate, reserve };
  b.phase = 'fighting';
  return [{ t: 'assault_deployed', wall, gate, reserve }];
}

// ─────────────────────────────────────────────────────────────
// 一轮交换
// ─────────────────────────────────────────────────────────────

/**
 * 打一轮。
 *
 * 若这一轮触发了决断，就把它挂在 pending 上并**停在这里** ——
 * 战斗要等玩家做完选择才继续。
 */
export function advanceRound(state: WorldState, idx: ContentIndex): SimEvent[] {
  const b = state.battle;
  if (!b || b.phase !== 'fighting' || b.pending) return [];

  b.round += 1;
  const events: SimEvent[] = [];

  const total = Math.max(1, b.deploy.wall + b.deploy.gate + b.deploy.reserve);
  const rawWall = b.deploy.wall / total;
  const gateShare = b.deploy.gate / total;
  const reserveShare = b.deploy.reserve / total;

  // 城头站得下的人是有限的。超过一半之后再堆人，多出来的只是挤在马道上 ——
  // 少了这道递减，「全压城头」会是永远的最优解，部署就不再是一个选择。
  const wallShare = rawWall <= 0.55 ? rawWall : 0.55 + (rawWall - 0.55) * 0.25;

  const wallFactor = b.wallIntegrity / 100;
  const defSpirit = 0.55 + (b.defMorale / 100) * 0.75;
  const atkSpirit = 0.55 + (b.atkMorale / 100) * 0.75;

  // 攻方折损：主要来自城头的压制。城墙越完好，居高临下越有效。
  // 城头的权重给得很重 —— 它是「打崩对方、逼他退兵」这条取胜路径的唯一来源
  const atkLoss = Math.max(4, Math.round(
    b.atkMen * (0.024 + wallShare * 0.082) * (0.42 + wallFactor * 0.58) * defSpirit
    * (b.atkLossMod / 1000) * (0.85 + nextInt(state.rng, 30) / 100),
  ));

  // 守方折损：来自蚁附。城头人多能分摊，预备队随时补缺口，城墙破了就挡不住。
  // 预备队的权重给得比城头高 —— 它的价值正在于「哪里破了往哪里堵」
  const defLoss = Math.max(2, Math.round(
    b.atkMen * 0.024 * atkSpirit
    / (1 + wallShare * 0.62 + reserveShare * 1.05)
    * (1.55 - wallFactor * 0.65)
    * (b.defLossMod / 1000) * (0.85 + nextInt(state.rng, 30) / 100),
  ));

  // 撞门。城门无人则一轮就能撞掉一大块 ——
  // 撞门必须真的危险，否则城门那一处永远不值得派人
  const ram = Math.max(0, Math.round(
    (b.atkMen / 78) * Math.max(0.06, 1 - gateShare * 2.6)
    * (0.7 + nextInt(state.rng, 60) / 100),
  ));

  b.atkMen = Math.max(0, b.atkMen - atkLoss);
  b.defMen = Math.max(0, b.defMen - defLoss);
  b.wallIntegrity = clamp(b.wallIntegrity - ram, 0, 100);

  // 按比例把损失摊回三处布置
  scaleDeploy(b);

  // 士气：伤亡越重掉得越快。
  //
  // 攻方的士气对伤亡格外敏感 —— 仰攻城墙的一方本来就更容易泄气，
  // 而这正是「城头」这个布置的取胜路径：不是熬到最后，是把他打退。
  b.defMorale = clamp(b.defMorale - 2 - Math.floor((defLoss * 30) / Math.max(1, b.defMen + defLoss)), 0, 100);
  b.atkMorale = clamp(b.atkMorale - 2 - Math.floor((atkLoss * 62) / Math.max(1, b.atkMen + atkLoss)), 0, 100);

  // 修正只作用一轮
  b.defLossMod = 1000;
  b.atkLossMod = 1000;

  events.push({ t: 'assault_round', round: b.round, defLoss, atkLoss, ram });
  b.log.push({
    round: b.round, textId: 'bt.exchange',
    vars: { defLoss, atkLoss }, tone: 'plain',
  });
  if (ram > 0 && b.wallIntegrity < 55) {
    b.log.push({ round: b.round, textId: 'bt.wall_crumbling', vars: {}, tone: 'bad' });
  }

  // 胜负先判，判完了才谈下一个决断
  const done = checkOutcome(state, idx);
  if (done.length > 0) return [...events, ...done];

  const decision = pickDecision(state, idx);
  if (decision) {
    b.pending = decision;
    b.usedDecisions.push(decision.id);
    events.push({ t: 'assault_decision', id: decision.id });
    return events;
  }

  if (b.round >= b.maxRounds) events.push(...finish(state, idx, 'held'));
  return events;
}

/** 损失按当前比例摊回三处 */
function scaleDeploy(b: Battle): void {
  const old = b.deploy.wall + b.deploy.gate + b.deploy.reserve;
  if (old <= 0) { b.deploy = { wall: 0, gate: 0, reserve: 0 }; return; }
  const k = b.defMen / old;
  const wall = Math.floor(b.deploy.wall * k);
  const gate = Math.floor(b.deploy.gate * k);
  b.deploy = { wall, gate, reserve: Math.max(0, b.defMen - wall - gate) };
}

// ─────────────────────────────────────────────────────────────
// 决断
// ─────────────────────────────────────────────────────────────

function pickDecision(state: WorldState, idx: ContentIndex): BattleDecision | null {
  const b = state.battle!;
  const fits = idx.db.battle.filter((d) => {
    if (b.usedDecisions.includes(d.id)) return false;
    const w = d.when;
    if (w.minRound !== undefined && b.round < w.minRound) return false;
    if (w.maxRound !== undefined && b.round > w.maxRound) return false;
    if (w.maxWall !== undefined && b.wallIntegrity > w.maxWall) return false;
    if (w.minAtkMorale !== undefined && b.atkMorale < w.minAtkMorale) return false;
    if (w.maxAtkMorale !== undefined && b.atkMorale > w.maxAtkMorale) return false;
    if (w.maxDefMorale !== undefined && b.defMorale > w.maxDefMorale) return false;
    return true;
  });
  if (fits.length === 0) return null;

  // 一场强攻最多出三次决断 —— 再多就成了问答题
  if (b.usedDecisions.length >= 3) return null;

  const def = fits[nextInt(state.rng, fits.length)]!;
  const faction = idx.faction.get(b.attackerId);
  return {
    id: def.id,
    textId: def.textId,
    vars: { faction: faction?.name ?? '', round: b.round, atk: b.atkMen, def: b.defMen },
    options: def.options.map((o) => ({
      textId: o.textId, hintId: o.hintId, effect: o.effect,
    })),
    round: b.round,
  };
}

export function applyDecision(
  state: WorldState, idx: ContentIndex, option: number,
): SimEvent[] | null {
  const b = state.battle;
  if (!b?.pending) return null;
  const opt = b.pending.options[option];
  if (!opt) return null;

  const events: SimEvent[] = [];
  const chosen = opt.textId;
  b.pending = null;

  const outcome = applyEffect(state, b, opt.effect);
  b.log.push({
    round: b.round, textId: chosen, vars: {},
    tone: outcome === 'lose' ? 'bad' : outcome === 'win' ? 'good' : 'plain',
  });
  events.push({ t: 'assault_decided', textId: chosen, gambled: outcome });

  const done = checkOutcome(state, idx);
  if (done.length > 0) return [...events, ...done];
  if (b.round >= b.maxRounds) events.push(...finish(state, idx, 'held'));
  return events;
}

/** 施加一条后果。返回赌局结果（若有） */
function applyEffect(
  state: WorldState, b: Battle, e: BattleEffect,
): 'win' | 'lose' | null {
  let gambleResult: 'win' | 'lose' | null = null;

  if (e.gamble) {
    const won = chance(state.rng, e.gamble.chance);
    gambleResult = won ? 'win' : 'lose';
    applyEffect(state, b, won ? e.gamble.win : e.gamble.lose);
  }

  if (e.defLossPermille !== undefined) b.defLossMod = e.defLossPermille;
  if (e.atkLossPermille !== undefined) b.atkLossMod = e.atkLossPermille;
  if (e.defMorale) b.defMorale = clamp(b.defMorale + e.defMorale, 0, 100);
  if (e.atkMorale) b.atkMorale = clamp(b.atkMorale + e.atkMorale, 0, 100);
  if (e.wall) b.wallIntegrity = clamp(b.wallIntegrity + e.wall, 0, 100);
  if (e.defMen) { b.defMen = Math.max(0, b.defMen - e.defMen); scaleDeploy(b); }
  if (e.atkMen) b.atkMen = Math.max(0, b.atkMen - e.atkMen);

  // 落到城与围城上的后果
  const city = state.cities[b.cityId];
  if (e.cityMorale && city) city.morale = clamp(city.morale + e.cityMorale, 0, 100);
  if (e.cityCoin && city) city.coin = Math.max(0, city.coin + e.cityCoin);
  if (e.atkSupply) {
    const siege = state.sieges[b.cityId];
    if (siege) siege.supply = Math.max(0, siege.supply + e.atkSupply);
  }
  if (e.wounded) state.flags['wounded'] = (state.flags['wounded'] ?? 0) + 1;

  return gambleResult;
}

// ─────────────────────────────────────────────────────────────
// 收场
// ─────────────────────────────────────────────────────────────

function checkOutcome(state: WorldState, idx: ContentIndex): SimEvent[] {
  const b = state.battle!;
  // 城墙塌尽、守军尽、或者守军崩了 —— 城陷
  if (b.wallIntegrity <= 0 || b.defMen <= 0 || b.defMorale <= MORALE_BREAK) {
    return finish(state, idx, 'fallen');
  }
  // 攻方伤亡过半或士气崩 —— 退兵
  const siege = state.sieges[b.cityId];
  const started = siege ? siege.troops : b.atkMen;
  if (b.atkMen <= 40 || b.atkMorale <= MORALE_BREAK || b.atkMen < started * 0.55) {
    return finish(state, idx, 'held');
  }
  return [];
}

function finish(
  state: WorldState, idx: ContentIndex, outcome: 'held' | 'fallen',
): SimEvent[] {
  const b = state.battle;
  if (!b || b.phase === 'done') return [];
  b.phase = 'done';
  b.outcome = outcome;
  b.pending = null;

  const node = state.nodes[b.cityId];
  const siege = state.sieges[b.cityId];
  const events: SimEvent[] = [];

  // 战果写回天下：守军与围兵的实际损耗
  if (node) node.troops = b.defMen;
  if (siege) siege.troops = b.atkMen;

  // 流寇打进来是抢一笔就走，不是占城 —— 他们要的从来不是城
  if (outcome === 'fallen' && b.attackerId === BANDIT_ID) {
    const city = state.cities[b.cityId];
    if (city) {
      const grain = Math.floor(city.grain * 0.42);
      const coin = Math.floor(city.coin * 0.5);
      city.grain -= grain;
      city.coin -= coin;
      city.morale = Math.max(0, city.morale - 16);
      events.push({ t: 'sacked', cityId: b.cityId, grain, coin });
    }
    delete state.sieges[b.cityId];
    if (node) node.lastSiegeDay = state.day;
    events.push({ t: 'assault_ended', outcome, defLeft: b.defMen, atkLeft: b.atkMen });
    void idx;
    return events;
  }

  if (outcome === 'fallen') {
    if (node && siege) {
      const from = node.factionId;
      node.factionId = siege.factionId;
      node.troops = Math.max(60, Math.floor(siege.troops / 2));
      node.unrest = 80;
      node.takenDay = state.day;
      node.lastSiegeDay = state.day;
      delete state.sieges[b.cityId];
      events.push({ t: 'city_fell', cityId: b.cityId, from, to: siege.factionId });
    }
  } else {
    // 打退了这一次。围城本身还在，但攻方元气大伤
    if (siege) {
      siege.days = 0;
      if (siege.troops <= 60) {
        delete state.sieges[b.cityId];
        if (node) node.lastSiegeDay = state.day;
        events.push({
          t: 'siege_lifted', cityId: b.cityId, factionId: b.attackerId, taken: false,
        });
      }
    }
    const city = state.cities[b.cityId];
    // 守住一场是实打实的功劳
    if (city) state.official.merit += 25;
  }

  events.push({
    t: 'assault_ended',
    outcome,
    defLeft: b.defMen,
    atkLeft: b.atkMen,
  });
  void idx;
  return events;
}

/** 打完之后把战斗清掉。由界面在玩家看完战报后发命令 */
export function dismissBattle(state: WorldState): boolean {
  if (!state.battle || state.battle.phase !== 'done') return false;
  state.battle = null;
  return true;
}

/** 这座城此刻能派上城头的人 */
export function availableDefenders(state: WorldState, idx: ContentIndex): number {
  const city = currentCity(state);
  return Math.max(1, Math.min(garrisonOf(city, idx), state.nodes[city.id]?.troops ?? 0));
}

export { nextRange };
