/**
 * 战场的测试。
 *
 * 守的是几条**曾经全线失效、却完全看不出来**的机制。
 * 每一条都能跑出漂亮的胜率表，而实际上那件事一次都没发生过：
 *
 *   一、**伏兵真的会杀出来**。
 *      「看」排在「打」前面，而伏兵冲出遮蔽之后就没得藏了 ——
 *      他每次都在够着人之前被 look() 标成已暴露，
 *      于是 fight() 里那句 `if (from.hidden)` 永远是假的。
 *      AMBUSH_BLOW、士气崩、乱阵，一整套从来没有执行过。
 *      推演十二局，伏兵出手零次；而胜率表上什么都看不出来，
 *      只显得「埋伏这个打法比较弱」。
 *
 *   二、**敌军自己也会设伏**。那段代码找的是 stance==='assault' 的守军，
 *      而守军早就全改成了 'hold' —— 于是它一次也没被执行过。
 *
 *   三、**围城的会分兵来打你**。他不动，你埋在哪块林子里都一样是白埋。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import type { SimEvent } from '../src/sim/commands.ts';
import type { ContentDB } from '../src/sim/content.ts';
import { STARTING_CAMP } from '../src/sim/general_types.ts';
import {
  SCOUT_MAX, SCOUT_MEN, WITHDRAW_TICKS, type Theatre,
} from '../src/sim/theatre_types.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'),
  terrain: read('terrain'), people: read('people'), text: read('text'),
} as ContentDB;

/** 摆一场解围之战：自家的城被围了，你带兵去救 —— 那是野战 */
function relief(seed: string, mine: number, foe: number): { e: Engine; t: Theatre } {
  const e = new Engine(seed, content);
  e.dispatch({
    t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
  });
  const st = e.getState() as never as {
    camps: Record<string, { troops: number; training: number; gear: number; grain: number }>;
    sieges: Record<string, unknown>;
    official: { cityId: string };
    retinue: string[];
  };
  const camp = st.camps[STARTING_CAMP]!;
  camp.troops = mine; camp.training = 70; camp.gear = 3; camp.grain = 6000;
  st.retinue = ['dianwei', 'yuejin', 'lidian', 'caoren'];
  const at = st.official.cityId;
  st.sieges[at] = { cityId: at, factionId: 'taiping', troops: foe, supply: 9000, days: 3 };
  e.dispatch({ t: 'theatre_open', targetNodeId: at });
  return { e, t: e.getState().theatre! };
}

/** 中路一带最近的一块藏得住人的地 */
function cover(t: Theatre, cx: number, cy: number): [number, number] | null {
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (let r = 1; r < t.rows - 1; r++) {
    for (let c = 1; c < t.cols - 1; c++) {
      const g = t.cells[r * t.cols + c]!.ground;
      if (g !== 'forest' && g !== 'hill') continue;
      const d = Math.hypot(c - cx, r - cy);
      if (d < bestD) { bestD = d; best = [c, r]; }
    }
  }
  return best;
}

function fight(e: Engine, t: Theatre): void {
  e.dispatch({ t: 'theatre_begin' });
  let guard = 0;
  while (t.phase === 'fighting' && guard++ < 950) e.dispatch({ t: 'theatre_step', ticks: 1 });
}

// ─────────────────────────────────────────────────────────────

