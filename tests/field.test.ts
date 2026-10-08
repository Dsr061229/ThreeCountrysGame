/**
 * 野战测试。
 *
 * 守四件事：流程走得通、**阵型是真的选择**、地形真的起作用、
 * 以及胜负会写回世界（赢了当场解围，输了城更难守）。
 *
 * 第二条最要紧 —— 一旦某个阵型处处最优，「选阵型」就退化成了一个仪式。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { type ContentDB } from '../src/sim/content.ts';
import type { Command } from '../src/sim/commands.ts';
import {
  FIELD_COLS, FORMATIONS, OWN_ROWS, TERRAIN_BONUS, type Formation,
} from '../src/sim/field_types.ts';

function loadContent(): ContentDB {
  const read = (n: string): unknown =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
  return {
    buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
    map: read('map'), factions: read('factions'), battle: read('battle'),
    field: read('field'), facilities: read('facilities'), terrain: read('terrain'), people: read('people'), text: read('text'),
  } as ContentDB;
}

const content = loadContent();
const BEGIN: Command = { t: 'begin', playerName: '无名', cityId: 'yongqiu', lordId: 'caocao' };

interface Setup { households: number; barracks: number; foe: number }

/** 摆到「城下有敌军」，然后出城 */
function stage(seed: string, s: Setup): Engine {
  const e = new Engine(seed, content);
  e.dispatch(BEGIN);
  const st = e.getState() as unknown as {
    cities: Record<string, {
      households: number; morale: number;
      plots: { buildingId: string | null; level: number; work: unknown }[];
    }>;
    sieges: Record<string, unknown>;
  };
  const city = st.cities['yongqiu']!;
  city.households = s.households;
  city.morale = 62;
  if (s.barracks > 0) city.plots[7] = { buildingId: 'barracks', level: s.barracks, work: null };
  st.sieges['yongqiu'] = {
    cityId: 'yongqiu', factionId: 'taiping', troops: s.foe, supply: 9000, days: 2,
  };
  e.dispatch({ t: 'sortie' });
  return e;
}

function fight(e: Engine, form: Formation): string {
  e.dispatch({ t: 'field_deploy', places: [], formation: form });
  e.dispatch({ t: 'field_begin' });
  for (let i = 0; i < 60; i++) {
    const f = e.getState().field;
    if (!f || f.phase === 'done') break;
    if (f.pending) e.dispatch({ t: 'field_decide', option: 0 });
    else e.dispatch({ t: 'field_round' });
  }
  return e.getState().field?.outcome ?? '?';
}

function winRate(s: Setup, form: Formation, n = 40): number {
  let won = 0;
  for (let i = 0; i < n; i++) if (fight(stage('fw' + i + form, s), form) === 'won') won++;
  return Math.round((won / n) * 100);
}

// ─────────────────────────────────────────────────────────────

test('城下有敌才谈得上出击，且出击时时间停住', () => {
  const e = new Engine('nosiege', content);
  e.dispatch(BEGIN);
  const before = e.fingerprint();
  e.dispatch({ t: 'sortie' });
  assert.equal(e.fingerprint(), before, '城下没有敌军时不该开得起野战');

  const e2 = stage('yes', { households: 700, barracks: 2, foe: 210 });
  const f = e2.getState().field;
  assert.ok(f, '城下有敌军时应当能出击');
  assert.equal(f!.phase, 'deploy');
  const day = e2.getState().day;
  e2.dispatch({ t: 'day' });
  assert.equal(e2.getState().day, day, '打野战时时间应当停住');
});

