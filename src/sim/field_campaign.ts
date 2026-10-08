/**
 * 军议那份计划，落到战场上是什么样。
 *
 * 出征那一层算出来的是一个 `Setup`：我有多少人接战、
 * 敌军剩多少、伏兵咬没咬住、哪一路第几轮才到。
 * 这个文件把它摆成一张真的战场。
 *
 * 两件事必须**看得见**，否则军议就白开了：
 *
 *   伏击成功 —— 敌军是**散着**的：队伍被打散、士气先掉一截、
 *              阵型的加成一概没有。玩家一进战场就该看出「这仗我占着先」
 *   侧击     —— 到了那一轮，一支兵从敌阵侧面**切进来**。
 *              打到一半援兵杀到，是这套系统最该有的那个时刻
 */
import { nextInt } from './rng.ts';
import type { WorldState } from './state.ts';
import type { SimEvent } from './commands.ts';
import { mintId } from './state.ts';
import type { Setup } from './campaign.ts';
import {
  FIELD_COLS, FIELD_ROUNDS, FOE_ROWS, OWN_ROWS,
  type FieldBattle, type FieldUnit, type Formation, type Reinforcement,
} from './field_types.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * 伏击时敌军的士气。
 *
 * 被伏的一方不是「稍微吃亏」，是**乱了**。
 * 这个数压得很低是故意的：伏击是这条线上最锋利的一招，
 * 它的回报必须一眼就看得见，否则玩家不会为它冒那个险。
 */
const AMBUSHED_MORALE = 34;

/**
 * 把出征的结果摆成一张战场。
 *
 * 这里刻意**不**复用 startSortie —— 那一套是「从城里出来打围城的人」，
 * 兵种构成看兵营、侦察看城墙。出征是另一回事：
 * 兵是你自己练的，敌情是斥候探的，开局的样子由军议那份计划决定。
 */
export function startCampaignBattle(
  state: WorldState,
  setup: Setup,
  opts: {
    foeFactionId: string;
    targetNodeId: string;
    /** 我方训练度，决定兵种构成与素质 */
    training: number;
    gear: number;
    morale: number;
    scouting: number;
    /** 营里养得起多少弓弩、多少骑兵（千分数上限） */
    bowCap: number;
    horseCap: number;
  },
): SimEvent[] {
  if (state.field || state.battle) return [];

  const own = splitCampaignForce(
    state, 'own', setup.ownMen, opts.training, opts.gear, opts.morale,
    { bow: opts.bowCap, horse: opts.horseCap },
  );
  const foe = splitCampaignForce(
    state, 'foe', setup.foeMen, 45 + nextInt(state.rng, 25), 1,
    clamp((setup.ambush ? AMBUSHED_MORALE : 68) - setup.foeMoraleHit, 8, 100),
  );

  lineUp(own, OWN_ROWS);
  if (setup.ambush) {
    // 被伏的一方是**散着**的：不成阵、挤在一处、离得极近。
    // 这一眼就看得出跟正面对垒不一样
    scatter(state, foe);
  } else {
    lineUp(foe, FOE_ROWS);
  }

  // 约好晚到的各路。按说好的时候一路一路上场
  const reinforcements: Reinforcement[] = setup.late.map((l) => ({
    round: l.round,
    men: l.men,
    // 第六轮才赶到的那一路是从后面追上来的，不是绕到敌后
    from: l.round >= 6 ? 'flank' : 'rear',
    officerId: l.officerId,
  }));

  const foeFormations: Formation[] = ['yulin', 'fengshi', 'heyi', 'fangyuan', 'yanyue'];

  state.field = {
    cause: 'campaign',
    foeFactionId: opts.foeFactionId,
    cityId: opts.targetNodeId,
    cells: makeCampaignTerrain(state, setup.ambush),
    units: [...own, ...foe],
    formation: 'heyi',
    foeFormation: foeFormations[nextInt(state.rng, foeFormations.length)]!,
    scouting: opts.scouting,
    round: 0,
    maxRounds: FIELD_ROUNDS,
    phase: 'deploy',
    ownAttackMod: 1000,
    ownDefendMod: 1000,
    foeAttackMod: 1000,
    pending: null,
    usedDecisions: [],
    log: [],
    outcome: null,
    reinforcements,
    ambush: setup.ambush,
  };

  return [{
    t: 'campaign_battle_begun',
    own: setup.ownMen,
    foe: setup.foeMen,
    ambush: setup.ambush,
  }];
}

/**
 * 到点了就把援兵放上来。
 *
 * 从敌后切进来的那一路直接落在敌阵背后 —— 这是侧击值钱的地方：
 * 敌军已经和你的正兵咬住了，回不了头。
 */
export function releaseReinforcements(
  state: WorldState, round: number,
): SimEvent[] {
  const f = state.field;
  if (!f || f.reinforcements.length === 0) return [];

  const events: SimEvent[] = [];
  for (let i = f.reinforcements.length - 1; i >= 0; i--) {
    const r = f.reinforcements[i]!;
    if (round < r.round) continue;
    f.reinforcements.splice(i, 1);

    const men = splitCampaignForce(state, 'own', r.men, 55, 1, 72);
    // 敌后的从敌阵那一行进来，侧翼的从自己这一侧的边上进来
    const row = r.from === 'rear' ? 0 : OWN_ROWS[0]!;
    men.forEach((u, k) => {
      u.row = row;
      u.col = clamp(
        r.from === 'rear'
          ? Math.round(((k + 1) * FIELD_COLS) / (men.length + 1))
          : (k % 2 === 0 ? 0 : FIELD_COLS - 1),
        0, FIELD_COLS - 1,
      );
    });
    f.units.push(...men);

    f.log.push({
      round,
      textId: r.from === 'rear' ? 'fd.flank_arrived' : 'fd.late_arrived',
      vars: { men: r.men },
      tone: 'good',
    });
    events.push({ t: 'column_arrived', men: r.men, from: r.from, officerId: r.officerId });
  }
  return events;
}

