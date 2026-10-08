/**
 * 主公这条线的测试。
 *
 * 守的是几条**都曾经让这局棋整个冻住**的事：
 *
 *   一、**AI 不许替玩家出兵**。少了这一条，当主公的玩家会发现
 *      他什么都不做地盘照样在长 —— 因为 `decideFactions` 一直在替他打。
 *      实测「什么都不做」十年长到三点八城，而「认真经营再出兵」
 *      反倒只有二点八：玩家做的每个决定都在跟一个看不见的自己抢兵。
 *
 *   二、**主公不该被拖进守城战**。那一套只认 `official.cityId` 那一座，
 *      而 `cmdDay` 见了 `state.battle` 就拒绝推进 ——
 *      实测每一局都在第 61 天卡死，日子再也不走。
 *
 *   三、**十二家都开得了局**。`begin` 原先只认 lords.json 里的条目，
 *      而那张表只有曹操；其余诸侯的 `begin` 直接被拒，role 还停在文官，
 *      于是推演里那几家看着像「什么都不做」，其实是压根没上场。
 *
 *   四、**征调要凑得出兵来**。主公一道令只调得动一座城，
 *      而 NPC 是整个辖境征调的 —— 不给他同样的手段，
 *      他永远凑不出优势，十年一城未下、一城未失。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import { idlePeople, KEEP_GARRISON } from '../src/sim/handlers_lord.ts';
import { wardenOf } from '../src/sim/people.ts';
import { planMarch } from '../src/sim/march.ts';

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
  e.dispatch({
    t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId, role: 'lord',
  });
  return e;
}
const held = (e: Engine, f: string): string[] =>
  Object.values(e.getState().nodes).filter((n) => n.factionId === f).map((n) => n.id);

// ─────────────────────────────────────────────────────────────

test('十二家诸侯都当得了主公，不是只有曹操', () => {
  for (const f of ['caocao', 'liubiao', 'taoqian', 'yuanshao', 'kongrong']) {
    const e = asLord('start-' + f, f);
    const st = e.getState();
    assert.equal(st.role, 'lord', `${f} 该开得了主公局`);
    assert.equal(st.official.lordId, f);
    assert.ok(held(e, f).length > 0, `${f} 开局该有地盘`);
    assert.equal(st.nodes[st.official.cityId]?.factionId, f, '治所该是自家的城');
  }
});

test('主公的日子走得下去，不会被守城战卡住', () => {
  const e = asLord('days');
  for (let d = 0; d < 900; d++) {
    if (e.getState().ending) break;
    e.dispatch({ t: 'day' });
  }
  assert.ok(e.getState().day > 800, `日子该一直走，实测停在第 ${e.getState().day} 天`);
  assert.equal(e.getState().battle, null, '主公不该被拖进守城战');
});

/**
 * AI 不替玩家出兵。
 *
 * ── 这条断言改过一次，记下为什么 ──────────────────────
 *
 * 原先断的是「什么都不做就该什么都不长」。那句话在 M4.5 之前是对的：
 * 唯一会替玩家出兵的是 `decideFactions`，把玩家那一家排除掉就完事了。
 *
 * 但朝堂那一版加了**自作主张** —— 请战的呈报你一直不理，
 * 心气跌到底的守将某一天会自己带兵出去（见 `actAlone`）。
 * 于是一个袖手旁观的主公**确实会长地盘**，而那正是设计要的东西：
 * 「主公若不允我，我便自己看着办」。
 *
 * 所以要守的不再是「不长」，是**长出来的每一支兵都得有出处**：
 * 不许是 AI 替他打的，只许是他自己的人不听话。
 */
test('AI 不替玩家出兵 —— 长出来的兵必须有出处', () => {
  const e = asLord('idle');
  const at0 = held(e, 'caocao').length;
  const seen: string[] = [];
  let aiLaunched = 0;
  let defied = 0;
  for (let d = 0; d < 1800; d++) {
    if (e.getState().ending) break;
    for (const ev of e.dispatch({ t: 'day' })) {
      seen.push(ev.t);
      if (ev.t === 'army_launched' && ev.factionId === 'caocao') aiLaunched += 1;
      if (ev.t === 'memorial_defied') defied += 1;
    }
  }
  assert.equal(aiLaunched, 0, '势力 AI 一次也不许替玩家发兵');

  const now = held(e, 'caocao').length;
  if (now > at0) {
    assert.ok(
      defied > 0,
      `地盘长了（${at0} → ${now}）却没有一次自作主张 —— 那这兵是谁发的？`,
    );
  }
});

test('任命：一将不能分身，调去别处就腾出原处', () => {
  const e = asLord('appoint');
  const cities = held(e, 'caocao');
  assert.ok(cities.length >= 2, '曹操开局该有两座城');
  const who = (idx.byFaction.get('caocao') ?? [])[0]!;

  e.dispatch({ t: 'lord_appoint', cityId: cities[0]!, personId: who.id });
  assert.equal(wardenOf(e.getState(), idx, cities[0]!)?.id, who.id);

  e.dispatch({ t: 'lord_appoint', cityId: cities[1]!, personId: who.id });
  assert.equal(wardenOf(e.getState(), idx, cities[1]!)?.id, who.id, '他该到了新任上');
  assert.notEqual(
    wardenOf(e.getState(), idx, cities[0]!)?.id, who.id,
    '一将不能分身 —— 原来那处该腾出来了',
  );
});

