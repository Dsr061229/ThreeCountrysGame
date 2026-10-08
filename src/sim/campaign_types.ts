/**
 * 出征：武将路线的操作层。
 *
 * 野战解决的是「这一仗怎么打」，出征解决的是**「这一仗怎么形成」** ——
 * 兵分几路、谁领哪一路、走哪条道、到了做什么。
 *
 * 三条设计上的硬规矩：
 *
 * 一、**多路只打一场战术仗**。
 *    分三路就打三场，玩家会累死，而且每一场都变得无关紧要。
 *    这里的做法是：几路人马共同决定那一场仗的**开局**——
 *    伏兵得手，敌军就是散着挨打的；侧击那一路，第三轮从侧翼切进来。
 *
 * 二、**单独的任务都平庸，配起来才成局**。
 *    佯动本身不杀人，设伏本身等不到人；
 *    佯动把敌军往大道上引、伏兵在小道上等——这两条合起来才是一个计。
 *    玩家要想的不是「哪个选项最强」，是「这几样怎么凑」。
 *
 * 三、**部将会走样**。
 *    你下的是命令，执行的是人。性急的提前动手，骄矜的不走你指的道。
 *    街亭就是这么丢的 —— 「派谁去」必须有真分量，
 *    否则点将就只是给每一路配一个数值加成。
 */
import type { NodeId } from './world_types.ts';

// ─────────────────────────────────────────────────────────────
// 道
// ─────────────────────────────────────────────────────────────

export type RouteKind = 'main' | 'byway' | 'mountain' | 'river';

export const ROUTE_NAME: Record<RouteKind, string> = {
  main: '大道',
  byway: '小道',
  mountain: '山道',
  river: '水路',
};

/** 兵从哪个方向到达战场。伏击与侧击都靠它 */
export type Approach = 'front' | 'flank' | 'rear';

export const APPROACH_NAME: Record<Approach, string> = {
  front: '正面',
  flank: '侧翼',
  rear: '敌后',
};

export interface Route {
  id: string;
  kind: RouteKind;
  /** 走完要几天 */
  days: number;
  /**
   * 这条道要过哪儿。
   *
   * 「翻伏牛山」「沿淮水」—— 这一句是玩家判断的依据，
   * 也是「地形」这件事从数值变回地理的地方。
   */
  through: string;
  /**
   * 隐蔽度 0~100。
   * 敌军的斥候能不能看见这一路人马 —— 伏兵能不能藏住，全看这个数。
   */
  cover: number;
  arrive: Approach;
}

/** 各种道的底子。实际数值还会按两地距离与地形浮动 */
export const ROUTE_BASE: Record<RouteKind, { cover: number; arrive: Approach; pace: number }> = {
  // 大道好走，但两边都盯着它。伏兵在大道上是藏不住的
  main: { cover: 12, arrive: 'front', pace: 100 },
  // 小道是设伏的地方：走得慢一点，但敌军的斥候多半看不见
  byway: { cover: 62, arrive: 'flank', pace: 145 },
  // 山道最苦，绕到敌后。走得动的人不多，走到了就是奇兵
  mountain: { cover: 84, arrive: 'rear', pace: 205 },
  // 水路快，但要有渡口，且船只瞒不过人
  river: { cover: 35, arrive: 'front', pace: 78 },
};

// ─────────────────────────────────────────────────────────────
// 任务
// ─────────────────────────────────────────────────────────────

export type Mission = 'assault' | 'flank' | 'ambush' | 'feint' | 'raid';

export const MISSION_NAME: Record<Mission, string> = {
  assault: '正击',
  flank: '侧击',
  ambush: '设伏',
  feint: '佯动',
  raid: '断粮道',
};

export const MISSION_DESC: Record<Mission, string> = {
  assault: '直取其军。到了就打，是这一仗的正兵。',
  flank: '按兵不动，等两军咬住了再从侧翼杀进去。去得早了没用，去得晚了赶不上。',
  ambush: '不进，就在这条道上等。敌军若从这里过，一战可定；若不从这里过，你白等一场。',
  feint: '虚张声势，把敌军的眼睛引到这条道上来。它自己不杀人——它是给伏兵铺路的。',
  raid: '绕到后面烧他的粮。敌军会一天比一天饿，但你这一路不参战。',
};

