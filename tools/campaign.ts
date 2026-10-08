/**
 * 出征的推演。
 *
 * 只问一件事：**动脑子有没有用**。
 *
 * 如果「全军压上去」和「佯动 + 设伏」结果差不多，那点将台就是个摆设；
 * 如果设伏永远成功，那它又太强，玩家只会重复同一个套路。
 * 所以这里要看的是三条线：
 *
 *   一、几种打法的胜率拉不拉得开
 *   二、设伏落空的比例够不够高（落空了要真吃亏）
 *   三、派谁去要紧不要紧 —— 同一个计划换个部将，差别有多大
 *
 *   node tools/campaign.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { indexContent, type ContentDB } from '../src/sim/content.ts';
import { seedRng } from '../src/sim/rng.ts';
import { makeRoutes, pickFoeRoute, resolveSetup, rollDeviations } from '../src/sim/campaign.ts';
import {
  MISSION_NAME, ROUTE_NAME, type Campaign, type Column, type Mission,
} from '../src/sim/campaign_types.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'), terrain: read('terrain'), people: read('people'), text: read('text'),
} as ContentDB;
const idx = indexContent(content);

const OWN = 600;
const FOE = 700;

interface Plan {
  name: string;
  build: (routes: { id: string; kind: string }[]) => Column[];
}

function col(
  i: number, men: number, routeId: string, mission: Mission, officerId: string | null,
): Column {
  return {
    id: 'c' + i, officerId, men, routeId, mission,
    progress: 6, state: 'arrived', deviated: null,
  };
}

const byway = (rs: { id: string; kind: string }[]): string =>
  (rs.find((r) => r.kind === 'byway') ?? rs[0]!).id;
const main = (rs: { id: string; kind: string }[]): string =>
  (rs.find((r) => r.kind === 'main') ?? rs[0]!).id;

const PLANS: Plan[] = [
  {
    name: '全军正击',
    build: (rs) => [col(0, OWN, main(rs), 'assault', null)],
  },
  {
    name: '正击 + 侧击',
    build: (rs) => [
      col(0, Math.round(OWN * 0.65), main(rs), 'assault', null),
      col(1, Math.round(OWN * 0.35), byway(rs), 'flank', 'yuejin'),
    ],
  },
  {
    name: '佯动 + 设伏（果决的人守伏）',
    build: (rs) => [
      col(0, Math.round(OWN * 0.25), main(rs), 'feint', 'lidian'),
      col(1, Math.round(OWN * 0.75), byway(rs), 'ambush', 'caoren'),
    ],
  },
  {
    name: '佯动 + 设伏（性急的人守伏）',
    build: (rs) => [
      col(0, Math.round(OWN * 0.25), main(rs), 'feint', 'lidian'),
      col(1, Math.round(OWN * 0.75), byway(rs), 'ambush', 'xiahoudun'),
    ],
  },
  {
    name: '三路：佯动 + 设伏 + 侧击',
    build: (rs) => [
      col(0, Math.round(OWN * 0.2), main(rs), 'feint', 'lidian'),
      col(1, Math.round(OWN * 0.5), byway(rs), 'ambush', 'caoren'),
      col(2, Math.round(OWN * 0.3), main(rs), 'flank', 'yuejin'),
    ],
  },
];

function makeCampaign(seed: string, plan: Plan): Campaign {
  const rng = seedRng(seed);
  const routes = makeRoutes(rng, idx.node.get('xuchang')!.at, idx.node.get('wan')!.at, idx.terrain);
  const camp: Campaign = {
    targetNodeId: 'x', foeFactionId: 'y', foeTroops: FOE, scouting: 60,
    routes, columns: [], phase: 'planning', startDay: 0,
    foeRouteId: null, ambushSprung: false, log: [],
  };
  camp.columns = plan.build(routes);
  camp.foeRouteId = pickFoeRoute(camp, rng);
  rollDeviations(camp, idx, rng);
  return camp;
}

/**
 * 一份计划值多少。
 *
 * 用「己方实际投入 vs 敌方实际到场」这个比值来衡量 ——
 * 它不是胜率，但它决定了那场战术仗从什么局面开打。
 * 侧击那一路按七成计：它来得晚，赶上的是后半场。
 */
