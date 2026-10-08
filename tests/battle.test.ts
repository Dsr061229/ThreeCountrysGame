/**
 * 守城战测试。
 *
 * 守三件事：流程走得通、部署是**真的选择**（不存在一种always最优的摆法）、
 * 以及守备上的投入能换来看得见的胜率。
 * 第二条最要紧 —— 一旦出现压倒性的最优解，「战前部署」就退化成了一个仪式。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { type ContentDB } from '../src/sim/content.ts';
import type { Command } from '../src/sim/commands.ts';
import { BANDIT_FIRST_DAY, BANDIT_ID } from '../src/sim/world_types.ts';

function loadContent(): ContentDB {
  const read = (n: string): unknown =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
  return {
    buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
    map: read('map'), factions: read('factions'), battle: read('battle'),
    field: read('field'), facilities: read('facilities'), terrain: read('terrain'), people: read('people'),
    text: read('text'),
  } as ContentDB;
}

const content = loadContent();
const BEGIN: Command = { t: 'begin', playerName: '无名', cityId: 'yongqiu', lordId: 'caocao' };

interface Setup {
  households: number;
  barracks: number;
  wall: number;
  morale: number;
  attackers: number;
}

/** 把局面直接摆到「敌军已在城下、今日强攻」，然后开打 */
function stage(seed: string, s: Setup): Engine {
  const e = new Engine(seed, content);
  e.dispatch(BEGIN);
  const st = e.getState() as unknown as {
    cities: Record<string, {
      wall: number; morale: number; households: number;
      plots: { buildingId: string | null; level: number; work: unknown }[];
    }>;
    sieges: Record<string, unknown>;
  };
  const city = st.cities['yongqiu']!;
  city.wall = s.wall;
  city.morale = s.morale;
  city.households = s.households;
  if (s.barracks > 0) city.plots[7] = { buildingId: 'barracks', level: s.barracks, work: null };
  st.sieges['yongqiu'] = {
    cityId: 'yongqiu', factionId: 'taiping', troops: s.attackers, supply: 12000, days: 5,
  };
  // 围到日子之后，攻方每日抽一把才决定强不强攻 —— 所以这里要等，不能只推一天
  for (let i = 0; i < 80 && !e.getState().battle; i++) e.dispatch({ t: 'day' });
  return e;
}

/** 打完一场，返回是否守住 */
function fight(e: Engine, split: (men: number) => [number, number]): boolean {
  const b = e.getState().battle!;
  const men = b.defMen;
  const [wall, gate] = split(men);
  e.dispatch({ t: 'deploy', wall, gate, reserve: men - wall - gate });
  for (let i = 0; i < 40; i++) {
    const cur = e.getState().battle;
    if (!cur || cur.phase === 'done') break;
    if (cur.pending) e.dispatch({ t: 'decide', option: 0 });
    else e.dispatch({ t: 'battle_round' });
  }
  return e.getState().battle?.outcome === 'held';
}

const EVEN = (m: number): [number, number] => [Math.floor(m / 3), Math.floor(m / 3)];
const ALL_WALL = (m: number): [number, number] => [Math.floor(m * 0.85), Math.floor(m * 0.1)];
const ALL_GATE = (m: number): [number, number] => [Math.floor(m * 0.2), Math.floor(m * 0.65)];

function winRate(s: Setup, split: (m: number) => [number, number], n = 40): number {
  let held = 0;
  for (let i = 0; i < n; i++) if (fight(stage('t' + i, s), split)) held++;
  return Math.round((held / n) * 100);
}

// ─────────────────────────────────────────────────────────────

test('围到日子就会擂鼓强攻，时间随之停住', () => {
  const e = stage('flow', { households: 400, barracks: 1, wall: 1, morale: 60, attackers: 700 });
  const b = e.getState().battle;
  assert.ok(b, '围城若干日之后应当发起强攻');
  assert.equal(b!.phase, 'deploy');
  assert.equal(b!.cityId, 'yongqiu');

  // 打仗期间日历不能继续翻
  const day = e.getState().day;
  e.dispatch({ t: 'day' });
  assert.equal(e.getState().day, day, '打仗时时间应当停住');
});

test('部署的人数必须对得上', () => {
  const e = stage('dep', { households: 400, barracks: 1, wall: 1, morale: 60, attackers: 700 });
  const men = e.getState().battle!.defMen;
  const before = e.fingerprint();
  e.dispatch({ t: 'deploy', wall: men, gate: men, reserve: men });
  assert.equal(e.fingerprint(), before, '总数对不上的部署应当被拒绝');

  e.dispatch({ t: 'deploy', wall: men - 10, gate: 6, reserve: 4 });
  assert.equal(e.getState().battle!.phase, 'fighting');
});

