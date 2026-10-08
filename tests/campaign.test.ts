/**
 * 出征测试。
 *
 * 守的是这套设计能不能立住的三条：
 *
 *   一、**动脑子要有用**：配合起来的计划要明显强过全军压上去
 *   二、**但会落空**：伏兵不是稳的，押错了要吃亏
 *   三、**派谁去要紧**：同一个计划换个部将，结果要看得出分别
 *
 * 第三条最要紧。若部将只是一个数值加成，点将台就是一张表；
 * 夏侯惇统率 80 却守不住伏，许褚统率 58 反而守得住 ——
 * 这个差别必须在数字上成立。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { indexContent, type ContentDB, type ContentIndex } from '../src/sim/content.ts';
import { seedRng } from '../src/sim/rng.ts';
import {
  makeRoutes, pickFoeRoute, resolveSetup, rollDeviations, validatePlan,
} from '../src/sim/campaign.ts';
import {
  MIN_COLUMN_MEN, type Campaign, type Column, type Mission,
} from '../src/sim/campaign_types.ts';
import { deviationRisk } from '../src/sim/officer_types.ts';

function loadContent(): ContentDB {
  const read = (n: string): unknown =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
  return {
    buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
    map: read('map'), factions: read('factions'), battle: read('battle'),
    field: read('field'), facilities: read('facilities'), terrain: read('terrain'), people: read('people'), text: read('text'),
  } as ContentDB;
}

const idx: ContentIndex = indexContent(loadContent());
const OWN = 600;
const FOE = 700;

function col(
  i: number, men: number, routeId: string, mission: Mission, officerId: string | null,
): Column {
  return {
    id: 'c' + i, officerId, men, routeId, mission,
    progress: 6, state: 'arrived', deviated: null,
  };
}

type Build = (routes: { id: string; kind: string }[]) => Column[];

const byway = (rs: { id: string; kind: string }[]): string =>
  (rs.find((r) => r.kind === 'byway') ?? rs[0]!).id;
const mainRoad = (rs: { id: string; kind: string }[]): string =>
  (rs.find((r) => r.kind === 'main') ?? rs[0]!).id;

/** 推演用的两地：许 → 宛，中间隔着伏牛山与南阳林，三条道都开得出来 */
const FROM: [number, number] = idx.node.get('xuchang')!.at;
const TO: [number, number] = idx.node.get('wan')!.at;

function stage(seed: string, build: Build): Campaign {
  const rng = seedRng(seed);
  const routes = makeRoutes(rng, FROM, TO, idx.terrain);
  const camp: Campaign = {
    targetNodeId: 'x', foeFactionId: 'y', foeTroops: FOE, scouting: 60,
    routes, columns: [], phase: 'planning', startDay: 0,
    foeRouteId: null, ambushSprung: false, log: [],
  };
  camp.columns = build(routes);
  camp.foeRouteId = pickFoeRoute(camp, rng);
  rollDeviations(camp, idx, rng);
  return camp;
}

/**
 * 一份计划值多少。
 *
 * 不是胜率 —— 是那场战术仗从什么局面开打：
 * 我方实际投入 ÷ 敌方实际到场。侧击的兵打的是已经咬住的敌人，
 * 值钱一些；第六轮才到的那一路赶上的只是收尾。
 */
function edge(seed: string, build: Build): number {
  const s = resolveSetup(stage(seed, build), idx);
  // 侧击打的是已经咬住的敌人，一个兵比正面的一个兵值钱；
  // 第六轮才到的那一路赶上的只是收尾
  const mine = s.ownMen + s.late.reduce(
    (a, l) => a + Math.round(l.men * (l.round >= 6 ? 0.45 : 1.35)), 0,
  );
  const theirs = Math.max(1, Math.round(s.foeMen * (1 - s.foeMoraleHit / 200)));
  return Math.round((mine / theirs) * 100);
}

function avgEdge(build: Build, n = 300): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += edge('t' + i, build);
  return Math.round(sum / n);
}

const PLAIN: Build = (rs) => [col(0, OWN, mainRoad(rs), 'assault', null)];

const ambushWith = (who: string): Build => (rs) => [
  col(0, Math.round(OWN * 0.2), mainRoad(rs), 'feint', 'lidian'),
  col(1, Math.round(OWN * 0.5), byway(rs), 'ambush', who),
  col(2, Math.round(OWN * 0.3), mainRoad(rs), 'flank', 'yuejin'),
];

// ─────────────────────────────────────────────────────────────

