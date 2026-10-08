/**
 * 命令与事件。
 *
 * 命令是**唯一**能改变世界状态的东西；事件是模拟层向外的广播。
 * 表现层只消费事件，绝不反向调用规则。
 *
 * 换来三件事：存档 = 种子 + 命令流；联机 = 客户端发命令服务端跑同一份模拟；
 * 可测试 = 给定命令流断言状态指纹。
 */
import type { AfflictionKind, BuildingId } from './types.ts';
import type { Formation } from './field_types.ts';
import type { PlayerRole } from './state.ts';
import type { EndingKind } from './world_types.ts';
import type { CampJob, JobTrack, Levy, RationOutcome } from './general_types.ts';
import type { Mission } from './campaign_types.ts';
import type { Stance, UnitKind } from './theatre_types.ts';
import type { OrderKind } from './order_types.ts';

// ─────────────────────────────────────────────────────────────
// 命令
// ─────────────────────────────────────────────────────────────

export type Command =
  /**
   * 开局。
   *
   * `role` 决定这一局手里握的是什么：
   * 文官管一座城的地块，武将管一座营的兵。
   * 不填就是文官 —— 老存档与旧测试里没有这个字段。
   */
  | {
      t: 'begin'; playerName: string; cityId: string; lordId: string;
      role?: PlayerRole;
    }
  /** 推进一日。由前端按实时时钟驱动，也可加速连发 */
  | { t: 'day' }
  /** 在某块地上兴建或升级 */
  | { t: 'build'; plot: number; buildingId: BuildingId }
  /** 罢工。营造中退回一半已付的钱粮；拆除中则只是停手 */
  | { t: 'cancel_work'; plot: number }
  /** 拆掉一块地上的营造，腾出地方 */
  | { t: 'demolish'; plot: number }
  /** 向主公缴纳 */
  | { t: 'pay'; grain: number; coin: number }
  /** 开放外圈城区 */
  | { t: 'expand' }
  /** 修葺城墙。不占地块 —— 城墙本来也不在坊里 */
  | { t: 'fortify' }

  /** ── 守城战 ── */
  /** 战前部署：把守军分到城头、城门、预备三处 */
  | { t: 'deploy'; wall: number; gate: number; reserve: number }
  /** 打一轮 */
  | { t: 'battle_round' }
  /** 做一个决断 */
  | { t: 'decide'; option: number }
  /** 看完战报，收起战斗界面 */
  | { t: 'battle_dismiss' }

  /** ── 屯兵地（武将） ── */
  /** 在营里开一项工：招兵 / 操练 / 造械 / 修营 */
  | {
      t: 'camp_work'; campId: string; job: CampJob;
      levy?: Levy; facilityId?: string;
    }
  /** 撂下某一摊人手上的活 */
  | { t: 'camp_cancel'; campId: string; track: JobTrack }
  /** 开屯或收屯 */
  | { t: 'camp_farm'; campId: string; on: boolean }
  /** 向主公请粮。批复要等些日子 */
  | { t: 'ration_ask'; amount: number }
  /** 就地征粮。立刻有粮，但伤驻地民心，且可能被参一本 */
  | { t: 'forage'; campId: string }

  /** ── 出征（武将） ── */
  /** 开军议：把兵指向某座城，摆出几条道 */
  | { t: 'campaign_open'; targetNodeId: string }
  /** 散会：不打了 */
  | { t: 'campaign_close' }
  /** 定计：分几路、每路多少兵、谁领、走哪条道、干什么 */
  | {
      t: 'campaign_plan';
      columns: {
        men: number; routeId: string; mission: Mission; officerId: string | null;
      }[];
    }
  /** 发兵。定了计才发得了 */
  | { t: 'campaign_go' }

  /** ── 战场（武将） ── */
  /** 开一场仗：全营出动，去打某处 */
  | { t: 'theatre_open'; targetNodeId: string }
  /** 不打了，收兵回营 */
  | { t: 'theatre_close' }
  /** 在图上派一支兵：谁带、多少、什么兵种、去哪儿、干什么 */
  | {
      t: 'theatre_send';
      kind: UnitKind; men: number;
      col: number; row: number;
      stance: Stance;
      officerId: string | null;
    }
  /** 收回一支还没出发的兵 */
  | { t: 'theatre_recall'; unitId: string }
  /**
   * 派一拨细作去探敌情。
   *
   * 花三十个人去问一句**可能是谎话**的话 —— 这是个决定，不是个按钮。
   * 探得明白的能把对面的伏兵指出来；探不明白的白搭三十人；
   * 最坏的是带回来一份言之凿凿的假数目，而你在击鼓之前分辨不了。
   */
  | { t: 'theatre_scout' }
  /**
   * 出马应战。
   *
   * 敌将指名搦战，你派那一路的主将出去斗。
   * 赢了三军振奋，输了三军夺气 —— 而且可能就此折掉一员好将。
   */
  | { t: 'theatre_duel_accept' }
  /** 不理他。当场示弱，本方掉士气 —— 但人还在 */
  | { t: 'theatre_duel_refuse' }
  /** 击鼓：开打 */
  | { t: 'theatre_begin' }
  /** 推进若干拍。界面按实时时钟连发 */
  | { t: 'theatre_step'; ticks: number }
  /**
   * 鸣金收兵。
   *
   * 打起来之后**必须有一条退路** —— 这一条原先根本不存在：
   * 你要是按兵不动，对面又守着工事不出来，
   * 两军能这么对望到天黑（九百拍，屏幕上一个字都不出），
   * 而界面上连一个能点的按钮都没有。玩家的原话是「游戏卡住走不了」。
   *
   * 「打不过就撤」本来就是将领手里最要紧的一个决定。
   * 它不该白撤：正咬着的人要付断后的代价。
   */
  | { t: 'theatre_withdraw' }
  /** 看完战报，收兵 */
  | { t: 'theatre_dismiss' }

  /** ── 军令（武将） ── */
  /**
   * 举荐一位部将给主公，去守一座没人守的城。
   *
   * 这是「任命」这套东西里**玩家插得上手的那一头**：
   * 你手上少一员将（也就少分一路兵），换主公的信任与一份战功。
   * 那个人从此在天下图上有了自己的城 —— 他不再是你帐下的一个名字。
   */
  | { t: 'recommend'; officerId: string; cityId: string }
  /** ── 主公 ── */
  /**
   * 任命一位守将。
   *
   * 这是主公玩法的核心动词。**它是有分量的** ——
   * 守将顶多少事直接进城防的公式（见 wardenPermille）。
   */
  | { t: 'lord_appoint'; cityId: string; personId: string }
  /**
   * 调兵。从自家一座城派兵去另一处 ——
   * 自家的城是增援，别人的城是出兵。军队在图上真的走，要时间、吃粮。
   */
  | { t: 'lord_march'; fromId: string; toId: string; troops: number }
  /**
   * 征调。把辖境各城的余兵**一齐往一处调**。
   *
   * 这是主公真正的力气所在，也是他和别人打法上唯一对等的地方：
   * NPC 出兵本来就是从整个辖境征调的（见 decideFactions 里的 `rear`），
   * 而玩家一道令只调得动一座城 —— 少了这一条，他永远凑不出优势，
   * 实测各家十年一城未下、一城未失，是一盘冻住的棋。
   *
   * 代价是实打实的：兵在路上要走好些天，这些日子里
   * **你的后方是空的**。
   */
  | { t: 'lord_muster'; cityId: string }
  /** 兴修。花粮把一座城做厚 */
  | { t: 'lord_invest'; cityId: string }
  /** 遣使。花粮去缓和与一家的关系 */
  | { t: 'lord_envoy'; factionId: string }

  /** ── 朝堂 ── */
  /**
   * 批一件呈报。
   *
   * **主公不再有按钮，他只有答复。** 允 / 留中 / 不许 ——
   * 而「留中」不是免费的中立选项：请援的城会破，请战的人会自己动手。
   */
  | { t: 'court_reply'; memorialId: string; answer: import('./lord_types.ts').Answer }
  /**
   * 准某一路去援。
   *
   * **一座被围的城，该有好几处同时请缨。**
   * 原先是「允」一下、由代码替你挑一路邻城 ——
   * 于是玩家看到的常常是一句「邻城派不出援兵」，而他明明还有别的兵。
   *
   * 现在几路人马连同各自的路程、兵力、要不要借道一齐摆在堂上，
   * 你挑一路，或者几路都发。挑完再「允」，那一下的意思是「就这些」。
   */
  | { t: 'court_relief'; memorialId: string; sourceKey: string }
  /**
   * 继位。
   *
   * **主公死了不等于这一局完了。** 望要重新挣、心气一齐掉、
   * 有人不肯事二主 —— 三样代价在按下这一下的时候一齐兑现。
   */
  | { t: 'court_succeed' }
  /**
   * 传下一位。
   *
   * **一次只见一个人。** 案上五件事一起摊着，玩家做的是「挨个点」；
   * 一个个引上堂来，他做的是「见人」—— 同样的信息，完全不同的一件事。
   *
   * 案上没人了，这一下就是「退朝」：时间才往前走。
   */
  | { t: 'court_next' }
  /**
   * 散朝。
   *
   * 主公没有日常，所以他不该有日历。按一下，天下自己往前跑，
   * 跑到下一件要你拍板的事为止；出大事会自动停住 ——
   * 和「打仗时时间停住」是同一条道理。
   */
  | { t: 'court_adjourn' }
  /** ── 挟天子 ── */
  /**
   * 下诏。
   *
   * **一道诏下去，动的是别人的兵。** 主公别的动作都只动一座城，
   * 这一条不是 —— 而且抗诏的那一家从此背着一个「逆」字，
   * 你打他名正言顺，打赢望还涨。
   */
  | { t: 'lord_edict'; to: string; kind: import('./lord_types.ts').EdictKind }
  /** 衣带诏：杀、查、还是不理。三条路都不好走，而且没有正确答案 */
  | { t: 'lord_plot'; how: 'kill' | 'probe' | 'ignore' }

  /** ── 军营 ── */
  /**
   * 立营，派一位**武将**去领。
   *
   * 城里的兵守家，营里的兵野战 —— **出兵不再掏空守军**。
   * 文吏带不了脱产的野战军，所以这一条只收武将。
   */
  | { t: 'lord_camp_open'; cityId: string; personId: string }
  /** 撤营。兵归城 */
  | { t: 'lord_camp_close'; campId: string }
  /** 城营之间拨兵。正数进营，负数回城 */
  | { t: 'lord_draft'; campId: string; men: number }
  /** 营出兵。**这一下不动城里一个人** */
  | { t: 'lord_camp_march'; campId: string; toId: string; men: number }
  /**
   * 表态。
   *
   * 天下同时收到一道题（讨董、迎天子、开仓），你答一个 ——
   * **而你是看着别家的答案做的决定。**
   */
  | { t: 'situation_answer'; option: string }
  /** 看完天下表态那张表，收起来 */
  | { t: 'situation_close' }
  /**
   * 募兵。**主公唯一能把粮变成兵的动词。**
   *
   * 代价是民心：一次募兵伤民心、涨离心，一座城九十天只募得了一次。
   */
  | { t: 'lord_levy'; cityId: string }
  /**
   * 修一段驿路。
   *
   * 修过的一段，信使走得快、也不容易被截。
   * 地盘越大越是刚需 —— 「城多了管不过来」的第二个形态：
   * 第一个是人不够，这个是消息跟不上。
   */
  | { t: 'lord_road'; fromId: string; toId: string }
  /**
   * 不等劝进，自己称帝。
   *
   * 这是袁术那条路：赢面小，但赢了是最快的一条。
   */
  | { t: 'lord_claim' }
  /** 接令 */
  | { t: 'order_accept' }
  /** 抗命。将在外，君命有所不受 —— 但要付代价 */
  | { t: 'order_defy' }
  /** 输粮：把粮送到主公那儿 */
  | { t: 'order_tribute' }

  /** ── 野战 ── */
  /** 出城迎击。城下有敌军时才谈得上 */
  | { t: 'sortie' }
  /** 布阵：把各队摆到阵前两行，并选定阵型 */
  | { t: 'field_deploy'; places: { id: string; col: number; row: number }[]; formation: Formation }
  /** 击鼓进兵，布阵到此为止 */
  | { t: 'field_begin' }
  | { t: 'field_round' }
  | { t: 'field_decide'; option: number }
  | { t: 'field_dismiss' };

