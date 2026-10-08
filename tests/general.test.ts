/**
 * 武将这条线的测试。
 *
 * 守的是三条，每一条都对应过一次真事故：
 *
 *   一、**别人的营垮了，不算你出局**。
 *      图上还扎着主公其他武将的营，它们不屯田也不请粮，
 *      坐吃山空两三个月就饿垮 —— 上一版这会判定成「你的兵散了」。
 *      玩家看到的是「粮总是不够，一会儿就兵营散了」，
 *      而他自己仓里还有一百石、一天都没断过粮。
 *
 *   二、**武将升得了官**。升迁的代码原先只写在文官的季度结算里，
 *      武将没有季度结算，所以无论立多少战功，军职永远是裨将，
 *      份例永远六百石。「升迁是你军队规模的上限」这条链，从头到尾是断的。
 *
 *   三、**粮饷不必你开口**。上一版要每季点一次「请粮」，
 *      忘了点就活活饿死 —— 那不是难度，是罚你没读说明书。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import { MILITARY_RANKS, STARTING_CAMP } from '../src/sim/general_types.ts';
import { rationCapOf } from '../src/sim/camp.ts';
import { whyNotMarch } from '../src/sim/handlers_theatre.ts';
import { unmannedCities, wardenOf } from '../src/sim/people.ts';
import { vacantPosts } from '../src/sim/handlers_general.ts';
import { angerFrom, atWar } from '../src/sim/diplomacy.ts';
import { wardenPermille } from '../src/sim/worldtick.ts';

function loadContent(): ContentDB {
  const read = (n: string): unknown =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
  return {
    buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
    map: read('map'), factions: read('factions'), battle: read('battle'),
    field: read('field'), facilities: read('facilities'),
    terrain: read('terrain'), people: read('people'), text: read('text'),
  } as ContentDB;
}

const content = loadContent();
const idx = indexContent(content);

function newGeneral(seed = 'g'): Engine {
  const e = new Engine(seed, content);
  e.dispatch({
    t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
  });
  return e;
}

// ─────────────────────────────────────────────────────────────

test('别人的营垮了，不算你出局', () => {
  const e = newGeneral('ally');
  const st = e.getState() as never as {
    camps: Record<string, { troops: number; morale: number; grain: number }>;
  };
  // 把一座友军的营弄垮：兵没了、士气见底
  const allyId = Object.keys(st.camps).find((k) => k !== STARTING_CAMP);
  assert.ok(allyId, '天下图上该有主公其他武将的营');
  st.camps[allyId]!.troops = 0;
  st.camps[allyId]!.morale = 0;

  for (let d = 0; d < 120; d++) e.dispatch({ t: 'day' });

  const after = e.getState();
  assert.equal(
    after.ending, null,
    '友军的营垮了不该判你出局 —— 你自己的营还好端端的',
  );
  assert.ok(after.camps[STARTING_CAMP]!.troops > 0, '你的兵一个没少');
});

test('粮饷按季自己来，不必你开口', () => {
  // 上一版要每季点一次「请粮」，忘了点就活活饿死。
  // 现实里辎重是按份例定期发的 —— 有趣的地方在于够不够，
  // 不在于你有没有递那张条子
  const e = newGeneral('ration');
  const before = e.getState().camps[STARTING_CAMP]!.grain;
  let got = 0;
  for (let d = 0; d < 200; d++) {
    const evs = e.dispatch({ t: 'day' });
    for (const ev of evs) {
      if (ev.t === 'ration_replied') got += ev.granted;
    }
  }
  assert.ok(got > 0, '两个季度过去，主公该拨过粮了');
  void before;
});

test('什么都不做的武将会饿垮，但要撑得过头一年', () => {
  // 一个只是坐着的武将最后是该垮的 —— 但不能两三个月就垮，
  // 那样玩家还没摸清怎么玩就出局了
  const e = newGeneral('idle');
  let broke = -1;
  for (let d = 0; d < 720; d++) {
    if (e.getState().ending) { broke = e.getState().day; break; }
    e.dispatch({ t: 'day' });
  }
  assert.ok(
    broke < 0 || broke > 300,
    `坐吃山空也该撑过头一年，实测第 ${broke} 天就出局了`,
  );
});

test('武将升得了官，而且升上去真的多领粮', () => {
  // 升迁原先只写在文官的季度结算里 —— 武将永远是裨将
  const e = newGeneral('rank');
  const st = e.getState() as never as { official: { merit: number; rank: number } };
  assert.equal(st.official.rank, 0, '开局是裨将');
  const capAtStart = rationCapOf(0);

  // 攒够战功
  st.official.merit = 5000;
  for (let d = 0; d < 400; d++) {
    e.dispatch({ t: 'day' });
    if (e.getState().official.rank >= MILITARY_RANKS.length - 1) break;
  }

  const after = e.getState().official;
  assert.ok(after.rank > 0, `战功够了就该升，实测还是 ${MILITARY_RANKS[after.rank]}`);
  assert.ok(
    rationCapOf(after.rank) > capAtStart,
    '升了官，一季的份例要跟着涨 —— 这是升迁在玩法上的全部意义',
  );
});

test('主公会下军令，而且军令指的是真有其事的地方', () => {
  // 随口指一座城的命令，玩家一眼就看出是任务栏。
  // 他让你打的，得是真的挨着你的敌城
  const e = newGeneral('order');
  let order = null as null | { kind: string; targetNodeId: string | null };
  for (let d = 0; d < 300; d++) {
    e.dispatch({ t: 'day' });
    const o = e.getState().order;
    if (o && o.outcome === 'pending') { order = o; break; }
  }
  assert.ok(order, '半年之内该来一道军令');

  if (order!.targetNodeId) {
    const st = e.getState();
    const node = st.nodes[order!.targetNodeId];
    assert.ok(node, '军令指的地方得真的存在');
    if (order!.kind === 'assault') {
      assert.notEqual(node!.factionId, st.official.lordId, '让你打的该是敌城');
      const here = idx.node.get(st.camps[STARTING_CAMP]!.nodeId)!;
      const there = idx.node.get(order!.targetNodeId)!;
      const d = Math.hypot(there.at[0] - here.at[0], there.at[1] - here.at[1]);
      assert.ok(d < 40, `让你打的城该在够得着的地方，实测隔了 ${Math.round(d)}`);
    }
  }
});

test('抗命比办砸了更伤主公的心', () => {
  /**
   * 办砸了是能力问题，抗命是态度问题 —— 主公介意的从来是后者。
   *
   * **两次要跑同一个世界。** 原先写的是 `'defy' + String(defy)`，
   * 于是抗命那一次和接令那一次落在两个不同的种子上 ——
   * 比的根本不是「抗不抗命」，是两个世界谁的运气好。
   * 世界那边稍微一动（比如守将的文治开始影响城池生长）这条就翻。
   * 对照实验只许变一个变量。
   */
  const run = (defy: boolean): number => {
    const e = newGeneral('defy-same-world');
    for (let d = 0; d < 500; d++) {
      const o = e.getState().order;
      if (o && o.outcome === 'pending' && !o.accepted) {
        e.dispatch({ t: defy ? 'order_defy' : 'order_accept' });
      }
      if (e.getState().ending) break;
      e.dispatch({ t: 'day' });
    }
    return e.getState().official.trust;
  };
  assert.ok(
    run(true) < run(false),
    '一概抗命之后的信任，该比接了令办不成更低',
  );
});

