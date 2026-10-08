/**
 * 战场推演。
 *
 * 这套东西的全部赌注在一句话上：**位置本身要有分量**。
 * 所以这个工具只问三件事：
 *
 *   一、伏兵藏在林子里，敌军会不会真的走过去没看见？
 *   二、同样的兵，摆在坡上和摆在平地上，结果差多少？
 *   三、绕到背后打，和迎面撞上去，差多少？
 *
 * 如果这三条答案都是「差不多」，那这张地图就是个背景板，
 * 玩家在上面点哪儿都一样 —— 那还不如回去做阵型台。
 *
 *   node tools/theatre.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import { makeTheatre, newUnit } from '../src/sim/theatre_setup.ts';
import { stepTheatre } from '../src/sim/theatre.ts';
import { GROUND_NAME, KIND_NAME, type Stance, type Theatre, type UnitKind } from '../src/sim/theatre_types.ts';
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

interface Order {
  kind: UnitKind;
  men: number;
  /** 派到哪儿。用相对位置：0 = 我营，1 = 敌营 */
  at: [number, number];
  stance: Stance;
}

function stage(seed: string, troops: number, foe: number): {
  e: Engine; t: Theatre;
} {
  const e = new Engine(seed, content);
  e.dispatch({
    t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general',
  });
  const st = e.getState() as never as {
    camps: Record<string, {
      troops: number; training: number; grain: number; gear: number;
      works: Record<string, number>;
    }>;
    nodes: Record<string, { troops: number; factionId: string }>;
  };
  const camp = st.camps[STARTING_CAMP]!;
  camp.troops = troops;
  camp.training = 70;
  camp.works = { jiaochang: 3, gongnufang: 3, jiuli: 2 };
  st.nodes['chenliu']!.factionId = 'lvbu';
  st.nodes['chenliu']!.troops = foe;

  const t = makeTheatre(
    e.getState() as never, idx, camp as never, 'chenliu',
  )!;
  return { e, t };
}

function deploy(e: Engine, t: Theatre, orders: Order[]): void {
  for (const o of orders) {
    const x = t.ownCamp[0] + (t.foeCamp[0] - t.ownCamp[0]) * o.at[0];
    const y = t.ownCamp[1] + (t.rows / 2 - t.ownCamp[1]) + (o.at[1] - 0.5) * t.rows * 0.85;
    const men = Math.min(o.men, t.pool[o.kind]);
    if (men < 40) continue;
    t.pool[o.kind] -= men;
    const u = newUnit(
      e.getState() as never, 'own', o.kind, men,
      t.ownCamp[0] + 1, t.ownCamp[1],
    );
    u.toX = Math.max(1, Math.min(t.cols - 2, x));
    u.toY = Math.max(1, Math.min(t.rows - 2, y));
    u.stance = o.stance;
    if (o.stance === 'ambush') {
      // 伏兵一开始就在位上藏好 —— 不然还没走到就被看见了
      u.x = u.toX; u.y = u.toY;
      u.hidden = true;
    }
    t.units.push(u);
  }
  t.phase = 'fighting';
}

function run(e: Engine, t: Theatre): void {
  const rng = (e.getState() as never as { rng: never }).rng;
  let guard = 0;
  while (t.phase === 'fighting' && guard++ < 2000) stepTheatre(t, rng);
}

function tally(t: Theatre): { own: number; foe: number; outcome: string } {
  const own = t.units.filter((u) => u.side === 'own' && !u.routed).reduce((a, u) => a + u.men, 0);
  const foe = t.units.filter((u) => u.side === 'foe' && !u.routed).reduce((a, u) => a + u.men, 0);
  return { own, foe, outcome: t.outcome ?? '—' };
}

// ─────────────────────────────────────────────────────────────