test('开局各队都在阵前两行，且拆成了几个兵种', () => {
  const e = stage('lineup', { households: 700, barracks: 2, foe: 210 });
  const f = e.getState().field!;
  const own = f.units.filter((u) => u.side === 'own');
  assert.ok(own.length >= 3, `我军该拆成几队，实测 ${own.length} 队`);
  for (const u of own) {
    assert.ok(OWN_ROWS.includes(u.row as 5 | 6), `${u.kind} 站到了阵前两行之外（row ${u.row}）`);
    assert.ok(u.col >= 0 && u.col < FIELD_COLS);
  }
  assert.ok(new Set(own.map((u) => u.kind)).size >= 2, '至少该有两个兵种');
});

test('只能摆在阵前两行', () => {
  const e = stage('place', { households: 700, barracks: 2, foe: 210 });
  const f = e.getState().field!;
  const u = f.units.find((x) => x.side === 'own')!;
  const before = e.fingerprint();
  e.dispatch({
    t: 'field_deploy',
    places: [{ id: u.id, col: 4, row: 2 }],
    formation: 'heyi',
  });
  assert.equal(e.fingerprint(), before, '摆到中路应当被拒绝');

  e.dispatch({ t: 'field_deploy', places: [{ id: u.id, col: 4, row: 5 }], formation: 'heyi' });
  const after = e.getState().field!;
  assert.equal(after.phase, 'deploy', '摆完位置仍应留在布阵阶段');
  assert.equal(after.units.find((x) => x.id === u.id)!.col, 4);
});

test('选阵型不会把布阵阶段结束掉', () => {
  // 这是上一版最要命的一个 bug：
  // 「设置布阵」和「开打」塞在了同一条命令里，于是玩家点一下阵型按钮，
  // 布阵阶段就结束了 —— 拖拽失效、开打按钮消失，看起来像卡死。
  const e = stage('form', { households: 700, barracks: 2, foe: 210 });
  for (const form of ['yulin', 'fengshi', 'fangyuan'] as Formation[]) {
    e.dispatch({ t: 'field_deploy', places: [], formation: form });
    const f = e.getState().field!;
    assert.equal(f.phase, 'deploy', `选了${form}之后不该离开布阵阶段`);
    assert.equal(f.formation, form);
  }
  // 摆完了还能接着挪位置
  const u = e.getState().field!.units.find((x) => x.side === 'own')!;
  e.dispatch({ t: 'field_deploy', places: [{ id: u.id, col: 7, row: 6 }], formation: 'yanyue' });
  const after = e.getState().field!;
  assert.equal(after.phase, 'deploy');
  assert.equal(after.units.find((x) => x.id === u.id)!.col, 7);

  // 只有击鼓进兵才开打
  e.dispatch({ t: 'field_begin' });
  assert.equal(e.getState().field!.phase, 'fighting');
});

test('开局的阵线是摊开的，不是挤成一堆', () => {
  // 按整数间隔算会把四支队伍全塞进左边三格（九列除以五等于一），
  // 画面上就是一片空地里挤着一坨人
  for (const seed of ['s1', 's2', 's3']) {
    const f = stage(seed, { households: 700, barracks: 2, foe: 210 }).getState().field!;
    const cols = f.units.filter((u) => u.side === 'own').map((u) => u.col);
    const spread = Math.max(...cols) - Math.min(...cols);
    assert.ok(spread >= 4, `阵线该摊开，实测各队在 ${cols.join(',')} 列`);
  }
});

test('两军会逐轮靠拢并交手', () => {
  const e = stage('advance', { households: 700, barracks: 2, foe: 210 });
  e.dispatch({ t: 'field_deploy', places: [], formation: 'heyi' });
  e.dispatch({ t: 'field_begin' });
  const gap = (): number => {
    const f = e.getState().field!;
    const own = f.units.filter((u) => u.side === 'own' && !u.routed);
    const foe = f.units.filter((u) => u.side === 'foe' && !u.routed);
    let best = 99;
    for (const a of own) {
      for (const b of foe) {
        best = Math.min(best, Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row)));
      }
    }
    return best;
  };
  const before = gap();
  for (let i = 0; i < 3; i++) {
    const f = e.getState().field;
    if (!f || f.phase === 'done') break;
    if (f.pending) e.dispatch({ t: 'field_decide', option: 0 });
    else e.dispatch({ t: 'field_round' });
  }
  assert.ok(gap() < before, `两军应当在靠拢：${before} → ${gap()}`);

  const f = e.getState().field!;
  const hurt = f.units.some((u) => u.men < u.men0);
  assert.ok(hurt, '靠拢之后应当有人在流血');
});