test('刚打完一仗的军队不能第二天又出现在别的城下', () => {
  // 少了这一条，玩家会天天出兵，一年打上百仗 —— 那不是战争，是刷副本
  const e = newGeneral('rest');
  const st = e.getState() as never as {
    camps: Record<string, { troops: number; grain: number }>;
    nodes: Record<string, { factionId: string; troops: number }>;
    flags: Record<string, number>;
  };
  st.camps[STARTING_CAMP]!.troops = 600;
  const foe = Object.entries(st.nodes).find(
    ([, n]) => n.factionId !== e.getState().official.lordId,
  );
  assert.ok(foe, '天下上该有敌城');

  // 假装刚打完
  st.flags['campaignRest'] = e.getState().day + 20;
  const rejected = e.dispatch({ t: 'theatre_open', targetNodeId: foe![0] });
  assert.ok(
    rejected.some((x) => x.t === 'rejected' && x.reasonId === 'resting'),
    '休整期内出兵该被挡住',
  );
});

// ─────────────────────────────────────────────────────────────
// 驰援
// ─────────────────────────────────────────────────────────────

test('自家的城被围了，出得了兵去救', () => {
  /**
   * 玩家的原话：「驰援自家城池时在地图上按键没有出兵，无法驰援」。
   *
   * 命令层一直是支持的（自家的城被围时出兵合法），
   * 缺的是天下图上那颗按钮 —— 点开自家被围的城只有一句「自家的城。」，
   * 而主公的军令偏偏就是「驰援雍丘」。
   * 界面上办不到主公交代的事，那道军令就只能眼看着过期。
   */
  const e = newGeneral('relieve');
  const st = e.getState() as never as {
    camps: Record<string, { troops: number; grain: number }>;
    sieges: Record<string, unknown>;
    official: { cityId: string };
  };
  st.camps[STARTING_CAMP]!.troops = 600;
  const at = st.official.cityId;

  // 没被围的时候不该出兵 —— 自家的城没什么可打的
  assert.equal(
    whyNotMarch(e.getState(), at), 'own_city',
    '自家的城没被围，本来就没什么可打的',
  );

  st.sieges[at] = { cityId: at, factionId: 'taiping', troops: 500, supply: 9000, days: 4 };
  assert.equal(
    whyNotMarch(e.getState(), at), null,
    '自家的城被围了就该去得了 —— 这正是主公会让你办的事',
  );

  const evs = e.dispatch({ t: 'theatre_open', targetNodeId: at });
  assert.ok(
    evs.some((x) => x.t === 'theatre_opened'),
    '驰援必须真的出得了兵',
  );
  const t = e.getState().theatre!;
  assert.equal(t.kind, 'field', '解围打的是野战，不是攻城');
  assert.ok(
    t.units.some((u) => u.side === 'foe'),
    '城下那支围兵得摆上来 —— 你打的是他们，不是自家的城',
  );
});

