/**
 * 派谁去，到底差多少。
 *
 * 招一名部将要二百六十石、二十四天，界面上写着「统 76 勇 68」——
 * 而在这之前，theatre.ts 里 grep 不到一个 valor、一个 command：
 * **招谁都一样，招不招也一样**。那几个数字纯粹是画上去的。
 *
 * 这个工具就问一句：同样的兵、同样的地、同样的打法，
 * 换一个人来领，结果差得看得出来吗 ——
 * 看不出来，「招将」这条发育线就是假的；
 * 差得太多，那就成了「谁带兵谁赢」，兵力和地形反倒不作数了。
 *
 *   node tools/officers.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import { STARTING_CAMP } from '../src/sim/general_types.ts';
import type { Theatre, Unit } from '../src/sim/theatre_types.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'),
  terrain: read('terrain'), people: read('people'), text: read('text'),
} as ContentDB;
const idx = indexContent(content);

function stage(seed: string): { e: Engine; t: Theatre } {
  const e = new Engine(seed, content);
  e.dispatch({
    t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
  });
  const st = e.getState() as never as {
    camps: Record<string, { troops: number; training: number; gear: number; grain: number }>;
    nodes: Record<string, { factionId: string }>;
    official: { lordId: string };
    retinue: string[];
  };
  const camp = st.camps[STARTING_CAMP]!;
  camp.troops = 800; camp.training = 70; camp.gear = 3; camp.grain = 6000;
  // 你请得动的是**你主公手下**的人
  st.retinue = (idx.byFaction.get('caocao') ?? []).map((o) => o.id);
  const foe = Object.entries(st.nodes).find(([, n]) => n.factionId !== st.official.lordId)!;
  e.dispatch({ t: 'theatre_open', targetNodeId: foe[0] });
  return { e, t: e.getState().theatre! };
}

const RUNS = 40;

/** 同一场仗，换一个人来领 */
function trial(officerId: string | null): { win: number; left: number; foe: number } {
  let wins = 0;
  let left = 0;
  let foeLeft = 0;
  let ran = 0;
  for (let i = 0; i < RUNS; i++) {
    const { e, t } = stage('off' + i);
    const sent = e.dispatch({
      t: 'theatre_send', kind: 'foot', men: Math.min(500, t.pool.foot),
      col: Math.round(t.foeCamp[0] - 6), row: Math.round(t.foeCamp[1]),
      stance: 'assault', officerId,
    });
    if (!sent.some((x) => x.t === 'theatre_sent')) continue;
    e.dispatch({ t: 'theatre_begin' });
    let g = 0;
    while (t.phase === 'fighting' && g++ < 950) e.dispatch({ t: 'theatre_step', ticks: 1 });
    ran++;
    if (t.outcome === 'won') wins++;
    left += t.units.filter((u: Unit) => u.side === 'own' && !u.routed)
      .reduce((a: number, u: Unit) => a + u.men, 0);
    foeLeft += t.units.filter((u: Unit) => u.side === 'foe' && !u.routed)
      .reduce((a: number, u: Unit) => a + u.men, 0);
  }
  const n = Math.max(1, ran);
  return { win: (wins / n) * 100, left: left / n, foe: foeLeft / n };
}

const people = [...(idx.byFaction.get('caocao') ?? [])]
  .sort((a, b) => (b.valor + b.command) - (a.valor + a.command));

{
  const { t } = stage('off0');
  const w = t.units.find((u) => u.side === 'foe' && u.name.includes('前军'))?.leader ?? '？';
  console.log(`
  同样五百人去撞 ${t.foeName}（守将 ${w}），换个人领。跑 ${RUNS} 局。
`);
}
console.log('  领兵的         统  勇  智     胜率   我军余   敌军余');
console.log('  ' + '─'.repeat(60));

const self = trial(null);
console.log(
  '  ' + '你亲领'.padEnd(13) + '56  52  50'
  + String(Math.round(self.win) + '%').padStart(9)
  + String(Math.round(self.left)).padStart(8)
  + String(Math.round(self.foe)).padStart(9),
);

for (const o of people.slice(0, 6)) {
  const r = trial(o.id);
  console.log(
    '  ' + (o.name + '（' + o.note.slice(0, 0) + '）').replace('（）', '').padEnd(13)
    + String(o.command).padStart(2) + '  ' + String(o.valor).padStart(2)
    + '  ' + String(o.wit).padStart(2)
    + String(Math.round(r.win) + '%').padStart(9)
    + String(Math.round(r.left)).padStart(8)
    + String(Math.round(r.foe)).padStart(9),
  );
}
console.log('');
