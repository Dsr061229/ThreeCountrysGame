/**
 * 平衡推演。
 *
 * 用一个「普通玩家会怎么玩」的策略把前几年跑一遍，把曲线打出来。
 * 调数值时先看这个，比在浏览器里点半小时快得多，也比拍脑袋准。
 *
 *   node tools/balance.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, upgradeCost, type ContentDB } from '../src/sim/content.ts';
import { availableBuildings, computeOutput, isPlotOpen } from '../src/sim/city.ts';
import { currentCity } from '../src/sim/state.ts';
import { formatMonth, quarterOf } from '../src/sim/time.ts';
import { YAMEN_PLOT } from '../src/sim/types.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
    field: read('field'), facilities: read('facilities'), terrain: read('terrain'), people: read('people'),
    text: read('text'),
} as ContentDB;
const idx = indexContent(content);

/**
 * 一个还算聪明、但不钻空子的玩家会怎么决定。
 *
 * 打分的原则是「缺什么补什么」，并且**空地优先补缺失的关键设施**——
 * 真人不会把八块地全种成田，然后发现没地方盖房子。
 */
function decide(e: Engine): boolean {
  const st = e.getState();
  const city = currentCity(st);
  const out = computeOutput(city, idx);
  const avail = availableBuildings(city, idx).filter((d) => d.id !== 'yamen');

  const daysOfFood = out.grainUpkeep > 0 ? city.grain / out.grainUpkeep : 99;
  const has = (id: string): boolean => city.plots.some((p) => p.buildingId === id);
  const hasFreePlot = city.plots.some(
    (p, i) => i !== YAMEN_PLOT && isPlotOpen(city, i) && !p.buildingId && !p.work,
  );

  // 「现在最缺什么」—— 决定了空地该拿去做什么
  const shortLabour = out.labourRatio < 920;
  const houseTight = out.capHouse - city.households < 45;
  const grainTight = city.grain > (out.capGrain * 8) / 10;
  const coinTight = city.coin > (out.capCoin * 8) / 10;
  const hungry = out.grainNet < Math.max(10, Math.floor(city.households / 40));

  type Choice = { plot: number; id: string; score: number };
  const choices: Choice[] = [];

  for (let p = 0; p < city.plots.length; p++) {
    if (p === YAMEN_PLOT || !isPlotOpen(city, p)) continue;
    const plot = city.plots[p]!;
    if (plot.work) continue;

    const cands = plot.buildingId ? [idx.building.get(plot.buildingId)!] : avail;
    const isFresh = !plot.buildingId;

    for (const def of cands) {
      const toLevel = plot.level + 1;
      if (toLevel > def.maxLevel) continue;
      const cost = upgradeCost(def, toLevel);
      if (cost.coin > city.coin || cost.grain > city.grain) continue;
      // 粮撑不到二十天就不动要吃粮的工程
      if (daysOfFood < 20 && cost.grain > 0) continue;

      let score = 0;
      switch (def.id) {
        case 'farm':
          score = hungry ? 100 : 45;
          break;
        case 'house':
          // 人口是赋税、劳力的来源。缺人或快住满时，盖房子压倒一切
          score = shortLabour || houseTight ? 130 : 35;
          break;
        case 'granary':
          // 没有仓，产出就在白白烂掉 —— 这比再开一块田要紧得多
          score = has('granary') ? (grainTight ? 135 : 30) : 150;
          break;
        case 'treasury':
          score = has('treasury') ? (coinTight ? 130 : 25) : 115;
          break;
        case 'well':
          score = city.morale < 62 ? 70 : 15;
          break;
        case 'market':
          score = out.coinPerDay < 40 ? 95 : 55;
          break;
        case 'pond':
          score = 88;
          break;
        case 'workshop':
          score = out.labourRatio > 900 ? 70 : 20;
          break;
        case 'school':
          score = city.morale < 72 ? 55 : 25;
          break;
        case 'barracks':
          score = 5;
          break;
        default:
          score = 10;
      }

      // 空地留给还没有的关键设施，别急着拿去堆重复的东西
      if (isFresh && has(def.id) && hasFreePlot) score -= 25;
      // 造价越高越谨慎
      score -= Math.floor(cost.coin / 40);
      choices.push({ plot: p, id: def.id, score });
    }
  }

  choices.sort((a, b) => b.score - a.score || a.plot - b.plot);
  const best = choices[0];
  if (!best || best.score <= 0) return false;
  const evs = e.dispatch({ t: 'build', plot: best.plot, buildingId: best.id });
  return evs.some((x) => x.t === 'work_started');
}