test('出不了兵的时候，界面和命令给的是同一个理由', () => {
  // 两处各写各的判定迟早分岔：按钮说「出兵」，点下去被挡回来，
  // 玩家看到的就是「按了没反应」
  const e = newGeneral('why');
  const st = e.getState() as never as {
    camps: Record<string, { troops: number; farming: boolean }>;
    nodes: Record<string, { factionId: string }>;
    official: { lordId: string };
    flags: Record<string, number>;
  };
  const foe = Object.entries(st.nodes)
    .find(([, n]) => n.factionId !== st.official.lordId)![0];
  const camp = st.camps[STARTING_CAMP]!;
  camp.troops = 600;

  const cases: [() => void, string][] = [
    [() => { camp.farming = true; }, 'farming'],
    [() => { camp.farming = false; camp.troops = 10; }, 'too_few'],
    [() => {
      camp.troops = 600;
      st.flags['campaignRest'] = e.getState().day + 20;
    }, 'resting'],
  ];

  for (const [setup, want] of cases) {
    setup();
    assert.equal(whyNotMarch(e.getState(), foe), want, `该报 ${want}`);
    const evs = e.dispatch({ t: 'theatre_open', targetNodeId: foe });
    assert.ok(
      evs.some((x) => x.t === 'rejected' && x.reasonId === want),
      `命令那边也该报 ${want} —— 两处不能各说各的`,
    );
  }
});

test('每一条拒绝理由都写得出一句人话', () => {
  /**
   * 这一条守的是一类**看不见的事故**：
   * `rej.resting`、`rej.farming`、`rej.own_city` 这些从来没写过文案，
   * 于是玩家被挡住的时候，屏幕上弹的是「⟪缺失文本:rej.resting⟫」。
   * 挡得对不对是一回事，说不说得清是另一回事。
   */
  const dir = fileURLToPath(new URL('../src/sim/', import.meta.url));
  const missing: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue;
    const src = readFileSync(dir + f, 'utf8');
    for (const m of src.matchAll(/reject\(\s*'[a-z_]+'\s*,\s*'([a-z_]+)'\s*\)/g)) {
      const id = 'rej.' + m[1];
      if (!content.text[id]) missing.push(id + '（' + f + '）');
    }
  }
  assert.deepEqual(missing, [], '这些拒绝理由没有文案，玩家会看到缺失文本占位符');
});

// ─────────────────────────────────────────────────────────────
// 人物库
// ─────────────────────────────────────────────────────────────

