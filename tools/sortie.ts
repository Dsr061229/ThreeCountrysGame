/**
 * 走一遍完整的出征：军议 → 定计 → 发兵 → 行军 → 接战 → 收兵。
 *
 * 上一个工具（tools/campaign.ts）只算「计划值多少」，
 * 这个工具跑的是**真的命令流** —— 状态、事件、战场、战果，一样不缺。
 * 它回答的是另一个问题：这套东西接起来之后，还成不成立。
 *
 *   node tools/sortie.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import {
  MISSION_NAME, ROUTE_NAME, type Mission,
} from '../src/sim/campaign_types.ts';
import { STARTING_CAMP } from '../src/sim/general_types.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'), terrain: read('terrain'), people: read('people'), text: read('text'),
} as ContentDB;
const idx = indexContent(content);

interface Order {
  share: number;
  mission: Mission;
  road: 'main' | 'byway' | 'mountain';
  officerId: string | null;
}

function play(seed: string, orders: Order[], loud: boolean): {
  outcome: string; merit: number; spoils: number; lost: number; ambush: boolean;
} {
  const e = new Engine(seed, content);
  e.dispatch({
    t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
  });

  // 给一支像样的兵，好让这一仗有得打
  const st0 = e.getState() as unknown as {
    camps: Record<string, { troops: number; training: number; grain: number; gear: number }>;
  };
  const camp = st0.camps[STARTING_CAMP]!;
  camp.troops = 700;
  camp.training = 62;
  camp.gear = 2;
  camp.grain = 4000;

  // 找一座近处的敌城
  const me = e.getState();
  const here = idx.node.get('yongqiu')!;
  const targets = Object.values(me.nodes)
    .filter((n) => n.factionId !== me.official.lordId)
    .map((n) => ({
      n,
      d: Math.hypot(
        idx.node.get(n.id)!.at[0] - here.at[0],
        idx.node.get(n.id)!.at[1] - here.at[1],
      ),
    }))
    .sort((a, b) => a.d - b.d);
  const target = targets[0]!.n;

  e.dispatch({ t: 'campaign_open', targetNodeId: target.id });
  const c0 = e.getState().campaign;
  if (!c0) return { outcome: 'no_campaign', merit: 0, spoils: 0, lost: 0, ambush: false };

  const roadOf = (want: string): string =>
    (c0.routes.find((r) => r.kind === want) ?? c0.routes[0]!).id;

  const troops = camp.troops;
  e.dispatch({
    t: 'campaign_plan',
    columns: orders.map((o) => ({
      men: Math.round(troops * o.share),
      routeId: roadOf(o.road),
      mission: o.mission,
      officerId: o.officerId,
    })),
  });
  if (e.getState().campaign!.columns.length === 0) {
    return { outcome: 'plan_rejected', merit: 0, spoils: 0, lost: 0, ambush: false };
  }

  e.dispatch({ t: 'campaign_go' });

  if (loud) {
    const c = e.getState().campaign!;
    console.log('  目标：' + (idx.node.get(target.id)?.name ?? target.id)
      + '（守军 ' + target.troops + '）  斥候 ' + c.scouting);
    console.log('  道：' + c.routes.map(
      (r) => ROUTE_NAME[r.kind] + ' ' + r.days + ' 日/隐蔽 ' + r.cover,
    ).join('　'));
    console.log('  敌军走：' + ROUTE_NAME[c.routes.find((r) => r.id === c.foeRouteId)!.kind]);
    for (const col of c.columns) {
      const o = col.officerId ? idx.person.get(col.officerId)! : null;
      const r = c.routes.find((x) => x.id === col.routeId)!;
      console.log('   ' + (o ? o.name : '（亲领）').padEnd(6)
        + String(col.men).padStart(4) + ' 人  '
        + ROUTE_NAME[r.kind] + '  ' + MISSION_NAME[col.mission]
        + (col.deviated ? '   ← ' + col.deviated : ''));
    }
  }

  // 行军
  const before = camp.troops;
  for (let d = 0; d < 90; d++) {
    const s = e.getState();
    if (s.field || !s.campaign) break;
    e.dispatch({ t: 'day' });
  }

  const f = e.getState().field;
  const ambush = f?.ambush ?? false;
  if (loud && f) {
    const own = f.units.filter((u) => u.side === 'own').reduce((a, u) => a + u.men, 0);
    const foe = f.units.filter((u) => u.side === 'foe').reduce((a, u) => a + u.men, 0);
    console.log('  接战：我 ' + own + ' 人，敌 ' + foe + ' 人'
      + (ambush ? '　【伏兵得手，敌军散乱】' : '')
      + (f.reinforcements.length > 0
        ? '　【第 ' + f.reinforcements[0]!.round + ' 轮有 '
          + f.reinforcements[0]!.men + ' 人从'
          + (f.reinforcements[0]!.from === 'rear' ? '敌后' : '侧翼') + '杀到】'
        : ''));
  }

  // 打。胜负要在收兵**之前**读 —— dismiss 之后 field 就没了
  let outcome = '—';
  for (let i = 0; i < 90; i++) {
    const s = e.getState();
    if (!s.field) break;
    const fb = s.field;
    if (fb.phase === 'done') {
      outcome = fb.outcome ?? '—';
      e.dispatch({ t: 'field_dismiss' });
      break;
    }
    if (fb.phase === 'deploy') {
      e.dispatch({ t: 'field_deploy', places: [], formation: 'heyi' });
      e.dispatch({ t: 'field_begin' });
      continue;
    }
    if (fb.pending) e.dispatch({ t: 'field_decide', option: 0 });
    else e.dispatch({ t: 'field_round' });
  }

  const st = e.getState() as unknown as {
    camps: Record<string, { troops: number; grain: number }>;
    official: { merit: number };
  };
  return {
    outcome,
    merit: st.official.merit,
    spoils: st.camps[STARTING_CAMP]!.grain - 4000,
    lost: before - st.camps[STARTING_CAMP]!.troops,
    ambush,
  };
}

const PLANS: { name: string; orders: Order[] }[] = [
  {
    name: '全军正击',
    orders: [{ share: 1, mission: 'assault', road: 'main', officerId: null }],
  },
  {
    name: '正击 + 侧击',
    orders: [
      { share: 0.65, mission: 'assault', road: 'main', officerId: null },
      { share: 0.35, mission: 'flank', road: 'byway', officerId: 'yuejin' },
    ],
  },
  {
    name: '三路：佯动 + 设伏 + 侧击',
    orders: [
      { share: 0.2, mission: 'feint', road: 'main', officerId: 'lidian' },
      { share: 0.5, mission: 'ambush', road: 'byway', officerId: 'caoren' },
      { share: 0.3, mission: 'flank', road: 'main', officerId: 'yuejin' },
    ],
  },
  {
    name: '三路，但让夏侯惇守伏',
    orders: [
      { share: 0.2, mission: 'feint', road: 'main', officerId: 'lidian' },
      { share: 0.5, mission: 'ambush', road: 'byway', officerId: 'xiahoudun' },
      { share: 0.3, mission: 'flank', road: 'main', officerId: 'yuejin' },
    ],
  },
];

console.log('  ── 一次出征从头到尾 ──');
play('demo3', PLANS[2]!.orders, true);

console.log('');
console.log('  ── 各种打法跑一百次 ──');
console.log('  打法                          胜率   平均战功   平均缴获   平均折损   伏中');
console.log('  ' + '─'.repeat(76));
for (const plan of PLANS) {
  let won = 0, merit = 0, spoils = 0, lost = 0, amb = 0;
  const n = 100;
  for (let i = 0; i < n; i++) {
    const r = play('s' + i, plan.orders, false);
    if (r.outcome === 'won') won++;
    merit += r.merit; spoils += r.spoils; lost += r.lost;
    if (r.ambush) amb++;
  }
  console.log(
    '  ' + plan.name.padEnd(28) +
    String(Math.round((won / n) * 100) + '%').padStart(5) +
    String(Math.round(merit / n)).padStart(10) +
    String(Math.round(spoils / n)).padStart(11) +
    String(Math.round(lost / n)).padStart(11) +
    String(Math.round((amb / n) * 100) + '%').padStart(7),
  );
}
