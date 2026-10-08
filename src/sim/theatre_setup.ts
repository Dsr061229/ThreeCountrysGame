/**
 * 开一场仗。
 *
 * 从「我的营」和「要打的那处」造出一张战场：地是那一段真实的地，
 * 两头各摆一座营，敌军按他自己的路数布防，
 * 我的兵先不上场 —— 等你在图上点位置下令。
 */
import { chancePermille, nextInt, nextRange } from './rng.ts';
import type { ContentIndex } from './content.ts';
import { mintId } from './state.ts';
import type { WorldState } from './state.ts';
import { surveyRoute } from './terrain.ts';
import { campOutput } from './camp.ts';
import { someoneFrom, wardenOf } from './people.ts';
import { carveRoad, COLS, flatten, makeTheatreMap, ROWS, cellAt } from './theatre_map.ts';
import {
  MAX_TICKS, type Theatre, type TheatreKind, type Unit, type UnitKind,
  KIND_NAME,
} from './theatre_types.ts';
import type { Camp } from './general_types.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * 摆一场仗出来。
 *
 * 两座营分踞左右，中间是那一段地。
 * 我的兵**不摆上去** —— 它们在 pool 里，等你派。
 */
export function makeTheatre(
  state: WorldState,
  idx: ContentIndex,
  camp: Camp,
  targetNodeId: string,
): Theatre | null {
  const target = state.nodes[targetNodeId];
  const there = idx.node.get(targetNodeId);
  if (!target || !there) return null;

  const survey = surveyRoute(camp.at, there.at as [number, number], idx.terrain);
  const cells = makeTheatreMap(state.rng, survey);

  // 两头。我在西，敌在东 —— 固定下来，玩家不必每次重新认方向
  const ownCamp: [number, number] = [3.5, ROWS / 2 + nextRange(state.rng, -3, 3)];
  const foeCamp: [number, number] = [COLS - 4.5, ROWS / 2 + nextRange(state.rng, -3, 3)];
  flatten(cells, [Math.round(ownCamp[0]), Math.round(ownCamp[1])], 3);
  flatten(cells, [Math.round(foeCamp[0]), Math.round(foeCamp[1])], 3.5);
  // 两营之间总有一条大道 —— 没有道的战场是不真实的，
  // 而且「走大路还是绕小道」这个取舍要有大路才成立
  carveRoad(cells, ownCamp, foeCamp);

  const out = campOutput(camp, idx);

  // 斥候：营里练得好、扎在林中的，探子出得去也回得来
  const intel = clamp(
    26 + Math.floor(camp.training / 2) + Math.floor(out.cover / 3)
    + nextInt(state.rng, 18),
    0, 100,
  );

  /**
   * 这是哪一种仗。
   *
   * 天下图上每一处都是城，所以「去打谁的城」永远是**攻城**。
   * 野战出现在另一个场合：**自家的城被围了，你去救**——
   * 那时你打的是城下那支围兵，两军在野地里对垒，
   * 城墙不在你和敌人之间，而在你身后。
   *
   * 这也正是主公会派你去做的事。
   */
  const siege = state.sieges[targetNodeId];
  const mine = target.factionId === state.official.lordId;
  const kind: TheatreKind = mine && siege ? 'field' : 'siege';

  const t: Theatre = {
    kind,
    cols: COLS,
    rows: ROWS,
    cells,
    units: [],
    ownCamp,
    foeCamp,
    foeName: there.name,
    foeFactionId: target.factionId,
    targetNodeId,
    phase: 'orders',
    tick: 0,
    maxTicks: MAX_TICKS,
    intel,
    scouts: 0,
    report: null,
    foeSupply: 1000,
    wall: kind === 'siege' ? 1000 : 0,
    engines: camp.gear,
    pool: splitPool(camp.troops, out.bowCap, out.horseCap, camp.training),
    lastAlive: -1,
    staleFor: 0,
    pressing: false,
    toldPressing: false,
    pressedAt: -1,
    pullingAt: -1,
    duel: null,
    dueled: false,
    log: [],
    outcome: null,
    result: null,
  };

  // 敌军布防。他先摆，你后派 —— 所以你是有得选的那一方。
  // 救援时打的是城下那支围兵，不是城里的守军
  placeDefenders(state, t, siege && mine ? siege.troops : target.troops, idx);
  return t;
}