test('天下图上的城有守将，而且是那一家的人', () => {
  /**
   * 上一版敌将的名字是从一份**没有归属**的名单里随手抽的，
   * 于是「攻孔融的城，董卓帐下的华雄出来单挑」这种事真的会发生。
   * 名字给对了人，天下才是一张有人的图。
   */
  const e = newGeneral('posts');
  const st = e.getState();
  let manned = 0;
  for (const node of Object.values(st.nodes)) {
    const w = wardenOf(st, idx, node.id);
    if (!w) continue;
    manned++;
    assert.equal(
      w.faction, node.factionId,
      `${node.id} 的守将 ${w.name} 出身 ${w.faction}，可这座城是 ${node.factionId} 的`,
    );
  }
  assert.ok(manned > 20, `天下四十几座城，该有大半派得上守将，实测只有 ${manned} 座`);
});

test('守将是常驻的：同一座城打两次，出来的是同一个人', () => {
  // 这一趟去打濮阳是张郃守，下一趟还得是他。
  // 守将换人只该发生在城易主、或者主公另有任命的时候 ——
  // 那正是 M4「任命」要动的那张表
  const e = newGeneral('warden');
  const st = e.getState() as never as {
    camps: Record<string, { troops: number; training: number; grain: number }>;
    nodes: Record<string, { factionId: string }>;
    official: { lordId: string };
    flags: Record<string, number>;
  };
  const camp = st.camps[STARTING_CAMP]!;
  camp.troops = 700; camp.training = 70; camp.grain = 6000;
  const foe = Object.entries(st.nodes)
    .find(([, n]) => n.factionId !== st.official.lordId)![0];

  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    delete st.flags['campaignRest'];
    e.dispatch({ t: 'theatre_open', targetNodeId: foe });
    const t = e.getState().theatre!;
    const main = t.units.find((u) => u.side === 'foe' && u.name.includes('前军'));
    seen.push(main?.leader ?? '');
    e.dispatch({ t: 'theatre_close' });
  }
  assert.ok(seen[0], '迎战的主将该有个名字');
  assert.ok(
    seen.every((x) => x === seen[0]),
    `守将该是常驻的，实测三次分别是 ${seen.join('、')}`,
  );
});

test('阵前叫战的是这一家的人，不是随便谁', () => {
  // 一场仗里露面的每一个敌将，出身都得对得上那座城
  const e = newGeneral('foefaction');
  const st = e.getState() as never as {
    camps: Record<string, { troops: number; training: number; grain: number }>;
    nodes: Record<string, { factionId: string }>;
    official: { lordId: string };
  };
  const camp = st.camps[STARTING_CAMP]!;
  camp.troops = 800; camp.training = 70; camp.grain = 6000;

  let checked = 0;
  for (const [id, node] of Object.entries(st.nodes)) {
    if (node.factionId === st.official.lordId) continue;
    const st2 = e.getState() as never as { flags: Record<string, number> };
    delete st2.flags['campaignRest'];
    const evs = e.dispatch({ t: 'theatre_open', targetNodeId: id });
    if (!evs.some((x) => x.t === 'theatre_opened')) continue;
    const t = e.getState().theatre!;
    const names = new Set(
      (idx.byFaction.get(node.factionId) ?? []).map((p) => p.name),
    );
    for (const u of t.units) {
      if (u.side !== 'foe' || !u.leader || u.leader === '偏将') continue;
      assert.ok(
        names.has(u.leader),
        `${id}（${node.factionId}）的城下出现了 ${u.leader} —— 他不是这一家的人`,
      );
      checked++;
    }
    e.dispatch({ t: 'theatre_close' });
    if (checked > 30) break;
  }
  assert.ok(checked > 10, `该验到十几个敌将，实测只有 ${checked} 个`);
});

test('一场仗里同一个人不会同时领两路', () => {
  const e = newGeneral('nodup');
  const st = e.getState() as never as {
    camps: Record<string, { troops: number; training: number; grain: number }>;
    nodes: Record<string, { factionId: string }>;
    official: { lordId: string };
  };
  const camp = st.camps[STARTING_CAMP]!;
  camp.troops = 800; camp.training = 70; camp.grain = 6000;
  const foe = Object.entries(st.nodes)
    .find(([, n]) => n.factionId !== st.official.lordId)![0];
  e.dispatch({ t: 'theatre_open', targetNodeId: foe });
  const t = e.getState().theatre!;
  const named = t.units
    .filter((u) => u.side === 'foe' && u.leader && u.leader !== '偏将')
    .map((u) => u.leader);
  assert.equal(
    named.length, new Set(named).size,
    `有人分身领了两路：${named.join('、')}`,
  );
});