export type CommandType = Command['t'];

/** 带序号与来源的命令封包。联机时 by 用于区分玩家 */
export interface CommandEnvelope {
  seq: number;
  cmd: Command;
  by: string;
}

// ─────────────────────────────────────────────────────────────
// 事件
// ─────────────────────────────────────────────────────────────

export type SimEvent =
  | { t: 'began' }
  | { t: 'day_passed'; day: number }
  /** 一个月过去了 —— 表现层用它做月度小结 */
  | { t: 'month_passed'; day: number }
  | { t: 'work_started'; plot: number; buildingId: BuildingId; toLevel: number; days: number }
  | { t: 'work_cancelled'; plot: number }
  /** 工程完工。这是发育反馈的高光时刻 */
  | { t: 'built'; plot: number; buildingId: BuildingId; level: number }
  | { t: 'demolish_started'; plot: number; buildingId: BuildingId; days: number }
  | {
      t: 'demolished'; plot: number; buildingId: BuildingId;
      refundCoin: number; refundGrain: number;
    }
  /** 新建筑解锁 */
  | { t: 'unlocked'; buildingId: BuildingId }
  /** 城区扩建 */
  | { t: 'expanded'; ring: number }

  | { t: 'pop_changed'; from: number; to: number; reason: 'growth' | 'flight' }
  /** 粮仓满了，产出开始白白浪费 —— 逼玩家把攒的东西用掉 */
  | { t: 'granary_full' }
  | { t: 'treasury_full' }
  /** 断粮 */
  | { t: 'famine' }

  /** 天灾人祸降临。这是发育之外的另一半节奏 */
  | { t: 'affliction'; kind: AfflictionKind; days: number; grainLost: number; popLost: number }
  | { t: 'affliction_ended'; kind: AfflictionKind }
  | { t: 'refugees_arrived'; count: number }

  | { t: 'quota_issued'; quarter: number; grain: number; coin: number; dueDay: number }
  | { t: 'paid'; grain: number; coin: number }
  | { t: 'quota_settled'; quarter: number; met: boolean; meritDelta: number; trustDelta: number }
  | { t: 'promoted'; rank: number }

  /** 城墙 */
  | { t: 'wall_started'; toLevel: number; days: number }
  | { t: 'wall_done'; level: number }

  /** ── 天下 ── */
  | { t: 'army_launched'; factionId: string; fromId: string; toId: string; troops: number }
  | { t: 'army_dispersed'; factionId: string; toId: string }
  | { t: 'reinforced'; cityId: string; factionId: string; troops: number }
  | { t: 'siege_started'; cityId: string; factionId: string; troops: number }
  | { t: 'siege_day'; cityId: string; days: number; attackers: number; defenders: number }
  | { t: 'siege_lifted'; cityId: string; factionId: string; taken: boolean }
  | { t: 'city_fell'; cityId: string; from: string; to: string }
  /** 主公派来的援军。信任够高才会有 */
  | { t: 'lord_relief'; cityId: string; troops: number }
  /** 这一局结束了 */
  | { t: 'game_over'; kind: EndingKind }

  /** ── 屯兵地（武将） ── */
  /** 断粮了，有人跑了 */
  | { t: 'camp_starving'; deserted: number; morale: number }
  /** 一批新兵到营 */
  | { t: 'camp_levied'; levy: Levy; men: number; troops: number }
  | { t: 'camp_drilled'; training: number }
  | { t: 'camp_geared'; gear: number }
  | { t: 'camp_built'; facilityId: string; level: number }
  /** 招揽有了结果。officerId 为 null 表示没请动 */
  | { t: 'officer_joined'; officerId: string | null }
  | { t: 'camp_farming'; on: boolean }
  /** 请粮的公文发出去了 */
  | { t: 'ration_asked'; amount: number; replyDay: number }
  /** 请粮批下来了 */
  | { t: 'ration_replied'; asked: number; granted: number; outcome: RationOutcome }
  /** 就地征粮 */
  | { t: 'foraged'; took: number; reported: boolean }

  /** ── 出征（武将） ── */
  /** 军议开了，几条道摆出来了 */
  | { t: 'campaign_opened'; targetNodeId: string; foeTroops: number }
  /** 各路人马起行 */
  | { t: 'campaign_marched'; columns: number }
  /** 接战。ambush 为真表示这一仗是从伏击开始的 */
  | { t: 'campaign_battle_begun'; own: number; foe: number; ambush: boolean }
  /** 约好的那一路杀到了 */
  | { t: 'column_arrived'; men: number; from: 'flank' | 'rear'; officerId: string | null }
  /** 出征结束 */
  | { t: 'campaign_done'; won: boolean; merit: number; spoils: number }

  /** ── 战场（武将） ── */
  /** ── 军令 ── */
  | {
      t: 'order_issued'; kind: OrderKind; targetNodeId: string | null;
      amount: number; dueDay: number;
    }
  | { t: 'order_accepted' }
  | { t: 'order_settled'; outcome: 'done' | 'failed' | 'defied'; merit: number }

  | { t: 'theatre_opened'; targetNodeId: string; foeTroops: number }
  | { t: 'theatre_sent'; unitId: string; men: number; kind: UnitKind }
  | { t: 'theatre_begun'; own: number; foe: number }
  /** 主公任命了一位守将 */
  | { t: 'lord_appointed'; cityId: string; personId: string }
  /** 主公发的兵上路了 */
  | { t: 'lord_marched'; fromId: string; toId: string; troops: number; attack: boolean }
  /** 征调令下了，几路兵在往一处赶 */
  | { t: 'lord_mustered'; cityId: string; troops: number; from: number }
  /** 一座城兴修过了 */
  | { t: 'lord_invested'; cityId: string; dev: number; cost: number }
  /** 使者回来了 */
  | { t: 'lord_envoy_done'; factionId: string; shift: number; cost: number }
  /**
   * 上计 —— 季末各城把余粮解到治所。**这就是太仓的进项。**
   *
   * `bare` 是有几座城因为无人主事，一粒也解不上来 ——
   * 「城多了管不过来」第一次变成一个看得见的数。
   */
  | { t: 'tribute_collected'; grain: number; bare: number }
  /** 有人升了，或者掉下去了。rank 为 -1 是免官 */
  | {
      t: 'rank_changed'; personId: string; name: string;
      rank: number; title: string; up: boolean;
    }
  /** 拨粮的车自己上路了 —— 不用主公点头，够就发（见 feedCities） */
  | { t: 'convoy_auto'; fromId: string; toId: string; grain: number }
  /**
   * 先主没了。**这不是结局** —— 是一次交接（见 succession.ts）。
   * 日子停在这儿，等玩家看完他的一生，按下「继位」。
   */
  | {
      t: 'court_mourning'; name: string;
      ending: 'founded' | 'entrusted' | 'divided';
      heirId: string; heirName: string;
    }
  /** 新主继位了。望打了折，有人不肯事二主 */
  | { t: 'lord_succeeded'; name: string; reign: number; left: number; renown: number }

  /** ── 朝堂 ── */
  /** 案上摞上了一件事 */
  | {
      t: 'memorial_raised';
      kind: import('./lord_types.ts').MemorialKind; personId: string; id: string;
    }
  /** 有人上堂了 */
  | {
      t: 'memorial_staged';
      kind: import('./lord_types.ts').MemorialKind; personId: string; id: string;
    }
  /** 你批了一件 */
  | {
      t: 'memorial_answered';
      kind: import('./lord_types.ts').MemorialKind; personId: string;
      answer: import('./lord_types.ts').Answer;
    }
  /**
   * 他听完你的话，做了什么。
   *
   * **这是心气第一次看得见。** 表现层照着演那 0.6 秒：
   * 深揖、抱拳、躬身、颔首，或者一言不发转身就走。
   */
  | {
      t: 'memorial_reacted'; personId: string; name: string;
      reaction: import('./lord_types.ts').Reaction;
    }
  /** 一件事在案上放到过期了。不批也是一种批 */
  | {
      t: 'memorial_lapsed';
      kind: import('./lord_types.ts').MemorialKind; personId: string; name: string;
    }
  /** 有人不等你点头就自己动手了 */
  | { t: 'memorial_defied'; personId: string; name: string; cityId: string; troops: number }
  /** 粮车上路了 */
  | { t: 'convoy_sent'; toId: string; grain: number }
  /** 有人来投 */
  | { t: 'person_enlisted'; personId: string; name: string }
  /** 有人走了。defected 为真是不告而别 */
  | { t: 'person_left'; personId: string; name: string; defected: boolean }
  /** 一家没了，地并进了另一家 */
  | { t: 'faction_absorbed'; factionId: string; intoId: string; cities: number }
  /** 某家的主故去了。主亡则乱 */
  | { t: 'lord_died'; factionId: string; name: string }
  /** 尊号那件事有了下文 */
  | { t: 'throne'; how: 'claimed' | 'declined' | 'refused' | 'forced' }
  /** 散朝之后，天下走了几天 */
  | { t: 'adjourned'; days: number }
  /** 一骑上路了 */
  | { t: 'courier_sent'; fromId: string; kind: import('./lord_types.ts').MemorialKind }
  /** 一骑到了 */
  | { t: 'courier_arrived'; fromId: string; kind: import('./lord_types.ts').MemorialKind }
  /**
   * 一骑没了。
   *
   * **界面上不该为这件事弹任何字。** 玩家是看着他从驿传里消失的 ——
   * 少了一骑本身就是消息，用不着旁白。这条事件只给推演工具数数用。
   */
  | { t: 'courier_lost'; fromId: string; kind: import('./lord_types.ts').MemorialKind }
  /** 修了一段驿 */
  | { t: 'road_built'; fromId: string; toId: string }
  /** 募到了一批兵 */
  | { t: 'lord_levied'; cityId: string; men: number }
  /** 立了一座营 */
  | { t: 'camp_opened'; campId: string; cityId: string; personId: string }
  /** 撤了 */
  | { t: 'camp_closed'; campId: string }
  /** 依托的城丢了，营也散了 */
  | { t: 'camp_lost'; campId: string; cityId: string }
  /** 断粮，营散了 */
  | { t: 'camp_starved'; campId: string; cityId: string }
  /** 城营之间拨了兵 */
  | { t: 'drafted'; campId: string; men: number }
  /** 一道诏发出去了，从没从 */
  | { t: 'edict_sent'; to: string; kind: import('./lord_types.ts').EdictKind; obeyed: boolean }
  /** 有人告发某某与天子密谋 */
  | { t: 'plot_found'; personId: string; name: string }
  /** 衣带诏了结了 */
  | { t: 'plot_settled'; how: 'kill' | 'probe' | 'ignore' }
  /** 天下摊上一件事，各家都要表态 */
  | { t: 'situation_open'; id: string }
  /** 你表了态 */
  | { t: 'situation_answered'; id: string; option: string }
  /** 你举荐的人上任了 */
  | { t: 'recommended'; personId: string; cityId: string; trust: number; merit: number }
  /** 某座城派了新守将。城易主之后必有此事 */
  | { t: 'warden_posted'; cityId: string; personId: string }
  /** 斗将收场了 */
  | {
      t: 'duel_settled'; outcome: 'won' | 'lost' | 'draw' | 'refused';
      fatal: boolean; who: string; foe: string;
      /** 斗了几合，各胜几合 */
      rounds: number; ownWins: number; foeWins: number;
    }
  /** 细作回来了（或者没回来）。kind 是这一拨的下场 */
  | { t: 'theatre_scouted'; kind: 'clear' | 'graze' | 'lost' | 'duped'; men: number }
  /** 场上出事了。界面据此写战报、推镜头 */
  | {
      t: 'theatre_event'; textId: string; tone: 'plain' | 'good' | 'bad';
      at?: [number, number]; vars?: Record<string, string | number>;
    }
  | {
      t: 'theatre_done'; outcome: 'won' | 'lost' | 'withdrew';
      lost: number; foeLost: number; merit: number; spoils: number;
    }

  /** ── 守城战 ── */
  | { t: 'assault_begun'; cityId: string; factionId: string; attackers: number; defenders: number }
  | { t: 'assault_deployed'; wall: number; gate: number; reserve: number }
  | { t: 'assault_round'; round: number; defLoss: number; atkLoss: number; ram: number }
  | { t: 'assault_decision'; id: string }
  | { t: 'assault_decided'; textId: string; gambled: 'win' | 'lose' | null }
  | { t: 'assault_ended'; outcome: 'held' | 'fallen'; defLeft: number; atkLeft: number }

  /** ── 野战 ── */
  | { t: 'sortie_begun'; cityId: string; factionId: string; own: number; foe: number }
  | { t: 'sortie_deployed'; formation: Formation }
  | { t: 'sortie_engaged' }
  | { t: 'sortie_round'; round: number; ownLoss: number; foeLoss: number }
  | { t: 'sortie_decision'; id: string }
  | { t: 'sortie_decided'; textId: string; gambled: 'win' | 'lose' | null }
  | {
      t: 'sortie_ended'; outcome: 'won' | 'lost' | 'withdrew';
      ownLeft: number; foeLeft: number;
    }
  /** 流寇破城：抢一笔就走，城还是你的 */
  | { t: 'sacked'; cityId: string; grain: number; coin: number }

  /** 通用提示，文本由内容库渲染 */
  | { t: 'notice'; textId: string; vars: Record<string, string | number>; tone?: 'plain' | 'good' | 'bad' }
  | { t: 'rejected'; cmd: CommandType; reasonId: string };

export interface CommandResult {
  ok: boolean;
  events: SimEvent[];
}

export function ok(...events: SimEvent[]): CommandResult {
  return { ok: true, events };
}

export function reject(cmd: CommandType, reasonId: string): CommandResult {
  return { ok: false, events: [{ t: 'rejected', cmd, reasonId }] };
}
