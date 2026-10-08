/**
 * 野战。
 *
 * 守城能靠文字撑住，是因为你在城里、视角本来就受限。
 * 野战不行 —— 两军在开阔地上对垒，**看不见阵型就等于没在打仗**。
 * 所以这一层的每一个数据都是**空间的**：谁站在哪一格、哪一格是坡是林、
 * 谁在往谁那边走。渲染层直接读同一份坐标，不另摆一套。
 *
 * 玩家的输入仍旧是那三样：**摆阵、选阵型、战中两三次决断**。
 * 不做即时操作 —— 古代将领在战场上本来也就是在关键时刻做几个决定。
 */

/** 战场是九列七行。玩家在下两行，敌方在上两行，中间三行是要抢的地方 */
export const FIELD_COLS = 9;
export const FIELD_ROWS = 7;
/** 玩家可布阵的行 */
export const OWN_ROWS = [5, 6] as const;
/** 敌方布阵的行 */
export const FOE_ROWS = [0, 1] as const;

export type Terrain =
  /** 平地 */ | 'plain'
  /** 缓坡。居高临下，守得住也射得远 */ | 'hill'
  /** 林地。有掩蔽，但骑兵施展不开 */ | 'forest'
  /** 沼泽。走得慢，重甲陷在里面 */ | 'marsh'
  /** 河滩。半渡而击者胜 */ | 'ford';

export const TERRAIN_NAME: Record<Terrain, string> = {
  plain: '平地', hill: '缓坡', forest: '林', marsh: '沼', ford: '河滩',
};

export type UnitKind =
  /** 步卒 */ | 'foot'
  /** 弓弩 */ | 'bow'
  /** 骑兵 */ | 'horse';

export const UNIT_NAME: Record<UnitKind, string> = {
  foot: '步卒', bow: '弓弩', horse: '骑兵',
};

export type Side = 'own' | 'foe';

export interface FieldUnit {
  id: string;
  side: Side;
  kind: UnitKind;
  /** 人数。降到 0 即溃散 */ men: number;
  /** 开战时的人数，用于算折损比 */ men0: number;
  morale: number;
  col: number;
  row: number;
  /** 已经溃了。溃兵留在场上但不再作战 */ routed: boolean;
}

/**
 * 阵型。
 *
 * 每一种都是**有得有失**的 —— 不存在一个全面最优的阵，
 * 否则「选阵型」就退化成了一个仪式。
 */
export type Formation = 'yulin' | 'fengshi' | 'heyi' | 'fangyuan' | 'yanyue';

export interface FormationDef {
  id: Formation;
  name: string;
  desc: string;
  /** 攻击修正，千分数 */ attack: number;
  /** 防御修正，千分数 */ defend: number;
  /** 移动加成：多走几格 */ speed: number;
  /** 士气韧性，千分数。越高越不容易崩 */ steady: number;
  /** 侧翼受击时的额外损失，千分数。1000 为无额外 */ flank: number;
}

export const FORMATIONS: Record<Formation, FormationDef> = {
  yulin: {
    id: 'yulin', name: '鱼鳞',
    desc: '兵力压在中路，一点凿穿。两翼因此薄，被包抄就麻烦。',
    attack: 1220, defend: 950, speed: 0, steady: 1000, flank: 1350,
  },
  fengshi: {
    id: 'fengshi', name: '锋矢',
    desc: '前锋突出，一往无前。冲得快，也收不住 —— 陷进去就拔不出来。',
    attack: 1260, defend: 930, speed: 1, steady: 970, flank: 1220,
  },
  heyi: {
    id: 'heyi', name: '鹤翼',
    desc: '两翼张开，图的是合围。中军薄，正面被凿会很难看。',
    attack: 1050, defend: 1000, speed: 0, steady: 1050, flank: 800,
  },
  fangyuan: {
    id: 'fangyuan', name: '方圆',
    desc: '四面朝外，守得住。也几乎打不动别人 —— 这是等援兵的阵。',
    attack: 800, defend: 1280, speed: -1, steady: 1200, flank: 860,
  },
  yanyue: {
    id: 'yanyue', name: '偃月',
    desc: '中央后缩，诱敌深入再从两侧掩杀。看着弱，打的是耐心。',
    attack: 990, defend: 1060, speed: 0, steady: 1080, flank: 900,
  },
};