test('挑哪座城打，是个真决定', () => {
  /**
   * 敌将从「随手抽的无名之辈」换成真人之后，守方普遍变强了。
   * 但**变难本身不是问题，难度不分化才是** ——
   * 要是每座城都一样难，那「先捏个软柿子」就不成其为决定。
   *
   * 吕布守的长安和张超守的官渡，该是两件完全不同的事。
   */
  const beat = (targetId: string): number => {
    let wins = 0;
    let ran = 0;
    for (let i = 0; i < 12; i++) {
      const e = new Engine('pick' + i, content);
      e.dispatch({
        t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
      });
      const st = e.getState() as never as {
        camps: Record<string, { troops: number; training: number; gear: number; grain: number }>;
      };
      const camp = st.camps[STARTING_CAMP]!;
      camp.troops = 800; camp.training = 70; camp.gear = 3; camp.grain = 6000;
      if (!e.dispatch({ t: 'theatre_open', targetNodeId: targetId })
        .some((x) => x.t === 'theatre_opened')) continue;
      const t = e.getState().theatre!;
      const sent = e.dispatch({
        t: 'theatre_send', kind: 'foot', men: Math.min(600, t.pool.foot),
        col: Math.round(t.foeCamp[0] - 6), row: Math.round(t.foeCamp[1]),
        stance: 'assault', officerId: null,
      });
      if (!sent.some((x) => x.t === 'theatre_sent')) continue;
      ran++;
      e.dispatch({ t: 'theatre_begin' });
      let g = 0;
      while (t.phase === 'fighting' && g++ < 950) e.dispatch({ t: 'theatre_step', ticks: 1 });
      if (t.outcome === 'won') wins++;
    }
    return ran === 0 ? -1 : (wins / ran) * 100;
  };

  // 长安是吕布守的；官渡是张超守的
  const hard = beat('changan');
  const soft = beat('guandu');
  assert.ok(hard >= 0 && soft >= 0, '这两座城都该打得起来');
  assert.ok(
    soft - hard >= 25,
    `软柿子和硬骨头该差得出来，实测 官渡 ${Math.round(soft)}%、长安 ${Math.round(hard)}%`,
  );
});

// ─────────────────────────────────────────────────────────────
// 任命
// ─────────────────────────────────────────────────────────────

test('城打下来了，新主人要派人守', () => {
  /**
   * 少了这一段，打下来的城从此没有守将：
   * `wardenOf` 认得出城头换了旗号，于是返回 null，那座城就永远无名。
   * 天下打上十年，满地都是空城 —— 那不是乱世，那是空场子。
   */
  const e = newGeneral('capture');
  const st = e.getState() as never as {
    nodes: Record<string, { factionId: string; troops: number }>;
    sieges: Record<string, unknown>;
    official: { lordId: string };
  };
  // 找一座别人家的城，把它打到城破
  const [id, node] = Object.entries(st.nodes)
    .find(([, n]) => n.factionId !== st.official.lordId && n.factionId !== 'taiping')!;
  const from = node.factionId;
  /**
   * 挑一个**还腾得出人**的势力来打。
   *
   * 人都派出去的势力打下城来也没人可派 —— 那是实情，不是事故
   * （吞得太快就会无人可用）。这一条测的是「腾得出人的时候会不会派」。
   */
  const posted = new Set(Object.values(e.getState().posts));
  const taker = [...idx.byFaction.entries()]
    .filter(([f, list]) => f !== from && list.some((p) => !posted.has(p.id)))
    .map(([f]) => f)[0]!;
  assert.ok(taker, '总该有一家还腾得出人');
  node.troops = 1;
  st.sieges[id] = { cityId: id, factionId: taker, troops: 900, supply: 9000, days: 9 };

  let fell = false;
  for (let d = 0; d < 30 && !fell; d++) {
    for (const ev of e.dispatch({ t: 'day' })) {
      if (ev.t === 'city_fell' && ev.cityId === id) fell = true;
    }
  }
  assert.ok(fell, '这座城该被打下来');

  const after = e.getState();
  assert.equal(after.nodes[id]!.factionId, taker, '城该换旗号了');
  const w = wardenOf(after, idx, id);
  assert.ok(w, '打下来的城要有人接手守，不能就此无名');
  assert.equal(w!.faction, taker, '接手的该是新主人的人');
});