/**
 * 分期缴纳。
 *
 * 关键：指标是**累计**的，可以分几次交。所以正确打法是攒够一批就送一批，
 * 而不是等到季末一次掏空 —— 那样既受仓容限制，又会把民心砸下去。
 * UI 必须把这一点表达清楚，否则玩家会踩这个坑。
 */
function maybePay(e: Engine): void {
  const st = e.getState();
  const q = st.quota;
  if (!q) return;
  const city = currentCity(st);
  const out = computeOutput(city, idx);
  const needG = Math.max(0, q.demandGrain - q.paidGrain);
  const needC = Math.max(0, q.demandCoin - q.paidCoin);
  if (needG === 0 && needC === 0) return;

  const daysLeft = q.dueDay - st.day;
  // 留出 15 日口粮，多出来的攒够一批就送走
  const reserveG = out.grainUpkeep * 15;
  const spareG = Math.max(0, city.grain - reserveG);
  const spareC = Math.max(0, city.coin - 150);

  const urgent = daysLeft <= 6;
  const payG = urgent ? Math.min(needG, city.grain) : Math.min(needG, spareG);
  const payC = urgent ? Math.min(needC, city.coin) : Math.min(needC, spareC);
  if (payG < 40 && payC < 40 && !urgent) return;
  if (payG === 0 && payC === 0) return;
  e.dispatch({ t: 'pay', grain: payG, coin: payC });
}

// ─────────────────────────────────────────────────────────────

const e = new Engine('balance', content);
e.dispatch({ t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao' });

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

const YEARS = 3;
const rows: string[] = [];
let lastQuarter = -1;
let met = 0, missed = 0;

for (let d = 0; d < 360 * YEARS; d++) {
  // 每天最多起一项工程，模拟玩家不会疯狂连点
  autoFight(e);
  autoField(e);
  decide(e);
  maybePay(e);
  const evs = e.dispatch({ t: 'day' });
  autoFight(e);
  autoField(e);
  for (const ev of evs) {
    if (ev.t === 'quota_settled') { if (ev.met) met++; else missed++; }
    if (ev.t === 'expanded') rows.push(`      ↑ 外郭拓开`);
    if (ev.t === 'unlocked') rows.push(`      ↑ 解锁：${idx.building.get(ev.buildingId)?.name}`);
    if (ev.t === 'promoted') rows.push(`      ★ 升迁`);
  }

  const st = e.getState();
  // 够条件就拓外郭
  if (currentCity(st).ring === 0) e.dispatch({ t: 'expand' });

  const q = quarterOf(st.day);
  if (q !== lastQuarter) {
    lastQuarter = q;
    const city = currentCity(st);
    const out = computeOutput(city, idx);
    const comp = new Map<string, number>();
    for (const p of city.plots) {
      if (!p.buildingId || p.buildingId === 'yamen' || p.level <= 0) continue;
      comp.set(p.buildingId, (comp.get(p.buildingId) ?? 0) + p.level);
    }
    const compStr = [...comp.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, lv]) => `${idx.building.get(id)?.name ?? id}${lv}`)
      .join('');
    rows.push(
      [
        formatMonth(st.day).padEnd(14),
        `粮${String(city.grain).padStart(5)}/${String(out.capGrain).padEnd(5)}`,
        `钱${String(city.coin).padStart(5)}/${String(out.capCoin).padEnd(5)}`,
        `户${String(city.households).padStart(4)}/${String(out.capHouse).padEnd(4)}`,
        `民心${String(city.morale).padStart(3)}`,
        `日粮${String(out.grainNet).padStart(4)}`,
        `日钱${String(out.coinPerDay).padStart(4)}`,
        `劳力${String(Math.floor(out.labourRatio / 10)).padStart(3)}%`,
        `功${String(st.official.merit).padStart(4)}`,
        `信${String(st.official.trust).padStart(3)}`,
        st.quota ? `索粮${String(st.quota.demandGrain).padStart(5)}` : '',
        compStr,
      ].join(' '),
    );
  }
}

console.log(rows.join('\n'));
const st = e.getState();
console.log(`\n三年结算：指标达成 ${met} / 未达成 ${missed}，功绩 ${st.official.merit}，信任 ${st.official.trust}，官阶 ${st.official.rank}`);
