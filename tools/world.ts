/**
 * 天下推演。
 *
 * 只看外面那个世界活不活：城池会不会易主、军队会不会满地跑、
 * 有没有哪一家势力在三年内吃掉所有人。玩家在这里是个不作为的县令，
 * 因为要测的是**世界自己转得对不对**。
 *
 *   node tools/world.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import { currentCity } from '../src/sim/state.ts';
import { formatMonth } from '../src/sim/time.ts';
import { computeOutput, isPlotOpen } from '../src/sim/city.ts';
import { WALL_COST } from '../src/sim/types.ts';
import { garrisonOf } from '../src/sim/worldtick.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
    field: read('field'), facilities: read('facilities'), terrain: read('terrain'), people: read('people'),
    text: read('text'),
} as ContentDB;
const idx = indexContent(content);

const e = new Engine('world', content);
e.dispatch({ t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao' });

/**
 * 一个称职的县令：种田、盖房、修仓，**并且记得留地方给兵营、记得修城墙**。
 *
 * 上一版的参考玩家把八块地全填了田和房，于是没地方摆兵营，
 * 太平期一过就被打死 —— 那测出来的是「不会玩会怎样」，不是平衡本身。
 */
function govern(): void {
  const st = e.getState();
  if (st.ending || st.battle) return;
  const city = currentCity(st);
  const out = computeOutput(city, idx);

  // 先把该交的交了，留十五日口粮
  const q = st.quota;
  if (q) {
    const needG = Math.max(0, q.demandGrain - q.paidGrain);
    const needC = Math.max(0, q.demandCoin - q.paidCoin);
    const spareG = Math.max(0, city.grain - out.grainUpkeep * 15);
    if (needG > 0 && spareG > 80) e.dispatch({ t: 'pay', grain: Math.min(needG, spareG), coin: 0 });
    if (needC > 0 && city.coin > 320) {
      e.dispatch({ t: 'pay', grain: 0, coin: Math.min(needC, city.coin - 280) });
    }
  }

  // 城墙是围城时唯一救得了命的东西。
  // 它排在所有营造之前 —— 攒着钱去盖第四块田，等于把命押在没人来打上
  const wc = WALL_COST[city.wall];
  const needWall = city.wall < 3 && city.wallWork === 0 && wc !== undefined;
  if (needWall && city.coin >= wc!.coin && city.grain >= wc!.grain + 200) {
    e.dispatch({ t: 'fortify' });
    return;
  }
  // 还差钱修城时，先不动别的工程，把钱攒出来
  if (needWall && city.wall === 0 && city.coin < wc!.coin) return;

  const has = (id: string): boolean => city.plots.some((p) => p.buildingId === id);
  const free = city.plots.filter(
    (p, i) => i !== 12 && isPlotOpen(city, i) && !p.buildingId && !p.work,
  ).length;

  // 想要的东西，按轻重缓急排。兵营排在民居前面 ——
  // 地是稀缺的，等到「有空地再说」就永远轮不到它
  const order = [
    'farm', 'house', 'granary', 'farm', 'well',
    ...(city.households >= 200 ? ['barracks'] : []),
    'house', 'market', 'farm', 'barracks', 'granary', 'workshop', 'pond',
  ];

  for (let p = 0; p < city.plots.length; p++) {
    if (p === 12 || !isPlotOpen(city, p)) continue;
    const plot = city.plots[p]!;
    if (plot.work || plot.buildingId) continue;
    for (const id of order) {
      // 只留最后两块空地给还没有的关键设施
      if (free <= 2 && has(id) && id !== 'barracks') continue;
      const evs = e.dispatch({ t: 'build', plot: p, buildingId: id });
      if (evs.some((x) => x.t === 'work_started')) return;
    }
  }

  // 地满了就升级，优先升兵营与田
  const prio = ['barracks', 'farm', 'house', 'granary', 'market', 'well'];
  for (const want of prio) {
    for (let p = 0; p < city.plots.length; p++) {
      const plot = city.plots[p]!;
      if (plot.work || plot.buildingId !== want) continue;
      const evs = e.dispatch({ t: 'build', plot: p, buildingId: want });
      if (evs.some((x) => x.t === 'work_started')) return;
    }
  }
}

/**
 * 自动把仗打完。
 *
 * 打仗期间时间是停住的（day 命令会被拒绝），
 * 所以任何自动推进的循环都必须先把仗了结，否则会空转到底。
 */
