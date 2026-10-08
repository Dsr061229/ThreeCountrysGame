/**
 * 野战的规则。
 *
 * 与守城战同一个形状（摆阵 → 打几轮 → 中间问两三次），
 * 但每一步都落在**格子**上：谁站在哪、脚下是什么地、往谁那边走。
 * 渲染层读的就是这份坐标 —— 玩家看见骑兵陷在沼里，规则里它就真的在沼里。
 */
import { chance, nextInt, nextRange } from './rng.ts';
import { mintId, type WorldState } from './state.ts';
import type { ContentIndex } from './content.ts';
import type { SimEvent } from './commands.ts';
import { garrisonOf } from './worldtick.ts';
import { releaseReinforcements } from './field_campaign.ts';
import { finishCampaign } from './handlers_campaign.ts';
import type { City } from './types.ts';
import {
  ARMY_BREAK, FIELD_COLS, FIELD_ROUNDS, FIELD_ROWS, FORMATIONS,
  FOE_ROWS, KIND_MATCH, OWN_ROWS, ROUT_MORALE, TERRAIN_BONUS,
  type FieldBattle, type FieldCell, type FieldDecision, type FieldEffect,
  type FieldUnit, type Formation, type Terrain, type UnitKind,
} from './field_types.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const idxOf = (col: number, row: number): number => row * FIELD_COLS + col;

// ─────────────────────────────────────────────────────────────
// 开战
// ─────────────────────────────────────────────────────────────

/**
 * 地形。
 *
 * 两条讲究：
 *
 * 一是**必须铺到阵前来**。上一版把地形全撒在中路，
 * 布阵区永远是清一色平地 —— 站哪儿都一样，那「排阵」就没得选了。
 * 现在坡与林会伸进第 4、5 行，你脚下踩着什么，从第一步起就有分别。
 *
 * 二是**不能全撒在角落**。地形若不在两军必然要争的地方，它就只是装饰。
 */
function makeTerrain(state: WorldState): FieldCell[] {
  const cells: FieldCell[] = [];
  for (let i = 0; i < FIELD_COLS * FIELD_ROWS; i++) {
    cells.push({ terrain: 'plain', height: 0 });
  }
  const put = (col: number, row: number, t: Terrain, h: number): void => {
    if (col < 0 || col >= FIELD_COLS || row < 0 || row >= FIELD_ROWS) return;
    cells[idxOf(col, row)] = { terrain: t, height: h };
  };
  const blob = (
    col: number, row: number, t: Terrain, h: number, size: number, pct: number,
  ): void => {
    for (let dc = -size; dc <= size; dc++) {
      for (let dr = -size; dr <= size; dr++) {
        if (Math.abs(dc) + Math.abs(dr) > size) continue;
        if (!chance(state.rng, pct)) continue;
        put(col + dc, row + dr, t, h);
      }
    }
  };

  // 一片缓坡。有时横在中路，有时压到某一方的阵前 ——
  // 压到谁的阵前，谁就该把弓弩摆上去
  const hillCol = nextRange(state.rng, 1, FIELD_COLS - 2);
  const hillRow = nextRange(state.rng, 2, 5);
  blob(hillCol, hillRow, 'hill', 1, 2, 74);

  // 一片林，通常在另一侧，也可能贴着阵前
  const woodCol = hillCol > FIELD_COLS / 2
    ? nextRange(state.rng, 0, 3)
    : nextRange(state.rng, FIELD_COLS - 4, FIELD_COLS - 1);
  const woodRow = nextRange(state.rng, 1, 5);
  blob(woodCol, woodRow, 'forest', 0, 2, 68);

  // 常有一道河滩或沼泽横在中路。它决定两军能不能痛快地撞上
  if (chance(state.rng, 62)) {
    const t: Terrain = chance(state.rng, 50) ? 'ford' : 'marsh';
    const row = nextRange(state.rng, 2, 4);
    const from = nextRange(state.rng, 0, 4);
    const len = nextRange(state.rng, 3, 6);
    for (let c = from; c < Math.min(FIELD_COLS, from + len); c++) {
      if (cells[idxOf(c, row)]!.terrain === 'plain') put(c, row, t, 0);
      if (chance(state.rng, 40) && cells[idxOf(c, row + 1)]?.terrain === 'plain') {
        put(c, row + 1, t, 0);
      }
    }
  }

  // 阵前再撒一两块小地形，让开局那一步也有得选
  for (let i = 0; i < nextRange(state.rng, 1, 2); i++) {
    const t: Terrain = chance(state.rng, 55) ? 'hill' : 'forest';
    const c = nextRange(state.rng, 0, FIELD_COLS - 1);
    const r = nextRange(state.rng, 5, 6);
    if (cells[idxOf(c, r)]!.terrain === 'plain') put(c, r, t, t === 'hill' ? 1 : 0);
  }
  // 敌阵前也来一块，两边公平
  for (let i = 0; i < nextRange(state.rng, 1, 2); i++) {
    const t: Terrain = chance(state.rng, 55) ? 'hill' : 'forest';
    const c = nextRange(state.rng, 0, FIELD_COLS - 1);
    const r = nextRange(state.rng, 0, 1);
    if (cells[idxOf(c, r)]!.terrain === 'plain') put(c, r, t, t === 'hill' ? 1 : 0);
  }

  return cells;
}