test('伏兵真的会杀出来，不是白蹲一场', () => {
  let sprung = 0;
  let ran = 0;
  for (let i = 0; i < 12; i++) {
    const { e, t } = relief('amb' + i, 450, 550);
    const midX = (t.ownCamp[0] + t.foeCamp[0]) / 2;
    const spot = cover(t, midX, t.ownCamp[1]);
    if (!spot) continue;
    // 一小股在前头引，主力伏在侧旁
    e.dispatch({
      t: 'theatre_send', kind: 'foot', men: Math.round(t.pool.foot * 0.3),
      col: Math.round(midX + 3), row: Math.round(t.ownCamp[1]),
      stance: 'assault', officerId: null,
    });
    const sent = e.dispatch({
      t: 'theatre_send', kind: 'foot', men: Math.round(t.pool.foot * 0.7),
      col: spot[0], row: spot[1], stance: 'ambush', officerId: 'yuejin',
    });
    if (!sent.some((x) => x.t === 'theatre_sent')) continue;
    ran++;
    fight(e, t);
    if (t.log.some((l) => l.textId === 'th.ambush_ours')) sprung++;
  }
  assert.ok(ran >= 8, `该摆得起至少八局，实测只摆起 ${ran} 局`);
  assert.ok(
    sprung >= ran * 0.4,
    `伏在敌军来路上，起码四成的局里该真的杀出来，实测 ${sprung}/${ran}`,
  );
});

test('围城的会分兵来打你，但不会把营空出来', () => {
  // 他不动，你埋在哪块林子里都一样是白埋 ——
  // 「伏击」这套玩法成立的前提，是对面得走过来。
  // 可他要是倾巢而出，又等于自己放弃了鹿角壕沟
  let moved = 0;
  for (let i = 0; i < 8; i++) {
    const { t } = relief('sortie' + i, 450, 550);
    if (t.units.some((u) => u.side === 'foe' && u.stance === 'assault')) moved++;
    const stay = t.units.filter((u) => u.side === 'foe' && u.stance === 'hold');
    assert.ok(stay.length > 0, '围城的总得留人看着营');
  }
  assert.equal(moved, 8, `每一局都该有一路来截你，实测只有 ${moved}/8 局有`);
});

test('攻城时守军不会被「按不住了」拽出工事', () => {
  // 「僵久了谁都按不住」讲的是两支野战军对望。
  // 守着自家鹿角壕沟的人没有这个道理 —— 他等的就是你来撞。
  // 少了这一层，营寨的加成一次都不会生效
  const e = new Engine('siege', content);
  e.dispatch({
    t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
  });
  const st = e.getState() as never as {
    camps: Record<string, { troops: number; training: number; gear: number; grain: number }>;
    nodes: Record<string, { factionId: string }>;
    official: { lordId: string };
  };
  const camp = st.camps[STARTING_CAMP]!;
  camp.troops = 800; camp.training = 70; camp.gear = 3; camp.grain = 6000;
  const foe = Object.entries(st.nodes).find(([, n]) => n.factionId !== st.official.lordId)!;
  e.dispatch({ t: 'theatre_open', targetNodeId: foe[0] });
  const t = e.getState().theatre!;
  assert.equal(t.kind, 'siege');

  // 只看奉命「据守」的那几支。城里也可能另伏一支兵，
  // 那一支本来就是要跑出来的
  const guards = t.units.filter((u) => u.side === 'foe' && u.stance === 'hold');
  const home: [number, number][] = guards.map((u) => [u.x, u.y]);
  // 你去撞他 —— 这一仗必须打在他的营前，而不是被他迎到半路上
  e.dispatch({
    t: 'theatre_send', kind: 'foot', men: Math.min(400, t.pool.foot),
    col: Math.round(t.foeCamp[0] - 6), row: Math.round(t.foeCamp[1]),
    stance: 'assault', officerId: null,
  });
  fight(e, t);

  const strayed = guards.filter((u, i) => {
    if (u.routed) return false;
    const [x0, y0] = home[i]!;
    return Math.hypot(u.x - x0, u.y - y0) > 14;
  });
  assert.equal(strayed.length, 0, '守军跑出了工事 —— 营寨的加成就白设了');
});

