/**
 * 外交到底有没有在动。
 *
 * `attitude` 这张表原先开局摆好之后就再没变过 —— 十年打下来，
 * 各家的恩怨还是初平元年那一天的样子。有数据，没有行为。
 *
 * 这个工具问三句：
 *   一、态度**真的会变**吗？变了多少？
 *   二、**打了会结仇**吗？围过谁的城，那家是不是就恨上了？
 *   三、**强邻招不招人忌惮**？天下第一大势力，是不是四邻都防着他 ——
 *      这是设计方案 8.1「主公滚雪球」那条问题的解法，
 *      不给赢家加惩罚，而是让别人怕他。
 *
 *   node tools/diplomacy.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import { STARTING_CAMP } from '../src/sim/general_types.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'),
  terrain: read('terrain'), people: read('people'), text: read('text'),
} as ContentDB;
const idx = indexContent(content);

const YEARS = 10;
const e = new Engine('diplo', content);
e.dispatch({
  t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
});

const snap = (): Map<string, number> => {
  const m = new Map<string, number>();
  for (const [a, fs] of Object.entries(e.getState().factions)) {
    for (const [b, v] of Object.entries(fs.attitude)) m.set(a + '>' + b, v);
  }
  return m;
};
const before = snap();

const keep = e.getState() as never as {
  camps: Record<string, { grain: number; troops: number }>;
  official: { trust: number };
};
let sieges = 0;
for (let d = 0; d < YEARS * 360; d++) {
  const c = keep.camps[STARTING_CAMP];
  if (c) { c.grain = 9000; c.troops = Math.max(200, c.troops); }
  keep.official.trust = 60;
  for (const ev of e.dispatch({ t: 'day' })) {
    if (ev.t === 'siege_started') sieges++;
  }
}
const st = e.getState();
const after = snap();

// ── 一、态度动了多少 ──────────────────────────────
let moved = 0;
let biggest = { pair: '', by: 0 };
for (const [k, v] of after) {
  const was = before.get(k) ?? 0;
  if (v !== was) moved++;
  if (Math.abs(v - was) > Math.abs(biggest.by)) biggest = { pair: k, by: v - was };
}
const name = (f: string): string => idx.faction.get(f)?.name ?? f;
const [ba, bb] = biggest.pair.split('>');

console.log('');
console.log(`  推演 ${YEARS} 年，各家出兵围城 ${sieges} 次。`);
console.log(`  态度变过的关系：${moved} / ${after.size} 对`);
console.log(
  `  变得最狠的一对：${name(ba ?? '')} 看 ${name(bb ?? '')}，`
  + `${biggest.by > 0 ? '+' : ''}${biggest.by}`,
);
console.log(
  moved > after.size * 0.5
    ? '  外交这张表在动 —— 这一条对了。'
    : '  ← 大半的关系纹丝不动，外交还是死的',
);

// ── 二、十年之后的天下 ────────────────────────────
const holds = new Map<string, number>();
for (const n of Object.values(st.nodes)) holds.set(n.factionId, (holds.get(n.factionId) ?? 0) + 1);
const rank = [...holds.entries()].sort((a, b) => b[1] - a[1]);

console.log('');
console.log('  十年之后的天下：');
for (const [f, n] of rank.slice(0, 6)) {
  console.log(`    ${name(f).padEnd(5)}${String(n).padStart(3)} 城`);
}

// ── 三、真出了一家独大，四邻防不防他 ──────────────
//
// 这一段**不等十年跑出一个霸主**：直接摆一个出来。
// 骑着真推演去量是量不准的 —— 十年里未必出得了真正的独大，
// 而「滚雪球有没有刹车」问的正是那种局面。
{
  const e2 = new Engine('runaway', content);
  e2.dispatch({
    t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
  });
  const s2 = e2.getState() as never as {
    nodes: Record<string, { factionId: string }>;
    camps: Record<string, { grain: number; troops: number }>;
    official: { trust: number };
  };
  // 把四成天下划给袁绍。**别动玩家那座城** ——
  // 一动他就出局，`day` 当场冻住，后面三年一天也不会走
  const skip = new Set([e2.getState().official.cityId]);
  const all = Object.keys(s2.nodes).filter((id) => !skip.has(id));
  const want = Math.floor(all.length * 0.44);
  for (let i = 0; i < want; i++) s2.nodes[all[i]!]!.factionId = 'yuanshao';

  for (let d = 0; d < 3 * 360; d++) {
    const c = s2.camps[STARTING_CAMP];
    if (c) { c.grain = 9000; c.troops = Math.max(200, c.troops); }
    s2.official.trust = 60;
    e2.dispatch({ t: 'day' });
  }
  const s3 = e2.getState();
  const h2 = new Map<string, number>();
  for (const n of Object.values(s3.nodes)) h2.set(n.factionId, (h2.get(n.factionId) ?? 0) + 1);
  const share = Math.round(((h2.get('yuanshao') ?? 0) * 1000) / Object.keys(s3.nodes).length);
  let sum = 0;
  let cnt = 0;
  let foes = 0;
  for (const [f] of h2) {
    if (f === 'yuanshao') continue;
    const att = s3.factions[f]?.attitude['yuanshao'] ?? 0;
    sum += att; cnt++;
    if (att < -20) foes++;
  }
  console.log('');
  console.log(
    `  摆一个霸主出来：袁绍据 ${(share / 10).toFixed(0)}% 天下，`
    + `跑到第 ${s3.day} 天。`,
  );
  console.log(
    `  其余 ${cnt} 家看他平均 ${Math.round(sum / Math.max(1, cnt))}，`
    + `其中 ${foes} 家已成敌对。`,
  );
  console.log(
    foes >= cnt * 0.6
      ? '  一家独大就会招来众怒 —— 滚雪球有了刹车。'
      : '  ← 他都这么大了，四邻还不防着他',
  );
}
console.log('');