/** 城里兵营的总级数。没有兵营就是 0 */
function barracksLevel(city: City): number {
  let n = 0;
  for (const p of city.plots) if (p.buildingId === 'barracks') n += p.level;
  return n;
}

/**
 * 把一支兵按兵种拆成几队。
 *
 * 两条讲究：
 *
 * 一是**不足编制的不单独成队**。上一版凑不满十二人就单开一队，
 * 于是常出现「骑兵 13 人」这种东西 —— 它第一轮就溃，
 * 画面上是三个小人，读起来像个笑话。真打仗不会这么编队。
 *
 * 二是**人不能凭空少掉**。上一版凑不够就把那一撮人直接丢弃，
 * 出城八十人、战场上只剩六十九，账对不上。现在一律并回步卒。
 */
const MIN_UNIT = 25;

function splitForce(
  state: WorldState, side: 'own' | 'foe', men: number, bowRatio: number, horseRatio: number,
): FieldUnit[] {
  let bow = Math.round(men * bowRatio);
  let horse = Math.round(men * horseRatio);
  // 凑不满一队的，牵回来跟着步卒走
  if (bow < MIN_UNIT) bow = 0;
  if (horse < MIN_UNIT) horse = 0;
  const foot = men - bow - horse;

  const out: FieldUnit[] = [];
  const add = (kind: UnitKind, n: number): void => {
    if (n <= 0) return;
    out.push({
      id: mintId(state, side === 'own' ? 'u' : 'f'),
      side, kind, men: n, men0: n,
      // 围城的一方士气更足 —— 是他找上门来的。
      // 玩家的优势在于「决断」，不该在初始数值上再送一份
      morale: side === 'own' ? 58 : 72,
      col: 0, row: 0, routed: false,
    });
  };

  // 步卒够多就拆成两队，让阵线有宽度；不够就一队，别为了好看凑数
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
    morale: 60, col: 0, row: 0, routed: false,
  }];
}

/**
 * 沿一行摊开摆队。
 *
 * 要真的摊开 —— 按整数间隔算会把四支队伍全挤在左边三格里
 * （九列除以五等于一），阵线就只剩一小撮。
 */
function lineUp(units: FieldUnit[], rows: readonly number[]): void {
  const n = units.length;
  units.forEach((u, i) => {
    u.col = clamp(Math.round(((i + 1) * FIELD_COLS) / (n + 1)), 0, FIELD_COLS - 1);
    // 弓弩摆在后排，骑兵摆在侧翼
    u.row = u.kind === 'bow' ? rows[rows.length - 1]! : rows[0]!;
    if (u.kind === 'horse') u.col = i % 2 === 0 ? 1 : FIELD_COLS - 2;
  });
}

