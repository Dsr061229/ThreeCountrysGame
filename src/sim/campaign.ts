/**
 * 出征的规则。
 *
 * 这个文件回答一个问题：**你摆的那个局，最后成不成？**
 *
 * 判定分三步，顺序不能乱：
 *
 *   一、敌军选道 —— 你的佯动往哪边拉，他就更可能往哪边走
 *   二、部将走样 —— 你派的人扛不扛得住这件差事
 *   三、结算局面 —— 伏兵咬没咬住、侧击赶不赶得上、粮道断没断
 *
 * 走样必须在选道**之后**判：马谡改走大道这件事，
 * 得先有「敌军会不会走大道」这个局面，才谈得上是不是坏了事。
 */
import { chancePermille, nextInt, nextRange } from './rng.ts';
import type { RngState } from './rng.ts';
import type { ContentIndex } from './content.ts';
import { deviationOf, deviationRisk } from './officer_types.ts';
import {
  AMBUSH_MORALE_HIT, AMBUSH_STRENGTH, DAY_MARCH, FEINT_PULL, FLANK_ROUND, LATE_ROUND,
  MIN_COLUMN_MEN, RAID_DECAY_PERMILLE, ROUTE_BASE,
  type Campaign, type Column, type DeviationKind, type Route,
} from './campaign_types.ts';
import {
  coverOf, landmarkOf, paceOf, surveyRoute, type RouteSurvey,
} from './terrain.ts';
import type { TerrainRegion } from './content.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ─────────────────────────────────────────────────────────────
// 铺路
// ─────────────────────────────────────────────────────────────

/**
 * 从这里到那里有哪几条道。
 *
 * 大道一定有 —— 没有大道就不叫出征，叫翻山。
 * 小道与山道则看地形，不是每一仗都有奇兵可用；
 * 这一条很要紧：**如果每次都能设伏，设伏就不值钱了**。
 */
export function makeRoutes(
  rng: RngState,
  from: [number, number],
  to: [number, number],
  regions: TerrainRegion[],
): Route[] {
  const survey = surveyRoute(from, to, regions);
  const land = landmarkOf(survey);
  const pace = paceOf(survey);
  const out: Route[] = [];

  // 一日行军多少图上单位。图上一单位约合三十里
  const daysFor = (mult: number): number =>
    Math.max(2, Math.round((survey.distance * pace * mult) / 1000 / DAY_MARCH));

  // 大道一定有 —— 没有大道就不叫出征，叫翻山。
  // 但大道也躲不开地形：秦岭挡在中间，走大道一样要多走十天
  out.push({
    id: 'main',
    kind: 'main',
    days: daysFor(1),
    cover: clamp(ROUTE_BASE.main.cover + Math.round(coverOf(survey) / 3), 0, 100),
    arrive: 'front',
    through: land ? '取道' + land.name : '一路坦途',
  });

  // 小道要有地方藏。
  //
  // **一马平川上没有小道** —— 这一条必须硬：
  // 否则玩家会在平原上设伏，而那本来就不该成立。
  // 中间隔着山林，绕路才有意义；隔得越多，可绕的越多。
  const rough = survey.mountain + survey.forest + survey.marsh;
  if (rough > 120) {
    const cov = coverOf(survey);
    out.push({
      id: 'byway',
      kind: 'byway',
      days: daysFor(1.35),
      cover: clamp(30 + cov + nextRange(rng, -6, 6), 0, 100),
      arrive: 'flank',
      through: land ? '穿' + land.name + '而过' : '绕行乡野',
    });
  }

  // 山道只有真有山的时候才有。它是这套系统里最锋利的一件东西
  if (survey.mountain > 200) {
    const peak = survey.crossings.find((c) => c.region.kind === 'mountain')?.region;
    out.push({
      id: 'mountain',
      kind: 'mountain',
      days: daysFor(1.85),
      cover: clamp(58 + coverOf(survey) + nextRange(rng, -5, 5), 0, 100),
      arrive: 'rear',
      through: peak ? '翻' + peak.name : '翻山',
    });
  }

  // 一条道走不成局面。实在无处可绕，也得有一条勉强的间道
  if (out.length < 2) {
    out.push({
      id: 'byway',
      kind: 'byway',
      days: daysFor(1.3),
      cover: clamp(22 + nextRange(rng, -6, 6), 0, 100),
      arrive: 'flank',
      through: '绕行乡野',
    });
  }
  return out;
}

/** 这一带的行军日程与地形，摆给玩家看 */
export function surveyBetween(
  from: [number, number], to: [number, number], regions: TerrainRegion[],
): RouteSurvey {
  return surveyRoute(from, to, regions);
}

// ─────────────────────────────────────────────────────────────
// 一、敌军选道
// ─────────────────────────────────────────────────────────────

/**
 * 敌军走哪条道。
 *
 * 底子是「谁好走走谁」—— 大道的权重天然最高。
 * 佯动改的就是这个权重：他看见你在那条道上张牙舞爪，
 * 就觉得那条有备，转而走别的。
 *
 * 这是整套设计的枢纽。佯动本身一个人也杀不了，
 * 它的全部价值是**把敌军推到伏兵等着的那条道上去**。
 */