/** 战场的一格 */
export interface FieldCell {
  terrain: Terrain;
  /** 高度，仅供渲染。逻辑只看 terrain */
  height: number;
}

export interface FieldDecision {
  id: string;
  textId: string;
  vars: Record<string, string | number>;
  options: { textId: string; hintId: string; effect: FieldEffect }[];
  round: number;
  /** 镜头该推到哪里 —— 「左翼被冲开了」就该让人看见左翼 */
  focus: { col: number; row: number } | null;
}

/** 决断的后果。与守城战同理：改的是形势，不是胜负 */
export interface FieldEffect {
  /** 我方本轮攻击修正，千分数 */ ownAttack?: number;
  /** 我方本轮防御修正 */ ownDefend?: number;
  /** 敌方本轮攻击修正 */ foeAttack?: number;
  ownMorale?: number;
  foeMorale?: number;
  /** 立刻折损（人），按全军比例摊 */ ownMen?: number;
  foeMen?: number;
  /** 换阵型 */ formation?: Formation;
  gamble?: { chance: number; win: FieldEffect; lose: FieldEffect };
}

export interface FieldLogEntry {
  round: number;
  textId: string;
  vars: Record<string, string | number>;
  tone: 'plain' | 'good' | 'bad';
}

/** 还没上场、说好第几轮才到的那一路 */
export interface Reinforcement {
  /** 第几轮杀到 */
  round: number;
  men: number;
  /** 从哪一边切进来。侧翼从两翼，敌后从敌阵背后 */
  from: 'flank' | 'rear';
  /** 领这一路的部将，写战报用 */
  officerId: string | null;
}

export interface FieldBattle {
  /**
   * 打这一仗的缘由，决定胜负之后怎么写回世界。
   *
   * sortie   —— 文官出城迎击围城的敌军
   * campaign —— 武将出征，这一仗的开局由军议那份计划决定
   */
  cause: 'sortie' | 'campaign';
  /** 对手 */ foeFactionId: string;
  /** 相关的城 */ cityId: string;

  cells: FieldCell[];
  units: FieldUnit[];
  formation: Formation;
  /** 敌方阵型。侦察不足时玩家看不到 */ foeFormation: Formation;
  /** 侦察程度 0~100。决定敌阵看得清不清楚 */ scouting: number;

  round: number;
  maxRounds: number;
  phase: 'deploy' | 'fighting' | 'done';

  /** 本轮修正，用完清零 */
  ownAttackMod: number;
  ownDefendMod: number;
  foeAttackMod: number;

  pending: FieldDecision | null;
  usedDecisions: string[];
  log: FieldLogEntry[];
  outcome: 'won' | 'lost' | 'withdrew' | null;

  /**
   * 约好晚到的那几路。
   *
   * 这是「军议」在战术层留下的手 —— 你在出征前定的侧击，
   * 到这里变成第三轮从敌阵侧面切进来的一支兵。
   * 打到一半援兵杀到，是这套系统最该有的那个时刻。
   */
  reinforcements: Reinforcement[];
  /** 这一仗是不是从伏击开始的。开局的样子完全不同 */
  ambush: boolean;
}

// ─────────────────────────────────────────────────────────────
// 平衡常数
// ─────────────────────────────────────────────────────────────

export const FIELD_ROUNDS = 10;
/** 士气跌破此值即溃 */
export const ROUT_MORALE = 22;
/** 全军折损超过这个比例（千分数）就该收兵了 */
export const ARMY_BREAK = 550;

/** 兵种相克，千分数。[攻方][守方] */
export const KIND_MATCH: Record<UnitKind, Record<UnitKind, number>> = {
  //          步     弓     骑
  foot: { foot: 1000, bow: 1250, horse: 850 },
  bow: { foot: 900, bow: 1000, horse: 1150 },
  horse: { foot: 1200, bow: 1400, horse: 1000 },
};

/** 地形对各兵种的加成，千分数 */
export const TERRAIN_BONUS: Record<Terrain, Partial<Record<UnitKind, number>>> = {
  plain: {},
  hill: { foot: 1150, bow: 1250, horse: 1050 },
  forest: { foot: 1100, bow: 950, horse: 700 },
  marsh: { foot: 850, bow: 900, horse: 620 },
  ford: { foot: 800, bow: 950, horse: 750 },
};