test('会配合的计划要明显强过全军压上去', () => {
  // 这是整套出征系统存在的理由。若两者差不多，点将台就是个摆设。
  //
  // 守的是**相对幅度**而不是绝对差值：绝对值会随基础杀伤、
  // 兵力对比这些数一起漂，相对幅度才是「动脑子值不值」这件事本身
  const plain = avgEdge(PLAIN);
  const clever = avgEdge(ambushWith('caoren'));
  assert.ok(
    clever > plain * 1.22,
    `三路配合该明显强过全军正击：${plain} → ${clever}`,
  );
});

test('计划落空的时候，兵不会凭空消失', () => {
  // 真事故：伏兵扑空算成「迟到的一路」，侧击也算「迟到的一路」，
  // 而当时只存了一对「第几轮、多少人」—— 后者把前者覆盖了，
  // 于是全军都约在第三轮到，正面一个人也没有，
  // 一进战场是一个兵对着七百人。
  //
  // 两条规矩因此立住：晚到的各路是一张**表**；
  // 而且正面永远有人 —— 谁先到谁就是正兵。
  for (let i = 0; i < 200; i++) {
    const s = resolveSetup(stage('gap' + i, ambushWith('caoren')), idx);
    const total = s.ownMen + s.late.reduce((a, l) => a + l.men, 0);
    assert.ok(total > OWN * 0.6, `派出去的兵不该凭空少掉：${total} / ${OWN}`);
    assert.ok(s.ownMen > 0, '正面不能一个人都没有');
    const rounds = s.late.map((l) => l.round);
    assert.equal(new Set(rounds).size, rounds.length, '两路不该被压成同一个时刻');
  }
});

test('但计划会落空，而且落空要真吃亏', () => {
  // 稳赢的计策就不是计策了。伏兵必须有扑空的时候
  let sprung = 0, missed = 0;
  const n = 300;
  for (let i = 0; i < n; i++) {
    const s = resolveSetup(stage('m' + i, ambushWith('caoren')), idx);
    if (s.ambush) sprung++; else missed++;
  }
  assert.ok(sprung > n * 0.25, `伏兵该常有咬住的时候，实测 ${Math.round(sprung / n * 100)}%`);
  assert.ok(missed > n * 0.25, `伏兵也该常有扑空的时候，实测 ${Math.round(missed / n * 100)}%`);

  // 而且这一路的成败要拉得开差距
  let hit = 0, hitN = 0, miss = 0, missN = 0;
  for (let i = 0; i < n; i++) {
    const camp = stage('m' + i, ambushWith('caoren'));
    const s = resolveSetup(camp, idx);
    const e = edge('m' + i, ambushWith('caoren'));
    if (s.ambush) { hit += e; hitN++; } else { miss += e; missN++; }
  }
  assert.ok(
    hit / hitN > miss / missN + 30,
    `伏中与扑空的局面该差得远：${Math.round(miss / missN)} → ${Math.round(hit / hitN)}`,
  );
});

test('派谁去守伏，比他统率多高更要紧', () => {
  // 街亭：不是马谡数值低，是诸葛亮让他当道下寨，他上了山。
  // 夏侯惇统率 80 而性急，许褚统率 58 而果决 —— 守伏该是许褚更靠得住
  const dun = avgEdge(ambushWith('xiahoudun'));
  const chu = avgEdge(ambushWith('xuchu'));
  const dunDef = idx.person.get('xiahoudun')!;
  const chuDef = idx.person.get('xuchu')!;
  assert.ok(dunDef.command > chuDef.command, '前提：夏侯惇的统率确实更高');
  assert.ok(
    chu > dun + 4,
    `性子该压过统率：夏侯惇 ${dun}，许褚 ${chu}`,
  );
});

test('果决的人交代什么就是什么', () => {
  // 「说到做到」若只是「和谨慎的人一样偶尔迟到」，这个性子就没有意义
  const decisive = deviationRisk(idx.person.get('caoren')!, 'ambush');
  const rash = deviationRisk(idx.person.get('xiahoudun')!, 'ambush');
  const proud = deviationRisk(idx.person.get('caohong')!, 'ambush');
  assert.equal(decisive, 0, '统率高的果决之人守伏不该走样');
  assert.ok(rash > 250, `性急的人守伏该常出事，实测 ${rash}‰`);
  assert.ok(proud > 200, `骄矜的人守伏该常出事，实测 ${proud}‰`);
});

test('憋着不动的差事最难，冲上去的差事最容易', () => {
  const o = idx.person.get('caohong')!;
  assert.ok(
    deviationRisk(o, 'ambush') > deviationRisk(o, 'assault'),
    '同一个人，设伏该比正击更容易走样',
  );
});

test('你亲自领的那一路不会走样', () => {
  assert.equal(deviationRisk(null, 'ambush'), 0);
  for (let i = 0; i < 40; i++) {
    const camp = stage('self' + i, (rs) => [col(0, OWN, byway(rs), 'ambush', null)]);
    assert.equal(camp.columns[0]!.deviated, null, '自己在那儿，不会有人自作主张');
  }
});