// ─────────────────────────────────────────────────────────────
// 一路人马
// ─────────────────────────────────────────────────────────────

export type ColumnState = 'marching' | 'waiting' | 'arrived' | 'engaged' | 'lost';

export interface Column {
  id: string;
  /** 谁领这一路。null 表示你亲自领 */
  officerId: string | null;
  men: number;
  routeId: string;
  mission: Mission;
  /** 已经走了几天 */
  progress: number;
  state: ColumnState;
  /**
   * 部将有没有走样。
   *
   * 这不是随机的惩罚 —— 是「你派了谁」的后果。
   * 走样了会写进战报，让你知道是谁误了事。
   */
  deviated: DeviationKind | null;
}

/** 走样的几种样子 */
export type DeviationKind =
  /** 性急：没等到时候就动手，伏兵暴露 */ | 'early'
  /** 骄矜：不走你指的道，改走大道 */ | 'wrong_road'
  /** 谨慎过头：磨蹭，来晚了 */ | 'late'
  /** 贪功：追出去，脱离了战场 */ | 'chased';

export const DEVIATION_TEXT: Record<DeviationKind, string> = {
  early: '未等号令便先动了手',
  wrong_road: '嫌道险，自作主张改走了大道',
  late: '一路逡巡，误了时辰',
  chased: '贪功追击，脱离了战场',
};

// ─────────────────────────────────────────────────────────────
// 一次出征
// ─────────────────────────────────────────────────────────────

export type CampaignPhase = 'planning' | 'marching' | 'battle' | 'done';

export interface Campaign {
  targetNodeId: NodeId;
  foeFactionId: string;
  /** 敌军实力（真值）。玩家看到的是被斥候打过折的估计 */
  foeTroops: number;
  /** 斥候 0~100：你对敌情知道多少 */
  scouting: number;
  routes: Route[];
  columns: Column[];
  phase: CampaignPhase;
  /** 出征是哪天开始的 */
  startDay: number;
  /** 敌军实际走了哪条道。玩家未必知道 */
  foeRouteId: string | null;
  /** 伏兵有没有咬住 */
  ambushSprung: boolean;
  /** 战报：这一路那一路都干了什么 */
  log: CampaignLine[];
}

export interface CampaignLine {
  day: number;
  textId: string;
  vars?: Record<string, string | number>;
  tone: 'plain' | 'good' | 'bad';
}

// ─────────────────────────────────────────────────────────────
// 平衡常数
// ─────────────────────────────────────────────────────────────

/**
 * 一日行军多少图上单位。图上一单位约合三十里。
 *
 * 这个数取小一点，是为了让**日数分得开**：
 * 取 11 的时候，平原走三日、翻秦岭也走四日，取整之后两者几乎一样，
 * 「地形」就成了地图上的一层花纹。取 4 之后，
 * 汉中往长安要走十一日，许往陈留三日 —— 那才叫隔着一座山。
 */
export const DAY_MARCH = 4;

/** 最多分几路。再多就不是排兵布阵，是填表 */
export const MAX_COLUMNS = 3;
/** 一路最少要有这些人，否则不成军 */
export const MIN_COLUMN_MEN = 40;

/**
 * 佯动能把敌军往别的道上赶多少（千分数）。
 *
 * 这个数必须压得过地形的天然偏好。
 * 敌军本来就爱走大道 —— 若佯动推不动他，伏兵就永远等不到人，
 * 「佯动 + 设伏」这个局也就永远做不成。
 */
export const FEINT_PULL = 520;
/** 伏击成功时，敌军的士气要掉多少 */
export const AMBUSH_MORALE_HIT = 32;
/** 伏击成功时，敌军战力打几折（千分数） */
export const AMBUSH_STRENGTH = 540;
/** 断粮道每持续一天，敌军战力掉千分之几 */
export const RAID_DECAY_PERMILLE = 9;
/** 侧击在第几轮杀到 */
export const FLANK_ROUND = 3;
/**
 * 迟到的那一路在第几轮才到。
 *
 * 伏兵扑空、部将逡巡，结果都是这个 —— 人还在，先手没了。
 * 一仗平均五轮，第六轮才到就只赶得上收尾了。
 */
export const LATE_ROUND = 6;