/**
 * 营里带出来的兵，按兵种分成几堆。
 *
 * 上限是营里的设施定的（厩栏、弓弩坊），
 * 训练度决定你能把那个上限用出几成 —— 有马而不会骑等于没有。
 */
function splitPool(
  troops: number, bowCap: number, horseCap: number, training: number,
): Record<UnitKind, number> {
  const reach = 0.45 + (clamp(training, 0, 100) / 100) * 0.55;
  const bow = Math.round((troops * bowCap * reach) / 1000);
  const horse = Math.round((troops * horseCap * reach) / 1000);
  return { foot: Math.max(0, troops - bow - horse), bow, horse };
}

/**
 * 敌军怎么摆。
 *
 * 他不是一堆站在营门口的木桩 —— 他也会守要地：
 * 大营前面摆主力，坡上放弓弩，隘口留一支。
 * 而且他也可能设伏 —— 你不是唯一会用计的人。
 */
function placeDefenders(
  state: WorldState, t: Theatre, troops: number, idx: ContentIndex,
): void {
  const rng = state.rng;
  const pool = splitPool(
    troops, 150 + nextInt(rng, 120), nextInt(rng, 110), 45 + nextInt(rng, 30),
  );

  /**
   * 一堆人分成几队。
   *
   * 上一版这里的下标用错了，九百人只摆得出四百九 ——
   * 凭空少掉的那四百人，玩家是看不见的，只会觉得「这仗怎么这么好打」。
   * 所以这里一个人都不许漏：最后一队直接吃掉余数。
   */
  const chunk = (total: number, parts: number): number[] => {
    if (parts <= 0 || total <= 0) return [];
    const out: number[] = [];
    let left = total;
    for (let i = 0; i < parts; i++) {
      const take = i === parts - 1 ? left : Math.round(total / parts);
      out.push(take);
      left -= take;
    }
    return out.filter((n) => n >= 30);
  };

  // 守军拆成两三支就够了。
  //
  // 拆得太碎的后果是每一支都一触即溃，而每溃一支旁边再掉一截士气 ——
  // 守方会自己把自己吓垮。宁可少而厚
  // 步卒**按职责分**，不按下标分。
  //
  // 上一版是「第一支去看营」，于是拆一支的时候唯一的主力被抽走，
  // 两军干站到天黑；拆三四支的时候又一触即溃连锁崩盘。
  // 按职责分就没有这个两难：抽两成看营，其余是迎战的主力，
  // 而主力最多拆两支 —— 少而厚。
  const guardMen = Math.round(pool.foot * 0.22);
  const mainMen = pool.foot - guardMen;
  const mainParts = mainMen > 420 ? 2 : 1;

  const plan: {
    kind: UnitKind; men: number; role: 'guard' | 'main' | 'bow' | 'horse';
  }[] = [];
  if (guardMen >= 40) plan.push({ kind: 'foot', men: guardMen, role: 'guard' });
  for (const men of chunk(mainMen, mainParts)) {
    plan.push({ kind: 'foot', men, role: 'main' });
  }
  for (const men of chunk(pool.bow, pool.bow > 240 ? 2 : 1)) {
    plan.push({ kind: 'bow', men, role: 'bow' });
  }
  for (const men of chunk(pool.horse, 1)) {
    plan.push({ kind: 'horse', men, role: 'horse' });
  }

  // 迎战的几支在**营前**集结 —— 要在鹿角壕沟的掩护之内（见 FORTIFIED_RANGE）。
  //
  // 上一版摆在营外九格，正好落在工事加成之外，
  // 等于守将主动放弃自己的营出来野战。那不合情理，
  // 也让攻方以少胜多变得太容易。
  const rally: [number, number] = [
    t.foeCamp[0] - 5 - nextRange(rng, 0, 1.5),
    t.foeCamp[1] + nextRange(rng, -2, 2),
  ];

  const made = { main: 0, sortie: 0 };
  // 这一仗已经露过面的人。同一个人不该同时领两路
  const used = new Set<string>();
  const warden = wardenOf(state, idx, t.targetNodeId);
  if (warden) used.add(warden.id);

  for (const p of plan) {
    let x = t.foeCamp[0] - 3 - nextRange(rng, 0, 4);
    let y = t.foeCamp[1] + nextRange(rng, -6, 6);
    if (p.role === 'bow') {
      const high = findGround(t, 'hill', t.foeCamp);
      if (high) { x = high[0]; y = high[1]; }
    }

    const u = newUnit(state, 'foe', p.kind, p.men, x, y);
    // 主力拆成两支的时候，两支都叫「敌前军」就白起了名字
    u.name = p.role === 'main' && mainParts > 1
      ? (made.main++ === 0 ? '敌前军' : '敌中军')
      : FOE_NAME[p.role];
    /**
     * 对面带兵的人。
     *
     * 名字要从**这一家**里取 —— 上一版是从一份没有归属的名单里随手抽，
     * 于是会出现「攻孔融的城，董卓帐下的华雄出来单挑」这种事。
     *
     * 主力那一路交给这座城的守将（他常驻在那儿，见 state.posts），
     * 其余几路从同一家的人里取。取不出来就是无名的偏将 ——
     * 硬凑一个别家的人出来，比没有名字更糟。
     */
    const isMain = p.role === 'main' && made.main <= 1;
    const who = (isMain ? warden : null) ?? someoneFrom(idx, rng, t.foeFactionId, used);
    if (who) {
      u.leader = who.name;
      u.valor = who.valor;
      u.command = who.command;
      u.wit = who.wit;
      u.temper = who.temper;
    } else {
      u.leader = '偏将';
      u.valor = 38 + nextInt(rng, 34);
      u.command = 38 + nextInt(rng, 34);
      u.wit = 38 + nextInt(rng, 34);
    }
    u.morale = 58 + nextInt(rng, 16);
    u.facing = Math.PI;

    // 守军不是一排木桩：弓弩守着高处，留一支看家，主力看是哪一种仗
    if (p.role === 'bow') {
      u.stance = 'hold';
      u.toX = u.x; u.toY = u.y;
    } else if (p.role === 'guard') {
      u.stance = 'hold';
      u.x = t.foeCamp[0] - 1.5;
      u.y = t.foeCamp[1];
      u.toX = u.x; u.toY = u.y;
    } else if (t.kind === 'siege') {
      // 攻城：主力在城下**列阵据守**，不是冲出去追人。
      //
      // 上一版给的是「主攻」，于是守军一见敌就扑上去，
      // 自己跑出了鹿角壕沟的范围 —— 营寨的加成一次都没生效过。
      // 守将不会这么打：他等你来撞他的阵。
      u.stance = 'hold';
      u.toX = rally[0];
      u.toY = rally[1] + nextRange(rng, -2, 2);
    } else {
      /**
       * 野战（你去解围）：围城的那支兵会**分兵来打你**。
       *
       * 这一条以前是没有的 —— 所有守军一律钉在自己营前，
       * 从头到尾一步不挪。后果比看上去严重得多：
       *
       *   一、**埋伏彻底失效**。伏兵靠的是敌军走过来，
       *      对面既然不动，你把兵藏在哪块林子里都一样是白藏。
       *      这条线最漂亮的玩法，等于从来没有开过。
       *
       *   二、每一仗都长得一样：走过大半张图，撞上去磨，
       *      磨到两边都按不住了一齐压上。地形一次也没进过账。
       *
       * 而现实里「围点打援」正是这种局面的常法：
       * 留一部围着，主力迎着来援的这一路上去。
       * 他一动，你埋在他必经之路上的那支兵才有意义。
       */
      //
      // 但**他不会把营空出来**。围城的兵要是全数迎上来，
      // 就等于自己放弃了鹿角壕沟（见 FORTIFIED），
      // 在旷野上被你以多打少 —— 实测九百打七百六只折八十人，
      // 那不是打仗，是收割。
      // 所以只分一路来截你，剩下的守在营前等你来撞。
      if (made.sortie++ === 0) {
        u.stance = 'assault';
        u.toX = (t.ownCamp[0] + t.foeCamp[0]) / 2 + nextRange(rng, -3, 3);
        u.toY = (t.ownCamp[1] + t.foeCamp[1]) / 2 + nextRange(rng, -4, 4);
      } else {
        u.stance = 'hold';
        u.toX = rally[0];
        u.toY = rally[1] + nextRange(rng, -2, 2);
      }
    }
    t.units.push(u);
  }

  // 他也可能埋伏你。斥候差的时候你根本不知道有这一手
  if (chancePermille(rng, 420)) {
    const spot = findGround(t, 'forest', [t.cols / 2, t.rows / 2]);
    // 从**最厚的那一支**里抽人。原先这里找的是 stance==='assault'，
    // 而守军早就全改成了 'hold' —— 于是这一整段从来没有执行过，
    // 「敌军也会埋伏你」这件事在游戏里根本不存在
    const main = t.units
      .filter((u) => u.side === 'foe' && u.kind === 'foot' && u.stance !== 'hold')
      .sort((a, b) => b.men - a.men)[0]
      ?? t.units
        .filter((u) => u.side === 'foe' && u.kind === 'foot')
        .sort((a, b) => b.men - a.men)[0];
    if (spot && main && main.men > 160) {
      const split = Math.floor(main.men * 0.4);
      main.men -= split;
      main.men0 = main.men;
      const u = newUnit(state, 'foe', 'foot', split, spot[0], spot[1]);
      u.name = '敌伏兵';
      // 伏兵也得有个带头的 —— 不然他杀出来之后既叫不了阵也没法被叫
      const led = someoneFrom(idx, rng, t.foeFactionId, used);
      u.leader = led?.name ?? '偏将';
      u.valor = led?.valor ?? 55;
      u.command = led?.command ?? 55;
      u.wit = led?.wit ?? (55 + nextInt(rng, 30));
      u.stance = 'ambush';
      u.hidden = true;
      u.toX = spot[0]; u.toY = spot[1];
      u.morale = 62;
      t.units.push(u);
    }
  }
}

