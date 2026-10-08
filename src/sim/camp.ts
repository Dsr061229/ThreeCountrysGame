/**
 * 屯兵地的规则。
 *
 * 全是纯函数与就地推进，和 city.ts 一个路数：
 * 派生量（每日口粮、战力、能不能开工）一律现算，绝不存进状态里。
 *
 * 这条线的重心是**粮**。兵不是越多越好 —— 多一百个兵就是每天多三石粮，
 * 而粮要向主公要，主公给不给取决于他自己手上还剩几座城。
 * 所以「招兵」在这里不是一个纯增益的按钮，是一笔要还的账。
 */
import { chancePermille, nextInt } from './rng.ts';
import type { RngState } from './rng.ts';
import {
  CAMP_BREAK_MORALE, DRILL_GAIN, DRILL_GRAIN_PER_100, FED_MORALE,
  GEAR_MAX, GRAIN_CAP_BASE, GRAIN_PER_100_PER_DAY, LEVIES, OFFICER_SLOTS_BASE,
  RATION_CAP_BY_RANK, STARVE_DESERT_PERMILLE, STARVE_MORALE,
  SITE_EFFECT, TRAIN_CAP_BASE, TRAINING_DECAY, trackOf,
  TUNTIAN_PER_100, TUNTIAN_TRAINING_DECAY,
  type Camp, type CampJob, type CampWork, type JobTrack, type Levy,
} from './general_types.ts';
import type { ContentIndex, FacilityDef } from './content.ts';
import type { WorldState } from './state.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 主公的家底里，有多少能匀给你这一路 */
const LORD_SHARE = 6;

/**
 * 营中一处设施修到了几级。没修就是 0。
 */
export function levelOf(camp: Camp, id: string): number {
  return camp.works[id] ?? 0;
}

/** 营里摆了几处设施 */
export function facilityCount(camp: Camp): number {
  return Object.values(camp.works).filter((v) => v > 0).length;
}

/**
 * 营中各项设施加起来，给了你什么。
 *
 * 一律现算，绝不存进状态里 —— 与城里那套派生量同一个规矩。
 * 存下来的后果是：改一个数值要写一次迁移，而漏写一次就再也对不上。
 */
export interface CampOutput {
  /** 训练度的上限 */
  trainCap: number;
  /** 一次操练涨多少 */
  drillGain: number;
  /** 骑兵最多占几成（千分数） */
  horseCap: number;
  /** 弓弩最多占几成（千分数） */
  bowCap: number;
  gearCap: number;
  grainCap: number;
  /** 屯田每百人每日的产出 */
  tuntianPer100: number;
  /** 点将时最多能派几个部将 */
  officerSlots: number;
  /** 守营时的加成（千分数） */
  defence: number;
  /** 营藏得住多少。林中之营斥候不容易摸清虚实 */
  cover: number;
}

export function campOutput(camp: Camp, idx: ContentIndex): CampOutput {
  const out: CampOutput = {
    trainCap: TRAIN_CAP_BASE,
    drillGain: DRILL_GAIN,
    horseCap: 0,
    bowCap: 120,
    gearCap: 1,
    grainCap: GRAIN_CAP_BASE,
    tuntianPer100: TUNTIAN_PER_100,
    officerSlots: OFFICER_SLOTS_BASE,
    defence: 1000,
    cover: 0,
  };
  for (const [id, level] of Object.entries(camp.works)) {
    if (level <= 0) continue;
    const def = idx.facility.get(id);
    if (!def) continue;
    out.trainCap += (def.trainCap ?? 0) * level;
    out.drillGain += (def.drillBonus ?? 0) * level;
    out.horseCap += (def.horse ?? 0) * level;
    out.bowCap += (def.bow ?? 0) * level;
    out.gearCap += (def.gearCap ?? 0) * level;
    out.grainCap += (def.grainCap ?? 0) * level;
    out.tuntianPer100 += (def.tuntian ?? 0) * level;
    out.officerSlots += (def.officers ?? 0) * level;
    out.defence += (def.defence ?? 0) * level;
  }
  // 扎营的地方也算数。傍山的营难攻，平野的营屯田最好 ——
  // 「在哪儿下寨」因此不是一句风景描述
  const site = SITE_EFFECT[camp.site];
  out.defence += site.defence;
  out.tuntianPer100 = Math.max(1, out.tuntianPer100 + site.tuntian);
  out.cover = site.cover;

  out.trainCap = clamp(out.trainCap, 0, 100);
  out.horseCap = Math.min(300, out.horseCap);
  out.bowCap = Math.min(400, out.bowCap);
  out.gearCap = Math.min(GEAR_MAX, out.gearCap);
  return out;
}

