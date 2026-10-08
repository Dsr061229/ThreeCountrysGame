/**
 * 武将路线的类型与常数。
 *
 * 这条线和文官线共用同一套地基（时间、天下图、野战、与主公的信任），
 * 但**粮的方向是反的**：
 *
 *   文官 —— 主公向你要粮。压力是「交不上差」
 *   武将 —— 你向主公要粮。压力是「要不到」
 *
 * 设计方案里写死了这一条：「**要不到粮怎么办** —— 这是武将路线的核心张力」。
 * 所以这个文件里最要紧的不是兵有多少，是粮从哪来。
 *
 * 而主公能给多少，是从**他手上那些城的存粮**里算出来的 ——
 * 他丢了城、打了败仗，你的军粮当月就短。
 * 这样天下图对武将不再只是背景板。
 */
import type { NodeId } from './world_types.ts';

/**
 * 营扎在什么地方。
 *
 * 不只是一句风景描述 —— 它有分量：
 * 傍山的营难攻，临水的营不愁饮马，林中的营藏得住，
 * 平野的营什么便宜都占不到，但屯田最好。
 */
export type CampSite = 'hill' | 'water' | 'forest' | 'plain';

export const SITE_NAME: Record<CampSite, string> = {
  hill: '傍山',
  water: '临水',
  forest: '林中',
  plain: '平野',
};

export const SITE_NOTE: Record<CampSite, string> = {
  hill: '背山而营。来攻的人要仰着打，橹楼也架得高。',
  water: '临水下寨。人马不愁饮，屯田也便利。',
  forest: '林中扎营。旌旗藏得住，斥候不容易摸清虚实。',
  plain: '平野立营。四面无遮，但地宽土厚，屯田最好。',
};

/** 各处营地的长短 */
export const SITE_EFFECT: Record<CampSite, {
  defence: number; tuntian: number; cover: number;
}> = {
  hill: { defence: 260, tuntian: -1, cover: 10 },
  water: { defence: 60, tuntian: 1, cover: 0 },
  forest: { defence: 120, tuntian: -1, cover: 25 },
  plain: { defence: 0, tuntian: 2, cover: 0 },
};

/**
 * 招揽一位部将：要几天、费多少粮。
 *
 * 不便宜，也不一定成 —— 一个有本事的人凭什么跟你？
 * 名望（战功）与主公的信任是你唯一的本钱。
 */
export const COURT_DAYS = 24;
export const COURT_GRAIN = 260;
/** 招揽成功的底数（千分数）。战功与信任往上加 */
export const COURT_BASE = 240;

/**
 * 举荐。
 *
 * 你把手上一员将交出去守城 —— 帐下少一个人，也就少分一路兵，
 * 换来的是主公的信任和一份战功。
 *
 * 数要给得**值得犹豫**：给少了没人举荐，给多了就成了
 * 「把部将当信任换」的刷分手法。一员好将本来就该舍不得。
 */
export const RECOMMEND_TRUST = 9;
export const RECOMMEND_MERIT = 35;

/** 开局那座营的 id。武将现在只有一座，将来升迁会有数座 */
export const STARTING_CAMP = 'camp_1';

/** 军职。与文官的 RANKS 平行 */
export const MILITARY_RANKS = ['裨将', '校尉', '中郎将', '将军', '都督'] as const;

/** 升到下一级军职所需战功 */
/**
 * 升到下一级军职所需战功。
 *
 * 这几个数拔高过一次。原先是 [120, 300, 600, 1000]，
 * 实测一年半就爬到都督 —— 一个刚受命的裨将，
 * 十八个月做到方面之任，那不叫发育，那叫开挂。
 *
 * 现在这一档大致是：打上十来仗升校尉，
 * 而都督要打满一场旷日持久的战争。
 */
export const MERIT_TO_PROMOTE_MIL = [200, 620, 1500, 3200] as const;

// ─────────────────────────────────────────────────────────────
// 屯兵地
// ─────────────────────────────────────────────────────────────

/** 兵源。三种来源的兵，带法不一样 */
export type Levy = 'refugee' | 'frontier' | 'retainer';

export const LEVY_NAME: Record<Levy, string> = {
  refugee: '流民',
  frontier: '边民',
  retainer: '部曲',
};

export interface LevyDef {
  /** 一次招多少人 */
  men: number;
  /** 每人要几石安家粮 */
  grainPer100: number;
  /** 招来时的训练度 */
  training: number;
  /** 招来时的军心 */
  morale: number;
  /** 要几天 */
  days: number;
}