function score(seed: string, plan: Plan): { edge: number; ambush: boolean; dev: boolean } {
  const camp = makeCampaign(seed, plan);
  const s = resolveSetup(camp, idx);
  // 侧击打的是已经咬住的敌人，一个兵比正面的一个兵值钱；
  // 但第六轮才到的那一路赶上的只是收尾
  const effective = s.ownMen + s.late.reduce(
    (a, l) => a + Math.round(l.men * (l.round >= 6 ? 0.45 : 1.35)), 0,
  );
  // 敌军士气挨的那一下也折进来
  const foeEff = Math.max(1, Math.round(s.foeMen * (1 - s.foeMoraleHit / 200)));
  return {
    edge: Math.round((effective / foeEff) * 100),
    ambush: s.ambush,
    // 只看伏兵那一路走没走样。把佯动那一路也算进来的话，
    // 每一行都掺着同一个人的走样率，谁也比不出谁
    dev: camp.columns.some((c) => c.mission === 'ambush' && c.deviated !== null),
  };
}

const N = 600;
console.log('  己方 ' + OWN + ' 人，敌军 ' + FOE + ' 人。');
console.log('  「优势」= 实际投入 ÷ 敌军实际到场，100 表示势均力敌。');
console.log('');
console.log('  打法                            平均优势   最好   最坏   伏中   走样');
console.log('  ' + '─'.repeat(76));

for (const plan of PLANS) {
  let sum = 0, best = -1, worst = 9999, amb = 0, dev = 0;
  for (let i = 0; i < N; i++) {
    const r = score('cp' + i, plan);
    sum += r.edge;
    if (r.edge > best) best = r.edge;
    if (r.edge < worst) worst = r.edge;
    if (r.ambush) amb++;
    if (r.dev) dev++;
  }
  console.log(
    '  ' + plan.name.padEnd(30) +
    String(Math.round(sum / N)).padStart(6) +
    String(best).padStart(7) +
    String(worst).padStart(7) +
    String(Math.round((amb / N) * 100) + '%').padStart(7) +
    String(Math.round((dev / N) * 100) + '%').padStart(7),
  );
}

console.log('');
console.log('  ── 同一个计划，换个人去守伏 ──');
for (const who of ['caoren', 'lidian', 'yujin', 'yuejin', 'caohong', 'xiahoudun', 'xuchu']) {
  const o = idx.person.get(who)!;
  let sum = 0, amb = 0, dev = 0;
  for (let i = 0; i < N; i++) {
    const plan: Plan = {
      name: who,
      build: (rs) => [
        col(0, Math.round(OWN * 0.25), main(rs), 'feint', 'lidian'),
        col(1, Math.round(OWN * 0.75), byway(rs), 'ambush', who),
      ],
    };
    const r = score('cp' + i, plan);
    sum += r.edge;
    if (r.ambush) amb++;
    if (r.dev) dev++;
  }
  console.log(
    '  ' + (o.name + '（' + o.temper + '，统率 ' + o.command + '）').padEnd(28) +
    String(Math.round(sum / N)).padStart(6) + ' 优势' +
    String(Math.round((amb / N) * 100) + '%').padStart(7) + ' 伏中' +
    String(Math.round((dev / N) * 100) + '%').padStart(7) + ' 走样',
  );
}

console.log('');
console.log('  ── 一次出征长什么样 ──');
const demo = makeCampaign('demo7', PLANS[4]!);
console.log('  道：' + demo.routes.map((r) => ROUTE_NAME[r.kind] + '（' + r.days + ' 日，隐蔽 ' + r.cover + '）').join('　'));
console.log('  敌军走了：' + ROUTE_NAME[demo.routes.find((r) => r.id === demo.foeRouteId)!.kind]);
for (const c of demo.columns) {
  const o = c.officerId ? idx.person.get(c.officerId)! : null;
  const r = demo.routes.find((x) => x.id === c.routeId)!;
  console.log(
    '  ' + (o ? o.name : '（亲领）').padEnd(6) + String(c.men).padStart(4) + ' 人  ' +
    ROUTE_NAME[r.kind] + '  ' + MISSION_NAME[c.mission] +
    (c.deviated ? '  ← 走样：' + c.deviated : ''),
  );
}
const s = resolveSetup(demo, idx);
console.log('  结果：我 ' + s.ownMen + ' 人接战'
  + s.late.map((l) => '，' + l.men + ' 人第 ' + l.round + ' 轮到').join('')
  + '，敌 ' + s.foeMen + ' 人，士气 -' + s.foeMoraleHit
  + (s.ambush ? '，伏兵咬住了' : ''));