test('任命挡得住不该办的事', () => {
  const e = asLord('appoint2');
  const st = e.getState();
  const foe = Object.values(st.nodes).find((n) => n.factionId !== 'caocao')!;
  const ourCity = held(e, 'caocao')[0]!;
  const ours = (idx.byFaction.get('caocao') ?? [])[0]!;
  const theirs = (idx.byFaction.get(foe.factionId) ?? [])[0];

  assert.ok(
    e.dispatch({ t: 'lord_appoint', cityId: foe.id, personId: ours.id })
      .some((x) => x.t === 'rejected' && x.reasonId === 'not_ours'),
    '派人去守别人的城，那不叫任命',
  );
  if (theirs) {
    assert.ok(
      e.dispatch({ t: 'lord_appoint', cityId: ourCity, personId: theirs.id })
        .some((x) => x.t === 'rejected' && x.reasonId === 'not_yours'),
      '别人家的人不听你的',
    );
  }
});

test('调兵：兵在图上真的走，而且不能把城调空', () => {
  const e = asLord('march');
  const st = e.getState();
  const from = held(e, 'caocao')[0]!;
  const links = idx.node.get(from)!.links;
  const to = links.find((id) => st.nodes[id])!;

  /**
   * **远处也去得，只是路上要付账。**
   *
   * 「隔着别人的地界所以过不去」是旧规矩 —— 它既不合地理，
   * 也让天下图上大半座城点开只有一句废话（见 march.ts）。
   * 现在算的是一条真的路：走得通就发得出兵，
   * 走不通只有一个理由 —— **有人不肯借道**，而那句话指得出名字。
   */
  const far = Object.keys(st.nodes).find((id) => id !== from && !links.includes(id))!;
  const plan = planMarch(st, idx, from, far, 'caocao');
  assert.ok(plan, '天下图该是连通的，任意两座城之间总找得出一条路');
  const tryFar = e.dispatch({ t: 'lord_march', fromId: from, toId: far, troops: 100 });
  if (plan!.refused) {
    assert.ok(
      tryFar.some((x) => x.t === 'rejected' && x.reasonId === 'refused'),
      '走不通的唯一理由是有人不肯借道',
    );
  } else {
    const sent = Object.values(e.getState().armies)
      .find((a) => a.factionId === 'caocao' && a.finalId === far);
    assert.ok(sent, '借得到道就该发得出兵');
    assert.ok((sent!.route ?? []).length > 0, '远征是一程一程走的');
  }
  // 这一趟发过（或被拒）之后，把场面收干净再试下面那一趟 ——
  // 出师那道闸是真的（见 marchWait），但这条用例要验的不是它
  const raw = e.getState() as never as {
    armies: Record<string, unknown>; court: { marchedDay: number };
  };
  for (const k of Object.keys(raw.armies)) delete raw.armies[k];
  raw.court.marchedDay = -9999;

  // 寻常的一趟：兵是从这座城出的，而且图上真的多了一支
  const before = e.getState().nodes[from]!.troops;
  const send = Math.min(200, before - KEEP_GARRISON - 20);
  const r = e.dispatch({ t: 'lord_march', fromId: from, toId: to, troops: send });
  assert.ok(r.some((x) => x.t === 'lord_marched'), '这一趟该派得出去');
  assert.equal(e.getState().nodes[from]!.troops, before - send, '兵是从这座城出的');
  assert.equal(
    Object.values(e.getState().armies).filter((a) => a.factionId === 'caocao').length, 1,
    '路上该有一支你的兵',
  );

  /**
   * 开口要整座城的兵。
   *
   * 断的**不是「被拒」**，是那条不变量本身：无论成不成，
   * 事后城里都得留着看家的那些人。
   *
   * （`cmdLordMarch` 现在的做法是削到留够为止 —— 守军和粮哪个先到底就削到哪儿，
   * 而不是整支兵发不出去。一座一千四百人、八百石粮的城点「出兵」什么也不发生，
   * 玩家看到的是按钮坏了。原因见那个函数上面那一段。）
   */
  const all = e.getState().nodes[from]!.troops;
  e.dispatch({ t: 'lord_march', fromId: from, toId: to, troops: all });
  assert.ok(
    e.getState().nodes[from]!.troops >= KEEP_GARRISON,
    `抽空一座城不叫调兵，叫弃守：城里只剩 ${e.getState().nodes[from]!.troops} 人`,
  );
});