test('打了十年，天下不会变成一片空城', () => {
  const e = newGeneral('decade');
  const keep = e.getState() as never as {
    camps: Record<string, { grain: number; troops: number }>;
    official: { trust: number };
  };
  const total = Object.keys(e.getState().nodes).length;
  const before = unmannedCities(e.getState(), idx);
  for (let d = 0; d < 2400; d++) {
    // 这一条量的是天下，不是玩家能活多久
    const c = keep.camps[STARTING_CAMP];
    if (c) { c.grain = 9000; c.troops = Math.max(200, c.troops); }
    keep.official.trust = 60;
    e.dispatch({ t: 'day' });
  }
  const after = unmannedCities(e.getState(), idx);
  assert.ok(
    after <= Math.max(before + 6, total * 0.45),
    `空城太多了：开局 ${before} 座，如今 ${after} 座（共 ${total} 座）`,
  );
});

test('举荐部将去守城：你少一路兵，换主公的信任', () => {
  // 这是玩家在「任命」这套东西里插得上手的那一头
  const e = newGeneral('recommend');
  const st = e.getState() as never as {
    retinue: string[];
    official: { trust: number; merit: number; lordId: string };
    nodes: Record<string, { factionId: string }>;
    posts: Record<string, string>;
  };
  st.retinue = ['dianwei'];
  // 腾一座自家的空城出来
  const mineCity = Object.entries(st.nodes)
    .find(([, n]) => n.factionId === st.official.lordId)![0];
  delete st.posts[mineCity];

  const spots = vacantPosts(e.getState(), idx);
  assert.ok(spots.includes(mineCity), '这座城该出现在可举荐的去处里');

  const trust0 = st.official.trust;
  const merit0 = st.official.merit;
  const evs = e.dispatch({ t: 'recommend', officerId: 'dianwei', cityId: mineCity });
  assert.ok(evs.some((x) => x.t === 'recommended'), '举荐该办得成');

  const after = e.getState();
  assert.ok(!after.retinue.includes('dianwei'), '举荐出去的人就不在你帐下了');
  assert.equal(after.posts[mineCity], 'dianwei', '他从此守这座城');
  assert.ok(after.official.trust > trust0, '主公该记这份人情');
  assert.ok(after.official.merit > merit0, '也该记一份功');
  assert.equal(wardenOf(after, idx, mineCity)?.id, 'dianwei');
});

test('举荐挡得住几种不该办的事', () => {
  const e = newGeneral('recommend2');
  const st = e.getState() as never as {
    retinue: string[];
    hurt: Record<string, number>;
    nodes: Record<string, { factionId: string }>;
    posts: Record<string, string>;
    official: { lordId: string };
    day: number;
  };
  st.retinue = ['dianwei'];
  const mineCity = Object.entries(st.nodes)
    .find(([, n]) => n.factionId === st.official.lordId)![0];
  const foeCity = Object.entries(st.nodes)
    .find(([, n]) => n.factionId !== st.official.lordId)![0];

  // 不是你帐下的人
  assert.ok(
    e.dispatch({ t: 'recommend', officerId: 'xuchu', cityId: mineCity })
      .some((x) => x.t === 'rejected' && x.reasonId === 'not_yours'),
  );
  // 不是主公的城
  assert.ok(
    e.dispatch({ t: 'recommend', officerId: 'dianwei', cityId: foeCity })
      .some((x) => x.t === 'rejected' && x.reasonId === 'not_ours'),
  );
  // 已经有人守着
  st.posts[mineCity] = 'yuejin';
  assert.ok(
    e.dispatch({ t: 'recommend', officerId: 'dianwei', cityId: mineCity })
      .some((x) => x.t === 'rejected' && x.reasonId === 'already_manned'),
  );
  // 伤着的人上不了任
  delete st.posts[mineCity];
  st.hurt['dianwei'] = st.day + 30;
  assert.ok(
    e.dispatch({ t: 'recommend', officerId: 'dianwei', cityId: mineCity })
      .some((x) => x.t === 'rejected' && x.reasonId === 'officer_hurt'),
  );
});

// ─────────────────────────────────────────────────────────────
// 外交
// ─────────────────────────────────────────────────────────────

