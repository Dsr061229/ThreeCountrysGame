/**
 * 天下图上有没有人。
 *
 * 人物库要真的落到城头上才算数：**哪座城谁在守**，
 * 而且守将得是那一家的人 —— 上一版敌将的名字是从一份
 * 没有归属的名单里随手抽的，「攻孔融的城，董卓帐下的华雄
 * 出来单挑」这种事真的会发生。
 *
 * 这个工具只问三句：
 *   一、有多少城派上了守将，多少城还空着？
 *   二、派上的人，出身对不对得上？
 *   三、同一座城打两次，守将是不是同一个人？
 *
 *   node tools/people.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import { unmannedCities, wardenOf } from '../src/sim/people.ts';
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

const e = new Engine('people', content);
e.dispatch({
  t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
});
const st = e.getState();

let manned = 0;
let empty = 0;
let wrong = 0;
const rows: string[] = [];
for (const node of Object.values(st.nodes)) {
  const w = wardenOf(st, idx, node.id);
  const def = idx.node.get(node.id);
  const fac = idx.faction.get(node.factionId);
  if (!w) { empty++; continue; }
  manned++;
  if (w.faction !== node.factionId) wrong++;
  rows.push(
    '  ' + (def?.name ?? node.id).padEnd(6)
    + (fac?.name ?? '').padEnd(5)
    + w.name.padEnd(5) + '　' + w.praise,
  );
}

console.log('');
console.log(`  天下 ${Object.keys(st.nodes).length} 城：${manned} 座有守将，${empty} 座空着。`);
console.log(`  出身对不上的：${wrong} 座` + (wrong ? '  ← 这是事故' : ''));
console.log('');
for (const r of rows.slice(0, 22)) console.log(r);
if (rows.length > 22) console.log(`  …… 另有 ${rows.length - 22} 座`);

// 同一座城打两次，守将该是同一个人
const st2 = e.getState() as never as {
  camps: Record<string, { troops: number; training: number; gear: number; grain: number }>;
  nodes: Record<string, { factionId: string }>;
  official: { lordId: string };
  flags: Record<string, number>;
};
const camp = st2.camps[STARTING_CAMP]!;
camp.troops = 700; camp.training = 70; camp.gear = 2; camp.grain = 6000;
const foe = Object.entries(st2.nodes).find(([, n]) => n.factionId !== st2.official.lordId)!;

const seen: string[] = [];
for (let i = 0; i < 3; i++) {
  delete st2.flags['campaignRest'];
  e.dispatch({ t: 'theatre_open', targetNodeId: foe[0] });
  const t = e.getState().theatre;
  const main = t?.units.find((u) => u.side === 'foe' && u.name.includes('前军'));
  seen.push(main?.leader ?? '（无）');
  e.dispatch({ t: 'theatre_close' });
}
const city = idx.node.get(foe[0])?.name ?? foe[0];
console.log('');
console.log(`  连打三次 ${city}，迎战的主将：${seen.join('、')}`);
console.log(
  seen.every((x) => x === seen[0])
    ? '  守将是常驻的 —— 这一条对了。'
    : '  ← 每次换人，守将没有常驻',
);
console.log('');

// ── 挑谁打，差别有多大 ──────────────────────────────
//
// 敌将从「随手抽的无名之辈」换成真人之后，守方普遍变强了。
// 但**变难本身不是问题，难度不分化才是**：
// 要是每座城都一样难，那「挑一个软柿子先捏」就不成其为决定。
console.log('');
console.log('  同样八百人去打不同的城，看守将是谁差多少。');
console.log('');
console.log('  城      守将      勇   胜率   我军余');
console.log('  ' + '─'.repeat(46));

const targets = Object.entries(st.nodes)
  .filter(([, n]) => n.factionId !== st.official.lordId)
  .slice(0, 40);

interface Row { city: string; who: string; valor: number; win: number; left: number }
const rows2: Row[] = [];

for (const [id] of targets) {
  const w = wardenOf(st, idx, id);
  if (!w) continue;
  let wins = 0;
  let left = 0;
  let ran = 0;
  for (let i = 0; i < 24; i++) {
    const e2 = new Engine('tg' + i, content);
    e2.dispatch({
      t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
    });
    const s2 = e2.getState() as never as {
      camps: Record<string, { troops: number; training: number; gear: number; grain: number }>;
    };
    const c2 = s2.camps[STARTING_CAMP]!;
    c2.troops = 800; c2.training = 70; c2.gear = 3; c2.grain = 6000;
    const opened = e2.dispatch({ t: 'theatre_open', targetNodeId: id });
    if (!opened.some((x) => x.t === 'theatre_opened')) continue;
    const t2 = e2.getState().theatre!;
    const sent = e2.dispatch({
      t: 'theatre_send', kind: 'foot', men: Math.min(600, t2.pool.foot),
      col: Math.round(t2.foeCamp[0] - 6), row: Math.round(t2.foeCamp[1]),
      stance: 'assault', officerId: null,
    });
    if (!sent.some((x) => x.t === 'theatre_sent')) continue;
    e2.dispatch({ t: 'theatre_begin' });
    let g = 0;
    while (t2.phase === 'fighting' && g++ < 950) e2.dispatch({ t: 'theatre_step', ticks: 1 });
    ran++;
    if (t2.outcome === 'won') wins++;
    left += t2.result?.back ?? 0;
  }
  if (ran < 10) continue;
  rows2.push({
    city: idx.node.get(id)?.name ?? id, who: w.name, valor: w.valor,
    win: Math.round((wins / ran) * 100), left: Math.round(left / ran),
  });
  if (rows2.length >= 10) break;
}

rows2.sort((a, b) => b.win - a.win);
for (const r of rows2) {
  console.log(
    '  ' + r.city.padEnd(7) + r.who.padEnd(8) + String(r.valor).padStart(3)
    + String(r.win + '%').padStart(7) + String(r.left).padStart(8),
  );
}
const spread = rows2.length
  ? (rows2[0]!.win - rows2[rows2.length - 1]!.win)
  : 0;
console.log('');
console.log(
  `  最好打的和最难打的差 ${spread} 个百分点 —— `
  + (spread >= 25 ? '挑谁打是个真决定。' : '← 太平了，挑谁打没什么分别'),
);
console.log('');

// ── 打了十年之后，天下还有没有人 ────────────────────
//
// 城易主之后没人接手守将的话，那座城就永远无名了 ——
// 打上十年，满地都是空城。那不是乱世，那是空场子。
{
  const e3 = new Engine('decade', content);
  e3.dispatch({
    t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
  });
  const before = unmannedCities(e3.getState(), idx);
  let fell = 0;
  const keep = e3.getState() as never as {
    camps: Record<string, { grain: number; troops: number }>;
    official: { trust: number };
  };
  for (let d = 0; d < 3600; d++) {
    // 这一段量的是天下，不是玩家能活多久 —— 别让他饿死把推演打断
    const c = keep.camps[STARTING_CAMP];
    if (c) { c.grain = 9000; c.troops = Math.max(200, c.troops); }
    // 也别让他因为一直不接军令被撤职 —— 这一段量的是天下
    keep.official.trust = 60;
    for (const ev of e3.dispatch({ t: 'day' })) {
      if (ev.t === 'city_fell') fell++;
    }
  }
  const s3 = e3.getState();
  const after = unmannedCities(s3, idx);
  const total = Object.keys(s3.nodes).length;
  console.log('');
  console.log(`  推演到第 ${s3.day} 天，城易主 ${fell} 次。`);
  console.log(`  无人守的城：开局 ${before} 座 → 如今 ${after} 座（共 ${total} 座）`);
  console.log(
    after <= total * 0.45
      ? '  城打下来有人接手 —— 这一条对了。'
      : '  ← 空城太多，说明打下来的城没人接手',
  );
  console.log('');
}
