/**
 * 单挑值不值得赌。
 *
 * 这颗按钮只有在两条都成立的时候才是个**决定**：
 *
 *   一、勇力要算数 —— 潘凤对上华雄该输，不然挑谁出马都一样；
 *   二、但不能是算术题 —— 勇高的必胜，那就没什么可赌的了，
 *      看一眼数字就知道答案。
 *
 * 还要看代价压不压得住：出马赢了三军振奋，输了可能就此少一员将。
 * 要是十次有九次不分胜负，那这件事等于没发生。
 *
 *   node tools/duel.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import type { ContentDB } from '../src/sim/content.ts';
import { STARTING_CAMP } from '../src/sim/general_types.ts';
import type { Theatre } from '../src/sim/theatre_types.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'),
  terrain: read('terrain'), people: read('people'), text: read('text'),
} as ContentDB;

function relief(seed: string): { e: Engine; t: Theatre } {
  const e = new Engine(seed, content);
  e.dispatch({
    t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
  });
  const st = e.getState() as never as {
    camps: Record<string, { troops: number; training: number; gear: number; grain: number }>;
    sieges: Record<string, unknown>;
    official: { cityId: string };
    retinue: string[];
  };
  const camp = st.camps[STARTING_CAMP]!;
  camp.troops = 700; camp.training = 70; camp.gear = 3; camp.grain = 6000;
  st.retinue = ['dianwei', 'yuejin', 'lidian', 'caoren'];
  const at = st.official.cityId;
  st.sieges[at] = { cityId: at, factionId: 'taiping', troops: 600, supply: 9000, days: 3 };
  e.dispatch({ t: 'theatre_open', targetNodeId: at });
  return { e, t: e.getState().theatre! };
}

// ── 一、勇力差多少，赢面差多少 ──────────────────────
//
// 这一段**不骑真实的战场**：搭好台子之后直接把单挑塞进去，
// 然后只走单挑那几拍。
// 骑着真战场量出来的数是不能用的 —— 仗会先结束、部队会先溃，
// 长的单挑被系统性地砍掉，量到的是「斗得完的那些」，不是这条规则本身。
console.log('');
console.log('  只看单挑这条规则：两人各多少勇，斗下来是什么结果。');
console.log('');
console.log('  我方勇  敌方勇     赢     输   不分胜负    平均合数');
console.log('  ' + '─'.repeat(58));

const PAIRS: [number, number][] = [
  [50, 50], [70, 50], [50, 70], [95, 50], [50, 95], [88, 84],
];
for (const [mine, foe] of PAIRS) {
  let won = 0;
  let lost = 0;
  let draw = 0;
  let rounds = 0;
  let n = 0;
  for (let i = 0; i < 500; i++) {
    const { e, t } = relief('d' + i);
    const sent = e.dispatch({
      t: 'theatre_send', kind: 'foot', men: 300,
      col: Math.round((t.ownCamp[0] + t.foeCamp[0]) / 2),
      row: Math.round(t.ownCamp[1]), stance: 'assault', officerId: 'dianwei',
    });
    if (!sent.some((x) => x.t === 'theatre_sent')) continue;
    e.dispatch({ t: 'theatre_begin' });
    // 直接摆一场单挑上去
    const own = t.units.find((u) => u.side === 'own');
    const bad = t.units.find((u) => u.side === 'foe');
    if (!own || !bad) continue;
    t.duel = {
      ownUnitId: own.id, foeUnitId: bad.id,
      ownName: '甲', foeName: '乙',
      ownValor: mine, foeValor: foe,
      ownOfficerId: 'dianwei',
      offeredAt: t.tick, round: 0, ownWins: 0, foeWins: 0,
      state: 'offered', outcome: null, fatal: false,
    };
    e.dispatch({ t: 'theatre_duel_accept' });
    let g = 0;
    let done = false;
    while (!done && g++ < 200) {
      for (const ev of e.dispatch({ t: 'theatre_step', ticks: 1 })) {
        if (ev.t !== 'duel_settled') continue;
        n++;
        rounds += ev.rounds;
        if (ev.outcome === 'won') won++;
        else if (ev.outcome === 'lost') lost++;
        else draw++;
        done = true;
      }
      if (t.phase !== 'fighting') break;
    }
  }
  const pc = (x: number): string => String(Math.round((x / Math.max(1, n)) * 100) + '%');
  console.log(
    '  ' + String(mine).padEnd(8) + String(foe).padEnd(9)
    + pc(won).padStart(5) + pc(lost).padStart(7) + pc(draw).padStart(9)
    + (rounds / Math.max(1, n)).toFixed(1).padStart(12)
    + ('  （斗完 ' + n + '/500）'),
  );
}

// ── 二、多久才碰上一次 ──────────────────────────────
let had = 0;
let fatal = 0;
let battles = 0;
for (let i = 0; i < 120; i++) {
  const { e, t } = relief('f' + i);
  e.dispatch({
    t: 'theatre_send', kind: 'foot', men: 300,
    col: Math.round((t.ownCamp[0] + t.foeCamp[0]) / 2),
    row: Math.round(t.ownCamp[1]), stance: 'assault', officerId: 'dianwei',
  });
  e.dispatch({ t: 'theatre_begin' });
  battles++;
  let g = 0;
  let sawOffer = false;
  while (t.phase === 'fighting' && g++ < 950) {
    for (const ev of e.dispatch({ t: 'theatre_step', ticks: 1 })) {
      if (ev.t === 'duel_settled' && ev.fatal) fatal++;
    }
    if (t.duel?.state === 'offered') {
      sawOffer = true;
      e.dispatch({ t: 'theatre_duel_accept' });
    }
  }
  if (sawOffer) had++;
}
console.log(
  `\n  一百二十场仗里，有人出阵搦战的：${had} 场（${Math.round((had / battles) * 100)}%），`
  + `其中斗到死人的 ${fatal} 场\n`,
);