/**
 * 出城野战。
 *
 * 文官守着一座小城，本来只能缩在墙后面挨打。
 * 「出击」给的是另一条路：赢了当场解围，输了守军折损、城更难守。
 * 这是一个真正的取舍，不是一个更优解。
 */
export function startSortie(
  state: WorldState, idx: ContentIndex, cityId: string,
): SimEvent[] {
  if (state.field || state.battle) return [];
  const siege = state.sieges[cityId];
  const city = state.cities[cityId];
  if (!siege || !city) return [];

  const men = garrisonOf(city, idx);
  // 留一部分守城 —— 倾巢而出的县令没有第二次机会，
  // 但只带六成人出去等于送死，那样「出击」就永远不会是一个真的选项
  const outMen = Math.max(20, Math.floor(men * 0.78));

  // 兵种构成是**练出来的**，不是固定的。
  // 兵营越像样，弓弩越多，到二级才养得起一队骑兵 ——
  // 这样每一局的阵中都不一样，「排阵」才有得排；
  // 也让「修兵营」在战场上看得见回报，而不只是守军数字大一点
  const bar = barracksLevel(city);
  // 封顶：再怎么练，步卒也得是阵中的骨干。
  // 一支七成是弓骑的县兵不像话，也会让阵型的取舍失去意义
  const own = splitForce(
    state, 'own', outMen,
    Math.min(0.30, 0.18 + bar * 0.05),
    Math.min(0.18, bar * 0.07),
  );
  const foe = splitForce(state, 'foe', siege.troops, 0.16, 0.1);
  lineUp(own, OWN_ROWS);
  lineUp(foe, FOE_ROWS);

  // 侦察：城头看得见城下，所以出城打的一方对敌情知道得不少
  const scouting = clamp(52 + city.wall * 12 + nextInt(state.rng, 20), 0, 100);
  const foeFormations: Formation[] = ['yulin', 'fengshi', 'heyi', 'fangyuan', 'yanyue'];

  state.field = {
    cause: 'sortie',
    foeFactionId: siege.factionId,
    cityId,
    cells: makeTerrain(state),
    units: [...own, ...foe],
    formation: 'heyi',
    foeFormation: foeFormations[nextInt(state.rng, foeFormations.length)]!,
    scouting,
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
    reinforcements: [],
    ambush: false,
  };

  return [{
    t: 'sortie_begun', cityId, factionId: siege.factionId,
    own: outMen, foe: siege.troops,
  }];
}

// ─────────────────────────────────────────────────────────────
// 布阵
// ─────────────────────────────────────────────────────────────

/**
 * 布阵：只挪位置、只换阵型，**不开打**。
 *
 * 这两件事必须分开。合在一条命令里的后果是：玩家点一下阵型按钮，
 * 布阵阶段就结束了 —— 拖拽失效、开打按钮消失，看起来像卡死。
 */
export function applyFieldDeploy(
  state: WorldState,
  places: { id: string; col: number; row: number }[],
  formation: Formation,
): SimEvent[] | null {
  const f = state.field;
  if (!f || f.phase !== 'deploy') return null;
  if (!FORMATIONS[formation]) return null;

  for (const p of places) {
    const u = f.units.find((x) => x.id === p.id && x.side === 'own');
    if (!u) continue;
    // 只能摆在自己的布阵区里
    if (!OWN_ROWS.includes(p.row as 5 | 6)) return null;
    u.col = clamp(Math.floor(p.col), 0, FIELD_COLS - 1);
    u.row = p.row;
  }
  f.formation = formation;
  return [{ t: 'sortie_deployed', formation }];
}

/** 击鼓进兵。布阵到此为止 */
export function beginField(state: WorldState): SimEvent[] | null {
  const f = state.field;
  if (!f || f.phase !== 'deploy') return null;
  f.phase = 'fighting';
  return [{ t: 'sortie_engaged' }];
}

// ─────────────────────────────────────────────────────────────
// 一轮
// ─────────────────────────────────────────────────────────────

const dist = (a: FieldUnit, b: FieldUnit): number =>
  Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));

