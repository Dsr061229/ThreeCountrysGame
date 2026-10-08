/**
 * 武将这条线从头到尾跑一遍。
 *
 * 只问一件事：**这条线有没有「发育感」**。
 *
 * 所谓发育感，就是三年之后回头看，手里的东西和开局明显不一样了：
 * 兵更多、更能打、营里立起了几处设施、帐下有了几员将、军职升了一级。
 * 若三年下来一切照旧，那这条线就是挂机，不是经营。
 *
 *   node tools/general.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import { campOutput, daysOfGrain, busyOn, strengthOf } from '../src/sim/camp.ts';
import { MILITARY_RANKS, STARTING_CAMP, type Camp } from '../src/sim/general_types.ts';
import { formatMonth } from '../src/sim/time.ts';
import type { UnitKind } from '../src/sim/theatre_types.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'),
  terrain: read('terrain'), people: read('people'), text: read('text'),
} as ContentDB;
const idx = indexContent(content);

const e = new Engine('general-run', content);
e.dispatch({ t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general' });

/** 修营的顺序：先校场（练兵到头），再廪仓（接得住粮），然后弓弩坊、厩栏 */
const BUILD_ORDER = ['jiaochang', 'lincang', 'gongnufang', 'jiuli', 'gongfang', 'tunsuo'];

/** 一个「稳着来」的武将会怎么过日子 */
function play(camp: Camp): void {
  const st = e.getState();
  const out = campOutput(camp, idx);
  const days = daysOfGrain(camp);

  // 粮不够半年就下地；够了就收屯回校场
  const wantFarm = camp.grain < out.grainCap * 0.45;
  if (wantFarm !== camp.farming && !busyOn(camp, 'train')) {
    e.dispatch({ t: 'camp_farm', campId: STARTING_CAMP, on: wantFarm });
  }

  // 工：先把营修起来
  if (!busyOn(camp, 'craft')) {
    for (const id of BUILD_ORDER) {
      const def = idx.facility.get(id);
      if (!def) continue;
      if ((camp.works[id] ?? 0) >= Math.min(3, def.maxLevel)) continue;
      const r = e.dispatch({ t: 'camp_work', campId: STARTING_CAMP, job: 'build', facilityId: id });
      if (r.some((x) => x.t === 'work_started')) return;
      break;
    }
  }

  // 募：先招将，再招兵
  if (!busyOn(camp, 'recruit')) {
    if (st.retinue.length < 3 && camp.grain > 900) {
      e.dispatch({ t: 'camp_work', campId: STARTING_CAMP, job: 'court' });
    } else if (days > 140 && camp.troops < 1400) {
      e.dispatch({ t: 'camp_work', campId: STARTING_CAMP, job: 'levy', levy: 'refugee' });
    }
  }

  // 练：能练就练
  if (!camp.farming && !busyOn(camp, 'train') && camp.training < out.trainCap) {
    e.dispatch({ t: 'camp_work', campId: STARTING_CAMP, job: 'drill' });
  }
}

/** 接令；能打的就出兵打 */
function obey(camp: Camp): void {
  const st = e.getState();
  const o = st.order;
  if (!o || o.outcome !== 'pending') return;
  if (!o.accepted) { e.dispatch({ t: 'order_accept' }); return; }
  if (o.kind === 'tribute') { e.dispatch({ t: 'order_tribute' }); return; }
  if (!o.targetNodeId || camp.troops < 220) return;
  if (camp.farming) { e.dispatch({ t: 'camp_farm', campId: STARTING_CAMP, on: false }); return; }

  const r0 = e.dispatch({ t: 'theatre_open', targetNodeId: o.targetNodeId });
  if (r0.some((x) => x.t === 'rejected')) return;
  const t = e.getState().theatre;
  if (!t) return;
  // 有几个将就分几路：正兵在前，弓弩压阵，骑兵抄侧
  const leaders: (string | null)[] = [null, ...st.retinue];
  const plan: { kind: UnitKind; col: number; row: number; stance: 'assault' | 'hold' }[] = [
    { kind: 'foot', col: t.cols - 12, row: Math.round(t.rows / 2), stance: 'assault' },
    { kind: 'bow', col: t.cols - 16, row: Math.round(t.rows / 2) + 2, stance: 'hold' },
    { kind: 'horse', col: t.cols - 10, row: Math.round(t.rows / 2) - 5, stance: 'assault' },
  ];
  let k = 0;
  for (const p of plan) {
    const men = t.pool[p.kind];
    if (men < 40 || k >= leaders.length) continue;
    e.dispatch({
      t: 'theatre_send', kind: p.kind, men,
      col: p.col, row: p.row, stance: p.stance, officerId: leaders[k] ?? null,
    });
    k += 1;
  }
  e.dispatch({ t: 'theatre_begin' });
  for (let i = 0; i < 400; i++) {
    const t2 = e.getState().theatre;
    if (!t2 || t2.phase !== 'fighting') break;
    e.dispatch({ t: 'theatre_step', ticks: 10 });
  }
  e.dispatch({ t: 'theatre_dismiss' });
}

console.log('  时间           军职   兵    训练  战力   粮    帐下  战功  信任   营中');
console.log('  ' + '─'.repeat(84));

let lastYear = -1;
let fights = 0;
for (let d = 0; d < 360 * 4; d++) {
  const st = e.getState();
  if (st.ending) {
    console.log('  第 ' + st.day + ' 天：' + st.ending.kind);
    break;
  }
  const camp = st.camps[STARTING_CAMP];
  if (!camp) break;

  const before = st.official.merit;
  obey(camp);
  if (e.getState().official.merit > before) fights += 1;
  play(camp);

  const year = Math.floor(st.day / 360);
  if (year !== lastYear || st.day % 180 === 0) {
    lastYear = year;
    const works = Object.entries(camp.works)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => (idx.facility.get(k)?.name ?? k) + v)
      .join('');
    console.log(
      '  ' + formatMonth(st.day).padEnd(14) +
      (MILITARY_RANKS[st.official.rank] ?? '').padEnd(5) +
      String(camp.troops).padStart(5) +
      String(camp.training).padStart(6) +
      String(strengthOf(camp)).padStart(7) +
      String(camp.grain).padStart(6) +
      String(st.retinue.length).padStart(5) +
      String(st.official.merit).padStart(6) +
      String(st.official.trust).padStart(6) +
      '   ' + (works || '（空）'),
    );
  }
  e.dispatch({ t: 'day' });
}
console.log('');
console.log('  四年间打了 ' + fights + ' 仗。');