test('一场仗要讲得出故事，不是几行一模一样的字', () => {
  // 上一版打两百多拍只出五行日志，其中四行都是「敌一路溃了」。
  // 玩家的原话是「开战后啥反馈都没有」—— 仗打得对，可是没人在讲它
  const { e, t } = relief('tale', 700, 550);
  const mid = Math.round((t.ownCamp[0] + t.foeCamp[0]) / 2);
  const row = Math.round(t.ownCamp[1]);
  e.dispatch({
    t: 'theatre_send', kind: 'foot', men: Math.round(t.pool.foot * 0.6),
    col: mid, row, stance: 'assault', officerId: null,
  });
  e.dispatch({
    t: 'theatre_send', kind: 'foot', men: Math.round(t.pool.foot * 0.4),
    col: mid, row: Math.max(1, row - 2), stance: 'assault', officerId: 'yuejin',
  });
  fight(e, t);

  const kinds = new Set(t.log.map((l) => l.textId));
  assert.ok(t.log.length >= 8, `一场仗该写得出八行以上，实测只有 ${t.log.length} 行`);
  assert.ok(kinds.size >= 4, `写出来的该有四种以上的事，实测只有 ${kinds.size} 种`);
  assert.ok(kinds.has('th.engaged'), '「接上手了」这一句必须有 —— 那是仗的开头');
  const named = t.log.filter((l) => typeof l.vars?.['who'] === 'string');
  assert.ok(named.length >= t.log.length / 2, '战报上过半的行该叫得出是哪一路');
});

test('打完一仗，账要留在战场上，收兵那一屏才写得出战报', () => {
  const { e, t } = relief('tally', 700, 550);
  const mid = Math.round((t.ownCamp[0] + t.foeCamp[0]) / 2);
  e.dispatch({
    t: 'theatre_send', kind: 'foot', men: Math.min(400, t.pool.foot),
    col: mid, row: Math.round(t.ownCamp[1]), stance: 'assault', officerId: null,
  });
  fight(e, t);
  assert.ok(t.result, '打完了该有一份账');
  assert.equal(t.result!.sent, t.result!.back + t.result!.lost, '派出去的 = 回来的 + 折的');
  assert.ok(t.result!.foeLost > 0, '打了半天总该杀伤了一些人');
});

// ─────────────────────────────────────────────────────────────
// 退路
// ─────────────────────────────────────────────────────────────

test('按兵不动也收得了场，不会僵到天黑', () => {
  /**
   * 玩家的原话：「我方不主攻就会僵住，也没有其他退出方式，游戏卡住走不了」。
   *
   * 实测确实如此：全军「据守」在自家营门口，守军窝在自己的鹿角后头，
   * 两军隔着大半张图站满九百拍 —— 期间只写出两行战报，
   * 而观战那一屏上一个能点的按钮都没有。
   *
   * 现实里守将不会这么待着：你既然不来撞我，那我就出去赶你。
   */
  const e = new Engine('nostall', content);
  e.dispatch({
    t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
  });
  const st = e.getState() as never as {
    camps: Record<string, { troops: number; training: number; gear: number; grain: number }>;
    nodes: Record<string, { factionId: string }>;
    official: { lordId: string };
  };
  const camp = st.camps[STARTING_CAMP]!;
  camp.troops = 800; camp.training = 70; camp.gear = 3; camp.grain = 6000;
  const foe = Object.entries(st.nodes).find(([, n]) => n.factionId !== st.official.lordId)!;
  e.dispatch({ t: 'theatre_open', targetNodeId: foe[0] });
  const t = e.getState().theatre!;

  e.dispatch({
    t: 'theatre_send', kind: 'foot', men: Math.min(400, t.pool.foot),
    col: Math.round(t.ownCamp[0] + 2), row: Math.round(t.ownCamp[1]),
    stance: 'hold', officerId: null,
  });
  fight(e, t);

  assert.equal(t.phase, 'done');
  assert.ok(
    t.tick < t.maxTicks * 0.6,
    `按兵不动也该有人来收场，实测拖到第 ${t.tick} 拍（上限 ${t.maxTicks}）`,
  );
  assert.ok(t.log.length >= 5, `这一仗该讲得出话来，实测只写出 ${t.log.length} 行`);
});

