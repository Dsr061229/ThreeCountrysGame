/**
 * 野战推演。
 *
 * 要验的：
 *   1. 阵型是**真的选择** —— 没有哪一种处处最优
 *   2. 兵力优劣势下的胜率曲线合理（不是必胜也不是必败）
 *   3. 地形真的起作用（占坡的一方该占便宜）
 *
 *   node tools/field.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { type ContentDB } from '../src/sim/content.ts';
import { FORMATIONS, type Formation } from '../src/sim/field_types.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'), terrain: read('terrain'), people: read('people'), text: read('text'),
} as ContentDB;

interface Setup {
  households: number;
  barracks: number;
  foe: number;
}

/** 摆到「城下有敌军」，然后出城野战 */
function runField(seed: string, s: Setup, form: Formation, bold: boolean): {
  outcome: string; ownLeft: number; foeLeft: number; rounds: number;
} {
  const e = new Engine(seed, content);
  e.dispatch({ t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao' });
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
  const f = e.getState().field;
  if (!f) throw new Error('野战没有开起来');

  e.dispatch({ t: 'field_deploy', places: [], formation: form });
  e.dispatch({ t: 'field_begin' });
  for (let i = 0; i < 60; i++) {
    const cur = e.getState().field;
    if (!cur || cur.phase === 'done') break;
    if (cur.pending) {
      const opts = cur.pending.options;
      let pick = 0;
      if (bold) {
        const g = opts.findIndex((o) => o.effect.gamble !== undefined);
        pick = g >= 0 ? g : opts.length - 1;
      }
      e.dispatch({ t: 'field_decide', option: pick });
    } else {
      e.dispatch({ t: 'field_round' });
    }
  }
  const fin = e.getState().field!;
  return {
    outcome: fin.outcome ?? '?',
    ownLeft: fin.units.filter((u) => u.side === 'own' && !u.routed).reduce((a, u) => a + u.men, 0),
    foeLeft: fin.units.filter((u) => u.side === 'foe' && !u.routed).reduce((a, u) => a + u.men, 0),
    rounds: fin.round,
  };
}

function rate(s: Setup, form: Formation, bold = false, n = 50): { won: number; lost: number } {
  let won = 0, lost = 0;
  for (let i = 0; i < n; i++) {
    const r = runField('fd' + i + form + (bold ? 'b' : ''), s, form, bold);
    if (r.outcome === 'won') won++;
    if (r.outcome === 'lost') lost++;
  }
  return { won: Math.round((won / n) * 100), lost: Math.round((lost / n) * 100) };
}

const FORMS: Formation[] = ['yulin', 'fengshi', 'heyi', 'fangyuan', 'yanyue'];

/** 出城的实际人数：乡勇(30 + 户/5) + 兵营 45/级，再乘出击比例 */
function ownMen(s: Setup): number {
  return Math.floor((30 + Math.floor(s.households / 5) + s.barracks * 45) * 0.78);
}

const cases: { name: string; s: Setup }[] = [
  { name: '兵力占优', s: { households: 900, barracks: 3, foe: 160 } },
  { name: '势均力敌', s: { households: 700, barracks: 2, foe: 210 } },
  { name: '以寡敌众', s: { households: 400, barracks: 1, foe: 260 } },
].map((c) => ({ ...c, name: `${c.name}：我 ${ownMen(c.s)} 敌 ${c.s.foe}` }));

console.log('局面'.padEnd(28) + FORMS.map((f) => FORMATIONS[f].name.padStart(9)).join('') + '     最优');
for (const c of cases) {
  const rs = FORMS.map((f) => rate(c.s, f));
  let best = 0;
  for (let i = 1; i < rs.length; i++) if (rs[i]!.won > rs[best]!.won) best = i;
  console.log(
    c.name.padEnd(24)
    + rs.map((r) => (r.won + '/' + r.lost).padStart(9)).join('')
    + '     ' + FORMATIONS[FORMS[best]!].name,
  );
}
console.log('\n（数字是 胜% / 败%，其余为两败俱伤各自收兵）');

console.log('\n=== 稳妥 vs 冒险（势均力敌） ===');
for (const f of FORMS) {
  const safe = rate(cases[1]!.s, f, false, 40);
  const bold = rate(cases[1]!.s, f, true, 40);
  console.log(
    '  ' + FORMATIONS[f].name.padEnd(4)
    + ` 稳 ${String(safe.won).padStart(3)}%胜 ${String(safe.lost).padStart(3)}%败`
    + `   险 ${String(bold.won).padStart(3)}%胜 ${String(bold.lost).padStart(3)}%败`,
  );
}