export function pickFoeRoute(camp: Campaign, rng: RngState): string {
  const weights = new Map<string, number>();
  // 行军的人在意的是**几天能到**，不是藏不藏得住人 ——
  // 藏得住是伏兵关心的事。
  //
  // 上一版按隐蔽度算，结果小道与山道的隐蔽都顶到一百，权重一模一样，
  // 佯动把敌军平均推给两条，押哪条都只有三成。
  // 按日数算之后，次好走的那条自然成了他的第二选择，
  // 「看懂地形」这件事才有了用处。
  const fastest = Math.min(...camp.routes.map((r) => r.days));
  for (const r of camp.routes) {
    weights.set(r.id, Math.max(80, 1000 - (r.days - fastest) * 220));
  }
  for (const col of camp.columns) {
    if (col.mission !== 'feint' || col.state === 'lost') continue;
    const w = weights.get(col.routeId) ?? 0;
    weights.set(col.routeId, Math.max(30, w - FEINT_PULL));

    // 被挤下来的分量**按好走程度**摊给别的道，不是平均分。
    //
    // 大道看着有备，敌军会改走次好走的那一条 —— 而不是随手挑一条山路。
    // 平均分的后果是：路一多，敌军的去向就散了，
    // 伏兵押哪条都只有三成，「看懂地形」这件事反而没了用处。
    const others = camp.routes.filter((r) => r.id !== col.routeId);
    let ease = 0;
    for (const r of others) ease += Math.max(1, weights.get(r.id) ?? 1);
    for (const r of others) {
      const share = Math.floor((FEINT_PULL * Math.max(1, weights.get(r.id) ?? 1)) / ease);
      weights.set(r.id, (weights.get(r.id) ?? 0) + share);
    }
  }

  let total = 0;
  for (const w of weights.values()) total += w;
  let roll = nextInt(rng, Math.max(1, total));
  for (const [id, w] of weights) {
    roll -= w;
    if (roll < 0) return id;
  }
  return camp.routes[0]!.id;
}

// ─────────────────────────────────────────────────────────────
// 二、部将走样
// ─────────────────────────────────────────────────────────────

/**
 * 各路人马照没照着计划走。
 *
 * 走样不是给玩家添堵的随机数 —— 它是「你派了谁」的后果，
 * 所以每一次都要能说清楚是谁、为什么。战报里会写出来。
 */