test('一场没打过的仗，不算你输', () => {
  // 原先天黑的判定是比**剩下的人数**：四百对九百，判你输 ——
  // 可那一仗你一个人都没折，对面也一个人都没折。
  // 该比的是各自折了多少，不是各自还剩多少
  const { e, t } = relief('nofight', 700, 550);
  const mid = Math.round((t.ownCamp[0] + t.foeCamp[0]) / 2);
  e.dispatch({
    t: 'theatre_send', kind: 'foot', men: 200,
    col: Math.round(t.ownCamp[0] + 2), row: Math.round(t.ownCamp[1]),
    stance: 'hold', officerId: null,
  });
  void mid;
  e.dispatch({ t: 'theatre_begin' });
  // 还没接战就天黑
  t.maxTicks = t.tick + 2;
  e.dispatch({ t: 'theatre_step', ticks: 5 });

  assert.equal(t.phase, 'done');
  assert.equal(
    t.outcome, 'withdrew',
    '两边都没折人就天黑了，那是各自收兵，不是败仗',
  );
});

test('鸣金收兵是一条走得通的退路', () => {
  // 打起来之后必须有一个能按下去的按钮 —— 这一条原先根本不存在
  const { e, t } = relief('gong', 500, 700);
  const mid = Math.round((t.ownCamp[0] + t.foeCamp[0]) / 2);
  e.dispatch({
    t: 'theatre_send', kind: 'foot', men: Math.min(300, t.pool.foot),
    col: mid, row: Math.round(t.ownCamp[1]), stance: 'assault', officerId: null,
  });
  e.dispatch({ t: 'theatre_begin' });
  for (let i = 0; i < 60; i++) e.dispatch({ t: 'theatre_step', ticks: 1 });

  const still = t.phase === 'fighting';
  assert.ok(still, '这会儿仗该还在打');
  const evs = e.dispatch({ t: 'theatre_withdraw' });
  assert.ok(!evs.some((x) => x.t === 'rejected'), '打起来之后就该撤得了');

  let guard = 0;
  while (t.phase === 'fighting' && guard++ < 400) e.dispatch({ t: 'theatre_step', ticks: 1 });
  assert.equal(t.phase, 'done', '鸣金之后必须收得了场');
  assert.equal(t.outcome, 'withdrew');
  assert.ok(
    t.tick - t.pullingAt <= WITHDRAW_TICKS + 2,
    `撤退要有个头，实测撤了 ${t.tick - t.pullingAt} 拍`,
  );
  assert.equal(t.result?.merit, 0, '撤下来的仗没有战功');
});

test('还没击鼓的时候鸣不了金 —— 那时候用的是「收兵回营」', () => {
  const { e, t } = relief('gong2', 500, 550);
  const evs = e.dispatch({ t: 'theatre_withdraw' });
  assert.ok(
    evs.some((x) => x.t === 'rejected' && x.reasonId === 'not_fighting'),
    '仗还没打起来就不该有「鸣金」这一说',
  );
  assert.equal(t.phase, 'orders');
});

// ─────────────────────────────────────────────────────────────
// 细作
// ─────────────────────────────────────────────────────────────

/** 摆一场攻城，营里的训练度可调 —— 细作的本事跟着它走 */
function assault(seed: string, training: number): { e: Engine; t: Theatre } {
  const e = new Engine(seed, content);
  e.dispatch({
    t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
  });
  const st = e.getState() as never as {
    camps: Record<string, { troops: number; training: number; gear: number; grain: number }>;
    nodes: Record<string, { factionId: string }>;
    official: { lordId: string };
  };
  const camp = st.camps[STARTING_CAMP]!;
  camp.troops = 700; camp.training = training; camp.gear = 2; camp.grain = 5000;
  const foe = Object.entries(st.nodes).find(([, n]) => n.factionId !== st.official.lordId)!;
  e.dispatch({ t: 'theatre_open', targetNodeId: foe[0] });
  return { e, t: e.getState().theatre! };
}