function alive(f: FieldBattle, side: 'own' | 'foe'): FieldUnit[] {
  return f.units.filter((u) => u.side === side && !u.routed && u.men > 0);
}

function totalMen(f: FieldBattle, side: 'own' | 'foe'): number {
  return f.units.filter((u) => u.side === side && !u.routed)
    .reduce((s, u) => s + u.men, 0);
}

function startMen(f: FieldBattle, side: 'own' | 'foe'): number {
  return f.units.filter((u) => u.side === side).reduce((s, u) => s + u.men0, 0);
}

/**
 * 一支队伍此刻的战力。
 *
 * 士气的权重刻意压得不高。士气与战力若绑得太死，就会形成死亡螺旋 ——
 * 挨打多 → 士气掉 → 战力掉 → 挨得更多，
 * 于是防御型阵永远稳赢、进攻型阵永远是废棋，「选阵型」就没有意义了。
 */
/**
 * 给每支队分派一个对手。
 *
 * 只挑「离得最近的」会出事：三四支队会一齐压到同一个敌人身上，
 * 剩下的队在旁边空转。实测下来，**兵越多空转的越多** ——
 * 兵营练到三级、多带三十几个人出城，胜率反而更低。
 * 那不是难度，那是模拟错了。
 *
 * 真打仗是列阵相对，一线对一线。所以分派时给已经被缠住的敌人加罚，
 * 让阵线自然铺开去对上敌人的阵线。
 */
function assignTargets(f: FieldBattle): Map<string, FieldUnit> {
  const out = new Map<string, FieldUnit>();
  const taken = new Map<string, number>();
  const units = [...f.units]
    .filter((u) => !u.routed && u.men > 0)
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const u of units) {
    const foes = units.filter((t) => t.side !== u.side);
    if (foes.length === 0) continue;
    let best = foes[0]!;
    let bestScore = Infinity;
    for (const t of foes) {
      const score = dist(u, t) + (taken.get(t.id) ?? 0) * 2.5;
      if (score < bestScore) { bestScore = score; best = t; }
    }
    taken.set(best.id, (taken.get(best.id) ?? 0) + 1);
    out.set(u.id, best);
  }
  return out;
}

function power(u: FieldUnit): number {
  return u.men * (0.72 + (u.morale / 100) * 0.5);
}

