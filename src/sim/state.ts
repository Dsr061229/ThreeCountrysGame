/**
 * 世界状态。唯一的真相来源。
 *
 * 表现层只读，任何修改都必须经由命令（见 commands.ts）。
 */
import type { RngState } from './rng.ts';
import type { City, CityId, Official, Quota } from './types.ts';
import type { Army, CityNode, Ending, FactionState } from './world_types.ts';
import type { Battle } from './battle_types.ts';
import type { FieldBattle } from './field_types.ts';
import type { Camp, Ration } from './general_types.ts';
import type { Campaign } from './campaign_types.ts';
import type { Theatre } from './theatre_types.ts';
import type { LordOrder } from './order_types.ts';

/**
 * 玩家站在哪个位置上。
 *
 * 三个身份共用同一个乱世、同一套时间与天下图，
 * 只是**手里的把手不一样**：文官管一座城的地块，武将管一座营的兵。
 */
/**
 * 你站在乱世的哪个位置上。
 *
 *   official —— 城池官长。守一座城、种田、修墙、按季交差。
 *   general  —— 领兵武将。屯兵、练兵、受军令、打仗。
 *   lord     —— 一家诸侯。**你不亲手做任何一件事** ——
 *               你派人去做。任命、调兵、遣使，然后看着天下变。
 *
 * 三条线跑的是同一套世界规则：你当主公时，
 * 手下那些城的守将吃的是和玩家一样的守备公式。
 */
export type PlayerRole = 'official' | 'general' | 'lord';

export interface WorldState {
  /** 存档兼容性版本 */
  readonly version: number;
  /** 世界种子。存档 = 种子 + 命令流 */
  readonly seed: string;

  /** 当前日 */
  day: number;
  rng: RngState;
  /** 确定性 id 计数器，禁止用时间戳或随机数生成 id */
  nextId: number;

  /** 是否已选定身份开局 */
  started: boolean;
  /** 这一局玩的是哪个身份 */
  role: PlayerRole;
  /**
   * 玩家这个人。
   *
   * 名字、军职/官职、功绩、主公的信任 —— 这些东西两条线是一样的，
   * 所以共用一份。只有 `rank` 落在哪张表上随身份不同：
   * 文官查 RANKS，武将查 MILITARY_RANKS。
   */
  official: Official;

  /** 玩家亲自治理的城，跑完整的地块模型 */
  cities: Record<CityId, City>;

  /** 天下：所有城池的节点状态（含玩家的城） */
  nodes: Record<string, CityNode>;
  factions: Record<string, FactionState>;
  /** 路上的部队 */
  armies: Record<string, Army>;
  /** 正在被围的城，键是城 id */
  sieges: Record<string, import('./world_types.ts').Siege>;

  /**
   * 正在打的仗。非 null 时时间停住 ——
   * 一场强攻是分秒之间的事，不该让日历在旁边继续翻。
   */
  battle: Battle | null;

  /** 正在打的野战。与守城战一样，非 null 时时间停住 */
  field: FieldBattle | null;

  /** 结局。非 null 时这一局已经结束 */
  ending: Ending | null;
  /** 连续几季没交上差 */
  consecutiveMisses: number;

