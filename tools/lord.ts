/**
 * 当主公是不是一盘棋。
 *
 * 主公只有四个动词：任命、调兵、兴修、遣使。
 * 这个工具问的是它们**各自算不算数** ——
 *
 *   一、什么都不做会怎样？会输吗？（不会输的话这局就没有压力）
 *   二、只任命、不打仗，能不能守住？（任命要真的顶事）
 *   三、认真打，十年能打到多大？（要打得出去，但不能一路平推）
 *   四、开局那十二家，难度是不是真的不一样？
 *
 * 四条都答得上来，这才是一盘棋；有一条答不上来，那就是个表格。
 *
 *   node tools/lord.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import { idlePeople, investCost, KEEP_GARRISON } from '../src/sim/handlers_lord.ts';
import { unmannedCities } from '../src/sim/people.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'),
  terrain: read('terrain'), people: read('people'), text: read('text'),
} as ContentDB;
const idx = indexContent(content);

interface Result {
  held: number;
  day: number;
  out: boolean;
}

/** 开一局主公 */
function start(seed: string, lordId: string): Engine {
  const e = new Engine(seed, content);
  e.dispatch({
    t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId, role: 'lord',
  });
  return e;
}

const heldBy = (e: Engine, f: string): string[] =>
  Object.values(e.getState().nodes).filter((n) => n.factionId === f).map((n) => n.id);

/**
 * 一个只会任命的主公。
 *
 * 每次有空城、手上又有闲人，就派一个去。别的什么都不做。
 */
function autoAppoint(e: Engine, lordId: string): void {
  const st = e.getState();
  const free = idlePeople(st, idx);
  if (free.length === 0) return;
  const bare = Object.values(st.nodes)
    .filter((n) => n.factionId === lordId && !st.posts[n.id]);
  for (let i = 0; i < Math.min(free.length, bare.length); i++) {
    e.dispatch({ t: 'lord_appoint', cityId: bare[i]!.id, personId: free[i]! });
  }
}

/** 一个也会兴修的主公：粮攒够了就往城里投 */
function autoInvest(e: Engine, lordId: string): void {
  const st = e.getState();
  for (const n of Object.values(st.nodes)) {
    if (n.factionId !== lordId) continue;
    if (n.grain > investCost(n.dev) * 2.4) {
      e.dispatch({ t: 'lord_invest', cityId: n.id });
    }
  }
}

/**
 * 一个会打仗的主公。
 *
 * **他先增援前线，攒够了才出兵。**
 * 这一点要紧：NPC 那边是从整个辖境一次征调的，
 * 而玩家一道令只调得动一座城的兵 —— 想凑出压倒性的优势，
 * 就得先把后方的兵一程一程挪到边境去。
 * 那正是「调兵」这个动词存在的理由。
 */
function autoAttack(e: Engine, lordId: string, tally: Tally): void {
  const st = e.getState();
  // 只挡住「已经有一路在打」；后方的增援还在路上不妨碍前头动手
  if (Object.values(st.armies).some(
    (a) => a.factionId === lordId && a.intent === 'attack',
  )) return;
  const held = Object.values(st.nodes).filter((n) => n.factionId === lordId);

  // 一、挨着敌人的城，攒够了就打
  for (const n of held) {
    if (st.sieges[n.id]) continue;
    const spare = n.troops - KEEP_GARRISON - 100;
    if (spare < 150) continue;
    for (const to of idx.node.get(n.id)?.links ?? []) {
      const t = st.nodes[to];
      if (!t || t.factionId === lordId) continue;
      if (spare < t.troops * 1.6) continue;
      const r = e.dispatch({ t: 'lord_march', fromId: n.id, toId: to, troops: spare });
      if (r.some((x) => x.t === 'lord_marched')) { tally.attacks++; return; }
    }
  }

  // 二、打不动就征调 —— 把辖境的余兵往边境一处调
  const frontier = held.filter((n) =>
    !st.sieges[n.id]
    && (idx.node.get(n.id)?.links ?? []).some((to) => {
      const t = st.nodes[to];
      return t && t.factionId !== lordId;
    }));
  if (frontier.length === 0) return;
  // 往兵最多的那处边城集结，凑得快
  const front = frontier.sort((a, b) => b.troops - a.troops)[0]!;
  const r = e.dispatch({ t: 'lord_muster', cityId: front.id });
  if (r.some((x) => x.t === 'lord_mustered')) tally.moves++;
}

interface Tally { attacks: number; moves: number; attacked: number; lost: number; took: number }
const blank = (): Tally => ({ attacks: 0, moves: 0, attacked: 0, lost: 0, took: 0 });