export function advanceFieldRound(state: WorldState, idx: ContentIndex): SimEvent[] {
  const f = state.field;
  if (!f || f.phase !== 'fighting' || f.pending) return [];

  f.round += 1;
  const events: SimEvent[] = [];

  // 约好这一轮到的那一路，在动手之前先上场 ——
  // 援兵要赶得上这一轮的厮杀，不然「第三轮杀到」就成了「第四轮杀到」
  events.push(...releaseReinforcements(state, f.round));

  const ownForm = FORMATIONS[f.formation];
  const foeForm = FORMATIONS[f.foeFormation];

  // 先动，后打 —— 同一轮里刚接触的两队也会交手
  const marks = assignTargets(f);
  for (const u of [...f.units].sort((a, b) => a.id.localeCompare(b.id))) {
    if (u.routed || u.men <= 0) continue;
    const near = marks.get(u.id);
    if (!near) continue;
    if (dist(u, near) <= 1) continue;

    const form = u.side === 'own' ? ownForm : foeForm;
    const cell = f.cells[idxOf(u.col, u.row)]!;
    // 沼泽与河滩走不快
    const slow = cell.terrain === 'marsh' || cell.terrain === 'ford' ? 1 : 0;
    let steps = 1 + (u.kind === 'horse' ? 1 : 0) + form.speed - slow;
    steps = Math.max(0, steps);
    for (let s = 0; s < steps && dist(u, near) > 1; s++) {
      u.col += Math.sign(near.col - u.col);
      u.row += Math.sign(near.row - u.row);
    }
  }

  // 交手
  let ownLoss = 0, foeLoss = 0;
  for (const u of [...f.units].sort((a, b) => a.id.localeCompare(b.id))) {
    if (u.routed || u.men <= 0) continue;
    // 弓弩够得着两格 —— 这是它存在的全部理由。
    //
    // 上一版所有兵种一律只能贴身打，于是弓弩成了「打步卒吃亏、被步卒克」
    // 的废棋：练出弓弩来的城反而更容易打输。
    // 一支只能肉搏的弓弩队，本来就不该叫弓弩。
    const reach = u.kind === 'bow' ? 2 : 1;
    const foes = alive(f, u.side === 'own' ? 'foe' : 'own').filter((t) => dist(u, t) <= reach);
    if (foes.length === 0) continue;
    const target = foes[nextInt(state.rng, foes.length)]!;
    /** 隔着一格放箭。没接上手，所以也挨不着还手 */
    const ranged = dist(u, target) > 1;

    const attForm = u.side === 'own' ? ownForm : foeForm;
    const defForm = target.side === 'own' ? ownForm : foeForm;
    const attMod = u.side === 'own' ? f.ownAttackMod : f.foeAttackMod;
    const defMod = target.side === 'own' ? f.ownDefendMod : 1000;

    const attCell = f.cells[idxOf(u.col, u.row)]!;
    const defCell = f.cells[idxOf(target.col, target.row)]!;
    const match = KIND_MATCH[u.kind][target.kind] / 1000;
    const attTerr = (TERRAIN_BONUS[attCell.terrain][u.kind] ?? 1000) / 1000;
    const defTerr = (TERRAIN_BONUS[defCell.terrain][target.kind] ?? 1000) / 1000;
    // 被从侧面打：阵型的两翼有多结实在这里体现
    const flanked = !ranged && Math.abs(u.col - target.col) > Math.abs(u.row - target.row);
    const flank = flanked ? defForm.flank / 1000 : 1;

    // 基础杀伤压得很低。
    //
    // 一仗要打上五六轮，中间那两三次决断才有出场的机会 ——
    // 决断是这个战斗系统的**全部玩法**，仗要是两轮就打完，
    // 玩家除了看数字掉什么也没做。
    //
    // 这个数在「人人都能接敌」之后重调过一次：原先一半队伍每轮空转，
    // 实际杀伤只有账面的一半，改对之后仗一下子缩到三轮。
    // 放箭比接战杀伤轻，但**不用挨还手**，而且在两军还没撞上的那几轮里
    // 只有它在输出。坡上的弓弩尤其占便宜 —— 射得远又打得准
    const raw = power(u) * 0.028 * match * attTerr * (ranged ? 0.62 : 1)
      * (attForm.attack / 1000) * (attMod / 1000) * flank
      / (defTerr * (defForm.defend / 1000) * (defMod / 1000));
    const loss = Math.max(1, Math.round(raw * (0.85 + nextInt(state.rng, 30) / 100)));

    target.men = Math.max(0, target.men - loss);
    if (target.side === 'own') ownLoss += loss; else foeLoss += loss;

    // 士气跟着伤亡走，阵型的韧性抵掉一部分
    const hit = Math.floor((loss * 240) / Math.max(1, target.men + loss));
    const steady = defForm.steady / 1000;
    target.morale = clamp(target.morale - Math.round(hit / steady), 0, 100);
    if (target.men <= 0 || target.morale <= ROUT_MORALE) {
      target.routed = true;
      f.log.push({
        round: f.round,
        textId: target.side === 'own' ? 'fd.own_routed' : 'fd.foe_routed',
        vars: { kind: target.kind },
        tone: target.side === 'own' ? 'bad' : 'good',
      });
    }
  }

  f.ownAttackMod = 1000;
  f.ownDefendMod = 1000;
  f.foeAttackMod = 1000;

  events.push({ t: 'sortie_round', round: f.round, ownLoss, foeLoss });
  f.log.push({
    round: f.round, textId: 'fd.exchange',
    vars: { ownLoss, foeLoss }, tone: 'plain',
  });

  const done = checkField(state, idx);
  if (done.length > 0) return [...events, ...done];

  const d = pickFieldDecision(state, idx);
  if (d) {
    f.pending = d;
    f.usedDecisions.push(d.id);
    events.push({ t: 'sortie_decision', id: d.id });
    return events;
  }

  if (f.round >= f.maxRounds) events.push(...finishField(state, idx, 'withdrew'));
  return events;
}