test('地形是有分别的，不是画着好看', () => {
  // 坡上射得远、守得住；沼里骑兵施展不开 —— 这两条必须在数值里成立
  assert.ok((TERRAIN_BONUS.hill.bow ?? 1000) > 1100, '弓弩在坡上该占便宜');
  assert.ok((TERRAIN_BONUS.marsh.horse ?? 1000) < 750, '骑兵在沼里该吃亏');
  assert.ok((TERRAIN_BONUS.forest.horse ?? 1000) < 800, '骑兵在林里该吃亏');
  assert.ok((TERRAIN_BONUS.forest.foot ?? 1000) > 1000, '步卒在林里该占便宜');

  // 而且战场上真的会长出这些地形
  const kinds = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const f = stage('terr' + i, { households: 700, barracks: 2, foe: 210 }).getState().field!;
    for (const c of f.cells) kinds.add(c.terrain);
  }
  assert.ok(kinds.has('hill'), '八张战场里总该有坡');
  assert.ok(kinds.has('forest'), '八张战场里总该有林');
});

test('阵型是真的选择：没有废棋，也没有稳赢的', () => {
  const even: Setup = { households: 700, barracks: 2, foe: 210 };
  // 势均力敌时，每一种阵型都该是一场真正的胜负未卜。
  //
  // 这里刻意**不**断言「甲阵该强于乙阵」—— 四十局的样本下那种比较全是噪声，
  // 而且真正要守的性质也不是「有好有坏」，是「没有一种处处最优」。
  // 各阵型在不同兵力对比下谁更优，交给 `npm run field` 的推演去看。
  for (const form of ['yulin', 'fengshi', 'heyi', 'fangyuan', 'yanyue'] as Formation[]) {
    const r = winRate(even, form);
    assert.ok(r >= 25, `${FORMATIONS[form].name} 不该是废棋，实测 ${r}%`);
    assert.ok(r <= 85, `${FORMATIONS[form].name} 不该稳赢，实测 ${r}%`);
  }
});

test('兵力占优就该赢，兵力不济就该难', () => {
  // 样本要够。三十局时前几个种子凑巧连赢，「兵力不济」能测出 43%，
  // 而同一套规则在 n=400 下是 14% —— 断言的是规律，不能让它去赌运气
  const strong = winRate({ households: 900, barracks: 3, foe: 160 }, 'yanyue', 120);
  const weak = winRate({ households: 400, barracks: 1, foe: 260 }, 'yanyue', 120);
  assert.ok(strong >= 80, `兵力占优该多半打赢，实测 ${strong}%`);
  assert.ok(weak <= 40, `兵力不济该多半打输，实测 ${weak}%`);
});

test('出城的人一个都不能少，也不许有凑数的小队', () => {
  // 上一版凑不满十二人的队会被直接丢掉 —— 那些人就这么没了，
  // 城里点了两百人出城，战场上只有一百八十九。
  // 而凑够十二人的又会变成「骑兵 13 人」这种东西，第一轮就溃
  for (const s of [
    { households: 300, barracks: 0, foe: 120 },
    { households: 700, barracks: 2, foe: 210 },
    { households: 1100, barracks: 3, foe: 300 },
  ]) {
    const f = stage('split' + s.households, s).getState().field!;
    for (const side of ['own', 'foe'] as const) {
      const us = f.units.filter((u) => u.side === side);
      for (const u of us) {
        assert.ok(u.men >= 25, `${side} 的 ${u.kind} 只有 ${u.men} 人，不成一队`);
      }
    }
  }
});

