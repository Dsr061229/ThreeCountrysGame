/**
 * 太仓、考课、远征、请缨。
 *
 * 这一组守的是四条**都曾经让主公这条线说不通**的事：
 *
 *   一、**太仓没有进项。** 治所自己那点日产要供全境的告急、兴修、募兵、
 *      立营、修驿、遣使、养天子 —— 玩家看到的永远是「粮不够」，
 *      而他找不到一个可以去挣粮的动作。
 *      可这件事在文官那条线上早就写好了：你每季给主公缴一笔粮。
 *      那笔粮进的正是这里。**三条线跑同一套逻辑。**
 *
 *   二、**帐下的人一辈子是同一个头衔。** 替你连下三城的人和丢了两座城的人
 *      待遇一模一样，于是「用人」只剩下派去哪座城。
 *
 *   三、**「隔着别人的地界，兵过不去」。** 天下图上大半座城点开都是这句话，
 *      而它既不合地理也不合史实。拦住一支远征军的从来是别的三样东西：
 *      路、借道、损耗。
 *
 *   四、**请援只有一个「允」。** 代码替你在挨着的邻城里挑一路，挑不出来
 *      就一句「邻城派不出援兵」—— 玩家眼看着自己还有两座营四座城。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import { wardenOf } from '../src/sim/people.ts';
import { planMarch } from '../src/sim/march.ts';
import { heartOf, ownPeople, reliefOffers } from '../src/sim/court.ts';
import { assess, tributeDue } from '../src/sim/tribute.ts';
import { wardenPermille } from '../src/sim/worldtick.ts';
import { MERIT_DEMOTE, MERIT_DISMISS, TRIBUTE_EVERY } from '../src/sim/lord_types.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'),
  terrain: read('terrain'), people: read('people'), text: read('text'),
} as ContentDB;
const idx = indexContent(content);

function asLord(seed: string, lordId = 'caocao'): Engine {
  const e = new Engine(seed, content);
  e.dispatch({ t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId, role: 'lord' });
  return e;
}
const held = (e: Engine, f: string): string[] =>
  Object.values(e.getState().nodes).filter((n) => n.factionId === f).map((n) => n.id);

/**
 * 曹操开局只有两座城（雍丘、己吾）。
 *
 * 好几条用例要的是「地盘铺开之后」的样子 —— 上计要看几座城的账，
 * 请缨要看几路人马。所以先把挨着的几座城划到他名下，
 * 再派人去守：**没有守将的城不上计、也出不了兵**，那正是被测的规则本身。
 */
function grow(e: Engine, want: number): string[] {
  const st = e.getState();
  const raw2 = st as never as {
    nodes: Record<string, { factionId: string; takenDay: number; unrest: number }>;
    posts: Record<string, string>;
  };
  const mine = new Set(held(e, 'caocao'));
  const queue = [...mine];
  while (mine.size < want && queue.length > 0) {
    const at = queue.shift()!;
    for (const to of (idx.node.get(at)?.links ?? []).slice().sort()) {
      if (mine.size >= want) break;
      if (mine.has(to) || !raw2.nodes[to]) continue;
      raw2.nodes[to]!.factionId = 'caocao';
      raw2.nodes[to]!.takenDay = -1;
      raw2.nodes[to]!.unrest = 0;
      // 旧守将随着旧旗号一起走了 —— 不清掉，这座城就永远认不出新守将
      delete raw2.posts[to];
      mine.add(to);
      queue.push(to);
    }
  }
  // 每座城派一个人守着
  const posted = new Set(Object.values(raw2.posts));
  const free = (idx.byFaction.get('caocao') ?? []).filter((p) => !posted.has(p.id));
  for (const id of [...mine].sort()) {
    if (raw2.posts[id]) continue;
    const who = free.shift();
    if (who) raw2.posts[id] = who.id;
  }
  return [...mine].sort();
}

/** 测试要往状态里塞东西。模拟层不认这个洞，只有测试认 */
type Raw = {
  nodes: Record<string, { grain: number; troops: number }>;
  posts: Record<string, string>;
  sieges: Record<string, unknown>;
  armies: Record<string, unknown>;
  court: {
    heart: Record<string, number>;
    rank: Record<string, number>;
    merit: Record<string, number>;
    memorials: unknown[];
  };
};
const raw = (e: Engine): Raw => e.getState() as never as Raw;

// ─────────────────────────────────────────────────────────────
// 上计
// ─────────────────────────────────────────────────────────────

