/**
 * 派细作值不值。
 *
 * 花三十个人去问一句可能是谎话的话 —— 这要成为一个**决定**，
 * 四种下场的分布就必须都摸得着：
 *
 *   探得太准，那就是白送的情报，人人都点，不成其为选择；
 *   探得太糟，那就没人点，这颗按钮等于不存在；
 *   假情报太少见，玩家永远不会怀疑，「可能是假的」就是句空话；
 *   假情报太常见，玩家索性不信，也一样是句空话。
 *
 * 还要看**营练得好不好真的管用** —— 细作不该是一颗独立的骰子，
 * 它得是「你把营经营成什么样」在战场上的又一次兑现。
 *
 *   node tools/scout.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import type { ContentDB } from '../src/sim/content.ts';
import { STARTING_CAMP } from '../src/sim/general_types.ts';
import { SCOUT_MAX } from '../src/sim/theatre_types.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'),
  terrain: read('terrain'), people: read('people'), text: read('text'),
} as ContentDB;

type Kind = 'clear' | 'graze' | 'lost' | 'duped';

function run(seed: string, training: number): Kind[] {
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

  const out: Kind[] = [];
  for (let i = 0; i < SCOUT_MAX; i++) {
    for (const ev of e.dispatch({ t: 'theatre_scout' })) {
      if (ev.t === 'theatre_scouted') out.push(ev.kind);
    }
  }
  return out;
}

const RUNS = 300;
console.log('\n  一拨细作的下场（按营里的训练度分）\n');
console.log('  训练度    探明    只摸到边    没回来    中了计');
console.log('  ' + '─'.repeat(56));

for (const training of [20, 45, 70, 95]) {
  const tally: Record<Kind, number> = { clear: 0, graze: 0, lost: 0, duped: 0 };
  let n = 0;
  for (let i = 0; i < RUNS; i++) {
    for (const k of run('sc' + i, training)) { tally[k]++; n++; }
  }
  const pc = (x: number): string => String(Math.round((x / Math.max(1, n)) * 100) + '%');
  console.log(
    '  ' + String(training).padEnd(9)
    + pc(tally.clear).padStart(5)
    + pc(tally.graze).padStart(11)
    + pc(tally.lost).padStart(10)
    + pc(tally.duped).padStart(10),
  );
}

// 第几拨探得动
console.log('\n  第几拨（训练度 70）\n');
console.log('  第几拨    探明    只摸到边    没回来    中了计');
console.log('  ' + '─'.repeat(56));
const byWave: Record<Kind, number>[] = [
  { clear: 0, graze: 0, lost: 0, duped: 0 },
  { clear: 0, graze: 0, lost: 0, duped: 0 },
  { clear: 0, graze: 0, lost: 0, duped: 0 },
];
for (let i = 0; i < RUNS; i++) {
  run('sc' + i, 70).forEach((k, w) => { if (byWave[w]) byWave[w]![k]++; });
}
byWave.forEach((tally, w) => {
  const n = tally.clear + tally.graze + tally.lost + tally.duped;
  const pc = (x: number): string => String(Math.round((x / Math.max(1, n)) * 100) + '%');
  console.log(
    '  ' + String(w + 1).padEnd(9)
    + pc(tally.clear).padStart(5)
    + pc(tally.graze).padStart(11)
    + pc(tally.lost).padStart(10)
    + pc(tally.duped).padStart(10),
  );
});
console.log('');