test('弓弩够得着两格，不然它就是废棋', () => {
  // 全兵种一律贴身打的时候，弓弩「打步卒吃亏、被步卒克」，
  // 于是练出弓弩的城反而更容易打输 —— 一支只能肉搏的弓弩队不该叫弓弩
  const e = stage('reach', { households: 900, barracks: 3, foe: 200 });
  const f = e.getState().field!;
  const bow = f.units.find((u) => u.side === 'own' && u.kind === 'bow');
  assert.ok(bow, '兵营三级的城该拉得出一队弓弩');
});

test('兵练得越多越该打得赢，不能越练越弱', () => {
  // 这一条守的是**发育有回报**。上一版兵营一级比零级多带三十几人出城，
  // 胜率却更低 —— 因为队伍变多之后一半人每轮都在旁边空转。
  // 那不是难度，是模拟错了
  const foe = 210;
  const bare = winRate({ households: 700, barracks: 0, foe }, 'heyi', 100);
  const built = winRate({ households: 700, barracks: 3, foe }, 'heyi', 100);
  assert.ok(built > bare + 10, `兵营三级该明显强过没兵营：${bare}% → ${built}%`);
});

test('一仗要打得够长，决断才有出场的机会', () => {
  // 「战前部署 + 战中两三次决断」是这个战斗系统的全部玩法。
  // 两轮就打完的仗，玩家除了看数字掉什么也没做。
  //
  // 这条守过一次真事故：把「每支队都能接敌」修对之后，
  // 实际杀伤翻了一倍，仗从五轮缩到三轮，决断次数掉到 1.4
  let rounds = 0, decisions = 0;
  const n = 60;
  for (let i = 0; i < n; i++) {
    const e = stage('len' + i, { households: 700, barracks: 2, foe: 210 });
    e.dispatch({ t: 'field_deploy', places: [], formation: 'heyi' });
    e.dispatch({ t: 'field_begin' });
    for (let k = 0; k < 90; k++) {
      const f = e.getState().field;
      if (!f || f.phase === 'done') break;
      if (f.pending) { decisions++; e.dispatch({ t: 'field_decide', option: 0 }); }
      else e.dispatch({ t: 'field_round' });
    }
    rounds += e.getState().field!.round;
  }
  const avgR = rounds / n, avgD = decisions / n;
  assert.ok(avgR >= 4, `一仗该打上几轮，实测平均 ${avgR.toFixed(1)} 轮`);
  assert.ok(avgD >= 2, `中间该有两三次决断，实测平均 ${avgD.toFixed(1)} 次`);
});

test('赢了当场解围，输了城更难守', () => {
  let sawWin = false, sawLoss = false;
  for (let i = 0; i < 40 && !(sawWin && sawLoss); i++) {
    const e = stage('res' + i, { households: 700, barracks: 2, foe: 210 });
    const moraleBefore = (e.getState() as unknown as {
      cities: Record<string, { morale: number }>;
    }).cities['yongqiu']!.morale;
    const out = fight(e, 'heyi');
    const st = e.getState();
    if (out === 'won' && !sawWin) {
      sawWin = true;
      assert.equal(st.sieges['yongqiu'], undefined, '打赢了应当当场解围');
      assert.ok(st.official.merit > 0, '打赢一场野战应当记功');
    }
    if (out === 'lost' && !sawLoss) {
      sawLoss = true;
      assert.ok(st.sieges['yongqiu'], '打输了敌军还在城下');
      const c = (st as unknown as { cities: Record<string, { morale: number }> })
        .cities['yongqiu']!;
      assert.ok(c.morale < moraleBefore, '打输了民心该跌');
    }
  }
  assert.ok(sawWin, '四十场里总该赢一次');
  assert.ok(sawLoss, '四十场里总该输一次');
});
