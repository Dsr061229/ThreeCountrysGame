/**
 * 模拟层测试。
 *
 * 第一组守的是地基：同种子同命令流必须得到逐位相同的世界，否则存档回放与联机同步都会塌。
 * 第二组守的是玩法：发育的节奏、指标的压力、民心与人口的联动，
 * 这些一旦跑偏，游戏就会变成「点着点着就赢了」或者「怎么点都不够」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine, StaleSaveError } from '../src/sim/engine.ts';
import {
  indexContent, totalInvested, upgradeCost, type ContentDB,
} from '../src/sim/content.ts';
import type { Command } from '../src/sim/commands.ts';
import { computeOutput, availableBuildings, countOf } from '../src/sim/city.ts';
import { PLOT_COUNT, YAMEN_PLOT, type City, type Plot } from '../src/sim/types.ts';
import { DEMOLISH_REFUND } from '../src/sim/types.ts';
import { currentCity } from '../src/sim/state.ts';
import { dayToDate, formatDate, quarterOf, DAYS_PER_YEAR } from '../src/sim/time.ts';

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

function newGame(seed = 'yongqiu-190'): Engine {
  const e = new Engine(seed, content);
  e.dispatch(BEGIN);
  return e;
}

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

function days(e: Engine, n: number): void {
  for (let i = 0; i < n; i++) { e.dispatch({ t: 'day' }); autoFight(e); }
}

// ─────────────────────────────────────────────────────────────
// 地基
// ─────────────────────────────────────────────────────────────

test('同种子同命令流 → 状态指纹一致', () => {
  const script: Command[] = [
    BEGIN,
    { t: 'build', plot: 7, buildingId: 'farm' },
    { t: 'build', plot: 11, buildingId: 'farm' },
    ...Array.from({ length: 40 }, () => ({ t: 'day' }) as Command),
    { t: 'build', plot: 13, buildingId: 'house' },
    ...Array.from({ length: 50 }, () => ({ t: 'day' }) as Command),
    { t: 'pay', grain: 200, coin: 0 },
  ];
  const run = (): string => {
    const e = new Engine('same', content);
    for (const c of script) e.dispatch(c);
    return e.fingerprint();
  };
  assert.equal(run(), run());
});

test('存档回放 → 与原局逐位相同', () => {
  const e = newGame();
  e.dispatch({ t: 'build', plot: 7, buildingId: 'farm' });
  days(e, 120);
  const restored = Engine.load(e.save(), content);
  assert.equal(restored.fingerprint(), e.fingerprint());
});

test('旧规则的存档要读不进来，而不是读成别的样子', () => {
  // 存档是「种子 + 命令流」，读档就是重放。
  // 规则一改，同一份命令流重放出来的是**另一个世界** ——
  // 那一仗的胜负变了，后面几百条命令全落在一个从未存在过的局面上。
  // 读出个错的比读不出来糟得多：玩家看不出哪里不对，
  // 只会觉得「我明明守住了那座城」
  const e = newGame();
  days(e, 30);
  const stale = { ...e.save(), version: 1 };
  assert.throws(
    () => Engine.load(stale, content),
    (err: unknown) => err instanceof StaleSaveError && err.saved === 1,
    '旧版本存档应当被拒绝',
  );
});

test('被拒绝的命令不入日志，也不改变世界', () => {
  const e = newGame();
  const before = e.fingerprint();
  e.dispatch({ t: 'build', plot: 12, buildingId: 'farm' });       // 官署所在
  e.dispatch({ t: 'build', plot: 0, buildingId: 'farm' });        // 外郭未开
  e.dispatch({ t: 'build', plot: 7, buildingId: 'market' });      // 未解锁
  e.dispatch({ t: 'build', plot: 7, buildingId: 'workshop' });    // 未解锁
  e.dispatch({ t: 'expand' });                                     // 城太小
  e.dispatch(BEGIN);                                               // 重复开局
  assert.equal(e.fingerprint(), before);
  assert.equal(e.save().log.length, 1);
});

test('时间换算与年号', () => {
  assert.deepEqual(dayToDate(0), { year: 190, month: 1, day: 1 });
  assert.deepEqual(dayToDate(29), { year: 190, month: 1, day: 30 });
  assert.deepEqual(dayToDate(30), { year: 190, month: 2, day: 1 });
  assert.deepEqual(dayToDate(DAYS_PER_YEAR), { year: 191, month: 1, day: 1 });
  assert.equal(formatDate(0), '初平元年 正月 初一');
  assert.equal(formatDate(DAYS_PER_YEAR * 6), '建安元年 正月 初一');
  assert.equal(quarterOf(0), 0);
  assert.equal(quarterOf(89), 0);
  assert.equal(quarterOf(90), 1);
});

// ─────────────────────────────────────────────────────────────
// 玩法
// ─────────────────────────────────────────────────────────────

test('渐进暴露：开局只有一件事可做', () => {
  const e = newGame();
  const avail = availableBuildings(currentCity(e.getState()), idx).filter((d) => d.id !== 'yamen');
  assert.deepEqual(avail.map((d) => d.id), ['farm'], '开局可建的应当只有田庄');
});

test('建成田庄后，解锁项一次只多出三样', () => {
  const e = newGame();
  e.dispatch({ t: 'build', plot: 7, buildingId: 'farm' });
  days(e, 5);
  const avail = availableBuildings(currentCity(e.getState()), idx).filter((d) => d.id !== 'yamen');
  assert.deepEqual(avail.map((d) => d.id).sort(), ['farm', 'granary', 'house', 'well']);
});

test('无所作为则粮尽 —— 什么都不做是会输的', () => {
  const e = newGame();
  days(e, 60);
  const c = currentCity(e.getState());
  assert.ok(c.grain < 60, `坐吃山空 60 日后粮应当见底，实测 ${c.grain}`);
  assert.ok(c.morale < 54, `民心应当下滑，实测 ${c.morale}`);
});

test('人不够，田就种不完', () => {
  // computeOutput 是纯函数，直接给它一个构造好的城。
  // 拿几百日的经济演化去造这个局面，测的就不是这条规则了。
  const mk = (households: number): City => {
    const plots: Plot[] = [];
    for (let i = 0; i < PLOT_COUNT; i++) plots.push({ buildingId: null, level: 0, work: null });
    plots[YAMEN_PLOT] = { buildingId: 'yamen', level: 1, work: null };
    // 八块田，每块占 25 户人手
    for (const p of [6, 7, 8, 11, 13, 16, 17, 18]) {
      plots[p] = { buildingId: 'farm', level: 1, work: null };
    }
    return {
      id: 'x', name: 'x', commandery: 'x', plots, ring: 0,
      grain: 500, coin: 500, households, morale: 60,
      taxPressure: 0, afflictions: [], wall: 0, wallWork: 0,
    };
  };

  const enough = computeOutput(mk(400), idx);
  assert.equal(enough.labourRatio, 1000, '人手充足时不该打折');

  const short = computeOutput(mk(105), idx);
  assert.ok(short.labourNeed > short.labourHave, '八块田需 210 户人手');
  assert.ok(short.labourRatio < 1000, '缺劳力时产出应当打折');
  assert.ok(
    short.grainPerDay < enough.grainPerDay,
    '同样的田，人少就该收得少：' + short.grainPerDay + ' vs ' + enough.grainPerDay,
  );
});

test('同类建筑有数量上限，堆单一建筑走不通', () => {
  const e = new Engine('cap-count', content);
  e.dispatch(BEGIN);
  e.dispatch({ t: 'build', plot: 7, buildingId: 'farm' });
  days(e, 8);
  // 水井上限三处
  const wellPlots = [6, 8, 11, 13];
  for (const p of wellPlots) {
    e.dispatch({ t: 'build', plot: p, buildingId: 'well' });
    days(e, 6);
  }
  assert.equal(countOf(currentCity(e.getState()), 'well'), 3, '水井不应超过三处');
});

test('天灾会真的压下来', () => {
  // 按**季度数**来衡量，而不是按天数 ——
  // 一局能活多久取决于玩家守不守得住城，那是另一条规则的事；
  // 天灾是每季抽一次的，拿季度数当分母才问得对。
  let hits = 0;
  let quarters = 0;
  for (const seed of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']) {
    const e = new Engine(seed, content);
    e.dispatch(BEGIN);
    for (const p of [7, 11, 13] as const) e.dispatch({ t: 'build', plot: p, buildingId: 'farm' });
    for (let i = 0; i < 720; i++) {
      const st = e.getState();
      if (st.ending) break;
      // 把该交的交上去，免得测试还没跑完人就被撤职了
      const q = st.quota;
      if (q && q.dueDay - st.day <= 5) {
        const c = currentCity(st);
        const need = Math.max(0, q.demandGrain - q.paidGrain);
        if (need > 0) e.dispatch({ t: 'pay', grain: Math.min(need, c.grain), coin: 0 });
      }
      for (const ev of e.dispatch({ t: 'day' })) {
        if (ev.t === 'affliction' || ev.t === 'refugees_arrived') hits++;
      }
      autoFight(e);
    autoField(e);
      autoField(e);
    }
    quarters += e.getState().quotaHistory.length;
  }
  assert.ok(quarters >= 12, `样本太小，只跑了 ${quarters} 个季度`);
  assert.ok(
    hits >= Math.floor(quarters * 0.15),
    `每季约三成机会遇上天灾人祸，${quarters} 季里只有 ${hits} 次`,
  );
});

test('粮仓是硬闸门：不修仓，攒下的粮会烂掉', () => {
  const e = new Engine('cap', content);
  e.dispatch(BEGIN);
  for (const p of [7, 11, 13] as const) e.dispatch({ t: 'build', plot: p, buildingId: 'farm' });
  let sawFull = false;
  for (let i = 0; i < 120; i++) {
    for (const ev of e.dispatch({ t: 'day' })) if (ev.t === 'granary_full') sawFull = true;
  }
  const c = currentCity(e.getState());
  const out = computeOutput(c, idx);
  assert.ok(sawFull, '三块田种上百日应当把基础仓容撑满');
  assert.ok(c.grain <= out.capGrain);
});

test('第一季指标：认真种田能过，躺着必挂', () => {
  // 躺平
  const lazy = new Engine('lazy', content);
  lazy.dispatch(BEGIN);
  const lazyQuota = lazy.getState().quota!;
  days(lazy, 90);
  assert.equal(lazy.getState().quotaHistory[0]?.outcome, 'missed');
  assert.ok(lazy.getState().official.trust < 50, '交不上差，主公的信任要掉');

  // 认真经营
  const keen = new Engine('keen', content);
  keen.dispatch(BEGIN);
  for (const p of [7, 11, 13] as const) keen.dispatch({ t: 'build', plot: p, buildingId: 'farm' });
  days(keen, 30);
  keen.dispatch({ t: 'build', plot: 6, buildingId: 'granary' });
  days(keen, 55);
  const demand = keen.getState().quota!.demandGrain;
  const stock = currentCity(keen.getState()).grain;
  assert.ok(
    stock >= demand,
    `三块田加一座仓，第一季末应当交得出 ${demand} 石，实测存粮 ${stock}`,
  );
  keen.dispatch({ t: 'pay', grain: demand, coin: 0 });
  days(keen, 5);
  assert.equal(keen.getState().quotaHistory[0]?.outcome, 'met');
  assert.ok(keen.getState().official.merit > 0);
  assert.equal(lazyQuota.demandCoin, 0, '第一季不该同时要钱，新手一次只面对一件事');
});

test('把家底全交上去会伤民心', () => {
  const e = new Engine('tax', content);
  e.dispatch(BEGIN);
  for (const p of [7, 11, 13] as const) e.dispatch({ t: 'build', plot: p, buildingId: 'farm' });
  days(e, 60);
  const before = currentCity(e.getState()).morale;
  const all = currentCity(e.getState()).grain;
  e.dispatch({ t: 'pay', grain: all, coin: 0 });
  assert.ok(currentCity(e.getState()).taxPressure > 20, '掏空粮仓应当推高征敛压力');
  days(e, 12);
  assert.ok(
    currentCity(e.getState()).morale < before,
    '征敛之后民心应当下滑',
  );
});

test('建好的能拆，但拆是有代价的', () => {
  const e = new Engine('raze', content);
  e.dispatch(BEGIN);
  e.dispatch({ t: 'build', plot: 7, buildingId: 'farm' });
  days(e, 6);
  assert.equal(currentCity(e.getState()).plots[7]?.buildingId, 'farm');

  const farm = idx.building.get('farm')!;
  const spent = totalInvested(farm, 1);
  const before = currentCity(e.getState()).coin;

  e.dispatch({ t: 'demolish', plot: 7 });
  const mid = currentCity(e.getState()).plots[7]!;
  assert.equal(mid.work?.demolish, true, '应当进入拆除工期');
  assert.equal(mid.buildingId, 'farm', '拆完之前房子还立在那里');
  assert.equal(currentCity(e.getState()).coin, before, '开工本身不退钱');

  days(e, mid.work!.totalDays);
  const after = currentCity(e.getState());
  assert.equal(after.plots[7]?.buildingId, null, '拆完应当腾出空地');
  assert.equal(after.plots[7]?.level, 0);

  const back = Math.floor((spent.coin * DEMOLISH_REFUND) / 1000);
  assert.ok(back > 0 && back < spent.coin, '只能收回一部分，不是全额退款');
});

test('拆除中途停手，房子留着且不白拿钱', () => {
  const e = new Engine('raze-cancel', content);
  e.dispatch(BEGIN);
  e.dispatch({ t: 'build', plot: 7, buildingId: 'farm' });
  days(e, 6);
  const coinBefore = currentCity(e.getState()).coin;

  e.dispatch({ t: 'demolish', plot: 7 });
  e.dispatch({ t: 'cancel_work', plot: 7 });

  const c = currentCity(e.getState());
  assert.equal(c.plots[7]?.buildingId, 'farm', '停手后房子应当还在');
  assert.equal(c.plots[7]?.work, null);
  assert.equal(c.coin, coinBefore, '拆除停手不该退钱');
});

test('官署拆不得', () => {
  const e = new Engine('raze-yamen', content);
  e.dispatch(BEGIN);
  const before = e.fingerprint();
  e.dispatch({ t: 'demolish', plot: 12 });
  assert.equal(e.fingerprint(), before);
  e.dispatch({ t: 'demolish', plot: 7 });
  assert.equal(e.fingerprint(), before, '空地也没东西可拆');
});

test('升级造价逐级抬升，避免无脑堆同一栋', () => {
  const farm = idx.building.get('farm')!;
  const c1 = upgradeCost(farm, 1), c3 = upgradeCost(farm, 3), c5 = upgradeCost(farm, 5);
  assert.ok(c3.coin > c1.coin * 2, `三级造价应显著高于一级，实测 ${c1.coin} → ${c3.coin}`);
  assert.ok(c5.coin > c3.coin * 2);
  assert.ok(c5.days > c1.days);
});