test('细作要花人，而且派不了几拨', () => {
  const { e, t } = assault('scoutcost', 70);
  const before = t.pool.foot;
  e.dispatch({ t: 'theatre_scout' });
  assert.equal(t.pool.foot, before - SCOUT_MEN, '一拨细作要从手上的兵里出');
  assert.equal(t.scouts, 1);

  for (let i = 0; i < SCOUT_MAX + 3; i++) e.dispatch({ t: 'theatre_scout' });
  assert.equal(t.scouts, SCOUT_MAX, `最多派 ${SCOUT_MAX} 拨，实测派出了 ${t.scouts} 拨`);

  const no = e.dispatch({ t: 'theatre_scout' });
  assert.ok(
    no.some((x) => x.t === 'rejected' && x.reasonId === 'no_more_scouts'),
    '派满了就该挡住',
  );
});

test('细作说的话不一定是真的', () => {
  // 「可能是假的」必须真的会发生 —— 否则那就是一句写在提示里的空话。
  // 而且假的那一份在界面上要和真的长得一模一样：
  // 报告里没有任何记号能让玩家一眼看破，他只能掂量、只能赌
  let sound = 0;
  let lies = 0;
  for (let i = 0; i < 120; i++) {
    const { e, t } = assault('lie' + i, 45);
    e.dispatch({ t: 'theatre_scout' });
    if (!t.report) continue;
    if (t.report.sound) sound++; else lies++;
  }
  assert.ok(lies > 0, '假情报一次都不出，那「可能是假的」就是句空话');
  assert.ok(sound > 0, '也不能全是假的 —— 那玩家索性不派了');
  assert.ok(
    lies < sound,
    `假的该比真的少，实测真 ${sound} 假 ${lies}`,
  );
});

test('假情报报的数目，和城下真有的人对不上', () => {
  for (let i = 0; i < 200; i++) {
    const { e, t } = assault('off' + i, 45);
    e.dispatch({ t: 'theatre_scout' });
    const r = t.report;
    if (!r || r.sound) continue;
    const real = t.units.filter((u) => u.side === 'foe').reduce((a, u) => a + u.men, 0);
    assert.ok(
      Math.abs(r.men - real) > real * 0.2,
      `假情报要假得有分量，实测报 ${r.men} 而实有 ${real}`,
    );
    return;
  }
  assert.fail('两百局里一份假情报都没出，这条测试没测到东西');
});

test('探明了就能指出他藏着的那一支', () => {
  // 这是提前看破埋伏的唯一门路。没有它，细作就只是个加数字的按钮
  let found = 0;
  let had = 0;
  for (let i = 0; i < 80; i++) {
    const { e, t } = assault('hid' + i, 95);
    if (!t.units.some((u) => u.side === 'foe' && u.hidden && !u.revealed)) continue;
    had++;
    for (let k = 0; k < SCOUT_MAX; k++) e.dispatch({ t: 'theatre_scout' });
    if (!t.units.some((u) => u.side === 'foe' && u.hidden && !u.revealed)) found++;
  }
  assert.ok(had >= 5, `该有几局对面是设了伏的，实测只有 ${had} 局`);
  assert.ok(
    found >= had * 0.6,
    `派满细作之后，多数时候该把伏兵挖出来，实测 ${found}/${had}`,
  );
});

test('营里练得好，细作才探得明白', () => {
  // 细作不该是一颗独立的骰子 —— 它是「你把营经营成什么样」的又一次兑现
  const rate = (training: number): number => {
    let clear = 0;
    let n = 0;
    for (let i = 0; i < 150; i++) {
      const { e } = assault('tr' + i, training);
      for (const ev of e.dispatch({ t: 'theatre_scout' })) {
        if (ev.t === 'theatre_scouted') { n++; if (ev.kind === 'clear') clear++; }
      }
    }
    return clear / Math.max(1, n);
  };
  const green = rate(20);
  const drilled = rate(95);
  assert.ok(
    drilled > green + 0.15,
    `练过的营该探得明白得多，实测生兵 ${(green * 100).toFixed(0)}%、` +
    `练兵 ${(drilled * 100).toFixed(0)}%`,
  );
});