/**
 * 三种兵源的取舍。
 *
 * 流民多而弱、边民少而悍、部曲有私心 —— 部曲不吃你的粮（豪族自己养），
 * 但军心低且不会跟你走，是**将来叛逃时最先散掉的那一批**。
 */
export const LEVIES: Record<Levy, LevyDef> = {
  refugee: { men: 120, grainPer100: 40, training: 10, morale: 45, days: 12 },
  frontier: { men: 45, grainPer100: 95, training: 42, morale: 62, days: 18 },
  retainer: { men: 70, grainPer100: 0, training: 30, morale: 34, days: 15 },
};

/** 营中正在做的事 */
export type CampJob = 'levy' | 'drill' | 'gear' | 'build' | 'court';

/**
 * 一件事归哪一摊人管。
 *
 * 营里同时能做几件事，看的不是「几个工位」，是**这几件事用不用同一批人**：
 *
 *   募   —— 派出去招兵的人。一次只能派一拨
 *   练   —— 校场上的兵。全营的人只有一副身子
 *   工   —— 匠人。修营和造械都是他们，一次只干一样
 *
 * 所以招兵、操练、修营三件事可以同时进行，
 * 而「修营」与「造械」不能 —— 匠人分不了身。
 * 这比「一次只能做一件」真实，也让营里终于有事可忙。
 */
export type JobTrack = 'recruit' | 'train' | 'craft';

export function trackOf(job: CampJob): JobTrack {
  if (job === 'levy') return 'recruit';
  if (job === 'drill') return 'train';
  return 'craft';
}

export const TRACK_NAME: Record<JobTrack, string> = {
  recruit: '募',
  train: '练',
  craft: '工',
};

export interface CampWork {
  job: CampJob;
  /** 招兵时是哪一种兵源 */
  levy: Levy | null;
  /** 修营时修的是哪一处，修到几级 */
  facilityId: string | null;
  toLevel: number;
  /** 还剩几天 */
  daysLeft: number;
  /** 一共要几天。用来画进度 */
  days: number;
}

/** 营中一处设施修到了几级 */
export type CampWorks = Record<string, number>;

export interface Camp {
  id: string;
  /**
   * 就近的那座城。补给、辖属、被围时驰援，都看它。
   *
   * 但营**不在城里** —— 它有自己的位置（见 at）。
   * 这一条是武将与文官真正分家的地方：
   * 文官守着一座城，武将扎在野地里。
   */
  nodeId: NodeId;
  /**
   * 营扎在哪儿。图上坐标，与城池同一套。
   *
   * 选址不是随手一放：营要靠水（人马都要喝）、
   * 要有林或坡遮着（不能四面受敌），又不能压在城头上。
   * 见 pickCampSite。
   */
  at: [number, number];
  /** 扎在什么地方 —— 「傍山」「临水」「林中」「平野」 */
  site: CampSite;
  /** 谁的营。玩家的是 null，其余是部将 id */
  ownerId: string | null;
  troops: number;
  /** 训练度 0~100。直接乘进战力 */
  training: number;
  grain: number;
  /** 军心 0~100。饿肚子掉得最快 */
  morale: number;
  /** 器械 0~5。攻守都用得上 */
  gear: number;
  /**
   * 在不在屯田。
   *
   * 建安元年曹操行屯田于许下，「岁得谷百万斛」—— 汉末带兵的人
   * 之所以能站住脚，靠的从来不只是能打。
   *
   * 这是这条线上唯一**自己长粮**的路子，代价是兵在种地就不在操练，
   * 训练度掉得比闲着还快。所以它不是一个「开了就不用管」的开关，
   * 是一道要反复权衡的取舍：仗打完了开屯，仗要来了收屯。
   */
  farming: boolean;
  /** 部曲占多少人。叛逃时这批人不跟你走 */
  retainers: number;
  /**
   * 营中的设施与各自的级数。
   *
   * 这是武将的「发育」落脚的地方 —— 城里盖房子是为了多收粮，
   * 修营是为了改变自己军队的**形状**：
   * 有厩栏才有骑兵，有弓弩坊才有弓弩，有工坊才有攻城的家伙什。
   */
  works: CampWorks;
  /**
   * 营中正在办的几件事。
   *
   * 同一摊人管的事不能并着办（见 JobTrack），
   * 所以这个数组最多三条：一件募、一件练、一件工。
   */
  jobs: CampWork[];
}

