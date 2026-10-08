/**
 * 守城战推演。
 *
 * 要验的是三件事：
 *   1. 部署真的有分别 —— 全压城头、全守城门、平摊，结果应当明显不同
 *   2. 强攻是有胜有负的，不是必守或必破
 *   3. 城墙等级与守军数量的投入，能换来看得见的胜率
 *
 *   node tools/battle.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { type ContentDB } from '../src/sim/content.ts';
import type { Command } from '../src/sim/commands.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
    field: read('field'), facilities: read('facilities'), terrain: read('terrain'), people: read('people'),
  text: read('text'),
} as ContentDB;

type Plan = 'wall' | 'gate' | 'even' | 'reserve';
type Style = 'safe' | 'bold';

interface Setup {
  /** 户口。乡勇随它走 */ households: number;
  /** 兵营等级 0~3，每级 45 人 */ barracks: number;
  wallLevel: number;
  cityMorale: number;
  attackers: number;
}

/** 造一局到「敌军已经在城下」的状态，然后打一场强攻 */
function runAssault(seed: string, s: Setup, plan: Plan, style: Style): {
  held: boolean; defLeft: number; atkLeft: number; rounds: number;
} {
  const e = new Engine(seed, content);
  e.dispatch({ t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: 'caocao' });

  // 直接把局面摆成想测的样子。这是推演工具，不是玩法路径。
  //
  // 注意守军不能直接塞进 node.troops —— 每日结算都会用建筑重新推导它，
  // 塞进去当场就被覆盖。要造出想要的守军，得给真实的户口与兵营。
  const st = e.getState() as unknown as {
    cities: Record<string, {
      wall: number; morale: number; households: number;
      plots: { buildingId: string | null; level: number; work: unknown }[];
    }>;
    sieges: Record<string, unknown>;
  };
  const city = st.cities['yongqiu']!;
  city.wall = s.wallLevel;
  city.morale = s.cityMorale;
  city.households = s.households;
  if (s.barracks > 0) city.plots[7] = { buildingId: 'barracks', level: s.barracks, work: null };
  // days 设成 5：当日结算会先自增到 6，正好落在第一次强攻的门槛上
  st.sieges['yongqiu'] = {
    cityId: 'yongqiu', factionId: 'taiping',
    troops: s.attackers, supply: 12000, days: 5,
  };

  e.dispatch({ t: 'day' });
  const b = e.getState().battle;
  if (!b) throw new Error('强攻没有触发');

  const men = b.defMen;
  const split: Record<Plan, [number, number]> = {
    wall: [Math.floor(men * 0.8), Math.floor(men * 0.12)],
    gate: [Math.floor(men * 0.25), Math.floor(men * 0.6)],
    even: [Math.floor(men / 3), Math.floor(men / 3)],
    reserve: [Math.floor(men * 0.35), Math.floor(men * 0.15)],
  };
  const [wall, gate] = split[plan];
  e.dispatch({ t: 'deploy', wall, gate, reserve: men - wall - gate });

  let guard = 0;
  for (;;) {
    if (guard++ > 40) break;
    const cur = e.getState().battle;
    if (!cur || cur.phase === 'done') break;
    if (cur.pending) {
      // safe 取第一个（多半是稳妥的那个），bold 取带赌局的
      const opts = cur.pending.options;
      let pick = 0;
      if (style === 'bold') {
        const gambler = opts.findIndex((o) => o.effect.gamble !== undefined);
        pick = gambler >= 0 ? gambler : opts.length - 1;
      }
      e.dispatch({ t: 'decide', option: pick });
      continue;
    }
    e.dispatch({ t: 'battle_round' });
  }

  const fin = e.getState().battle!;
  return {
    held: fin.outcome === 'held',
    defLeft: fin.defMen,
    atkLeft: fin.atkMen,
    rounds: fin.round,
  };
}

function trial(s: Setup, plan: Plan, style: Style, n = 60): string {
  let held = 0, def = 0, atk = 0, rounds = 0;
  for (let i = 0; i < n; i++) {
    const r = runAssault('b' + i + plan + style, s, plan, style);
    if (r.held) held++;
    def += r.defLeft; atk += r.atkLeft; rounds += r.rounds;
  }
  return [
    plan.padEnd(8),
    style.padEnd(5),
    `守住 ${String(Math.round((held / n) * 100)).padStart(3)}%`,
    `余守军 ${String(Math.round(def / n)).padStart(4)}`,
    `余攻军 ${String(Math.round(atk / n)).padStart(4)}`,
    `${(rounds / n).toFixed(1)} 轮`,
  ].join('  ');
}

const cases: { name: string; s: Setup }[] = [
  {
    name: '毫无准备：户 140、无兵营、无城墙、民心 50，敌 500',
    s: { households: 140, barracks: 0, wallLevel: 0, cityMorale: 50, attackers: 500 },
  },
  {
    name: '略有防备：户 400、兵营 1、城墙 1、民心 60，敌 700',
    s: { households: 400, barracks: 1, wallLevel: 1, cityMorale: 60, attackers: 700 },
  },
  {
    name: '有备而来：户 700、兵营 2、城墙 2、民心 68，敌 1000',
    s: { households: 700, barracks: 2, wallLevel: 2, cityMorale: 68, attackers: 1000 },
  },
  {
    name: '经营多年：户 1100、兵营 3、城墙 3、民心 78，敌 1600',
    s: { households: 1100, barracks: 3, wallLevel: 3, cityMorale: 78, attackers: 1600 },
  },
  {
    name: '寡不敌众：户 700、兵营 2、城墙 2、民心 45，敌 2400',
    s: { households: 700, barracks: 2, wallLevel: 2, cityMorale: 45, attackers: 2400 },
  },
];

/** 只算胜率，用来横向比较各种摆法 */
function rate(s: Setup, plan: Plan, n = 60): number {
  let held = 0;
  for (let i = 0; i < n; i++) if (runAssault('r' + i + plan, s, plan, 'safe').held) held++;
  return Math.round((held / n) * 100);
}

const PLANS: Plan[] = ['wall', 'gate', 'even', 'reserve'];
const NAME: Record<Plan, string> = {
  wall: '\u538b\u57ce\u5934', gate: '\u5b88\u57ce\u95e8',
  even: '\u5e73\u644a', reserve: '\u539a\u9884\u5907',
};

// \u8981\u9a8c\u7684\u4e0d\u662f\u300c\u6709\u597d\u6709\u574f\u300d\uff0c\u800c\u662f\u300c\u6ca1\u6709\u54ea\u4e00\u79cd\u6446\u6cd5\u5904\u5904\u6700\u4f18\u300d
console.log('=== \u5404\u5c40\u9762\u4e0b\u7684\u6700\u4f18\u6446\u6cd5 ===');
for (const c of cases) {
  const rs = PLANS.map((pl) => rate(c.s, pl));
  let best = 0;
  for (let k = 1; k < rs.length; k++) if (rs[k]! > rs[best]!) best = k;
  console.log(
    c.name.padEnd(30)
    + rs.map((r, k) => (NAME[PLANS[k]!] + ' ' + r + '%').padStart(11)).join('')
    + '   \u6700\u4f18\uff1a' + NAME[PLANS[best]!],
  );
}

console.log('\n=== \u7a33\u59a5 vs \u5192\u9669 ===');
for (const c of cases) {
  console.log('\n' + c.name);
  for (const plan of PLANS) {
    for (const style of ['safe', 'bold'] as Style[]) {
      console.log('  ' + trial(c.s, plan, style, 40));
    }
  }
}

void (0 as unknown as Command);