test('击鼓之后就派不出细作了', () => {
  const { e, t } = assault('late', 70);
  e.dispatch({
    t: 'theatre_send', kind: 'foot', men: 200,
    col: Math.round(t.cols / 2), row: Math.round(t.rows / 2),
    stance: 'assault', officerId: null,
  });
  e.dispatch({ t: 'theatre_begin' });
  const no = e.dispatch({ t: 'theatre_scout' });
  assert.ok(
    no.some((x) => x.t === 'rejected'),
    '仗都打起来了，细作是来不及派了',
  );
});

// ─────────────────────────────────────────────────────────────
// 派谁去
// ─────────────────────────────────────────────────────────────

test('派谁领兵是算数的', () => {
  /**
   * 招一名部将要二百六十石、二十四天，界面上写着「统 76 勇 68」——
   * 而在这之前，theatre.ts 里 grep 不到一个 valor、一个 command：
   * **招谁都一样，招不招也一样**。那几个数字纯粹是画上去的，
   * 「招将」这条发育线整条是假的。
   *
   * 这里比的是同一场仗打两遍：种子一样、地形一样、派法一样，
   * 只把领兵那个人的本事换掉。勇不消耗随机数，
   * 所以两次的分岔**只可能是这个人带来的**。
   */
  const withValor = (valor: number, command: number): { lost: number; wins: number } => {
    let lost = 0;
    let wins = 0;
    for (let i = 0; i < 16; i++) {
      const { e, t } = relief('lead' + i, 700, 620);
      e.dispatch({
        t: 'theatre_send', kind: 'foot', men: Math.min(500, t.pool.foot),
        col: Math.round((t.ownCamp[0] + t.foeCamp[0]) / 2),
        row: Math.round(t.ownCamp[1]), stance: 'assault', officerId: null,
      });
      const u = t.units.find((x) => x.side === 'own')!;
      u.valor = valor;
      u.command = command;
      fight(e, t);
      lost += t.result?.lost ?? 0;
      if (t.outcome === 'won') wins++;
    }
    return { lost, wins };
  };

  // 比的是**折了多少**。杀伤那一头很容易顶到「全歼」而看不出差别，
  // 自家折了多少人才是那个人带兵好不好的真账
  const dull = withValor(20, 20);
  const great = withValor(95, 95);
  assert.ok(
    great.lost < dull.lost * 0.9,
    `猛将带兵该折得少，实测折 ${great.lost} 对 ${dull.lost}`,
  );
  assert.ok(
    great.wins >= dull.wins,
    `猛将的胜数不该更少，实测 ${great.wins} 对 ${dull.wins}`,
  );
});

test('智略高的伏得更深', () => {
  // 「智」在战场上的实处就是这一条：藏得住。
  // 少了它，officers.json 里那一列数字有一半是白写的
  const spotted = (wit: number): number => {
    let seen = 0;
    let ran = 0;
    for (let i = 0; i < 20; i++) {
      const { e, t } = relief('wit' + i, 450, 550);
      const midX = (t.ownCamp[0] + t.foeCamp[0]) / 2;
      const spot = cover(t, midX, t.ownCamp[1]);
      if (!spot) continue;
      e.dispatch({
        t: 'theatre_send', kind: 'foot', men: Math.round(t.pool.foot * 0.3),
        col: Math.round(midX + 3), row: Math.round(t.ownCamp[1]),
        stance: 'assault', officerId: null,
      });
      const sent = e.dispatch({
        t: 'theatre_send', kind: 'foot', men: Math.round(t.pool.foot * 0.7),
        col: spot[0], row: spot[1], stance: 'ambush', officerId: 'yuejin',
      });
      if (!sent.some((x) => x.t === 'theatre_sent')) continue;
      // 直接改这一路主将的智略，别的都不动
      const amb = t.units.find((u) => u.side === 'own' && u.stance === 'ambush')!;
      amb.wit = wit;
      ran++;
      fight(e, t);
      if (t.log.some((l) => l.textId === 'th.spotted_ours')) seen++;
    }
    return seen / Math.max(1, ran);
  };
  const dull = spotted(10);
  const sharp = spotted(95);
  assert.ok(
    sharp <= dull,
    `智略高的该更不容易被发现，实测 智10 露 ${(dull * 100).toFixed(0)}%、智95 露 ${(sharp * 100).toFixed(0)}%`,
  );
});