/** 修这一处到下一级要多少粮、几天 */
export function facilityCost(
  def: FacilityDef, toLevel: number,
): { grain: number; days: number } {
  const mult = Math.pow(def.costGrowth / 1000, Math.max(0, toLevel - 1));
  return {
    grain: Math.round(def.costGrain * mult),
    days: Math.round(def.costDays * Math.pow(1.28, Math.max(0, toLevel - 1))),
  };
}

/** 今天要吃多少粮。操练期间吃得更多 —— 练兵是要吃饱的 */
export function upkeepOf(camp: Camp): number {
  const per100 = GRAIN_PER_100_PER_DAY
    + (camp.jobs.some((j) => j.job === 'drill') ? DRILL_GRAIN_PER_100 : 0);
  return Math.max(1, Math.ceil((camp.troops * per100) / 100));
}

/** 这一摊人手上有没有活 */
export function busyOn(camp: Camp, track: JobTrack): CampWork | null {
  return camp.jobs.find((j) => trackOf(j.job) === track) ?? null;
}

/** 屯田今天能收多少粮。没开屯就是 0 */
export function harvestOf(camp: Camp, per100 = TUNTIAN_PER_100): number {
  if (!camp.farming) return 0;
  return Math.floor((camp.troops * per100) / 100);
}

/** 今天净进出多少粮。负数就是在吃老本 */
export function grainFlowOf(camp: Camp): number {
  return harvestOf(camp) - upkeepOf(camp);
}

/**
 * 还够吃几天。断粮前的这个数字是武将路线上最要紧的一个。
 *
 * 算的是**净流出**：开着屯田的营，粮是往上走的，那就没有「还够吃几天」这回事。
 */
export function daysOfGrain(camp: Camp): number {
  const flow = grainFlowOf(camp);
  if (flow >= 0) return 999;
  return Math.floor(camp.grain / -flow);
}

/**
 * 军心该稳在哪儿。
 *
 * 吃得上饭是底线，练得出来是底气，器械齐整是脸面；
 * 部曲多了则人心不齐 —— 那些人本来就是豪族的，不是你的。
 */
export function moraleTargetOf(camp: Camp): number {
  const retainerShare = camp.troops > 0
    ? Math.floor((camp.retainers * 100) / camp.troops)
    : 0;
  return clamp(
    48
    + Math.floor(camp.training / 4)
    + camp.gear * 2
    - Math.floor(retainerShare / 4),
    0, 100,
  );
}

/**
 * 这营兵值多少战力。
 *
 * 训练度与军心都是乘数而不是加数 —— 两千个饿着肚子的新兵
 * 打不过八百个吃饱了的老卒，这一条必须在数值上成立，
 * 否则「练兵」就只是个把数字堆上去的按钮。
 */
export function strengthOf(camp: Camp): number {
  const train = 700 + camp.training * 6;
  const spirit = 600 + camp.morale * 5;
  const gear = 1000 + camp.gear * 70;
  return Math.floor((camp.troops * train * spirit * gear) / 1e9);
}