export function rollDeviations(camp: Campaign, idx: ContentIndex, rng: RngState): void {
  for (const col of camp.columns) {
    const officer = col.officerId ? idx.person.get(col.officerId) ?? null : null;
    if (!officer) continue;
    const risk = deviationRisk(officer, col.mission);
    if (risk <= 0 || !chancePermille(rng, risk)) continue;
    col.deviated = deviationOf(officer.temper, col.mission) as DeviationKind;
    // 骄矜的人嫌小道难走改上大道 —— 于是他既不在小道上，也就伏不成兵了
    if (col.deviated === 'wrong_road') {
      const main = camp.routes.find((r) => r.kind === 'main');
      if (main) col.routeId = main.id;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 三、结算局面
// ─────────────────────────────────────────────────────────────

export interface SetupNote {
  textId: string;
  vars?: Record<string, string | number>;
  tone: 'good' | 'bad' | 'plain';
}

/** 约好晚到的一路 */
export interface LateColumn {
  round: number;
  men: number;
  officerId: string | null;
}

export interface Setup {
  /** 正面接战的自家兵 */
  ownMen: number;
  /**
   * 晚到的各路。
   *
   * 必须是一张**表**而不是一个「第几轮、多少人」。
   * 上一版只存一对数，于是「伏兵扑空（第六轮到）」
   * 和「侧击（第三轮到）」互相覆盖 ——
   * 结果是全军都约在第三轮，正面一个人也没有，
   * 一进战场我方只剩一个兜底的兵在对着七百人。
   */
  late: LateColumn[];
  /** 敌军实际能拉上战场的兵 */
  foeMen: number;
  /** 敌军士气的减项 */
  foeMoraleHit: number;
  /** 伏兵有没有咬住 */
  ambush: boolean;
  /** 这一仗为什么是这个样子，逐条写给玩家看 */
  notes: SetupNote[];
}

/**
 * 把一份计划算成一场仗的开局。
 *
 * 这里是整个设计成不成立的地方：
 * 「佯动 + 设伏」必须明显强于「全军正击」，否则玩家没有理由动脑子；
 * 但它也必须**会落空** —— 敌军没走那条道，你就白等一场。
 */
export function resolveSetup(camp: Campaign, idx: ContentIndex): Setup {
  const notes: SetupNote[] = [];
  const late: LateColumn[] = [];
  let ownMen = 0;
  let foeMen = camp.foeTroops;
  let foeMoraleHit = 0;
  let ambush = false;

  for (const col of camp.columns) {
    if (col.men < MIN_COLUMN_MEN) continue;
    const officer = col.officerId ? idx.person.get(col.officerId) ?? null : null;
    const name = officer?.name ?? '你';

    if (col.deviated) {
      notes.push({ textId: 'cp.dev.' + col.deviated, vars: { name }, tone: 'bad' });
    }

    switch (col.mission) {
      case 'assault':
        ownMen += col.men;
        // 贪功追出去的那一路，打着打着就不见了
        if (col.deviated === 'chased') ownMen -= Math.floor(col.men / 2);
        break;

      case 'flank':
        // 侧击要卡时候。来早了是添油，来晚了赶不上收尾
        if (col.deviated === 'late') {
          // 来晚了不等于没来。赶上的是后半场，扳不扳得回来看运气
          late.push({ round: LATE_ROUND, men: col.men, officerId: col.officerId });
          notes.push({ textId: 'cp.flank_late', vars: { name }, tone: 'bad' });
          break;
        }
        if (col.deviated === 'early') {
          ownMen += col.men;
          notes.push({ textId: 'cp.flank_early', vars: { name }, tone: 'bad' });
          break;
        }
        late.push({ round: FLANK_ROUND, men: col.men, officerId: col.officerId });
        notes.push({ textId: 'cp.flank_set', vars: { name }, tone: 'good' });
        break;

      case 'ambush': {
        if (col.deviated === 'early') {
          notes.push({ textId: 'cp.ambush_early', vars: { name }, tone: 'bad' });
          ownMen += col.men;
          break;
        }
        if (col.deviated === 'wrong_road') {
          notes.push({ textId: 'cp.ambush_wrong', vars: { name }, tone: 'bad' });
          ownMen += col.men;
          break;
        }
        if (col.deviated === 'late') {
          // 到得晚了，敌军已经过去了。埋伏这件事差一个时辰就是差了
          late.push({ round: LATE_ROUND, men: col.men, officerId: col.officerId });
          notes.push({ textId: 'cp.ambush_late', vars: { name }, tone: 'bad' });
          break;
        }
        if (col.routeId !== camp.foeRouteId) {
          // 伏兵不遇，引兵还。
          //
          // 人还在 —— 落空的代价是**先手**，不是这支军队。
          // 上一版让这一路整场仗都不出现，于是「设伏」不是决策，是赌命：
          // 押中了翻倍，押不中全没。没人会去做这种选择，
          // 做了也不是在动脑子，是在掷骰子。
          late.push({ round: LATE_ROUND, men: col.men, officerId: col.officerId });
          notes.push({ textId: 'cp.ambush_missed', vars: { name }, tone: 'bad' });
          break;
        }
        ambush = true;
        ownMen += col.men;
        foeMoraleHit += AMBUSH_MORALE_HIT;
        foeMen = Math.floor((foeMen * AMBUSH_STRENGTH) / 1000);
        notes.push({ textId: 'cp.ambush_sprung', vars: { name }, tone: 'good' });
        break;
      }

      case 'feint':
        // 佯动的人不参战 —— 他的功劳已经记在敌军选的那条道上了
        notes.push({ textId: 'cp.feint', vars: { name }, tone: 'plain' });
        break;

      case 'raid': {
        if (col.deviated) break;
        const days = Math.max(0, col.progress);
        const decay = Math.min(400, days * RAID_DECAY_PERMILLE);
        foeMen = Math.floor((foeMen * (1000 - decay)) / 1000);
        foeMoraleHit += Math.floor(decay / 20);
        notes.push({ textId: 'cp.raid', vars: { name, days }, tone: 'good' });
        break;
      }
    }
  }

  late.sort((a, b) => a.round - b.round);

  // 正面一个人都没有的仗打不起来 —— 谁先到，谁就是正兵。
  //
  // 这一条不是补丁，是常识：一支军队不可能整个都「稍后抵达」。
  // 计划全落空的时候（伏兵扑空、正兵那一路又没派），
  // 先头那一路就得硬着头皮顶上去，而不是让画面上出现
  // 一个人对着七百人。
  if (ownMen <= 0 && late.length > 0) {
    const first = late.shift()!;
    ownMen = first.men;
    notes.push({ textId: 'cp.forced_front', vars: { men: first.men }, tone: 'bad' });
  }

  return {
    ownMen: Math.max(0, ownMen),
    late,
    foeMen: Math.max(1, foeMen),
    foeMoraleHit,
    ambush,
    notes,
  };
}

/** 这份计划合不合规矩 */
export function validatePlan(
  columns: Column[], available: number, routes: Route[],
): string | null {
  if (columns.length === 0) return 'no_columns';
  let sum = 0;
  const seen = new Set<string>();
  for (const c of columns) {
    if (c.men < MIN_COLUMN_MEN) return 'column_too_small';
    if (!routes.some((r) => r.id === c.routeId)) return 'no_such_route';
    if (c.officerId) {
      if (seen.has(c.officerId)) return 'officer_twice';
      seen.add(c.officerId);
    }
    sum += c.men;
  }
  if (sum > available) return 'not_enough_men';
  return null;
}