// ─────────────────────────────────────────────────────────────
// 斗将
// ─────────────────────────────────────────────────────────────

/** 直接摆一场单挑上去，不骑真实的仗 —— 免得仗先结束把长的那些砍掉 */
function stageDuel(
  seed: string, ownValor: number, foeValor: number,
): { e: Engine; t: Theatre } | null {
  const { e, t } = relief(seed, 700, 600);
  const sent = e.dispatch({
    t: 'theatre_send', kind: 'foot', men: 300,
    col: Math.round((t.ownCamp[0] + t.foeCamp[0]) / 2),
    row: Math.round(t.ownCamp[1]), stance: 'assault', officerId: 'dianwei',
  });
  if (!sent.some((x) => x.t === 'theatre_sent')) return null;
  e.dispatch({ t: 'theatre_begin' });
  const own = t.units.find((u) => u.side === 'own');
  const foe = t.units.find((u) => u.side === 'foe');
  if (!own || !foe) return null;
  t.duel = {
    ownUnitId: own.id, foeUnitId: foe.id,
    ownName: '甲', foeName: '乙',
    ownValor, foeValor, ownOfficerId: 'dianwei',
    offeredAt: t.tick, round: 0, ownWins: 0, foeWins: 0,
    state: 'offered', outcome: null, fatal: false,
  };
  return { e, t };
}

/** 斗到收场，把结果那条事件捞出来 */
function fightDuel(e: Engine, t: Theatre): SimEvent | null {
  e.dispatch({ t: 'theatre_duel_accept' });
  for (let g = 0; g < 300; g++) {
    for (const ev of e.dispatch({ t: 'theatre_step', ticks: 1 })) {
      if (ev.t === 'duel_settled') return ev;
    }
    if (t.phase !== 'fighting') break;
  }
  return null;
}

test('勇力算数，但不是勇高就必胜', () => {
  /**
   * 这颗按钮只有两条都成立才是个**决定**：
   * 勇力要算数（不然挑谁出马都一样），但不能是算术题
   * （勇高的必胜，看一眼数字就知道答案，那还赌什么）。
   */
  const trial = (mine: number, foe: number): { won: number; lost: number; draw: number } => {
    let won = 0;
    let lost = 0;
    let draw = 0;
    for (let i = 0; i < 160; i++) {
      const st = stageDuel('du' + i, mine, foe);
      if (!st) continue;
      const ev = fightDuel(st.e, st.t);
      if (!ev || ev.t !== 'duel_settled') continue;
      if (ev.outcome === 'won') won++;
      else if (ev.outcome === 'lost') lost++;
      else draw++;
    }
    return { won, lost, draw };
  };

  const even = trial(50, 50);
  const strong = trial(95, 50);
  const weak = trial(50, 95);

  assert.ok(
    strong.won > even.won && even.won > weak.won,
    `勇越高赢得越多，实测 95 勇赢 ${strong.won}、平手赢 ${even.won}、50 对 95 赢 ${weak.won}`,
  );
  assert.ok(
    weak.won > 0,
    '勇低的也该偶尔翻船 —— 全无胜算的赌局不是赌局',
  );
  assert.ok(
    strong.lost > 0,
    '勇高的也该偶尔失手 —— 不然这就是一道算术题',
  );
  assert.ok(
    even.draw > even.won * 0.4,
    `势均力敌该常常不分胜负，实测平 ${even.draw} 胜 ${even.won}`,
  );
});