/** 能不能开一项新工。营里一次只做一件事 */
export function canStart(camp: Camp, job: CampJob, levy: Levy | null): string | null {
  // 同一摊人管的事不能并着办
  if (busyOn(camp, trackOf(job))) return 'busy';
  // 兵在地里就不在校场上 —— 但招兵与修营不耽误，那不是同一批人
  if (camp.farming && job === 'drill') return 'farming';
  if (job === 'levy') {
    if (!levy) return 'no_levy';
    const def = LEVIES[levy];
    const cost = Math.ceil((def.men * def.grainPer100) / 100);
    if (camp.grain < cost) return 'no_grain';
  }
  return null;
}

/**
 * 营过一天。
 *
 * 顺序是有讲究的：**先吃饭，再干活**。
 * 断了粮的营是练不了兵的，也不该在饿死人的同一天把训练度涨上去。
 */
export function tickCamp(
  camp: Camp, rng: RngState, day: number, out0: CampOutput,
): CampEvent[] {
  const out: CampEvent[] = [];
  // 先收后吃。屯田收上来的粮当天就能下锅
  const got = harvestOf(camp, out0.tuntianPer100);
  if (got > 0) camp.grain = Math.min(out0.grainCap, camp.grain + got);
  const need = upkeepOf(camp);

  if (camp.grain >= need) {
    camp.grain -= need;
    // 吃饱了只是「不至于散」，不是「士气如虹」。
    // 军心朝一个由处境算出来的目标漂 —— 一路顶在一百的军心
    // 等于没有军心这项，玩家看它一眼就再也不看第二眼
    const target = moraleTargetOf(camp);
    if (camp.morale < target) camp.morale = clamp(camp.morale + FED_MORALE, 0, 100);
    else if (camp.morale > target) camp.morale = clamp(camp.morale - 1, 0, 100);
  } else {
    // 断粮。先把仅有的吃掉，然后掉军心、开始逃人
    camp.grain = 0;
    camp.morale = clamp(camp.morale - STARVE_MORALE, 0, 100);
    const gone = Math.max(1, Math.floor((camp.troops * STARVE_DESERT_PERMILLE) / 1000));
    if (camp.troops > 0) {
      camp.troops = Math.max(0, camp.troops - gone);
      // 先跑的是部曲 —— 他们本来就不是你的人
      camp.retainers = Math.max(0, camp.retainers - gone);
      out.push({ t: 'camp_starving', deserted: gone, morale: camp.morale });
    }
  }

  // 不练就生疏。每旬掉一点，逼着你不能光囤兵不练。
  // 在地里刨食的兵忘得更快 —— 这是屯田要付的账
  if (!busyOn(camp, 'train') && day % 10 === 0) {
    const decay = camp.farming ? TUNTIAN_TRAINING_DECAY : TRAINING_DECAY;
    camp.training = clamp(camp.training - decay, 0, 100);
  }
  // 没有校场，练到六十就再也上不去 —— 修营的理由之一
  if (camp.training > out0.trainCap) camp.training = out0.trainCap;

  // 手上的几件事各推一天。倒着走，做完了就地摘掉
  for (let i = camp.jobs.length - 1; i >= 0; i--) {
    const w = camp.jobs[i]!;
    w.daysLeft -= 1;
    if (w.daysLeft > 0) continue;
    camp.jobs.splice(i, 1);

    if (w.job === 'levy' && w.levy) {
      const def = LEVIES[w.levy];
      const before = camp.troops;
      camp.troops += def.men;
      // 新兵拉低平均训练度与军心 —— 一次塞进来一批生瓜蛋子，
      // 这营兵是会变生的
      camp.training = Math.round(
        (camp.training * before + def.training * def.men) / Math.max(1, camp.troops),
      );
      camp.morale = Math.round(
        (camp.morale * before + def.morale * def.men) / Math.max(1, camp.troops),
      );
      if (w.levy === 'retainer') camp.retainers += def.men;
      out.push({ t: 'camp_levied', levy: w.levy, men: def.men, troops: camp.troops });
    } else if (w.job === 'drill') {
      const gain = out0.drillGain + nextInt(rng, 5);
      camp.training = clamp(camp.training + gain, 0, out0.trainCap);
      camp.morale = clamp(camp.morale + 3, 0, 100);
      out.push({ t: 'camp_drilled', training: camp.training });
    } else if (w.job === 'court') {
      // 招揽的结果不在这里定 —— 成不成要看名望与信任，
      // 那些数在 state 上，camp.ts 够不着。交给 handlers 收尾
      out.push({ t: 'camp_courted' });
    } else if (w.job === 'build' && w.facilityId) {
      camp.works[w.facilityId] = w.toLevel;
      out.push({ t: 'camp_built', facilityId: w.facilityId, level: w.toLevel });
    } else {
      camp.gear = Math.min(out0.gearCap, camp.gear + 1);
      out.push({ t: 'camp_geared', gear: camp.gear });
    }
  }

  if (camp.troops <= 0 || camp.morale <= CAMP_BREAK_MORALE) {
    out.push({ t: 'camp_broke' });
  }
  return out;
}