test('佯动把敌军往别的道上赶', () => {
  // 佯动一个人也杀不了。它的全部价值是把敌军推到伏兵等着的那条道上去 ——
  // 若它推不动，这套设计就散了
  const roadOf = (camp: Campaign): string =>
    camp.routes.find((r) => r.id === camp.foeRouteId)!.kind;

  let withFeint = 0, without = 0;
  const n = 400;
  for (let i = 0; i < n; i++) {
    const a = stage('f' + i, (rs) => [col(0, OWN, mainRoad(rs), 'assault', null)]);
    const b = stage('f' + i, (rs) => [
      col(0, 200, mainRoad(rs), 'feint', 'lidian'),
      col(1, 400, byway(rs), 'ambush', 'caoren'),
    ]);
    if (roadOf(a) === 'main') without++;
    if (roadOf(b) === 'main') withFeint++;
  }
  assert.ok(
    withFeint < without - n * 0.1,
    `在大道上佯动，敌军该少走大道：${Math.round(without / n * 100)}% → ${Math.round(withFeint / n * 100)}%`,
  );
});

test('有几条道，看中间隔着什么', () => {
  // 这一条守的是「出兵与地形有关」这句话。
  //
  // 奇道不是掷骰子掷出来的 —— 汉中往长安要翻秦岭，所以有山道；
  // 雍丘往陈留是一马平川，所以**只能正面走过去**。
  // 若平原上也能设伏，「设伏」就成了一个随处可点的按钮。
  const rng = seedRng('geo');
  const at = (id: string): [number, number] => idx.node.get(id)!.at;

  const overMountain = makeRoutes(rng, at('hanzhong'), at('changan'), idx.terrain);
  assert.ok(
    overMountain.some((r) => r.kind === 'mountain'),
    '汉中往长安全程秦岭，该有山道',
  );

  const flat = makeRoutes(rng, at('yongqiu'), at('chenliu'), idx.terrain);
  assert.ok(
    !flat.some((r) => r.kind === 'mountain'),
    '雍丘往陈留一马平川，不该凭空冒出一条山道',
  );
  const flatCover = Math.max(...flat.map((r) => r.cover));
  assert.ok(flatCover < 45, `平原上藏不住人，实测最高隐蔽 ${flatCover}`);

  const roughCover = Math.max(...overMountain.map((r) => r.cover));
  assert.ok(roughCover > 60, `山里该藏得住人，实测最高隐蔽 ${roughCover}`);
});

test('隔着山就要多走日子', () => {
  // 图上距离差不多的两条路，翻山的那条必须明显更久 ——
  // 否则「地形」就只是地图上的一层花纹
  const rng = seedRng('pace');
  const at = (id: string): [number, number] => idx.node.get(id)!.at;

  const mountain = makeRoutes(rng, at('hanzhong'), at('changan'), idx.terrain)[0]!;
  const plain = makeRoutes(rng, at('xuchang'), at('chenliu'), idx.terrain)[0]!;
  const mDist = Math.hypot(
    at('changan')[0] - at('hanzhong')[0], at('changan')[1] - at('hanzhong')[1],
  );
  const pDist = Math.hypot(
    at('chenliu')[0] - at('xuchang')[0], at('chenliu')[1] - at('xuchang')[1],
  );
  const mPer = mountain.days / mDist;
  const pPer = plain.days / pDist;
  assert.ok(
    mPer > pPer * 1.6,
    `同样一里路，翻秦岭该慢得多：平原 ${pPer.toFixed(2)} 日/单位，山中 ${mPer.toFixed(2)}`,
  );
});

test('不合规矩的计划要被挡住', () => {
  const rng = seedRng('v');
  const routes = makeRoutes(rng, FROM, TO, idx.terrain);
  const r0 = routes[0]!.id;
  assert.equal(validatePlan([], OWN, routes), 'no_columns');
  assert.equal(
    validatePlan([col(0, MIN_COLUMN_MEN - 1, r0, 'assault', null)], OWN, routes),
    'column_too_small',
    '凑不成一军的零头不该单独成路',
  );
  assert.equal(
    validatePlan([col(0, OWN + 1, r0, 'assault', null)], OWN, routes),
    'not_enough_men',
    '不能派出比手里更多的兵',
  );
  assert.equal(
    validatePlan(
      [col(0, 200, r0, 'assault', 'caoren'), col(1, 200, r0, 'flank', 'caoren')],
      OWN, routes,
    ),
    'officer_twice',
    '一个人分不了身',
  );
  assert.equal(
    validatePlan([col(0, 200, 'nope', 'assault', null)], OWN, routes),
    'no_such_route',
  );
  assert.equal(validatePlan([col(0, 200, r0, 'assault', null)], OWN, routes), null);
});