const PLANS: { name: string; make: (t: Theatre) => Order[] }[] = [
  {
    name: '全军平推',
    make: () => [
      { kind: 'foot', men: 9999, at: [0.9, 0.5], stance: 'assault' },
      { kind: 'bow', men: 9999, at: [0.85, 0.5], stance: 'assault' },
      { kind: 'horse', men: 9999, at: [0.9, 0.5], stance: 'assault' },
    ],
  },
  {
    name: '正面 + 骑兵包抄',
    make: () => [
      { kind: 'foot', men: 9999, at: [0.9, 0.5], stance: 'assault' },
      { kind: 'bow', men: 9999, at: [0.8, 0.5], stance: 'assault' },
      { kind: 'horse', men: 9999, at: [0.95, 0.08], stance: 'assault' },
    ],
  },
  {
    name: '诱敌 + 林中埋伏',
    make: (t) => {
      const spot = findForest(t);
      return [
        { kind: 'foot', men: 9999, at: [0.9, 0.5], stance: 'assault' },
        { kind: 'bow', men: 9999, at: [0.3, 0.5], stance: 'hold' },
        {
          kind: 'horse', men: 9999,
          at: [(spot[0] - t.ownCamp[0]) / (t.foeCamp[0] - t.ownCamp[0]), spot[1] / t.rows],
          stance: 'ambush',
        },
      ];
    },
  },
  {
    name: '正面牵制 + 偷袭大营',
    make: () => [
      { kind: 'foot', men: 9999, at: [0.75, 0.5], stance: 'assault' },
      { kind: 'bow', men: 9999, at: [0.7, 0.5], stance: 'hold' },
      { kind: 'horse', men: 9999, at: [1, 0.5], stance: 'raid' },
    ],
  },
];

function findForest(t: Theatre): [number, number] {
  for (let r = 2; r < t.rows - 2; r++) {
    for (let c = Math.floor(t.cols * 0.4); c < t.cols * 0.8; c++) {
      if (t.cells[r * t.cols + c]!.ground === 'forest') return [c, r];
    }
  }
  return [t.cols * 0.6, t.rows / 2];
}

console.log('  我方 800 人（校场3 弓弩坊3 厩栏2），敌军 900 人守陈留。');
console.log('');
console.log('  打法                    胜率   我军余   敌军余   平均拍数');
console.log('  ' + '─'.repeat(64));

for (const plan of PLANS) {
  let won = 0, own = 0, foe = 0, ticks = 0;
  const n = 60;
  for (let i = 0; i < n; i++) {
    const { e, t } = stage('th' + i, 800, 900);
    deploy(e, t, plan.make(t));
    run(e, t);
    const r = tally(t);
    if (r.outcome === 'won') won++;
    own += r.own; foe += r.foe; ticks += t.tick;
  }
  console.log(
    '  ' + plan.name.padEnd(24) +
    String(Math.round((won / n) * 100) + '%').padStart(5) +
    String(Math.round(own / n)).padStart(8) +
    String(Math.round(foe / n)).padStart(9) +
    String(Math.round(ticks / n)).padStart(10),
  );
}

// ── 地形到底有没有分量 ────────────────────────────────────
console.log('');
console.log('  ── 同样一支弓弩，摆在不同的地方 ──');
for (const where of ['plain', 'hill', 'forest', 'marsh'] as const) {
  let own = 0, foe = 0, won = 0;
  const n = 40;
  for (let i = 0; i < n; i++) {
    const { e, t } = stage('g' + i, 800, 900);
    // 把中间那块地整片改成要测的地面
    for (let r = 0; r < t.rows; r++) {
      for (let c = Math.floor(t.cols * 0.45); c < t.cols * 0.62; c++) {
        t.cells[r * t.cols + c] = { ground: where, height: where === 'hill' ? 2 : 0 };
      }
    }
    // 守在那块地上等敌军来撞 —— 敌军的主力是会迎上来的，
    // 所以这一仗必定在那块地上打
    deploy(e, t, [
      { kind: 'foot', men: 9999, at: [0.53, 0.5], stance: 'hold' },
      { kind: 'bow', men: 9999, at: [0.5, 0.5], stance: 'hold' },
      { kind: 'horse', men: 9999, at: [0.53, 0.62], stance: 'hold' },
    ]);
    run(e, t);
    const r = tally(t);
    own += r.own; foe += r.foe;
    if (r.outcome === 'won') won++;
  }
  console.log(
    '  据守' + GROUND_NAME[where].padEnd(6) +
    String(Math.round((won / n) * 100) + '%').padStart(6) + ' 胜' +
    String(Math.round(own / n)).padStart(7) + ' 存' +
    String(Math.round(foe / n)).padStart(7) + ' 敌余',
  );
}