test('上计：各郡把余粮解到治所，而无人主事的城一粒也上不来', () => {
  const e = asLord('tribute');
  const seatId = e.getState().official.cityId;
  grow(e, 4);
  const r = raw(e);
  const mine = held(e, 'caocao').filter((id) => id !== seatId);
  assert.ok(mine.length >= 2, '划过地之后该有好几座城');

  for (const id of mine) r.nodes[id]!.grain = 4000;
  // 一座空着不派人，看它上不上得来
  const manned = mine.filter((id) => wardenOf(e.getState(), idx, id));
  assert.ok(manned.length >= 2, '划过地之后该有两座以上有人守的城');
  const bare = manned[0]!;
  delete r.posts[bare];

  const lines = tributeDue(e.getState(), idx);
  assert.equal(
    lines.find((l) => l.cityId === bare)?.grain, 0,
    '无人主事的城，赋税一粒也收不上来 ——「派人」这件事第一次有了账面上的分量',
  );
  assert.ok(
    (lines.find((l) => l.cityId === manned[1]!)?.grain ?? 0) > 0,
    '有人守的城该解得上来',
  );

  const before = r.nodes[seatId]!.grain;
  for (let i = 0; i < TRIBUTE_EVERY + 2; i++) {
    if (e.getState().ending) break;
    e.dispatch({ t: 'day' });
  }
  assert.ok(
    e.getState().nodes[seatId]!.grain > before,
    `太仓该因为上计而涨：${before} → ${e.getState().nodes[seatId]!.grain}`,
  );
  assert.ok((e.getState().court!.tally['tribute'] ?? 0) > 0, '上计该真的跑过');
});

test('心气跌到底的太守，账照做，解上来的一年比一年少', () => {
  const e = asLord('tribute-heart');
  const seatId = e.getState().official.cityId;
  grow(e, 3);
  const city = held(e, 'caocao')
    .find((id) => id !== seatId && wardenOf(e.getState(), idx, id))!;
  const who = wardenOf(e.getState(), idx, city);
  assert.ok(who, '总该有一座有人守的城');

  const r = raw(e);
  r.nodes[city]!.grain = 5000;
  r.nodes[city]!.troops = 600;
  r.court.heart[who!.id] = 90;
  const warm = tributeDue(e.getState(), idx).find((l) => l.cityId === city)!.grain;
  r.court.heart[who!.id] = 22;
  const cold = tributeDue(e.getState(), idx).find((l) => l.cityId === city)!.grain;

  assert.ok(warm > 0, '心气高的人该解得上来');
  assert.ok(cold < warm, `你怎么待人，季末就摆在案头：热 ${warm} 石，冷 ${cold} 石`);
});

// ─────────────────────────────────────────────────────────────
// 远征
// ─────────────────────────────────────────────────────────────

test('远征：路上真的折人，而且借过道的那一家记着你', () => {
  const e = asLord('expedition');
  const st = e.getState();
  const from = held(e, 'caocao')[0]!;

  let target: string | null = null;
  for (const id of Object.keys(st.nodes).sort()) {
    const p = planMarch(st, idx, from, id, 'caocao');
    if (p && !p.refused && p.borrow.length > 0 && p.path.length >= 3) { target = id; break; }
  }
  assert.ok(target, '天下这么大，总该有一条要借道才走得通的路');

  const plan = planMarch(st, idx, from, target!, 'caocao')!;
  assert.ok(plan.wastePermille > 0, '走了远路就该折人');
  assert.ok(plan.days > 6, '远路该比一程路久');

  const lender = plan.borrow[0]!;
  const attBefore = st.factions[lender]!.attitude['caocao'] ?? 0;
  const r = raw(e);
  r.nodes[from]!.troops = 3000;
  r.nodes[from]!.grain = 9000;

  const evs = e.dispatch({ t: 'lord_march', fromId: from, toId: target!, troops: 900 });
  assert.ok(evs.some((x) => x.t === 'lord_marched'), '借得到道就该发得出兵');

  const army = Object.values(e.getState().armies).find((a) => a.finalId === target);
  assert.ok(army, '图上该真的多了一支远征军');
  assert.ok((army!.route ?? []).length > 0, '远征是一程一程走的');
  assert.ok((army!.waste ?? 0) > 0, '每落一次脚要散一批人');
  assert.ok(
    (e.getState().factions[lender]!.attitude['caocao'] ?? 0) < attBefore,
    '过境是要打招呼的，而打过招呼那一家就记着你',
  );
});