// ─────────────────────────────────────────────────────────────
// 决断
// ─────────────────────────────────────────────────────────────

function pickFieldDecision(state: WorldState, idx: ContentIndex): FieldDecision | null {
  const f = state.field!;
  if (f.usedDecisions.length >= 3) return null;

  const ownLeft = (totalMen(f, 'own') * 1000) / Math.max(1, startMen(f, 'own'));
  const foeLeft = (totalMen(f, 'foe') * 1000) / Math.max(1, startMen(f, 'foe'));
  const ownRouted = f.units.some((u) => u.side === 'own' && u.routed);
  const foeRouted = f.units.some((u) => u.side === 'foe' && u.routed);
  // 有没有人站在坡上
  const onHill = alive(f, 'own').some(
    (u) => f.cells[idxOf(u.col, u.row)]!.terrain === 'hill',
  );

  const fits = idx.db.field.filter((d) => {
    if (f.usedDecisions.includes(d.id)) return false;
    const w = d.when;
    if (w.minRound !== undefined && f.round < w.minRound) return false;
    if (w.maxRound !== undefined && f.round > w.maxRound) return false;
    if (w.maxOwnLeft !== undefined && ownLeft > w.maxOwnLeft) return false;
    if (w.maxFoeLeft !== undefined && foeLeft > w.maxFoeLeft) return false;
    if (w.ownRouted !== undefined && ownRouted !== w.ownRouted) return false;
    if (w.foeRouted !== undefined && foeRouted !== w.foeRouted) return false;
    if (w.onHill !== undefined && onHill !== w.onHill) return false;
    return true;
  });
  if (fits.length === 0) return null;

  const def = fits[nextInt(state.rng, fits.length)]!;
  // 镜头该推到出事的地方 —— 「左翼被冲开了」就该让人看见左翼
  const hurt = f.units
    .filter((u) => u.side === 'own')
    .sort((a, b) => a.men / Math.max(1, a.men0) - b.men / Math.max(1, b.men0))[0];

  return {
    id: def.id,
    textId: def.textId,
    vars: {
      foe: idx.faction.get(f.foeFactionId)?.name ?? '',
      round: f.round,
    },
    options: def.options.map((o) => ({ textId: o.textId, hintId: o.hintId, effect: o.effect })),
    round: f.round,
    focus: hurt ? { col: hurt.col, row: hurt.row } : null,
  };
}

export function applyFieldDecision(
  state: WorldState, idx: ContentIndex, option: number,
): SimEvent[] | null {
  const f = state.field;
  if (!f?.pending) return null;
  const opt = f.pending.options[option];
  if (!opt) return null;

  const chosen = opt.textId;
  f.pending = null;
  const res = applyFieldEffect(state, f, opt.effect);
  f.log.push({
    round: f.round, textId: chosen, vars: {},
    tone: res === 'lose' ? 'bad' : res === 'win' ? 'good' : 'plain',
  });

  const events: SimEvent[] = [{ t: 'sortie_decided', textId: chosen, gambled: res }];
  const done = checkField(state, idx);
  if (done.length > 0) return [...events, ...done];
  if (f.round >= f.maxRounds) events.push(...finishField(state, idx, 'withdrew'));
  return events;
}