function autoFight(e2: Engine): void {
  for (let i = 0; i < 60; i++) {
    const b = e2.getState().battle;
    if (!b) return;
    if (b.phase === 'done') { e2.dispatch({ t: 'battle_dismiss' }); return; }
    if (b.phase === 'deploy') {
      const m = b.defMen;
      const w = Math.floor(m / 3);
      e2.dispatch({ t: 'deploy', wall: w, gate: w, reserve: m - w - w });
      continue;
    }
    if (b.pending) e2.dispatch({ t: 'decide', option: 0 });
    else e2.dispatch({ t: 'battle_round' });
  }
}

/** 野战同理：不打完，日历一天也不会走 */
function autoField(e2: Engine): void {
  for (let i = 0; i < 60; i++) {
    const f = e2.getState().field;
    if (!f) return;
    if (f.phase === 'done') { e2.dispatch({ t: 'field_dismiss' }); return; }
    if (f.phase === 'deploy') { e2.dispatch({ t: 'field_deploy', places: [], formation: 'heyi' });
      e2.dispatch({ t: 'field_begin' });
      continue; }
    if (f.pending) e2.dispatch({ t: 'field_decide', option: 0 });
    else e2.dispatch({ t: 'field_round' });
  }
}

const YEARS = 5;
const log: string[] = [];
let lastYear = -1;

for (let d = 0; d < 360 * YEARS; d++) {
  govern();
  autoFight(e);
  autoField(e);
  const evs = e.dispatch({ t: 'day' });
  autoFight(e);
  autoField(e);
  const st = e.getState();

  for (const ev of evs) {
    const f = (id: string): string => idx.faction.get(id)?.name ?? id;
    const c = (id: string): string => idx.node.get(id)?.name ?? id;
    switch (ev.t) {
      case 'army_launched':
        log.push(`  ${formatMonth(st.day)}  ${f(ev.factionId)} 自 ${c(ev.fromId)} 发兵 ${ev.troops} 攻 ${c(ev.toId)}`);
        break;
      case 'city_fell':
        log.push(`  ${formatMonth(st.day)}  ★ ${c(ev.cityId)} 陷落：${f(ev.from)} → ${f(ev.to)}`);
        break;
      case 'siege_lifted':
        log.push(`  ${formatMonth(st.day)}  ${f(ev.factionId)} 自 ${c(ev.cityId)} 城下退兵`);
        break;
      case 'army_dispersed':
        log.push(`  ${formatMonth(st.day)}  ${f(ev.factionId)} 往 ${c(ev.toId)} 的军队断粮溃散`);
        break;
      case 'lord_relief':
        log.push(`  ${formatMonth(st.day)}  ✦ 主公遣兵 ${ev.troops} 来援 ${c(ev.cityId)}`);
        break;
      case 'game_over':
        log.push(`  ${formatMonth(st.day)}  ✖ 结局：${ev.kind === 'captured' ? '城破被俘' : '交不上差，被撤职'}`);
        break;
      default: break;
    }
  }

  const year = Math.floor(st.day / 360);
  if (year !== lastYear) {
    lastYear = year;
    const city = currentCity(st);
    const owned = new Map<string, number>();
    for (const n of Object.values(st.nodes)) {
      owned.set(n.factionId, (owned.get(n.factionId) ?? 0) + 1);
    }
    const share = [...owned.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `${idx.faction.get(id)?.name ?? id}${n}`)
      .join(' ');
    log.push(
      [
        formatMonth(st.day).padEnd(13),
        `粮${String(city.grain).padStart(5)}`,
        `钱${String(city.coin).padStart(5)}`,
        `户${String(city.households).padStart(4)}`,
        `民心${String(city.morale).padStart(3)}`,
        `守军${String(garrisonOf(city, idx)).padStart(4)}`,
        `城墙${city.wall}`,
        `功${String(st.official.merit).padStart(4)}`,
        `信${String(st.official.trust).padStart(3)}`,
        `军${Object.keys(st.armies).length}`,
        `围${Object.keys(st.sieges).length}`,
        `| ${share}`,
      ].join(' '),
    );
  }

  if (st.ending) break;
}

console.log(log.join('\n'));
const st = e.getState();
console.log(`\n结局：${st.ending ? st.ending.kind : '仍在任上'}　第 ${Math.floor(st.day / 360) + 1} 年`);
