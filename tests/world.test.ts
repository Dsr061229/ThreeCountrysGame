/**
 * 天下层测试。
 *
 * 守两件事：外面那个世界是活的（城会易主、军队会断粮），
 * 以及守备投入是有意义的（兵营与城墙真的顶用，而不是占地方的摆设）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import type { Command } from '../src/sim/commands.ts';
import { currentCity } from '../src/sim/state.ts';
import { defenceOf, garrisonOf } from '../src/sim/worldtick.ts';
import { BANDIT_ID, GRACE_DAYS } from '../src/sim/world_types.ts';
import { PLOT_COUNT, WALL_COST, YAMEN_PLOT, type City, type Plot } from '../src/sim/types.ts';

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
const idx = indexContent(content);
const BEGIN: Command = { t: 'begin', playerName: '无名', cityId: 'yongqiu', lordId: 'caocao' };

/**
 * 自动把仗打完。
 *
 * 打仗期间时间是停住的（day 命令会被拒绝），
 * 所以任何自动推进的循环都必须先把仗了结，否则会空转到底、
 * 日历一天也不走 —— 跑出来的结果全是假的。
 */
function autoFight(e: Engine): void {
  for (let i = 0; i < 60; i++) {
    const b = e.getState().battle;
    if (!b) return;
    if (b.phase === 'done') { e.dispatch({ t: 'battle_dismiss' }); return; }
    if (b.phase === 'deploy') {
      const m = b.defMen;
      const w = Math.floor(m / 3);
      e.dispatch({ t: 'deploy', wall: w, gate: w, reserve: m - w - w });
      continue;
    }
    if (b.pending) e.dispatch({ t: 'decide', option: 0 });
    else e.dispatch({ t: 'battle_round' });
  }
}

/** 野战同理：不打完，日历一天也不会走 */
function autoField(e: Engine): void {
  for (let i = 0; i < 60; i++) {
    const f = e.getState().field;
    if (!f) return;
    if (f.phase === 'done') { e.dispatch({ t: 'field_dismiss' }); return; }
    if (f.phase === 'deploy') { e.dispatch({ t: 'field_deploy', places: [], formation: 'heyi' });
      e.dispatch({ t: 'field_begin' });
      continue; }
    if (f.pending) e.dispatch({ t: 'field_decide', option: 0 });
    else e.dispatch({ t: 'field_round' });
  }
}