test('走远路的兵，到地方比出发时少', () => {
  const e = asLord('waste');
  const st = e.getState();
  const from = held(e, 'caocao')[0]!;
  let target: string | null = null;
  for (const id of Object.keys(st.nodes).sort()) {
    const p = planMarch(st, idx, from, id, 'caocao');
    if (p && !p.refused && p.path.length >= 4) { target = id; break; }
  }
  assert.ok(target, '总该找得出一条要走三程以上的路');

  const r = raw(e);
  r.nodes[from]!.troops = 4000;
  r.nodes[from]!.grain = 14000;
  e.dispatch({ t: 'lord_march', fromId: from, toId: target!, troops: 1200 });
  const army = Object.values(e.getState().armies).find((a) => a.finalId === target)!;
  const set = army.troops;

  for (let i = 0; i < 200; i++) {
    const cur = e.getState().armies[army.id];
    if (!cur || cur.fromId !== from) break;
    e.dispatch({ t: 'day' });
  }
  const mid = e.getState().armies[army.id];
  // 半路上被人堵住、或者已经走完全程，都不算这条用例失败
  if (!mid) return;
  assert.ok(
    mid.troops < set,
    `千里而袭人者必蹶上将军：出发 ${set}，走完一程剩 ${mid.troops}`,
  );
});

test('正在跟你打的那一家，不会借道给你', () => {
  const e = asLord('noborrow');
  const st = e.getState();
  const from = held(e, 'caocao')[0]!;
  // 把所有别家对你的态度压到底 —— 谁也不肯借
  const rf = e.getState() as never as {
    factions: Record<string, { attitude: Record<string, number> }>;
  };
  for (const f of Object.keys(rf.factions)) {
    if (f === 'caocao') continue;
    rf.factions[f]!.attitude['caocao'] = -90;
  }
  let far: string | null = null;
  for (const id of Object.keys(st.nodes).sort()) {
    const p = planMarch(e.getState(), idx, from, id, 'caocao');
    if (p && p.refused) { far = id; break; }
  }
  assert.ok(far, '天下人都恨你的时候，总该有走不通的地方');
  assert.ok(
    e.dispatch({ t: 'lord_march', fromId: from, toId: far!, troops: 100 })
      .some((x) => x.t === 'rejected' && x.reasonId === 'refused'),
    '走不通的唯一理由是有人不肯借道 —— 而那句话指得出名字',
  );
});

// ─────────────────────────────────────────────────────────────
// 请缨
// ─────────────────────────────────────────────────────────────

test('请援：几路都报得上名，准哪一路、准几路，是你挑的', () => {
  const e = asLord('rally');
  const st = e.getState();
  const seatId = st.official.cityId;
  grow(e, 5);
  const city = held(e, 'caocao')
    .find((id) => id !== seatId && wardenOf(e.getState(), idx, id))!;
  const r = raw(e);
  for (const id of held(e, 'caocao')) {
    r.nodes[id]!.troops = 1400;
    r.nodes[id]!.grain = 6000;
  }
  r.sieges[city] = {
    cityId: city, factionId: 'yuanshao', troops: 900, supply: 9000, days: 3,
  };

  const offers = reliefOffers(e.getState(), idx, city);
  assert.ok(offers.length >= 2, `一座被围的城该有好几处请缨，实测 ${offers.length} 路`);
  for (const o of offers) {
    assert.ok(o.troops >= 120, '报上来的每一路都该真的抽得出兵');
    assert.ok(o.days >= 1, '每一路都该说得出要走几天');
  }

  r.court.memorials.push({
    id: 'mem-test-relief', kind: 'relief', personId: wardenOf(e.getState(), idx, city)!.id,
    fromId: city, aboutId: city, amount: 900, atDay: st.day, arriveDay: st.day,
    dueDay: st.day + 40, textId: 'mem.relief.plain', vars: {},
  });
  const pick = offers.find((o) => !o.refused)!;
  const before = Object.keys(e.getState().armies).length;
  e.dispatch({ t: 'court_relief', memorialId: 'mem-test-relief', sourceKey: pick.key });
  assert.equal(
    Object.keys(e.getState().armies).length, before + 1,
    '准了一路，图上就该真的多一支援军',
  );

  const still = e.getState().court!.memorials.find((m) => m.id === 'mem-test-relief');
  assert.equal(still?.sent, 1, '发过之后这一件还留在堂上 —— 你可以再准一路');

  const second = reliefOffers(e.getState(), idx, city)
    .find((o) => !o.refused && o.key !== pick.key);
  if (second) {
    e.dispatch({ t: 'court_relief', memorialId: 'mem-test-relief', sourceKey: second.key });
    assert.equal(
      Object.keys(e.getState().armies).length, before + 2,
      '「选一路或多路」这句话必须是真的',
    );
  }
});

// ─────────────────────────────────────────────────────────────
// 考课
// ─────────────────────────────────────────────────────────────