function applyFieldEffect(
  state: WorldState, f: FieldBattle, e: FieldEffect,
): 'win' | 'lose' | null {
  let g: 'win' | 'lose' | null = null;
  if (e.gamble) {
    const won = chance(state.rng, e.gamble.chance);
    g = won ? 'win' : 'lose';
    applyFieldEffect(state, f, won ? e.gamble.win : e.gamble.lose);
  }
  if (e.ownAttack !== undefined) f.ownAttackMod = e.ownAttack;
  if (e.ownDefend !== undefined) f.ownDefendMod = e.ownDefend;
  if (e.foeAttack !== undefined) f.foeAttackMod = e.foeAttack;
  if (e.formation) f.formation = e.formation;

  const shift = (side: 'own' | 'foe', dm: number): void => {
    for (const u of f.units) {
      if (u.side !== side || u.routed) continue;
      u.morale = clamp(u.morale + dm, 0, 100);
    }
  };
  if (e.ownMorale) shift('own', e.ownMorale);
  if (e.foeMorale) shift('foe', e.foeMorale);

  const bleed = (side: 'own' | 'foe', n: number): void => {
    const us = alive(f, side);
    const tot = us.reduce((s, u) => s + u.men, 0);
    if (tot <= 0) return;
    for (const u of us) {
      u.men = Math.max(0, u.men - Math.round((n * u.men) / tot));
      if (u.men <= 0) u.routed = true;
    }
  };
  if (e.ownMen) bleed('own', e.ownMen);
  if (e.foeMen) bleed('foe', e.foeMen);

  return g;
}

// ─────────────────────────────────────────────────────────────
// 收场
// ─────────────────────────────────────────────────────────────

function checkField(state: WorldState, idx: ContentIndex): SimEvent[] {
  const f = state.field!;
  const own = totalMen(f, 'own');
  const foe = totalMen(f, 'foe');
  const own0 = startMen(f, 'own');
  const foe0 = startMen(f, 'foe');

  if (foe <= 0 || (foe * 1000) / Math.max(1, foe0) < ARMY_BREAK) {
    return finishField(state, idx, 'won');
  }
  if (own <= 0 || (own * 1000) / Math.max(1, own0) < ARMY_BREAK) {
    return finishField(state, idx, 'lost');
  }
  return [];
}

/**
 * 收场，并把战果写回世界。
 *
 * 赢了当场解围 —— 这正是出城野战值得冒的险；
 * 输了守军折损、士气受挫，接下来的城更难守。
 */
function finishField(
  state: WorldState, idx: ContentIndex, outcome: 'won' | 'lost' | 'withdrew',
): SimEvent[] {
  const f = state.field;
  if (!f || f.phase === 'done') return [];
  f.phase = 'done';
  f.outcome = outcome;
  f.pending = null;

  const node = state.nodes[f.cityId];
  const city = state.cities[f.cityId];
  const siege = state.sieges[f.cityId];
  const events: SimEvent[] = [];

  const ownLeft = totalMen(f, 'own');
  const ownLost = startMen(f, 'own') - ownLeft;
  const foeLeft = totalMen(f, 'foe');
  const foeLost = startMen(f, 'foe') - foeLeft;

  // 出征打的仗走另一条路：折损记在营里，战果记在功劳簿上
  if (f.cause === 'campaign') {
    const camp = Object.values(state.camps)[0];
    if (camp) {
      camp.troops = Math.max(0, camp.troops - ownLost);
      // 打赢的兵有底气，打输的兵没有
      camp.morale = clamp(camp.morale + (outcome === 'won' ? 6 : -6), 0, 100);
    }
    events.push(...finishCampaign(state, outcome === 'won', foeLost));
    events.push({
      t: 'sortie_ended', outcome, ownLeft, foeLeft,
    });
    return events;
  }

  // 出战的那部分人回城
  if (node) node.troops = Math.max(1, node.troops - ownLost);

  if (siege) {
    if (outcome === 'won') {
      delete state.sieges[f.cityId];
      if (node) node.lastSiegeDay = state.day;
      state.official.merit += 40;
      events.push({
        t: 'siege_lifted', cityId: f.cityId, factionId: f.foeFactionId, taken: false,
      });
    } else {
      siege.troops = Math.max(20, foeLeft);
      if (city) city.morale = clamp(city.morale - (outcome === 'lost' ? 10 : 4), 0, 100);
    }
  }

  events.push({
    t: 'sortie_ended', outcome, ownLeft, foeLeft,
  });
  void idx;
  return events;
}

export function dismissField(state: WorldState): boolean {
  if (!state.field || state.field.phase !== 'done') return false;
  state.field = null;
  return true;
}