function run(
  seed: string, lordId: string, years: number,
  play: (e: Engine, tally: Tally) => void,
): Result & { tally: Tally } {
  const e = start(seed, lordId);
  const tally = blank();
  for (let d = 0; d < years * 360; d++) {
    if (e.getState().ending) break;
    play(e, tally);
    for (const ev of e.dispatch({ t: 'day' })) {
      if (ev.t === 'siege_started' && e.getState().nodes[ev.cityId]?.factionId === lordId) {
        tally.attacked++;
      }
      if (ev.t === 'city_fell') {
        if (ev.to === lordId) tally.took++;
        if (ev.from === lordId) tally.lost++;
      }
    }
  }
  const st = e.getState();
  return { held: heldBy(e, lordId).length, day: st.day, out: !!st.ending, tally };
}

const YEARS = 10;
const SEEDS = ['a', 'b', 'c', 'd', 'e', 'f'];

function trial(lordId: string, play: (e: Engine, t: Tally) => void): {
  held: number; out: number; day: number; t: Tally;
} {
  let held = 0;
  let out = 0;
  let day = 0;
  const sum = blank();
  for (const s of SEEDS) {
    const r = run(s, lordId, YEARS, play);
    held += r.held; out += r.out ? 1 : 0; day += r.day;
    sum.attacks += r.tally.attacks; sum.moves += r.tally.moves;
    sum.attacked += r.tally.attacked; sum.lost += r.tally.lost; sum.took += r.tally.took;
  }
  const n = SEEDS.length;
  for (const k of Object.keys(sum) as (keyof Tally)[]) sum[k] = Math.round(sum[k] / n);
  return { held: held / n, out: (out / n) * 100, day: day / n, t: sum };
}

console.log('');
console.log(`  曹操，跑 ${YEARS} 年，${SEEDS.length} 局取平均。开局 ${
  heldBy(start('a', 'caocao'), 'caocao').length} 城。`);
console.log('');
console.log('  怎么玩                 十年后   出局率   挨打   打下   丢掉   出兵   调兵');
console.log('  ' + '─'.repeat(72));

const PLANS: [string, (e: Engine, t: Tally) => void][] = [
  ['什么都不做', () => { /* 就看着 */ }],
  ['只任命', (e) => autoAppoint(e, 'caocao')],
  ['任命 + 兴修', (e) => { autoAppoint(e, 'caocao'); autoInvest(e, 'caocao'); }],
  ['任命 + 兴修 + 出兵', (e, t) => {
    autoAppoint(e, 'caocao'); autoInvest(e, 'caocao'); autoAttack(e, 'caocao', t);
  }],
];

for (const [name, play] of PLANS) {
  const r = trial('caocao', play);
  console.log(
    '  ' + name.padEnd(20)
    + r.held.toFixed(1).padStart(7)
    + (Math.round(r.out) + '%').padStart(9)
    + String(r.t.attacked).padStart(7)
    + String(r.t.took).padStart(7)
    + String(r.t.lost).padStart(7)
    + String(r.t.attacks).padStart(7)
    + String(r.t.moves).padStart(7),
  );
}

// ── 十二家的难度真的不一样吗 ──────────────────────
console.log('');
console.log('  换一家来当（都用「任命 + 兴修 + 出兵」这一套）');
console.log('');
console.log('  诸侯      开局   十年后   出局率   出兵   征调   打下   丢掉');
console.log('  ' + '─'.repeat(62));

for (const f of ['caocao', 'yuanshao', 'liubiao', 'gongsunzan', 'kongrong', 'taoqian']) {
  const at0 = heldBy(start('a', f), f).length;
  if (at0 === 0) continue;
  const r = trial(f, (e, t) => {
    autoAppoint(e, f); autoInvest(e, f); autoAttack(e, f, t);
  });
  console.log(
    '  ' + (idx.faction.get(f)?.name ?? f).padEnd(9)
    + String(at0).padStart(4)
    + r.held.toFixed(1).padStart(9)
    + (Math.round(r.out) + '%').padStart(9)
    + String(r.t.attacks).padStart(7)
    + String(r.t.moves).padStart(7)
    + String(r.t.took).padStart(7)
    + String(r.t.lost).padStart(7),
  );
}

// ── 人够不够派 ────────────────────────────────────
{
  const e = start('a', 'caocao');
  for (let d = 0; d < YEARS * 360; d++) {
    if (e.getState().ending) break;
    autoAppoint(e, 'caocao'); autoInvest(e, 'caocao'); autoAttack(e, 'caocao', blank());
    e.dispatch({ t: 'day' });
  }
  const st = e.getState();
  const held = heldBy(e, 'caocao');
  const bare = held.filter((id) => !st.posts[id]).length;
  console.log('');
  console.log(
    `  十年之后曹操有 ${held.length} 城，其中 ${bare} 座没人守；`
    + `手上闲着的人 ${idlePeople(st, idx).length} 个。`,
  );
  console.log(
    bare > 0
      ? '  城多了就管不过来 —— 这条张力是真的。'
      : '  人还够派，压力还没上来。',
  );
  console.log(`  （天下无人守的城共 ${unmannedCities(st, idx)} 座）`);
}
console.log('');