// ── 伏兵真的藏得住吗 ──────────────────────────────────────
console.log('');
console.log('  ── 伏兵藏在哪儿，敌军多久才发现 ──');
for (const where of ['plain', 'forest', 'hill'] as const) {
  let seenAt = 0, never = 0;
  const n = 40;
  for (let i = 0; i < n; i++) {
    const { e, t } = stage('a' + i, 800, 900);
    const cx = Math.round(t.cols * 0.55);
    const cy = Math.round(t.rows / 2);
    for (let r = cy - 3; r <= cy + 3; r++) {
      for (let c = cx - 3; c <= cx + 3; c++) {
        if (r < 0 || r >= t.rows || c < 0 || c >= t.cols) continue;
        t.cells[r * t.cols + c] = { ground: where, height: where === 'hill' ? 2 : 0 };
      }
    }
    const u = newUnit(e.getState() as never, 'own', 'foot', 300, cx, cy);
    u.stance = 'ambush'; u.hidden = true; u.toX = cx; u.toY = cy;
    t.units.push(u);
    // 再派一支正兵把敌人引过来
    const bait = newUnit(e.getState() as never, 'own', 'foot', 200, t.ownCamp[0] + 1, t.ownCamp[1]);
    bait.stance = 'assault'; bait.toX = t.foeCamp[0]; bait.toY = t.foeCamp[1];
    t.units.push(bait);
    t.phase = 'fighting';

    const rng = (e.getState() as never as { rng: never }).rng;
    let at = -1;
    for (let k = 0; k < 900 && t.phase === 'fighting'; k++) {
      stepTheatre(t, rng);
      if (u.revealed && at < 0) { at = t.tick; break; }
    }
    if (at < 0) never++; else seenAt += at;
  }
  const found = n - never;
  console.log(
    '  伏在' + GROUND_NAME[where].padEnd(6) +
    (found > 0 ? '第 ' + Math.round(seenAt / found) + ' 拍暴露' : '始终没被发现').padStart(14) +
    '　' + Math.round((never / n) * 100) + '% 一直没被发现',
  );
}

console.log('');
console.log('  ── 一张战场长什么样 ──');
{
  const { t } = stage('look', 800, 900);
  const glyph: Record<string, string> = {
    plain: '·', road: '=', forest: '木', hill: '▲', water: '~', marsh: '沼',
  };
  for (let r = 0; r < t.rows; r += 2) {
    let line = '  ';
    for (let c = 0; c < t.cols; c++) {
      const cell = t.cells[r * t.cols + c]!;
      const isOwn = Math.round(t.ownCamp[0]) === c && Math.abs(t.ownCamp[1] - r) < 1.5;
      const isFoe = Math.round(t.foeCamp[0]) === c && Math.abs(t.foeCamp[1] - r) < 1.5;
      line += isOwn ? '我' : isFoe ? '敌' : glyph[cell.ground] ?? '·';
    }
    console.log(line);
  }
  console.log('  敌军：' + t.units.filter((u) => u.side === 'foe')
    .map((u) => KIND_NAME[u.kind] + u.men + (u.hidden ? '（伏）' : ''))
    .join('、'));
  console.log('  我的兵：步卒 ' + t.pool.foot + '、弓弩 ' + t.pool.bow + '、骑兵 ' + t.pool.horse);
}