/** 让天下自己走一段，别让玩家先饿死或被撤职把推演打断 */
function runWorld(e: Engine, days: number): void {
  const keep = e.getState() as never as {
    camps: Record<string, { grain: number; troops: number }>;
    official: { trust: number };
  };
  for (let d = 0; d < days; d++) {
    const c = keep.camps[STARTING_CAMP];
    if (c) { c.grain = 9000; c.troops = Math.max(200, c.troops); }
    keep.official.trust = 60;
    e.dispatch({ t: 'day' });
  }
}

test('天下的恩怨会变，不是开局摆好就冻住', () => {
  /**
   * `attitude` 这张表原先开局设好之后**再没变过** ——
   * 十年打下来，各家的关系还是初平元年那一天的样子。
   * 有数据，没有行为：又一条看着在运转、其实一次也没跑过的机制。
   */
  const e = newGeneral('diplo');
  const snap = (): Map<string, number> => {
    const m = new Map<string, number>();
    for (const [a, fs] of Object.entries(e.getState().factions)) {
      for (const [b, v] of Object.entries(fs.attitude)) m.set(a + '>' + b, v);
    }
    return m;
  };
  const before = snap();
  runWorld(e, 1440);
  const after = snap();

  let moved = 0;
  for (const [k, v] of after) if (v !== (before.get(k) ?? 0)) moved++;
  assert.ok(
    moved > after.size * 0.4,
    `四年下来该有大半的关系动过，实测只有 ${moved}/${after.size} 对`,
  );
});

test('打了人就结仇，挨打的记得最牢', () => {
  const e = newGeneral('anger');
  const st = e.getState() as never as {
    nodes: Record<string, { factionId: string }>;
    factions: Record<string, { attitude: Record<string, number> }>;
    official: { lordId: string };
  };
  const [victimCity, victim] = Object.entries(st.nodes)
    .find(([, n]) => n.factionId !== st.official.lordId)!;
  const attacker = Object.values(st.nodes)
    .map((n) => n.factionId)
    .find((f) => f !== victim.factionId)!;

  const was = st.factions[victim.factionId]!.attitude[attacker] ?? 0;
  angerFrom(e.getState(), attacker, victim.factionId, false);
  const now = st.factions[victim.factionId]!.attitude[attacker] ?? 0;
  const back = st.factions[attacker]!.attitude[victim.factionId] ?? 0;

  assert.ok(now < was, '挨打的该恨上动手的');
  assert.ok(
    was - now > Math.abs(back),
    '挨打的记得该比动手的深 —— 这是不对称的',
  );
  void victimCity;
});

test('一家独大就会招来众怒 —— 滚雪球有了刹车', () => {
  /**
   * 设计方案 8.1 说的是「主公滚雪球」。
   * 解法不该是给赢家加惩罚，而是**让别人怕他** ——
   * 这样刹车是从世界里长出来的，不是外面贴上去的。
   */
  const e = newGeneral('runaway');
  const st = e.getState() as never as {
    nodes: Record<string, { factionId: string }>;
    official: { cityId: string };
  };
  // 把近一半天下划给袁绍。别动玩家那座城 —— 一动他就出局，天下也不走了
  const all = Object.keys(st.nodes).filter((id) => id !== st.official.cityId);
  const want = Math.floor(all.length * 0.44);
  for (let i = 0; i < want; i++) st.nodes[all[i]!]!.factionId = 'yuanshao';

  runWorld(e, 1080);

  const s2 = e.getState();
  assert.ok(s2.day > 1000, '这一条量的是天下，推演不能中途停住');

  const others = new Set(
    Object.values(s2.nodes).map((n) => n.factionId).filter((f) => f !== 'yuanshao'),
  );
  let foes = 0;
  for (const f of others) {
    if (atWar(s2, f, 'yuanshao')) foes++;
  }
  assert.ok(
    foes >= others.size * 0.6,
    `霸主该招来众怒，实测 ${others.size} 家里只有 ${foes} 家防着他`,
  );
});