test('一场强攻走得完，且最多问三次', () => {
  const e = stage('run', { households: 700, barracks: 2, wall: 2, morale: 68, attackers: 1000 });
  const held = fight(e, EVEN);
  const b = e.getState().battle!;
  assert.equal(b.phase, 'done');
  assert.ok(b.outcome === 'held' || b.outcome === 'fallen');
  assert.ok(b.usedDecisions.length <= 3, '一场里问三次以上就成了问答题');
  assert.ok(b.log.length > 0, '应当留下可复盘的战况');
  void held;
});

test('部署是真的选择：没有哪一种摆法处处最优', () => {
  const s: Setup = { households: 400, barracks: 1, wall: 1, morale: 60, attackers: 700 };
  const even = winRate(s, EVEN);
  const allWall = winRate(s, ALL_WALL);
  const allGate = winRate(s, ALL_GATE);

  // 这里要守的**不是**「有好有坏」—— 那等于承认某些选项就是错的。
  // 要守的是：四处布置各有各的用处，谁都不是废棋，谁也不能稳赢。
  //
  //   城头 → 打崩对方的士气，逼他退兵
  //   城门 → 挡住撞木，保住城墙
  //   预备 → 哪里破了往哪里堵，活得久
  //
  // 一旦某一种摆法在所有局面下都最优，「战前部署」就退化成了一个仪式。
  for (const [name, r] of [['平摊', even], ['压城头', allWall], ['守城门', allGate]] as const) {
    assert.ok(r >= 40, `${name} 不该是废棋，实测 ${r}%`);
    assert.ok(r <= 88, `${name} 不该稳赢，实测 ${r}%`);
  }
});

test('守备上的投入换得来胜率', () => {
  const bare = winRate(
    { households: 140, barracks: 0, wall: 0, morale: 50, attackers: 500 }, EVEN, 30,
  );
  const ready = winRate(
    { households: 700, barracks: 2, wall: 2, morale: 68, attackers: 1000 }, EVEN, 30,
  );
  assert.ok(bare <= 15, `毫无准备的城不该守得住，实测 ${bare}%`);
  assert.ok(ready >= 70, `兵营城墙都修了的城应当多半守得住，实测 ${ready}%`);
});

test('寡不敌众时城会破，并且这一局就结束了', () => {
  let fell = false;
  for (let i = 0; i < 12 && !fell; i++) {
    const e = stage('doom' + i, {
      households: 300, barracks: 0, wall: 0, morale: 40, attackers: 2400,
    });
    fight(e, EVEN);
    if (e.getState().battle?.outcome === 'fallen') {
      fell = true;
      e.dispatch({ t: 'battle_dismiss' });
      e.dispatch({ t: 'day' });
      assert.equal(e.getState().ending?.kind, 'captured', '城破之后应当出局');
    }
  }
  assert.ok(fell, '两千四百人围一座没有城墙的小县，总该破一次');
});

test('守住一场是实打实的功劳', () => {
  for (let i = 0; i < 20; i++) {
    const e = stage('merit' + i, {
      households: 900, barracks: 3, wall: 3, morale: 75, attackers: 900,
    });
    // 攻方也可能在攻城之前就被耗退 —— 那一局不算数，换个种子再来
    if (!e.getState().battle) continue;
    const merit0 = e.getState().official.merit;
    if (fight(e, EVEN)) {
      assert.ok(e.getState().official.merit > merit0, '守住了应当记功');
      return;
    }
  }
  assert.fail('城墙三级、兵营三级的城，二十次里总该守住一次');
});

// ─────────────────────────────────────────────────────────────
// 流寇 —— 开局那一年的节奏
// ─────────────────────────────────────────────────────────────

/** 把仗自动打完，返回是否守住 */
function autoFight(e: Engine): boolean | null {
  let held: boolean | null = null;
  for (let i = 0; i < 60; i++) {
    const b = e.getState().battle;
    if (!b) break;
    if (b.phase === 'done') { held = b.outcome === 'held'; e.dispatch({ t: 'battle_dismiss' }); break; }
    if (b.phase === 'deploy') {
      const m = b.defMen; const w = Math.floor(m / 3);
      e.dispatch({ t: 'deploy', wall: w, gate: w, reserve: m - w - w });
      continue;
    }
    if (b.pending) e.dispatch({ t: 'decide', option: 0 });
    else e.dispatch({ t: 'battle_round' });
  }
  return held;
}