  /**
   * 武将的屯兵地。文官这一局是空的。
   *
   * 用字典而不是单个营，是因为升迁之后要管数营 ——
   * 现在只会有一个，但换成数组的成本以后会很高
   */
  camps: Record<string, Camp>;
  /** 武将这一季的请粮。还没请就是 null */
  ration: Ration | null;
  /**
   * 你手下的部将。
   *
   * **开局是空的** —— 一个刚受命的裨将手底下没有名将。
   * 部将要么是主公按信任指派下来的，要么是你自己花粮招揽来的。
   *
   * 这一条决定了你能分几路兵：每一路必须有一位将坐镇，
   * 而一将不能分身。所以「三路包抄」不是一个可以随便点的选项，
   * 是你先得有两个能用的人。
   */
  retinue: string[];
  /**
   * 挂了彩的部将：**部将 id → 哪一天将养得好**。
   *
   * 斗将输了不一定当场毙命，更多的是负伤退回本阵。
   * 伤要养 —— 这段日子他上不了阵，你手上就少一路。
   * 「一将不能分身」之外，这是第二件让「帐下有几个人」变得要紧的事。
   */
  hurt: Record<string, number>;
  /**
   * 谁在守哪座城：**城 id → 人物 id**。
   *
   * 天下图上每一座城都有个守将，而且是**那一家的人** ——
   * 上一版敌将的名字是从一份没有归属的名单里随手抽的，
   * 于是「攻孔融的城，董卓帐下的华雄出来单挑」这种事真的会发生。
   *
   * 这张表也是 M4「任命」的地基：城易了主，守将就要换人；
   * 你当上主公之后，换的就是这张表。
   */
  posts: Record<string, string>;
  /**
   * 主公下的军令。
   *
   * 这是武将这条线的心跳 —— 文官被季度指标追着跑，
   * 武将被军令追着跑。没有它，你可以在营里屯四年田什么都不干。
   */
  order: LordOrder | null;
  /**
   * 正在进行的出征。
   *
   * 从「军议」开到「接战」为止都活在这里 ——
   * 各路人马走到哪儿了、敌军选了哪条道、伏兵咬没咬住，
   * 全是这一份状态。打完了就收掉。
   */
  campaign: Campaign | null;

  /**
   * 正在打的那一场野战（武将）。
   *
   * 与文官的 `field` 是两套东西，故意不共用：
   * `field` 是回合 + 阵型，`theatre` 是地图 + 位置 + 时间。
   * 硬凑成一个的后果是两边都做不好 —— 那正是上一版的教训。
   */
  theatre: Theatre | null;

  /**
   * 朝堂。**只有主公这一局有，另外两条线是 null。**
   *
   * 案头的呈报、帐下的心气、天下的望、主公的寿数，全在这里。
   * 主公的一天原先是空的（「他自己什么也不做」）—— 现在这里就是那一天。
   */
  court: import('./lord_types.ts').Court | null;

  /**
   * 路上的信使。**只有主公这一局有。**
   *
   * 呈报不是凭空落到案上的，是有人骑马送来的 ——
   * 而送信的人是会被截的（见 tickCouriers）。
   */
  couriers: Record<string, import('./lord_types.ts').Courier>;

  /** 当前季度指标；开局前为 null */
  quota: Quota | null;
  /** 历史指标，用于复盘与主公印象 */
  quotaHistory: Quota[];

  /** 已经通知过玩家的解锁项，避免重复播报 */
  seenUnlocks: string[];

  /** 通用标记位，值一律为整数 */
  flags: Record<string, number>;
}

/**
 * 存档兼容版本。
 *
 * 存档是「种子 + 命令流」，读档就是照着重放一遍。
 * 这意味着**只要规则改了，同一份命令流就会重放出另一个世界** ——
 * 不是读不出来，是悄悄读成了别的样子：那一仗的胜负变了、
 * 后面几百条命令全落在一个从未存在过的局面上。
 *
 * 所以凡是动了模拟层的数值或规则，这个数就得 +1，
 * 让旧存档明明白白地读不进来，而不是读进来一个错的。
 */
export const STATE_VERSION = 10;

export function mintId(state: WorldState, prefix: string): string {
  const n = state.nextId++;
  return `${prefix}_${n.toString(36)}`;
}

/** 玩家当前治理的城 */
export function currentCity(state: WorldState): City {
  return state.cities[state.official.cityId]!;
}

// ─────────────────────────────────────────────────────────────
// 状态指纹 —— 验证「同种子 + 同命令流 = 同世界」，联机一致性校验也用它
// ─────────────────────────────────────────────────────────────

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return '{' + Object.keys(obj).sort()
    .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** FNV-1a 32 位 */
export function hashState(state: WorldState): string {
  const s = stableStringify(state);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export { stableStringify };