test('斗将一定会有结果，不会斗到一半没了下文', () => {
  // 玩家点了「出马」，看了两三合，然后再没有下文 ——
  // 一件永远不揭晓的事，比没有这件事更糟
  let settled = 0;
  let ran = 0;
  for (let i = 0; i < 40; i++) {
    const st = stageDuel('done' + i, 60, 60);
    if (!st) continue;
    ran++;
    if (fightDuel(st.e, st.t)) settled++;
  }
  assert.ok(ran >= 30, `该摆得起三十场，实测 ${ran} 场`);
  assert.equal(settled, ran, `每一场都得有个结果，实测 ${settled}/${ran}`);
});

test('斗输了要么折人要么挂彩，而且带得回营', () => {
  // 斗将真正的分量在于**你可能永远失去这个人**。
  // 少了这一段，它就只是一次性的士气波动
  let slain = 0;
  let hurt = 0;
  for (let i = 0; i < 120; i++) {
    const st = stageDuel('hurt' + i, 20, 95);
    if (!st) continue;
    const ev = fightDuel(st.e, st.t);
    if (!ev || ev.t !== 'duel_settled' || ev.outcome !== 'lost') continue;
    const after = st.e.getState();
    if (ev.fatal) {
      assert.ok(!after.retinue.includes('dianwei'), '斩了就该从帐下除名');
      slain++;
    } else {
      assert.ok(
        (after.hurt['dianwei'] ?? 0) > after.day,
        '负伤的要将养一段日子',
      );
      hurt++;
    }
  }
  assert.ok(slain > 0, '一百二十场里该有斗死人的');
  assert.ok(hurt > 0, '也该有只是负伤的');
  assert.ok(hurt > slain, `负伤该比阵亡多，实测 伤 ${hurt} 亡 ${slain}`);
});

test('伤着的部将上不了阵', () => {
  const { e, t } = relief('benched', 700, 600);
  const st = e.getState() as never as { hurt: Record<string, number>; day: number };
  st.hurt['dianwei'] = st.day + 30;
  const no = e.dispatch({
    t: 'theatre_send', kind: 'foot', men: 200,
    col: Math.round(t.ownCamp[0] + 4), row: Math.round(t.ownCamp[1]),
    stance: 'assault', officerId: 'dianwei',
  });
  assert.ok(
    no.some((x) => x.t === 'rejected' && x.reasonId === 'officer_hurt'),
    '伤还没好就该挡住',
  );
});

test('不理他也是一条路，但要当场夺气', () => {
  // 避战是正当的选择 —— 可两军都看着，拒战就是示弱
  const st = stageDuel('refuse', 40, 90);
  assert.ok(st, '该摆得起这一场');
  const before = st!.t.units
    .filter((u) => u.side === 'own')
    .reduce((a, u) => a + u.morale, 0);
  const evs = st!.e.dispatch({ t: 'theatre_duel_refuse' });
  const after = st!.t.units
    .filter((u) => u.side === 'own')
    .reduce((a, u) => a + u.morale, 0);
  assert.ok(after < before, '不出去，本方士气该掉');
  assert.ok(
    evs.some((x) => x.t === 'duel_settled' && x.outcome === 'refused'),
    '拒战也算一种收场',
  );
  // 人还在
  assert.ok(st!.e.getState().retinue.includes('dianwei'), '没出去，人当然还在');
});

test('一仗只斗一次将，不会没完没了地车轮', () => {
  const st = stageDuel('once', 60, 60);
  assert.ok(st);
  fightDuel(st!.e, st!.t);
  const t = st!.t;
  assert.ok(t.dueled, '斗过了就该记上');
  let more = 0;
  for (let g = 0; g < 300 && t.phase === 'fighting'; g++) {
    st!.e.dispatch({ t: 'theatre_step', ticks: 1 });
    if (t.duel) more++;
  }
  assert.equal(more, 0, '一仗只该斗一次');
});