// ─────────────────────────────────────────────────────────────
// 内部
// ─────────────────────────────────────────────────────────────

/** 一路兵最少要这些人才成一队。与野战那边同一个道理 */
const MIN_UNIT = 25;

/**
 * 把出征的兵拆成几队。
 *
 * 与守城出击最大的不同：兵种构成看的是**你练兵练成了什么样**，
 * 而不是城里兵营几级。训练度高的营弓弩多、骑兵多，
 * 因为那些兵种本来就是要练才用得起来的。
 */
function splitCampaignForce(
  state: WorldState, side: 'own' | 'foe',
  men: number, training: number, gear: number, morale: number,
  caps?: { bow: number; horse: number },
): FieldUnit[] {
  const t = clamp(training, 0, 100);
  // 兵种是**营里养出来的**，不是练出来的。
  //
  // 没有厩栏就没有骑兵 —— 训练度再高也变不出马来。
  // 这一条是「修营」在战场上兑现的地方：
  // 你那一队弓弩，是你三个季度前修的那座弓弩坊。
  const bowCap = caps ? caps.bow : Math.min(320, 140 + t * 2);
  const horseCap = caps ? caps.horse : Math.min(200, t * 1.6);
  // 练得越熟，越用得起来。设施定上限，训练度决定你摸到几成
  const reach = 0.45 + (t / 100) * 0.55;
  let bow = Math.round((men * bowCap * reach) / 1000);
  let horse = Math.round((men * horseCap * reach) / 1000);
  if (bow < MIN_UNIT) bow = 0;
  if (horse < MIN_UNIT) horse = 0;
  const foot = men - bow - horse;

  const out: FieldUnit[] = [];
  const add = (kind: FieldUnit['kind'], n: number): void => {
    if (n <= 0) return;
    out.push({
      id: mintId(state, side === 'own' ? 'u' : 'f'),
      side, kind, men: n, men0: n,
      morale: clamp(morale + gear * 2, 0, 100),
      col: 0, row: 0, routed: false,
    });
  };

  if (foot >= MIN_UNIT * 2) {
    add('foot', Math.ceil(foot / 2));
    add('foot', Math.floor(foot / 2));
  } else {
    add('foot', foot);
  }
  add('bow', bow);
  add('horse', horse);

  return out.length > 0 ? out : [{
    id: mintId(state, side === 'own' ? 'u' : 'f'),
    side, kind: 'foot', men: Math.max(1, men), men0: Math.max(1, men),
    morale, col: 0, row: 0, routed: false,
  }];
}

/** 沿一行摊开摆队 */
function lineUp(units: FieldUnit[], rows: readonly number[]): void {
  const n = units.length;
  units.forEach((u, i) => {
    u.col = clamp(Math.round(((i + 1) * FIELD_COLS) / (n + 1)), 0, FIELD_COLS - 1);
    u.row = rows[i % rows.length]!;
    if (u.kind === 'horse') u.col = i % 2 === 0 ? 1 : FIELD_COLS - 2;
  });
}

/**
 * 被伏的一方：挤在道上，不成阵。
 *
 * 全塞在中路那两三格里。玩家一进战场就该看出来
 * ——「他们还在行军队形上」。
 */
function scatter(state: WorldState, units: FieldUnit[]): void {
  const mid = Math.floor(FIELD_COLS / 2);
  units.forEach((u) => {
    u.col = clamp(mid + nextInt(state.rng, 3) - 1, 0, FIELD_COLS - 1);
    u.row = 2 + nextInt(state.rng, 2);
  });
}

/**
 * 出征的战场地形。
 *
 * 伏击一定发生在**险地** —— 两边是林是坡，中间一条道。
 * 这不是装饰：地形本来就是伏兵能成立的原因，
 * 战场上看不见那条谷道，「设伏」就只是一个加成数字。
 */
function makeCampaignTerrain(state: WorldState, ambush: boolean): FieldBattle['cells'] {
  const cells: FieldBattle['cells'] = [];
  const rows = 7;
  for (let i = 0; i < FIELD_COLS * rows; i++) {
    cells.push({ terrain: 'plain', height: 0 });
  }
  const put = (col: number, row: number, t: FieldBattle['cells'][number]['terrain']): void => {
    if (col < 0 || col >= FIELD_COLS || row < 0 || row >= rows) return;
    cells[row * FIELD_COLS + col] = { terrain: t, height: t === 'hill' ? 1 : 0 };
  };

  if (ambush) {
    // 一条谷道：中间三列是路，两侧全是林与坡
    const mid = Math.floor(FIELD_COLS / 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < FIELD_COLS; c++) {
        if (Math.abs(c - mid) <= 1) continue;
        put(c, r, Math.abs(c - mid) >= 3 ? 'hill' : 'forest');
      }
    }
    return cells;
  }

  // 寻常战场：散着几块坡与林
  for (let i = 0; i < 3 + nextInt(state.rng, 3); i++) {
    const c = nextInt(state.rng, FIELD_COLS);
    const r = 1 + nextInt(state.rng, rows - 2);
    const t = nextInt(state.rng, 2) === 0 ? 'hill' : 'forest';
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (nextInt(state.rng, 100) < 40) continue;
        put(c + dc, r + dr, t);
      }
    }
  }
  return cells;
}

export { splitCampaignForce, makeCampaignTerrain };