function mkCity(over: Partial<City>): City {
  const plots: Plot[] = [];
  for (let i = 0; i < PLOT_COUNT; i++) plots.push({ buildingId: null, level: 0, work: null });
  plots[YAMEN_PLOT] = { buildingId: 'yamen', level: 1, work: null };
  return {
    id: 'x', name: 'x', commandery: 'x', plots, ring: 0,
    grain: 500, coin: 500, households: 200, morale: 60,
    taxPressure: 0, afflictions: [], wall: 0, wallWork: 0,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────

test('天下是活的：几年之内必有城池易主', () => {
  let falls = 0;
  for (const seed of ['w1', 'w2', 'w3']) {
    const e = new Engine(seed, content);
    e.dispatch(BEGIN);
    for (let i = 0; i < 900; i++) {
      const st = e.getState();
      if (st.ending) break;
      const q = st.quota;
      if (q && q.dueDay - st.day <= 5) {
        const c = currentCity(st);
        const need = Math.max(0, q.demandGrain - q.paidGrain);
        if (need > 0) e.dispatch({ t: 'pay', grain: Math.min(need, c.grain), coin: 0 });
      }
      for (const ev of e.dispatch({ t: 'day' })) if (ev.t === 'city_fell') falls++;
      autoFight(e);
    autoField(e);
      autoField(e);
    }
  }
  assert.ok(falls >= 3, `三局各跑两年半，应当有若干城池易主，实测 ${falls} 次`);
});

test('头一年没有哪家势力来打玩家的城（流寇不算）', () => {
  for (const seed of ['g1', 'g2', 'g3', 'g4']) {
    const e = new Engine(seed, content);
    e.dispatch(BEGIN);
    for (let i = 0; i < GRACE_DAYS; i++) {
      autoFight(e);
    autoField(e);
      autoField(e);
      for (const ev of e.dispatch({ t: 'day' })) {
        // 流寇不是势力，是一种天灾 —— 它本来就该在太平期里出现，
        // 那一年的空白正是靠它填上的
        if (ev.t === 'siege_started' && ev.factionId !== BANDIT_ID) {
          assert.notEqual(
            ev.cityId, 'yongqiu',
            `第 ${e.getState().day} 日就被正规军围了，太平日子没生效`,
          );
        }
      }
    }
  }
});

test('兵营与城墙真的顶用，不是占地方的摆设', () => {
  const bare = mkCity({});
  const withBarracks = mkCity({});
  withBarracks.plots[7] = { buildingId: 'barracks', level: 2, work: null };

  assert.ok(
    garrisonOf(withBarracks, idx) > garrisonOf(bare, idx) + 80,
    '两级兵营应当带来九十上下的守军',
  );

  const walled = mkCity({});
  walled.plots[7] = { buildingId: 'barracks', level: 2, work: null };
  walled.wall = 3;
  const plain = defenceOf(withBarracks, idx);
  assert.ok(
    defenceOf(walled, idx) > plain * 2,
    `三级城墙应当把守备翻倍以上：${plain} → ${defenceOf(walled, idx)}`,
  );

  // 民心低的城，守军也没有斗志
  const sullen = mkCity({ morale: 10 });
  sullen.plots[7] = { buildingId: 'barracks', level: 2, work: null };
  assert.ok(defenceOf(sullen, idx) < plain, '民心低应当拖累守备');
});

test('乡勇随户口走：人多的县临事凑得出人', () => {
  const small = mkCity({ households: 100 });
  const big = mkCity({ households: 900 });
  assert.ok(garrisonOf(big, idx) > garrisonOf(small, idx) + 100);
});

test('修城要钱要粮要工期，且有上限', () => {
  const e = new Engine('wall', content);
  e.dispatch(BEGIN);
  // 开局钱粮不够，修不动
  const before = e.fingerprint();
  e.dispatch({ t: 'fortify' });
  assert.equal(e.fingerprint(), before, '钱粮不够时不该开工');

  // 攒够再修
  for (const p of [6, 7, 8, 11] as const) e.dispatch({ t: 'build', plot: p, buildingId: 'farm' });
  for (let i = 0; i < 240; i++) {
    const st = e.getState();
    if (st.ending) break;
    const c = currentCity(st);
    if (c.wall === 0 && c.wallWork === 0 && c.coin >= WALL_COST[0]!.coin + 40
        && c.grain >= WALL_COST[0]!.grain + 200) {
      e.dispatch({ t: 'fortify' });
    }
    e.dispatch({ t: 'day' });
    autoFight(e);
    autoField(e);
  }
  assert.equal(currentCity(e.getState()).wall, 1, '攒够钱粮之后应当修得起一级城墙');
});

test('城破即出局', () => {
  const e = new Engine('fall', content);
  e.dispatch(BEGIN);
  // 直接把玩家的城判给别家，模拟城破之后的状态
  const st = e.getState() as unknown as { nodes: Record<string, { factionId: string }> };
  st.nodes['yongqiu']!.factionId = 'taiping';
  e.dispatch({ t: 'day' });
  assert.equal(e.getState().ending?.kind, 'captured');
  // 结束之后时间不再走
  const day = e.getState().day;
  e.dispatch({ t: 'day' });
  assert.equal(e.getState().day, day, '局终之后不该再推进');
});

test('连着几季交不上差就会被撤职', () => {
  const e = new Engine('sack', content);
  e.dispatch(BEGIN);
  let over = false;
  for (let i = 0; i < 900 && !over; i++) {
    autoFight(e);
    autoField(e);
    for (const ev of e.dispatch({ t: 'day' })) {
      if (ev.t === 'game_over') {
        assert.equal(ev.kind, 'dismissed');
        over = true;
      }
    }
  }
  assert.ok(over, '一个什么都不做的县令，两三年内应当被撤职');
  assert.ok(e.getState().consecutiveMisses >= 3);
});