test('没人做大的时候，天下不会人人自危', () => {
  // 忌惮要有门槛。开局就人人为敌，那这条规则等于没有
  const e = newGeneral('calm');
  runWorld(e, 360);
  const st = e.getState();
  const holds = new Map<string, number>();
  for (const n of Object.values(st.nodes)) {
    holds.set(n.factionId, (holds.get(n.factionId) ?? 0) + 1);
  }
  const total = Object.keys(st.nodes).length;
  // 挑一家还没做大的，看看是不是四邻皆敌
  const small = [...holds.entries()].find(([, n]) => n / total < 0.12);
  assert.ok(small, '总该有一家还不大');
  let foes = 0;
  for (const [f] of holds) {
    if (f !== small![0] && atWar(st, f, small![0])) foes++;
  }
  assert.ok(
    foes < holds.size * 0.7,
    `没做大的一家不该四面皆敌，实测 ${holds.size} 家里 ${foes} 家与他为敌`,
  );
});

test('天下各城的粮：有进有出，仓有底，但不会饿死', () => {
  /**
   * 上一版只有 `grain +=` 那一句 —— 不消耗，也没有上限。
   * 两年下来一座民心只剩十的小城能攒下三万六千石，
   * 而玩家点开它就看得见这个数。
   *
   * 补消耗的时候我按行军的口粮算，又走到了另一头：
   * 各城的日耗超过日产，天下所有的城都在饿肚子 ——
   * 而**主公的粮饷正是从他各城的存粮里出的**，
   * 于是玩家开局一百六十天就散伙了。
   *
   * 所以这一条要两头都守住：既不能无限涨，也不能净流出。
   */
  const e = newGeneral('grain');
  runWorld(e, 1440);
  const st = e.getState();

  const npc = Object.values(st.nodes).filter((n) => !st.cities[n.id]);
  const rich = npc.filter((n) => n.grain > 12000);
  assert.equal(rich.length, 0, `有城攒下了不该有的粮：${rich.map((n) => n.id + ':' + n.grain).join('、')}`);

  const starving = npc.filter((n) => n.grain <= 0);
  assert.ok(
    starving.length < npc.length * 0.3,
    `太多城在饿肚子（${starving.length}/${npc.length}）—— 主公的粮饷就是从这里出的`,
  );
});

test('主公发得出粮饷 —— 那是玩家唯一稳定的粮道', () => {
  // 天下各城的存粮一变，这条粮道就跟着变。
  // 这一条守的是「改了那边别忘了这边」
  const e = newGeneral('ration2');
  let got = 0;
  for (let d = 0; d < 400; d++) {
    if (e.getState().ending) break;
    for (const ev of e.dispatch({ t: 'day' })) {
      if (ev.t === 'ration_replied') got += ev.granted;
    }
  }
  assert.ok(got > 300, `头一年多的粮饷该有个几百石，实测只有 ${got}`);
});

test('派谁守城是算数的 —— 任命不是摆设', () => {
  /**
   * `nodeDefence` 原先**根本不看守将**。
   * 于是「任命」这套东西 —— 城易主派人、你举荐部将、
   * 乃至主公玩法里最核心的那个动词 —— 在机制上一律是零：
   * 派谁守、派不派人守，城的防御一模一样。
   *
   * 但这个乘数必须**以一为轴**：写成往上加的话，
   * 天下所有城的防御整体抬高，而玩家那座城不吃这一层，
   * 他就成了四邻里最软的一个，流寇提前来、还来得小。
   */
  const e = newGeneral('warden');
  const st = e.getState();
  const foe = Object.values(st.nodes)
    .find((n) => n.factionId !== st.official.lordId && !st.cities[n.id])!;

  const s2 = e.getState() as never as { posts: Record<string, string> };
  delete s2.posts[foe.id];
  const bare = wardenPermille(e.getState(), idx, foe.id);

  // 找一位**这家自己的**名将来守。
  // `wardenOf` 认旗号：派个曹操的人去守董卓的城，那不叫守将
  const best = [...(idx.byFaction.get(foe.factionId) ?? [])]
    .sort((a, b) => b.command - a.command)[0];
  assert.ok(best, '这一家总该有自己的人');
  s2.posts[foe.id] = best!.id;
  const held = wardenPermille(e.getState(), idx, foe.id);

  assert.ok(held > bare, '有名将坐镇的城该比没人守的难打');
  assert.ok(bare < 1000, '没人守的城该比常态弱');
  assert.ok(held > 1000 && held < 1400, `名将该高于常态但不该离谱，实测 ${held}`);

  // 玩家自己坐镇的城不吃这一层 —— 他本人就在城里
  assert.equal(
    wardenPermille(e.getState(), idx, st.official.cityId), 1000,
    '玩家亲自坐镇的城不该按「有没有守将」打折',
  );
});