/** 找一块这种地。找不到就算了 */
function findGround(
  t: Theatre, ground: string, near: [number, number],
): [number, number] | null {
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (let r = 1; r < t.rows - 1; r++) {
    for (let c = 1; c < t.cols - 1; c++) {
      if (t.cells[r * t.cols + c]!.ground !== ground) continue;
      const d = Math.hypot(c - near[0], r - near[1]);
      if (d < bestD) { bestD = d; best = [c, r]; }
    }
  }
  return best;
}

/**
 * 对面那几支叫什么。
 *
 * 守军是按职责摆的（看营的、迎战的主力、弓弩、骑兵），
 * 战报里就照这个称呼 —— 「敌前军溃」和「敌守营兵溃」
 * 对玩家是完全不同的两件事：前者是仗赢了，后者是营快破了。
 */
const FOE_NAME: Record<'guard' | 'main' | 'bow' | 'horse', string> = {
  guard: '敌守营兵',
  main: '敌前军',
  bow: '敌弓弩',
  horse: '敌骑',
};

export function newUnit(
  state: WorldState, side: 'own' | 'foe', kind: UnitKind,
  men: number, x: number, y: number,
): Unit {
  return {
    id: mintId(state, side === 'own' ? 'tu' : 'tf'),
    side,
    kind,
    officerId: null,
    name: (side === 'own' ? '' : '敌') + KIND_NAME[kind],
    leader: '',
    men,
    men0: men,
    morale: 66,
    x, y,
    facing: side === 'own' ? 0 : Math.PI,
    toX: x, toY: y,
    stance: 'assault',
    hidden: false,
    revealed: false,
    routed: false,
    target: null,
    temper: null,
    valor: 50,
    command: 50,
    wit: 50,
    strayed: false,
    toldEngaged: false,
    toldPressed: false,
    waited: 0,
    springing: false,
    idle: 0,
    shaken: 0,
    wound: 0,
  };
}

/** 这一格藏不藏得住人。派埋伏之前界面要能告诉玩家 */
export function hidesWell(t: Theatre, x: number, y: number): boolean {
  const cell = cellAt(t.cells, x, y);
  return cell.ground === 'forest' || cell.ground === 'hill' || cell.ground === 'marsh';
}