export type CampEvent =
  | { t: 'camp_starving'; deserted: number; morale: number }
  | { t: 'camp_levied'; levy: Levy; men: number; troops: number }
  | { t: 'camp_drilled'; training: number }
  | { t: 'camp_geared'; gear: number }
  | { t: 'camp_built'; facilityId: string; level: number }
  | { t: 'camp_courted' }
  | { t: 'camp_broke' };

// ─────────────────────────────────────────────────────────────
// 粮从哪来
// ─────────────────────────────────────────────────────────────

/**
 * 主公此刻还能匀出多少粮。
 *
 * 从**他手上那些城的存粮**里算，而不是凭空一个数字 ——
 * 他丢了城、打了败仗，你的军粮当月就短。
 * 这是天下图与武将这条线之间唯一、但足够重的一条联系：
 * 你在营里等的那车粮，取决于三百里外那座城还在不在他手里。
 *
 * 每座城自己也要留口粮，所以只有余粮的一部分调得动。
 */
export function lordGrainPool(state: WorldState, factionId: string): number {
  let total = 0;
  for (const node of Object.values(state.nodes)) {
    if (node.factionId === factionId) total += node.grain;
  }
  // 你不是他唯一的一支兵。粮还要走路、要损耗、要分给别的营，
  // 所以能落到你头上的只是他家底的一小块
  return Math.floor(total / LORD_SHARE);
}

/**
 * 主公批多少粮下来。
 *
 * 三样东西说了算：他有多少余粮、他信不信你、你要得合不合规矩。
 * 狮子大开口不会让他多给，只会让他觉得你不知轻重。
 */
export function rationCapOf(rank: number): number {
  const i = clamp(Math.floor(rank), 0, RATION_CAP_BY_RANK.length - 1);
  return RATION_CAP_BY_RANK[i]!;
}

export function grantOf(
  asked: number, pool: number, trust: number, rank: number, rng: RngState,
): number {
  if (asked <= 0) return 0;
  // 你的份例。要得再多也没用 —— 主公不会为了你破规矩
  const want = Math.min(asked, rationCapOf(rank));
  // 但份例是纸面上的。他手上真拿不出来的时候，纸面不管用
  const affordable = Math.floor((pool * (250 + clamp(trust, 0, 100) * 7)) / 1000);
  // 上下浮动一成半，让同样的局面不至于每次一模一样
  const jitter = 850 + nextInt(rng, 300);
  return Math.max(0, Math.min(want, Math.floor((affordable * jitter) / 1000)));
}

/** 就地征粮：这座城能刮出多少 */
export function forageYield(cityGrain: number, permille: number): number {
  return Math.max(0, Math.floor((cityGrain * permille) / 1000));
}

/** 这次征粮会不会被参一本 */
export function forageReported(rng: RngState, times: number, base: number, step: number): boolean {
  return chancePermille(rng, Math.min(900, base + times * step));
}