// ─────────────────────────────────────────────────────────────
// 粮
// ─────────────────────────────────────────────────────────────

/** 每一百个兵每天吃多少粮 */
export const GRAIN_PER_100_PER_DAY = 2;
/** 操练额外耗粮（每百人每天）。练兵是要吃饱的 */
export const DRILL_GRAIN_PER_100 = 1;
/** 一次操练几天 */
export const DRILL_DAYS = 20;
/**
 * 没有校场时，训练度顶到哪儿。
 *
 * 光靠日常操演练不出精兵 —— 这是「修营」值得占用一整季钱粮的理由之一。
 */
export const TRAIN_CAP_BASE = 58;
/** 营里最多摆得下几处设施 */
export const FACILITY_SLOTS = 8;
/** 没有廪仓时存得下多少粮 */
export const GRAIN_CAP_BASE = 1200;
/** 帅帐之外，你本来就能带几个部将 */
export const OFFICER_SLOTS_BASE = 1;
/** 一次操练涨多少训练度 */
export const DRILL_GAIN = 14;
/** 不操练时训练度每旬掉多少 —— 兵是会生疏的 */
export const TRAINING_DECAY = 2;
/** 造一次器械要几天、耗多少粮 */
export const GEAR_DAYS = 30;
export const GEAR_GRAIN = 220;
export const GEAR_MAX = 5;

/** 屯田时每百人每天产多少粮 */
export const TUNTIAN_PER_100 = 5;
/** 屯田时训练度掉得更快（每旬） */
export const TUNTIAN_TRAINING_DECAY = 5;

/** 断粮时军心每天掉多少 */
export const STARVE_MORALE = 4;
/** 断粮时每天逃掉千分之几 */
export const STARVE_DESERT_PERMILLE = 12;
/** 粮足时军心每天回多少 */
export const FED_MORALE = 1;

/** 军心低到这个数，营就散了 */
export const CAMP_BREAK_MORALE = 12;

// ─────────────────────────────────────────────────────────────
// 请粮
// ─────────────────────────────────────────────────────────────

export type RationOutcome = 'pending' | 'granted' | 'partial' | 'refused';

export interface Ration {
  quarter: number;
  /** 哪天批复 */
  replyDay: number;
  asked: number;
  granted: number;
  outcome: RationOutcome;
}

/**
 * 一季能领多少粮，看的是**军职**，不是你手上有多少兵。
 *
 * 这是这条线的中轴。裨将就是裨将的份例 ——
 * 你自作主张招了一千人，主公不会因此多给你一粒米，
 * 那一千张嘴得你自己想办法。
 *
 * 于是就有了三条出路，各有各的代价：
 *   屯田  —— 自己长粮，但兵会生疏
 *   征粮  —— 立刻有粮，但毁的是自己驻地的民心
 *   打仗  —— 因粮于敌，但要拿命换
 *
 * 也于是「升迁」不再只是一个头衔：**它是你军队规模的上限**。
 * 而升迁要战功，战功要打仗 —— 这条线到这里才闭合。
 */
export const RATION_CAP_BY_RANK = [600, 1150, 1950, 3100, 4800] as const;
/** 请粮要几天才批下来 */
export const RATION_REPLY_DAYS = 12;

/**
 * 就地征粮：向驻地的城要。
 *
 * 立刻有粮，但伤民心，而且**有可能被参一本** —— 这是最常走的一条路，
 * 也是最容易把自己走进死胡同的一条：民心低的城守不住，
 * 而你恰恰驻扎在那儿。
 */
export const FORAGE_TAKE_PERMILLE = 300;
export const FORAGE_MORALE_HIT = 9;
/** 被参一本的概率（千分数），每征一次都会累加 */
export const FORAGE_REPORT_BASE = 180;
export const FORAGE_REPORT_STEP = 140;
export const FORAGE_TRUST_HIT = 12;

/**
 * 因粮于敌。
 *
 * 打赢一仗要有缴获 —— 这不是奖励，是**这条线的第三条粮道**。
 * 请粮看主公脸色，征粮伤自己驻地的民心，只有打赢是纯赚的。
 * 少了这一条，武将就只能在「求人」和「害民」之间二选一，
 * 那不像个带兵的，像个收租的。
 */
export const SPOILS_PER_FOE_100 = 55;