test('征调：凑得出兵来，而且后方是真的空了', () => {
  const e = asLord('muster', 'taoqian');
  const cities = held(e, 'taoqian');
  assert.ok(cities.length >= 3, '陶谦开局该有几座城');
  const rally = cities[0]!;
  const rear = cities.slice(1);
  const before = rear.map((id) => e.getState().nodes[id]!.troops);

  const r = e.dispatch({ t: 'lord_muster', cityId: rally });
  assert.ok(r.some((x) => x.t === 'lord_mustered'), '征调该下得成');

  const after = rear.map((id) => e.getState().nodes[id]!.troops);
  assert.ok(
    after.some((t, i) => t < before[i]!),
    '后方的兵该被抽走了 —— 这正是征调的代价',
  );
  assert.ok(
    Object.values(e.getState().armies).filter((a) => a.factionId === 'taoqian').length > 0,
    '几路兵该在往集结地赶',
  );
});

test('粮决定征得动多少人，而不是征不征得成', () => {
  /**
   * 原先是「凑不出随军口粮就整座城跳过」——
   * 于是曹操那种「兵多而粮少」的开局一个人也调不动，
   * 而那本来正是他最该有的处境：人有的是，就是喂不饱。
   */
  const e = asLord('feed');
  const cities = held(e, 'caocao');
  const r = e.dispatch({ t: 'lord_muster', cityId: cities[0]! });
  assert.ok(
    r.some((x) => x.t === 'lord_mustered'),
    '兵多粮少也该调得动一些人，不该整个办不成',
  );
});

test('兴修：花粮把城做厚，但小县做不成大邑', () => {
  const e = asLord('invest');
  const city = held(e, 'caocao')[0]!;
  const st = e.getState() as never as {
    nodes: Record<string, { dev: number; grain: number }>;
  };
  st.nodes[city]!.grain = 90_000;
  const dev0 = st.nodes[city]!.dev;

  for (let i = 0; i < 200; i++) {
    const r = e.dispatch({ t: 'lord_invest', cityId: city });
    if (r.some((x) => x.t === 'rejected')) break;
    st.nodes[city]!.grain = 90_000;
  }
  const dev1 = e.getState().nodes[city]!.dev;
  assert.ok(dev1 > dev0, '砸粮进去该看得见效果');

  const cap = (idx.node.get(city)?.scale ?? 1) * 30;
  assert.ok(dev1 <= cap, `小县再怎么经营也还是小县，上限 ${cap}，实测 ${dev1}`);
  assert.ok(
    e.dispatch({ t: 'lord_invest', cityId: city })
      .some((x) => x.t === 'rejected' && x.reasonId === 'maxed'),
    '到顶了就该说到顶了',
  );
});

test('遣使：花粮把一家的态度拉回来一点', () => {
  const e = asLord('envoy');
  const st = e.getState() as never as {
    nodes: Record<string, { grain: number }>;
    factions: Record<string, { attitude: Record<string, number> }>;
    official: { cityId: string };
  };
  st.nodes[st.official.cityId]!.grain = 5000;
  const foe = Object.values(e.getState().nodes).find((n) => n.factionId !== 'caocao')!;
  st.factions[foe.factionId]!.attitude['caocao'] = -60;

  const r = e.dispatch({ t: 'lord_envoy', factionId: foe.factionId });
  assert.ok(r.some((x) => x.t === 'lord_envoy_done'), '使者该派得出去');
  const now = st.factions[foe.factionId]!.attitude['caocao'] ?? 0;
  assert.ok(now > -60, '关系该缓和一点');
  assert.ok(now < 0, '一趟使节化不开结下的仇 —— 只是缓和一点');
});

test('地盘丢光才算出局 —— 治所换了旗号不算', () => {
  const e = asLord('ending');
  const st = e.getState() as never as {
    nodes: Record<string, { factionId: string }>;
    official: { cityId: string };
  };
  const cities = held(e, 'caocao');
  assert.ok(cities.length >= 2);
  st.nodes[st.official.cityId]!.factionId = 'dongzhuo';
  e.dispatch({ t: 'day' });
  assert.equal(e.getState().ending, null, '还有城就还没完 —— 那正是要打回来的理由');

  for (const id of held(e, 'caocao')) st.nodes[id]!.factionId = 'dongzhuo';
  e.dispatch({ t: 'day' });
  assert.ok(e.getState().ending, '地盘丢光就该出局');
});

test('人是有限的：城多了就管不过来', () => {
  // 「城多了必须任命」是这条线的核心张力。人要真的不够用才成立
  const e = asLord('people');
  const st = e.getState() as never as { nodes: Record<string, { factionId: string }> };
  const all = Object.keys(st.nodes);
  for (let i = 0; i < Math.floor(all.length * 0.5); i++) {
    st.nodes[all[i]!]!.factionId = 'caocao';
  }
  const s2 = e.getState();
  const bare = held(e, 'caocao').filter((id) => !wardenOf(s2, idx, id));
  assert.ok(
    bare.length > idlePeople(s2, idx).length,
    `城该多过人：${bare.length} 座没人守，手上只有 ${idlePeople(s2, idx).length} 个人`,
  );
});
