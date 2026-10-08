/**
 * 解围之战的推演。
 *
 * 平衡工具 `tools/theatre.ts` 打的全是**攻城**，
 * 而攻城里伏兵本来就没有用武之地 —— 守军蹲在墙后不出来，
 * 你把三百人藏进林子，等于自断一路去撞城墙。
 * 于是那张表上「诱敌 + 林中埋伏」只有 8% 胜率，
 * 看着像是伏击这套玩法废了，其实是**场子选错了**。
 *
 * 伏击的场子是野战：主公的城被围，你带兵去解围，
 * 围城的那一路分兵来截你 —— 他动，你才伏得着他。
 *
 * 这个工具只问一句：在野战里，**多花心思排的兵，是不是真的更划算**。
 *
 *   node tools/relief.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import { STARTING_CAMP } from '../src/sim/general_types.ts';
import type { Stance, Theatre, UnitKind } from '../src/sim/theatre_types.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'),
  terrain: read('terrain'), people: read('people'), text: read('text'),
} as ContentDB;
void indexContent(content);

interface Col { kind: UnitKind; men: number; at: [number, number]; stance: Stance; who: string | null }

function stage(seed: string, mine: number, foe: number): { e: Engine; t: Theatre } {
  const e = new Engine(seed, content);
  e.dispatch({ t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao', role: 'general' });
  const st = e.getState() as never as {
    camps: Record<string, { troops: number; training: number; gear: number; grain: number }>;
    sieges: Record<string, unknown>;
    official: { cityId: string };
    retinue: string[];
  };
  const camp = st.camps[STARTING_CAMP]!;
  camp.troops = mine; camp.training = 70; camp.gear = 3; camp.grain = 6000;
  st.retinue = ['yuejin', 'lidian', 'caoren'];
  const at = st.official.cityId;
  st.sieges[at] = { cityId: at, factionId: 'taiping', troops: foe, supply: 9000, days: 3 };
  e.dispatch({ t: 'theatre_open', targetNodeId: at });
  return { e, t: e.getState().theatre! };
}

/** 在这一带找一块藏得住人的地 */
function cover(t: Theatre, cx: number, cy: number): [number, number] | null {
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (let r = 1; r < t.rows - 1; r++) {
    for (let c = 1; c < t.cols - 1; c++) {
      const g = t.cells[r * t.cols + c]!.ground;
      if (g !== 'forest' && g !== 'hill') continue;
      const d = Math.hypot(c - cx, r - cy);
      if (d < bestD) { bestD = d; best = [c, r]; }
    }
  }
  return best;
}
/** 站得住脚的地。免得把兵派进水里 */
function dry(t: Theatre, cx: number, cy: number): [number, number] {
  for (let rad = 0; rad < 8; rad++) {
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const c = Math.round(cx + dx); const r = Math.round(cy + dy);
        if (c < 1 || r < 1 || c >= t.cols - 1 || r >= t.rows - 1) continue;
        if (t.cells[r * t.cols + c]!.ground !== 'water') return [c, r];
      }
    }
  }
  return [Math.round(cx), Math.round(cy)];
}

type Plan = (t: Theatre) => Col[];

