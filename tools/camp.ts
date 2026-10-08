/**
 * 武将路线的粮草推演。
 *
 * 这条线的全部张力在一件事上：**养得起多少兵**。
 * 所以调数值之前先把这条曲线打出来 —— 兵涨到哪儿会断粮、
 * 主公一季能批多少、光靠请粮能不能撑住一支像样的军队。
 *
 *   node tools/camp.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import { seedRng } from '../src/sim/rng.ts';
import {
  busyOn, campOutput, daysOfGrain, forageYield, grantOf, lordGrainPool,
  rationCapOf, strengthOf, tickCamp, upkeepOf,
} from '../src/sim/camp.ts';
import {
  DRILL_DAYS, FORAGE_MORALE_HIT, FORAGE_TAKE_PERMILLE, GEAR_DAYS, GEAR_GRAIN, LEVIES,
  STARTING_CAMP, type Camp, type Levy,
} from '../src/sim/general_types.ts';
import { formatMonth, quarterOf } from '../src/sim/time.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'), terrain: read('terrain'), people: read('people'), text: read('text'),
} as ContentDB;
const idx = indexContent(content);

/**
 * 一个「稳着来」的武将会怎么决定。
 *
 * 核心的一条：**粮不够就去种地，粮够了就回来练兵**。
 * 这正是这条线想让玩家反复做的那个取舍，所以推演里也照这个来。
 */
function decide(camp: Camp): { job: 'levy' | 'drill' | 'gear'; levy: Levy | null } | null {
  if (busyOn(camp, 'train') || busyOn(camp, 'craft')) return null;
  const days = daysOfGrain(camp);

  // 仓里不到半年的口粮就下地。够了就收屯回校场
  const shouldFarm = camp.grain < upkeepOf(camp) * 180;
  if (shouldFarm !== camp.farming) {
    camp.farming = shouldFarm;
    return null;
  }
  if (camp.farming) return null;

  if (days < 60) return null;
  if (camp.training < 60) return { job: 'drill', levy: null };
  if (camp.gear < 3 && camp.grain > GEAR_GRAIN + 800) return { job: 'gear', levy: null };
  if (days > 110) return { job: 'levy', levy: 'refugee' };
  return null;
}

/** 打起来了就把它打完，否则 day 会被一直拒绝 */
function settleBattles(e: Engine): void {
  let guard = 0;
  while (guard++ < 300) {
    const s = e.getState();
    if (s.battle) {
      const b = s.battle;
      if (b.phase === 'done') { e.dispatch({ t: 'battle_dismiss' }); continue; }
      if (b.phase === 'deploy') {
        const m = b.defMen, w = Math.floor(m / 3);
        e.dispatch({ t: 'deploy', wall: w, gate: w, reserve: m - w - w });
        continue;
      }
      if (b.pending) e.dispatch({ t: 'decide', option: 0 });
      else e.dispatch({ t: 'battle_round' });
      continue;
    }
    if (s.field) {
      const f = s.field;
      if (f.phase === 'done') { e.dispatch({ t: 'field_dismiss' }); continue; }
      if (f.phase === 'deploy') {
        e.dispatch({ t: 'field_deploy', places: [], formation: 'heyi' });
        e.dispatch({ t: 'field_begin' });
        continue;
      }
      if (f.pending) e.dispatch({ t: 'field_decide', option: 0 });
      else e.dispatch({ t: 'field_round' });
      continue;
    }
    return;
  }
}

const e = new Engine('camp-sim', content);
e.dispatch({
  t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
});

const camp = e.getState().camps[STARTING_CAMP]!;
const rng = seedRng('camp-rng');
let lastQuarter = -1;
let starvedDays = 0;
let forages = 0;
let lastForage = -99;

console.log('  时间           兵    训练  军心  器械   存粮   够吃    战力   请粮 → 批下');
console.log('  ' + '─'.repeat(82));

for (let d = 0; d < 360 * 4; d++) {
  const st = e.getState();
  if (st.ending) {
    console.log('');
    console.log('  ✗ 第 ' + st.day + ' 天出局：' + st.ending.kind);
    break;
  }

  const q = quarterOf(st.day);
  const newQuarter = q !== lastQuarter;
  if (newQuarter) {
    lastQuarter = q;
    // 顶格要。要得到要不到是主公的事，少要一点他也不会多给
    const askedNow = rationCapOf(st.official.rank);
    const pool = lordGrainPool(st, 'caocao');
    const gotNow = grantOf(askedNow, pool, st.official.trust, st.official.rank, rng);
    camp.grain += gotNow;

    console.log(
      '  ' + formatMonth(st.day).padEnd(14) +
      String(camp.troops).padStart(4) +
      String(camp.training).padStart(7) +
      String(camp.morale).padStart(6) +
      String(camp.gear).padStart(6) +
      String(camp.grain).padStart(7) +
      (camp.farming ? '  屯田中' : String(daysOfGrain(camp)).padStart(6) + ' 天') +
      String(strengthOf(camp)).padStart(8) +
      '   ' + String(askedNow).padStart(4) + ' → ' + String(gotNow).padStart(4) +
      (askedNow > 0 && gotNow < askedNow
        ? '  只批了 ' + Math.round((gotNow / askedNow) * 100) + '%'
        : ''),
    );
  }

  // 粮不够一个月就就地征粮 —— 这是被逼出来的，不是想做的。
  // 刮的是驻地那座城的存粮，同时把它的民心刮下去一截。
  // 一个月最多刮一次：城也要喘口气，天天刮等于把驻地毁了
  if (daysOfGrain(camp) < 30 && st.day - lastForage >= 30) {
    const node = st.nodes[camp.nodeId];
    if (node && node.grain > 80) {
      const take = forageYield(node.grain, FORAGE_TAKE_PERMILLE);
      node.grain -= take;
      node.morale = Math.max(0, node.morale - FORAGE_MORALE_HIT);
      camp.grain += take;
      forages++;
      lastForage = st.day;
    }
  }

  const plan = decide(camp);
  if (plan) {
    if (plan.job === 'levy' && plan.levy) {
      const def = LEVIES[plan.levy];
      camp.grain -= Math.ceil((def.men * def.grainPer100) / 100);
      camp.jobs.push({
        job: 'levy', levy: plan.levy, facilityId: null, toLevel: 0,
        daysLeft: def.days, days: def.days,
      });
    } else if (plan.job === 'drill') {
      camp.jobs.push({
        job: 'drill', levy: null, facilityId: null, toLevel: 0,
        daysLeft: DRILL_DAYS, days: DRILL_DAYS,
      });
    } else {
      camp.grain -= GEAR_GRAIN;
      camp.jobs.push({
        job: 'gear', levy: null, facilityId: null, toLevel: 0,
        daysLeft: GEAR_DAYS, days: GEAR_DAYS,
      });
    }
  }

  const evs = tickCamp(camp, rng, st.day, campOutput(camp, idx));
  if (evs.some((x) => x.t === 'camp_starving')) starvedDays++;
  if (evs.some((x) => x.t === 'camp_broke')) {
    console.log('');
    console.log('  ✗ 第 ' + st.day + ' 天，营散了。');
    break;
  }

  settleBattles(e);
  e.dispatch({ t: 'day' });
}

console.log('');
console.log('  断粮 ' + starvedDays + ' 天，就地征粮 ' + forages + ' 次');
console.log('  主公此刻能匀给这一路的：' + lordGrainPool(e.getState(), 'caocao'));