test('升迁不只是一个头衔：品秩真的顶事，而办砸了自己会掉下去', () => {
  const e = asLord('rank');
  const st = e.getState();
  const city = held(e, 'caocao').find((id) => id !== st.official.cityId)!;
  const who = wardenOf(st, idx, city)!;
  const r = raw(e);

  const bare = wardenPermille(e.getState(), idx, city);
  r.court.rank[who.id] = 3;
  const high = wardenPermille(e.getState(), idx, city);
  assert.ok(
    high > bare,
    `一位太守调得动的人力物力，不是一个县丞比得了的：${bare} → ${high}`,
  );

  // 贬不用主公点头 —— 那是考课，不是恩典
  r.court.merit[who.id] = MERIT_DEMOTE - 10;
  assess(e.getState(), idx);
  assert.equal(e.getState().court!.rank[who.id], 2, '一年年办砸下去，位子自己就没了');

  // 最低一秩还往下折就是免官，那座城就空了出来
  r.court.rank[who.id] = 0;
  r.court.merit[who.id] = MERIT_DISMISS - 10;
  assess(e.getState(), idx);
  assert.ok(!wardenOf(e.getState(), idx, city), '免官之后那座城无人主事');
});

test('叙功：准了他就升，而且那一下是主公自己拍的板', () => {
  const e = asLord('merit-memo');
  const st = e.getState();
  const city = held(e, 'caocao').find((id) => id !== st.official.cityId)!;
  const who = wardenOf(st, idx, city)!;
  const sponsor = ownPeople(st, idx).find((p) => p.id !== who.id)!;
  const r = raw(e);

  r.court.memorials.push({
    id: 'mem-test-merit', kind: 'merit', personId: sponsor.id,
    fromId: st.official.cityId, aboutId: who.id, amount: 0,
    atDay: st.day, arriveDay: st.day, dueDay: st.day + 40,
    textId: 'mem.merit.plain', vars: {},
  });
  const heartBefore = heartOf(e.getState(), who.id);
  e.dispatch({ t: 'court_reply', memorialId: 'mem-test-merit', answer: 'allow' });

  assert.equal(e.getState().court!.rank[who.id], 1, '准了叙功，他就该升一秩');
  assert.ok(
    heartOf(e.getState(), who.id) > heartBefore,
    '名位是主公手上最便宜、也最有分量的赏赐',
  );
});

// ─────────────────────────────────────────────────────────────
// 请粮
// ─────────────────────────────────────────────────────────────

test('请粮不上案头了，但粮车照发', () => {
  const e = asLord('nograinmemo');
  const seatId = e.getState().official.cityId;
  const r = raw(e);
  r.nodes[seatId]!.grain = 12000;
  for (const id of held(e, 'caocao')) {
    if (id !== seatId) r.nodes[id]!.grain = 40;
  }

  let sawMemorial = false;
  let sawConvoy = false;
  for (let i = 0; i < 400; i++) {
    if (e.getState().ending) break;
    const evs = e.dispatch({ t: 'day' });
    if (evs.some((x) => x.t === 'convoy_auto')) sawConvoy = true;
    if (e.getState().court!.memorials.some((m) => m.kind === 'grain')) sawMemorial = true;
  }
  assert.equal(sawMemorial, false, '请粮不该再摞上案头 —— 它从头到尾没有一个决定');
  assert.ok(sawConvoy, '够就发 —— 郡府该自己把粮车发出去');
});

// ─────────────────────────────────────────────────────────────
// 军营
// ─────────────────────────────────────────────────────────────

test('营将自己募部曲，而且募的是新人，不是把城头的兵拉下来', () => {
  const e = asLord('campgrow');
  const st = e.getState();
  const city = held(e, 'caocao').find((id) => id !== st.official.cityId)!;
  const r = raw(e);
  r.nodes[city]!.grain = 20000;
  r.nodes[city]!.troops = 900;

  const officer = ownPeople(e.getState(), idx)
    .find((p) => !Object.values(e.getState().posts).includes(p.id) && p.valor >= 70);
  assert.ok(officer, '曹操帐下总该有个带得了兵的闲人');
  e.dispatch({ t: 'lord_camp_open', cityId: city, personId: officer!.id });
  const camp = Object.values(e.getState().court!.camps).find((c) => c.cityId === city)!;

  const troopsBefore = e.getState().nodes[city]!.troops;
  for (let i = 0; i < 60; i++) {
    if (e.getState().ending) break;
    e.dispatch({ t: 'day' });
  }
  const now = e.getState().court!.camps[camp.id];
  assert.ok(now, '营该还在');
  assert.ok(now!.troops > 0, '营将该自己把营带起来 —— 不必主公一勺一勺喂');
  assert.ok(
    e.getState().nodes[city]!.troops >= troopsBefore - 60,
    '他募的是乡里的丁壮，不是去把城墙上站岗的人喊下来',
  );
});