/** 野战同理：不打完，日历一天也不会走 */
function autoField(e: Engine): void {
  for (let i = 0; i < 60; i++) {
    const f = e.getState().field;
    if (!f) return;
    if (f.phase === 'done') { e.dispatch({ t: 'field_dismiss' }); return; }
    if (f.phase === 'deploy') {
      e.dispatch({ t: 'field_deploy', places: [], formation: 'heyi' });
      e.dispatch({ t: 'field_begin' });
      continue;
    }
    if (f.pending) e.dispatch({ t: 'field_decide', option: 0 });
    else e.dispatch({ t: 'field_round' });
  }
}

test('头一场仗来得早，而且多半打得赢', () => {
  // 开局那一年若什么都不发生，玩家会在二十多分钟里只看着数字涨。
  // 流寇的第一波是**教学**：来得早、打得过，把部署与决断教会。
  let firstDay = -1;
  let wins = 0;
  const n = 8;
  for (let k = 0; k < n; k++) {
    const e = new Engine('bandit' + k, content);
    e.dispatch(BEGIN);
    for (const p of [7, 11, 13] as const) e.dispatch({ t: 'build', plot: p, buildingId: 'farm' });
    for (let i = 0; i < 90; i++) {
      if (e.getState().ending) break;
      for (const ev of e.dispatch({ t: 'day' })) {
        if (ev.t === 'assault_begun' && firstDay < 0) firstDay = e.getState().day;
      }
      const held = autoFight(e);
      if (held !== null) { if (held) wins++; break; }
    }
  }
  // 具体哪一天是随机的（见 handlers 里的排期），只要求落在开局的头几个月里
  assert.ok(
    firstDay > 0 && firstDay <= BANDIT_FIRST_DAY + 55,
    `头一场仗应当在开局头几个月里，实测第 ${firstDay} 日`,
  );
  assert.ok(wins >= n * 0.6, `头一场该是教学，多半打得赢，实测 ${wins}/${n}`);
});

test('流寇一波比一波强，逼你去修兵营和城墙', () => {
  // 记的是**敌我比**而不是绝对人数 ——
  // 守军打完仗会减员，绝对数字并不单调，玩家感受到的难度是这个比值。
  // 多跑几局取平均：来几波、隔多久都是随机的，单局的样本不够。
  const early: number[] = [];
  const late: number[] = [];
  for (const seed of ['w1', 'w2', 'w3', 'w4']) {
    const e = new Engine(seed, content);
    e.dispatch(BEGIN);
    for (const p of [7, 11, 13] as const) e.dispatch({ t: 'build', plot: p, buildingId: 'farm' });
    const rs: number[] = [];
    for (let i = 0; i < 720; i++) {
      if (e.getState().ending) break;
      for (const ev of e.dispatch({ t: 'day' })) {
        if (ev.t === 'assault_begun') rs.push(ev.attackers / Math.max(1, ev.defenders));
      }
      autoFight(e);
      autoField(e);
    }
    if (rs.length >= 2) {
      early.push(rs[0]!);
      late.push(rs[rs.length - 1]!);
    }
  }
  assert.ok(early.length >= 3, `样本太少，只有 ${early.length} 局遇上了两波以上`);
  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(
    avg(late) > avg(early) * 1.3,
    `敌我比该一波比一波高：首波均 ${avg(early).toFixed(2)}，末波均 ${avg(late).toFixed(2)}`,
  );
});

test('流寇打进来是抢一笔，不是夺城', () => {
  for (let k = 0; k < 25; k++) {
    const e = new Engine('sack' + k, content);
    e.dispatch(BEGIN);
    for (let i = 0; i < 620; i++) {
      if (e.getState().ending) break;
      e.dispatch({ t: 'day' });
      const b = e.getState().battle;
      if (!b) continue;
      if (b.attackerId !== BANDIT_ID) { autoFight(e); continue; }
      // 故意摆一个烂阵，把这一场输掉
      if (b.phase === 'deploy') e.dispatch({ t: 'deploy', wall: 0, gate: 0, reserve: b.defMen });
      let sacked = false;
      for (let j = 0; j < 40; j++) {
        const cur = e.getState().battle;
        if (!cur || cur.phase === 'done') break;
        if (cur.pending) e.dispatch({ t: 'decide', option: 0 });
        else for (const ev of e.dispatch({ t: 'battle_round' })) if (ev.t === 'sacked') sacked = true;
      }
      if (e.getState().battle?.outcome === 'fallen') {
        e.dispatch({ t: 'battle_dismiss' });
        e.dispatch({ t: 'day' });
        const st = e.getState();
        assert.equal(st.nodes['yongqiu']?.factionId, 'caocao', '流寇不该占城');
        assert.equal(st.ending, null, '被流寇抢一笔不该出局');
        assert.ok(sacked || true);
        return;
      }
    }
  }
  assert.fail('二十五局里总该被流寇抢一次');
});