const PLANS: Record<string, Plan> = {
  '全军平推': (t) => {
    const mid = dry(t, (t.ownCamp[0] + t.foeCamp[0]) / 2, t.ownCamp[1]);
    return [
      { kind: 'foot', men: Math.round(t.pool.foot * 0.55), at: mid, stance: 'assault', who: null },
      { kind: 'foot', men: Math.round(t.pool.foot * 0.45), at: mid, stance: 'assault', who: 'yuejin' },
      { kind: 'bow', men: t.pool.bow, at: mid, stance: 'assault', who: 'lidian' },
    ];
  },
  '一路诱敌 + 半路设伏': (t) => {
    const midX = (t.ownCamp[0] + t.foeCamp[0]) / 2;
    const spot = cover(t, midX, t.ownCamp[1]) ?? dry(t, midX, t.ownCamp[1] - 4);
    const bait = dry(t, midX + 3, t.ownCamp[1]);
    return [
      // 诱：一小股顶上去，把来截的那一路引到伏圈边上
      { kind: 'foot', men: Math.round(t.pool.foot * 0.30), at: bait, stance: 'assault', who: null },
      // 伏：主力藏在林子或坡上
      { kind: 'foot', men: Math.round(t.pool.foot * 0.70), at: spot, stance: 'ambush', who: 'yuejin' },
      { kind: 'bow', men: t.pool.bow, at: spot, stance: 'ambush', who: 'lidian' },
    ];
  },
  '守住要路，等他来撞': (t) => {
    const midX = (t.ownCamp[0] + t.foeCamp[0]) / 2;
    const hi = cover(t, midX, t.ownCamp[1]) ?? dry(t, midX, t.ownCamp[1]);
    return [
      { kind: 'foot', men: Math.round(t.pool.foot * 0.55), at: hi, stance: 'hold', who: null },
      { kind: 'foot', men: Math.round(t.pool.foot * 0.45), at: hi, stance: 'reserve', who: 'yuejin' },
      { kind: 'bow', men: t.pool.bow, at: hi, stance: 'hold', who: 'lidian' },
    ];
  },
  '牵制 + 偷袭大营': (t) => {
    const mid = dry(t, (t.ownCamp[0] + t.foeCamp[0]) / 2, t.ownCamp[1]);
    return [
      { kind: 'foot', men: Math.round(t.pool.foot * 0.55), at: mid, stance: 'assault', who: null },
      { kind: 'foot', men: Math.round(t.pool.foot * 0.45), at: mid, stance: 'raid', who: 'yuejin' },
      { kind: 'bow', men: t.pool.bow, at: mid, stance: 'assault', who: 'lidian' },
    ];
  },
};

const RUNS = 30;
/**
 * 真实的解围之战是**以少击众**：围城的常有五六百人，
 * 而一个裨将的营里只坐得下二百。所以这张表要从劣势那一头开始扫，
 * 不能只看一个我随手编的九百对七百六。
 */
function table(mine: number, foe: number): void {
  for (const [name, plan] of Object.entries(PLANS)) {
    let wins = 0, ownLeft = 0, foeLeft = 0, ticks = 0, lost = 0, ran = 0;
    for (let i = 0; i < RUNS; i++) {
      const { e, t } = stage('r' + i, mine, foe);
      let sent = 0;
      for (const c of plan(t)) {
        if (c.men < 40 || c.men > t.pool[c.kind]) continue;
        const r = e.dispatch({
          t: 'theatre_send', kind: c.kind, men: c.men,
          col: c.at[0], row: c.at[1], stance: c.stance, officerId: c.who,
        });
        if (r.some((x) => x.t === 'theatre_sent')) sent++;
      }
      if (sent === 0) continue;
      e.dispatch({ t: 'theatre_begin' });
      let g = 0;
      while (t.phase === 'fighting' && g++ < 950) e.dispatch({ t: 'theatre_step', ticks: 1 });
      ran++;
      if (t.outcome === 'won') wins++;
      ownLeft += t.units.filter((u) => u.side === 'own' && !u.routed).reduce((a, u) => a + u.men, 0);
      foeLeft += t.units.filter((u) => u.side === 'foe' && !u.routed).reduce((a, u) => a + u.men, 0);
      ticks += t.tick;
      lost += t.result?.lost ?? 0;
    }
    const n = Math.max(1, ran);
    console.log(
      '  ' + name.padEnd(24)
      + String(Math.round((wins / n) * 100) + '%').padStart(6)
      + String(Math.round(ownLeft / n)).padStart(8)
      + String(Math.round(foeLeft / n)).padStart(9)
      + String(Math.round(ticks / n)).padStart(11)
      + String(Math.round(lost / n)).padStart(7),
    );
  }
}

const FOE = 550;
for (const mine of [300, 450, 600, 900]) {
  console.log(`
  解围：我 ${mine} 出营，围城的有 ${FOE} 人。跑 ${RUNS} 局。
`);
  console.log('  打法                        胜率   我军余   敌军余   平均拍数   我折');
  console.log('  ' + '─'.repeat(72));
  table(mine, FOE);
}
console.log('');
