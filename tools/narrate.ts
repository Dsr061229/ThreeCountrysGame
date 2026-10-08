/**
 * 一场仗到底讲不讲得出故事。
 *
 * 平衡工具看的是**数**（胜率、折损），这一个看的是**字**：
 * 打完两百多拍，战报上写得出几行、写的是不是人话。
 *
 * 上一版的答案是「五行，其中四行一模一样」——
 * 仗打得对，可是没人在讲它。玩家的原话是「开战后啥反馈都没有」。
 *
 *   node tools/narrate.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, renderText, type ContentDB } from '../src/sim/content.ts';
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

const SHICHEN = ['辰时', '巳时', '午时', '未时', '申时', '酉时'];
const shichen = (tick: number): string =>
  SHICHEN[Math.min(5, Math.floor(tick / 46))] ?? '酉时';

function run(seed: string): void {
  const e = new Engine(seed, content);
  e.dispatch({ t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general' });
  const st = e.getState() as never as {
    camps: Record<string, { troops: number; training: number; gear: number; grain: number }>;
    nodes: Record<string, { factionId: string }>;
    sieges: Record<string, unknown>;
    official: { lordId: string; cityId: string };
    retinue: string[];
    flags: Record<string, number>;
  };
  const camp = st.camps[STARTING_CAMP]!;
  camp.troops = 900; camp.training = 72; camp.gear = 3; camp.grain = 6000;
  st.retinue = ['yuejin', 'lidian', 'caoren'];
  const at = st.official.cityId;
  st.sieges[at] = { cityId: at, factionId: 'taiping', troops: 760, supply: 9000, days: 3 };
  e.dispatch({ t: 'theatre_open', targetNodeId: at });

  const t = e.getState().theatre!;
  // 找一块林子埋伏
  let spot: [number, number] = [18, 10];
  for (let r = 8; r < 18 && spot[0] === 18; r++) {
    for (let c = 14; c < 26; c++) {
      if (t.cells[r * t.cols + c]!.ground === 'forest') { spot = [c, r]; break; }
    }
  }
  const say = (r: readonly { t: string; reasonId?: string }[]): string =>
    r.map((x) => x.t + (x.reasonId ? ':' + x.reasonId : '')).join(',');
  console.log('  派：' + say(e.dispatch({ t: 'theatre_send', kind: 'foot', men: 380, col: 24, row: 14, stance: 'assault', officerId: null }) as never));
  console.log('  伏：' + spot + ' ' + say(e.dispatch({ t: 'theatre_send', kind: 'foot', men: 330, col: spot[0], row: spot[1], stance: 'ambush', officerId: 'yuejin' }) as never));
  e.dispatch({ t: 'theatre_send', kind: 'bow', men: t.pool.bow, col: 20, row: 16, stance: 'hold', officerId: 'lidian' });
  e.dispatch({ t: 'theatre_send', kind: 'foot', men: 99, col: 22, row: 18, stance: 'reserve', officerId: 'caoren' });
  e.dispatch({ t: 'theatre_begin' });

  let guard = 0;
  while (t.phase === 'fighting' && guard++ < 900) e.dispatch({ t: 'theatre_step', ticks: 1 });

  console.log(`\n── ${seed} · ${t.kind === 'siege' ? '攻城' : '野战'} · ${t.tick} 拍 · ${t.outcome} ──`);
  for (const l of t.log) {
    console.log('  ' + shichen(l.tick).padEnd(4) + renderText(idx.db.text, l.textId, l.vars ?? {}));
  }
  const r = t.result;
  if (r) console.log(`  账：折 ${r.lost}　敌折 ${r.foeLost}　缴 ${r.spoils}　功 ${r.merit}`);
}

for (const s of ['a', 'b', 'c']) run(s);

