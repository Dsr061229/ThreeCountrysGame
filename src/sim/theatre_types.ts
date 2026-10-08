/**
 * 战场。
 *
 * 这是武将这条线的核心，也是与文官那条线彻底分家的地方。
 *
 * 文官的野战是「摆阵型 → 一轮一轮结算」——
 * 那套东西的骨架是回合与阵型加成，玩家做的是选项题。
 *
 * 战场不是。战场是**一张地图**：
 *   你在图上点一个位置，说「乐进带二百弓弩去那个山头埋伏」，
 *   然后两军在图上真的走动、真的碰面、真的厮杀。
 *   伏兵藏在林子里，敌军没看见就走过去了 —— 那一下才叫伏击。
 *
 * 所以这里没有「阵型」这个概念，也没有回合。
 * 有的是位置、视野、朝向、距离，和时间。
 *
 * ── 三条硬规矩 ─────────────────────────────────────────
 *
 * 一、**看得见才打得着**。
 *    每支部队有自己的视野，林子和坡挡视线。
 *    藏在林子里的伏兵，敌军走到跟前才发现 —— 这不是一个百分比，
 *    是「他确实没看见」。
 *
 * 二、**位置决定一切**。
 *    背后挨打比正面挨打疼得多，高处往下打占便宜，
 *    渡水的时候最脆弱。这些都不是加成表里的条目，
 *    是从坐标算出来的。
 *
 * 三、**下令之后就交给他们了**。
 *    开打之后你只能在几个关口做决断，不能操控每一支兵。
 *    古代的将领在战场上就是这样 —— 令一出，剩下的看天。
 */
import type { Temper } from './officer_types.ts';

// ─────────────────────────────────────────────────────────────
// 地
// ─────────────────────────────────────────────────────────────

export type Ground = 'plain' | 'forest' | 'hill' | 'water' | 'marsh' | 'road';

export const GROUND_NAME: Record<Ground, string> = {
  plain: '平地',
  forest: '林',
  hill: '坡',
  water: '水',
  marsh: '沼',
  road: '道',
};

export interface GroundDef {
  /** 走得快慢，千分数。1000 = 常速 */
  pace: number;
  /** 藏身。站在这里，别人要多近才看得见（千分数，越大越藏得住） */
  cover: number;
  /** 在这里接战，战力的乘数（千分数） */
  fight: number;
  /** 高度。看得远、往下打占便宜 */
  height: number;
}

/**
 * 各种地面的性子。
 *
 * 这张表是整个战场的物理。它必须**互相咬得住**：
 * 林子藏得住人但打不开阵（cover 高、fight 低），
 * 坡上看得远打得狠但爬得慢，
 * 水里又慢又挨打 —— 半渡而击之所以是名局，就在这一行。
 */
export const GROUND: Record<Ground, GroundDef> = {
  plain: { pace: 1000, cover: 0, fight: 1000, height: 0 },
  road: { pace: 1350, cover: 0, fight: 960, height: 0 },
  forest: { pace: 700, cover: 820, fight: 880, height: 0 },
  hill: { pace: 620, cover: 260, fight: 1180, height: 1 },
  marsh: { pace: 450, cover: 380, fight: 700, height: 0 },
  water: { pace: 330, cover: 0, fight: 520, height: -1 },
};

export interface Cell {
  ground: Ground;
  /** 起伏。坡有高低，看得远近与俯冲都看它 */
  height: number;
}

// ─────────────────────────────────────────────────────────────
// 部队
// ─────────────────────────────────────────────────────────────

export type UnitKind = 'foot' | 'bow' | 'horse';

export const KIND_NAME: Record<UnitKind, string> = {
  foot: '步卒',
  bow: '弓弩',
  horse: '骑兵',
};

export interface KindDef {
  /** 常速（格／拍） */
  speed: number;
  /** 打得着多远（格） */
  reach: number;
  /** 看得见多远（格） */
  sight: number;
  /** 每人的分量 */
  power: number;
}

export const KIND: Record<UnitKind, KindDef> = {
  // 步卒：慢、近、结实。阵中的骨干
  foot: { speed: 0.30, reach: 0.9, sight: 6.5, power: 100 },
  // 弓弩：够得着远，但近身就完了
  bow: { speed: 0.26, reach: 3.4, sight: 7.5, power: 74 },
  // 骑兵：快得多，冲起来最狠，进了林子沼地就施展不开
  horse: { speed: 0.62, reach: 1.0, sight: 8.5, power: 155 },
};

/**
 * 你下给一支部队的命令。
 *
 * 这几样是玩家在地图上真正做的选择 —— 派谁、带多少、去哪儿、干什么。
 */
export type Stance =
  /** 主攻：走到那儿，见敌就打 */
  | 'assault'
  /** 埋伏：藏在那儿不动，等敌军走近了猛扑。要有遮蔽才藏得住 */
  | 'ambush'
  /** 后援：守在那儿，哪一路顶不住了就去哪一路 */
  | 'reserve'
  /** 偷袭：绕开敌军主力，直取他的大营 */
  | 'raid'
  /** 据守：钉在那儿不动，谁来打谁 */
  | 'hold';

export const STANCE_NAME: Record<Stance, string> = {
  assault: '主攻',
  ambush: '埋伏',
  reserve: '后援',
  raid: '偷袭',
  hold: '据守',
};

export const STANCE_DESC: Record<Stance, string> = {
  assault: '直插过去，见敌就打。这是你的正兵。',
  ambush: '伏在此处不动，等敌军走到近前再起。**要有林子或坡挡着才藏得住**，平地上伏不了人。',
  reserve: '按兵在此。哪一路顶不住了，他就往哪一路去。',
  raid: '绕开敌军，直取他的大营。烧了粮草，前头的人就散了。',
  hold: '钉在这儿。守住要紧的路口、渡头、坡顶，谁来都不让。',
};

export interface Unit {
  id: string;
  side: 'own' | 'foe';
  kind: UnitKind;
  officerId: string | null;
  /**
   * 战报上怎么称呼这一支。
   *
   * 「敌一路溃了」写四遍，玩家看到的是四条一模一样的字 ——
   * 那不叫战报，那叫计数器。战场上的每一支都该有个名字：
   * 你派出去的那几路叫得出将名，对面的叫得出前军、中军、弓弩、守营。
   * 有了名字，「乐进的伏兵起了，敌中军就是从那时候散的」才讲得出来。
   */
  name: string;
  men: number;
  men0: number;
  /** 士气 0~100。跌破了就溃 */
  morale: number;

  /** 现在在哪儿（格，连续值） */
  x: number;
  y: number;
  /** 面朝哪边（弧度）。背后挨打疼得多 */
  facing: number;

  /** 奉命去哪儿 */
  toX: number;
  toY: number;
  stance: Stance;

  /**
   * 藏着没有。
   *
   * 伏兵在被发现之前既不出手也不挨打 —— 他就是不在那儿。
   * 这是「埋伏」这件事在模拟里的全部：不是一个加成，是一段时间的隐身。
   */
  hidden: boolean;
  /** 已经动手了。伏兵一旦出手就不再藏 */
  revealed: boolean;
  routed: boolean;
  /** 正在跟谁咬着 */
  target: string | null;
  /** 部将的性子。走样、抗命都看它 */
  temper: Temper | null;
  /**
   * 领这一路的人叫什么。
   *
   * 单挑要有个名字才成立 ——「敌前军的将出阵搦战」是说明书，
   * 「华雄出马，指名要斗」才是那件事本身。
   */
  leader: string;
  /**
   * 领这一路的人有多大本事。
   *
   * **这三个数原先在战场上一次也没被读过。**
   *
   * 招一名部将要二百六十石、二十四天，界面上明明白白写着
   * 「统 76 勇 68」—— 而 theatre.ts 里 grep 不到一个 valor、
   * 一个 command。换句话说：招谁都一样，招不招也一样，
   * 那几个数字纯粹是画上去的。
   *
   * 「招将」是武将这条线上最主要的一件发育，它得真的兑现在刀口上。
   */
  valor: number;
  command: number;
  wit: number;
  /** 这一支有没有自作主张过 */
  strayed: boolean;
  /**
   * 战报里已经报过的事。
   *
   * 一支兵和对面咬上，是要报的；但要**只报一次** ——
   * 每拍报一遍就成了刷屏，而刷屏和什么都不报，对玩家是同一件事。
   */
  toldEngaged: boolean;
  toldPressed: boolean;
  /** 伏在圈里空等了多少拍。等过了头就该出来打 */
  waited: number;
  /**
   * 已经决定杀出去了。
   *
   * 起身与亮相是两回事。伏兵从圈里冲到刀口上要好几十拍
   * （一拍走不了多远），这段路上他还是伏兵 ——
   * 「被看见」不该在这段里把他变成一支普通的队伍。
   *
   * 少了这个标记，判定就只能拿「离伏点多远」来近似，
   * 而按实际的行军速度，他离开伏点一格半之前早被发现了：
   * 实测十二局，伏兵出手零次。
   */
  springing: boolean;
  /**
   * 这一支自己闲了多少拍。
   *
   * 全场的「僵住」是按两军人数之和有没有变来算的 ——
   * 可只要**别处**有人在打，那个数就一直在变，
   * 于是这两支隔着四格互相看不见的队伍会一直站到天黑。
   * 玩家看到的就是「两军都不肯上」。
   *
   * 所以每一支还要各记各的闲工夫：你自己闲太久了，
   * 不管别人打得多热闹，都该往前压。
   */
  idle: number;
  /**
   * 还要乱多少拍。
   *
   * 挨了伏击的队伍在这段时间里结不成阵：挨打加倍，还手打折。
   * 这才是伏击真正的杀伤 —— 见 AMBUSH_SHOCK。
   */
  shaken: number;
  /**
   * 伤亡的零头。
   *
   * 一拍打掉一点几个人，零头攒着 —— 攒够一个才真的少一个人。
   * 少了这一条，所有小于一的伤害都会被进位成一，
   * 地形与朝向的乘数就全白算了。
   */
  wound: number;
}

// ─────────────────────────────────────────────────────────────
// 一场仗
// ─────────────────────────────────────────────────────────────

export type TheatrePhase = 'orders' | 'fighting' | 'done';

export interface TheatreLine {
  tick: number;
  textId: string;
  vars?: Record<string, string | number>;
  tone: 'plain' | 'good' | 'bad';
  /** 出事的地方。镜头会推过去 */
  at?: [number, number];
}

/**
 * 打的是哪一种仗。
 *
 * 这两种从根上不同，不该混成一个：
 *
 *   野战 —— 两军在野地里对垒。地形是全部：坡、林、水、道。
 *          胜负在于谁先看见谁、谁绕到了谁背后。
 *
 *   攻城 —— 对面是一座城。城墙是硬的，没有器械就爬不上去；
 *          城门是唯一的软处；守军站在墙上占尽便宜。
 *          这里比的是你有没有备好攻城的家伙什。
 */
export type TheatreKind = 'field' | 'siege';

/**
 * 一仗打完之后的账。
 *
 * 这些数原先只随 `theatre_done` 事件飘过去一次 ——
 * 界面接不住，于是战后那一屏只写得出一个「胜」字。
 * 一场仗打了两刻钟，收场时连折了多少人都不告诉你，
 * 那前面所有的排兵布阵都没有落点。
 *
 * 记在战场上，战报就查得到，存档也带得走。
 */
/**
 * 细作回来说的话。
 *
 * `men` 是**他说的**数目，不是真的数目 —— 见 `sound`。
 */
export interface ScoutReport {
  /** 他说城下有多少人 */
  men: number;
  /** 这话靠不靠得住。假的那一份在界面上和真的一模一样 */
  sound: boolean;
  /** 第几拨细作带回来的 */
  wave: number;
}

/**
 * 单挑。
 *
 * 斗将在汉末不是常事，但它确实发生过，而且发生的时候
 * **决定的不是杀了几个人，是三军看着谁赢了** ——
 * 它是一件士气上的事，不是伤亡上的事。这里就照这个来做：
 * 赢了全军振奋，输了全军夺气，杀伤那一笔小得几乎可以不计。
 *
 * 玩家那一头它必须是个**决定**：出马有可能折掉一员好将，
 * 不理他则当场示弱。两条路都要疼。
 */
export interface Duel {
  /** 我方应战的是哪一路 */
  ownUnitId: string;
  /** 对面搦战的是哪一路 */
  foeUnitId: string;
  ownName: string;
  foeName: string;
  ownValor: number;
  foeValor: number;
  /** 我方出马的是哪位部将。null 表示你亲自出马 */
  ownOfficerId: string | null;

  /** 搦战在哪一拍发出的 */
  offeredAt: number;
  /** 已经斗了几合 */
  round: number;
  /** 各赢了几合 */
  ownWins: number;
  foeWins: number;
  state: 'offered' | 'fighting' | 'done';
  /** 收场：赢／输／不分胜负／没理他 */
  outcome: 'won' | 'lost' | 'draw' | 'refused' | null;
  /** 分出胜负时，输的那个是死是伤 */
  fatal: boolean;
}

export interface TheatreResult {
  /** 派出去多少人 */
  sent: number;
  /** 回来多少（溃散的算回来一半） */
  back: number;
  lost: number;
  foeLost: number;
  merit: number;
  spoils: number;
}

export interface Theatre {
  kind: TheatreKind;
  /** 图的格数 */
  cols: number;
  rows: number;
  cells: Cell[];

  units: Unit[];
  /** 我的营寨在哪儿 */
  ownCamp: [number, number];
  /** 敌方的大营或城在哪儿 */
  foeCamp: [number, number];
  /** 敌方那处叫什么 */
  foeName: string;
  foeFactionId: string;
  /** 打的是天下图上的哪一处 */
  targetNodeId: string;

  phase: TheatrePhase;
  tick: number;
  maxTicks: number;

  /** 斥候探得的清楚程度 0~100。决定开战前你看得见多少敌军 */
  intel: number;
  /** 已经派出去过几拨细作 */
  scouts: number;
  /**
   * 细作带回来的话。
   *
   * 注意它**不是**敌军的真实兵力，是「有人这么说」——
   * 两者可能不是一回事，而你在击鼓之前无从分辨。
   * 这正是派细作这件事有意思的地方：
   * 情报不是一个会自动变准的数字，是一句可能骗你的话。
   */
  report: ScoutReport | null;
  /** 敌方大营还剩多少粮。被偷袭烧光了，前头的人就散 */
  foeSupply: number;
  /**
   * 攻城时城墙还剩几成（千分数）。野战时是 0。
   *
   * 墙不破，你的人就只能在墙下挨射。
   * 破墙靠的是器械 —— 这是「修工坊」在战场上兑现的地方。
   */
  wall: number;
  /** 带来了几架攻城器械。营里的工坊修到几级就有几架 */
  engines: number;

  /** 尚未派出去的兵，按兵种 */
  pool: Record<UnitKind, number>;

  /** 上一次两军人数之和。用来看有没有僵住 */
  lastAlive: number;
  /** 场上正在斗的将。没人搦战就是 null */
  duel: Duel | null;
  /** 这一场已经斗过将了没有。一仗只斗一次，不然就成了车轮战 */
  dueled: boolean;

  /** 已经僵了多少拍 */
  staleFor: number;
  /** 「两军压上了」这一句报过没有 */
  toldPressing: boolean;
  /** 从哪一拍开始压上的。没压上是 -1 */
  pressedAt: number;
  /** 从哪一拍开始鸣金的。没鸣金是 -1 */
  pullingAt: number;
  /**
   * 两军已经压上来了。
   *
   * 一旦僵到按不住，全军就开始找对手 —— 而且**再也回不去**。
   * 少了这个「回不去」，会变成压一下、见血、停住、再僵、再压，
   * 两军隔着二里地来回磨蹭一整天。
   * 真实的战场上，投入了就是投入了。
   */
  pressing: boolean;

  log: TheatreLine[];
  outcome: 'won' | 'lost' | 'withdrew' | null;
  /** 收场之后的账。没打完是 null */
  result: TheatreResult | null;
}

// ─────────────────────────────────────────────────────────────
// 平衡常数
// ─────────────────────────────────────────────────────────────

/** 一场仗最多打多少拍。打到这儿还没分出胜负，各自收兵 */
export const MAX_TICKS = 900;
/**
 * 这么多拍没死一个人，两军就都按不住了，开始压上去。
 *
 * 这**不是**提前收兵的判定 —— 那种做法是拿规则去掩盖问题。
 * 真实的战场上，两支军队走到一处不会隔着二里地站到天黑：
 * 要么打，要么有一方退走。
 *
 * 所以僵住之后所有人都开始找对手，不管原来奉的是什么命令。
 * 「按兵不动」是一段时间，不是一辈子。
 */
export const RESTLESS_AFTER = 70;
/**
 * 打完一仗要歇多少天才能再出兵。
 *
 * 行军往返、收拢散卒、埋掉死人、修补器械 —— 一支刚打完的军队
 * 第二天不可能又出现在另一座城下。
 *
 * 少了这一条，玩家（和推演里的机器人）会天天出兵，
 * 一年打上百仗，战功像雪片一样落下来 —— 那不是战争，是刷副本。
 */
export const CAMPAIGN_REST = 26;

/**
 * 全军压上之后，伏兵还肯再等多少拍。
 *
 * 伏兵的本分是等 —— 所以它不跟着「按不住了」那一波压上去，
 * 否则藏在林子里就毫无意义。
 * 但等过了头就成了另一件荒唐事：前头三路打光了，
 * 林子里那三百人一箭没放，从头坐到尾。
 *
 * 圈没等到，就该出来打。
 */
export const AMBUSH_PATIENCE = 85;

/**
 * 鸣金之后，撤到多少拍算撤完。
 *
 * 收兵不是一按就没影了 —— 队伍要脱离接触，断后的要顶一阵。
 * 但它必须**有个头**：这是玩家用来脱身的那条路，
 * 不能又变成一段走不完的等待。
 */
export const WITHDRAW_TICKS = 70;
/** 鸣金时还咬着对面的队伍，每拍多挨多少（千分数）—— 断后的代价 */
export const REARGUARD = 1900;

/**
 * 守军窝在工事里不出来的前提：**你得在他跟前**。
 *
 * 少了这一条，会出现一种谁也收不了的场面：
 * 你按兵不动，他守着鹿角不动，两边隔着大半张图站到天黑。
 * 实测全军「据守」是 900 拍里只写出两行战报，
 * 而且最后还判你输 —— 一个没打过的仗。
 *
 * 现实里没有这种事：来犯的人不动手，守将迟早要出来赶他走。
 */
export const WORKS_WATCH = 14;

/**
 * 细作。
 *
 * 「敌营里有多少人」这件事，上一版是**开局自动算出来的一个数** ——
 * 玩家插不上手，看着像个天气预报。
 *
 * 而这是玩家早就要过的东西：派人去探，可能探不回来，
 * 探回来的还可能是假的。三样都要真的做出来，
 * 它才是一个**决定**：是花三十个人去问一句可能是谎话的话，
 * 还是省下这三十个人，蒙着眼打。
 */
/** 一拨细作多少人。他们不上阵 */
export const SCOUT_MEN = 30;
/** 最多派几拨。再多就成了刷情报 */
export const SCOUT_MAX = 3;
/** 探明了，清楚程度加多少 */
export const SCOUT_GAIN = 26;
/** 无功而返也算见过世面，加这么点 */
export const SCOUT_GRAZE = 8;
/** 假情报把敌军兵力说歪多少（千分数，正负各一半概率） */
export const SCOUT_LIE = 420;

/** 一支部队最少要这些人 */
export const MIN_MEN = 40;
/** 最多分几路。再多就不是排兵布阵，是填表 */
export const MAX_UNITS = 5;

/** 士气跌破这个数就溃 */
export const ROUT_AT = 20;
/**
 * 每一拍的基础杀伤。
 *
 * 这个数配着 `Unit.wound`（伤亡的零头）一起用。
 *
 * 上一版没有零头，每一下都 `Math.max(1, ...)` 进位成整数 ——
 * 而一支三百人的队伍一拍的账面伤害只有 0.66，
 * 于是**所有的乘数都失效了**：背后捅一刀是 1，高处冲下来也是 1，
 * 站在水里挨打还是 1。地形、朝向、伏击，全被那个进位抹平。
 *
 * 攒着零头之后，那些乘数才真的进得了账。
 */
export const LETHALITY = 47;
/**
 * 主将的本事怎么折算。
 *
 * 一个庸将和一员猛将带同样多的兵，差得该看得出来，但不该差到
 * 「谁带的兵谁就赢」—— 兵力、地形、朝向仍旧是大头。
 * 勇 0 打八折，勇 100 打一点二折，中间线性。
 */
export const VALOR_FLOOR = 800;
export const VALOR_SPAN = 400;
/**
 * 统率压住的是**散**。
 *
 * 统率高的队伍挨了打不容易乱 —— 折同样多的人，士气掉得慢。
 * 这条比「打得更疼」更贴近统率这两个字：他管的是队伍还成不成形。
 */
export const COMMAND_STEADY = 1150;
export const COMMAND_SPAN = 400;
/** 智略高的藏得住。伏兵被发现的距离乘这么多（千分数，智 100 时） */
export const WIT_HIDE = 550;

/**
 * 单挑的分寸，三条：
 *
 *   一、**不常有**。一仗至多一次，而且要两边都有将、正咬在一处。
 *      满地都是单挑，那就成了另一个游戏。
 *   二、**赢面看勇，但勇高不必胜**。潘凤对上华雄该输，
 *      可华雄也翻得了船 —— 不然它不是一个决定，是一道算术题。
 *   三、**赌注在士气不在人头**。斗将的分量从来是三军看着。
 */
/** 两军咬上之后，每拍有多大机会有人出阵搦战（千分数） */
export const DUEL_CHANCE = 8;
/** 至多斗多少合。到头还分不出，就是不分胜负 */
export const DUEL_ROUNDS = 9;
/**
 * 隔几拍走一合。
 *
 * 五拍一合的时候，斗满九合要四十五拍 —— 而实测四百场里
 * **有三百零二场的单挑没斗完，仗就先结束了**：
 * 玩家点了「出马」，看了两三合，然后再没有下文。
 * 一件永远不揭晓的事，比没有这件事更糟。
 */
export const DUEL_PACE = 3;
/**
 * 搦战之后，等玩家多少拍。
 *
 * 界面在搦战一出现的时候就会自己停下来，所以正常情况下这个数
 * **永远不会走到** —— 拍子都停了。
 * 它是一道保险：万一哪条路子上界面没停，仗也不会就此卡死在
 * 一个等不到回答的问句上。犹豫太久就当没理他。
 */
export const DUEL_WAIT = 40;
/** 净胜这么多合就算分出了胜负 */
export const DUEL_MARGIN = 3;
/** 分出胜负时，输家当场毙命的机会（千分数）。其余是负伤退回本阵 */
export const DUEL_FATAL = 340;
/** 赢了，本方全军涨多少士气 */
export const DUEL_WIN_MORALE = 12;
/** 输了，本方全军掉多少士气 */
export const DUEL_LOSS_MORALE = 14;
/** 输的那一路自己另外再掉多少 */
export const DUEL_LOSER_UNIT = 10;
/** 不理他，本方掉多少士气 —— 拒战就是示弱 */
export const DUEL_REFUSE_MORALE = 6;
/** 主将折了，那一路的勇跌到多少 */
export const DUEL_LEADERLESS_VALOR = 25;
/** 部将负伤，要将养多少天 */
export const HURT_DAYS = 40;
/** 你自己负了伤，多少天动不了兵 */
export const HURT_DAYS_SELF = 60;

/** 背后挨打，伤害乘这么多（千分数） */
export const BACKSTAB = 2100;
/** 侧面挨打 */
export const FLANKED = 1450;
/** 伏兵头一下，伤害乘这么多 */
export const AMBUSH_BLOW = 3200;
/**
 * 挨了伏击之后，乱多少拍。
 *
 * **伏击的分量从来不在那一下。**
 *
 * 上一版只给了头一击一个 ×3.2 —— 一拍。一场仗三百拍，
 * 那一拍在总账里约等于零。于是推演表上「诱敌 + 林中埋伏」
 * 无论人多人少都比「全军平推」更亏：慢一百拍，还多折五十人。
 * 这条线最漂亮的玩法，是全场最差的选择。
 *
 * 真实的伏击杀伤也不在第一下：人是排着行军纵队走的，
 * 刀还在鞘里，队形没有展开，忽然两侧鼓噪 ——
 * 接下来那一阵子他既结不成阵，也不知道该朝哪边打。
 * 值钱的是**那一阵子**。
 */
export const AMBUSH_SHOCK = 34;
/**
 * 伏兵在多远就扑出去（格）。
 *
 * 上一版是「进了扑击距离」—— 步卒的 reach 是 0.9 格，
 * 加上两格余量也就三格。三格是**刀已经架上脖子**的距离，
 * 敌军贴着林子边走过去都不算进圈。
 * 实测的后果是伏兵十次有八次白等一整场。
 *
 * 真的伏兵不等人走到跟前：看见旗号从侧面过，就鼓噪杀出去。
 */
export const AMBUSH_SPRING = 5.5;
/** 乱着的时候，挨打乘这么多（千分数） */
export const SHAKEN_TAKE = 1650;
/** 乱着的时候，打出去乘这么多（千分数） */
export const SHAKEN_DEAL = 560;
/** 挨了伏击，当场掉多少士气 */
export const AMBUSH_MORALE = 20;
/** 高处往下打的加成，每一级高差 */
export const HIGH_GROUND = 220;

/**
 * 守在自家营前的加成（千分数）。
 *
 * 攻打一座扎好的营是要付代价的 —— 有鹿角、有壕、有橹楼，
 * 守的人熟悉每一处地面。少了这一条，攻方以少胜多太轻松：
 * 实测八百人能稳吃两千守军，那不像打仗，像赶集。
 */
export const FORTIFIED = 1620;
/** 离营多近才算「守在营前」（格） */
export const FORTIFIED_RANGE = 7;

/**
 * 大营被烧，全军士气掉多少。
 *
 * 乌巢一把火烧垮了袁绍 —— 这一条该重，但不该是一击必杀。
 * 34 的时候「偷袭大营」的胜率是 92%，压过其余所有打法，
 * 那玩家就只会用这一招了。
 */
export const SUPPLY_LOST_MORALE = 24;

/**
 * 攻城：墙下的账。
 *
 * 城墙是**硬的**。没有器械，你的人在墙下只能挨射 ——
 * 这一条要够狠，狠到玩家宁可先回营修三个月工坊。
 * 汉末攻城动辄经年，靠的从来不是人多。
 */
/** 墙没破时，攻方在墙下挨打乘这么多（千分数） */
export const UNDER_WALL = 2300;
/** 墙没破时，攻方打出去的伤害乘这么多 */
export const UNDER_WALL_OUT = 320;
/** 离城墙多近算「在墙下」（格） */
export const WALL_RANGE = 5;
/** 每一架器械，每拍砸掉多少城墙（千分数） */
export const ENGINE_BITE = 3;
/** 没有器械时，纯拿人命撞城门，每拍砸掉多少（千分数） */
export const BARE_BITE = 0.4;

/** 敌军每损失一百人，缴获多少粮。因粮于敌 */
export const SPOILS_PER_FOE = 55;
/** 营里还有这么近的守军，粮就烧不成 */
export const RAID_CLEAR = 4.5;
/**
 * 旁边一支溃了，别人跟着掉多少士气。
 *
 * 这个数从 12 压到 6，是因为**溃散会连锁**：
 * 守军若被拆成五六支，一支溃了旁边掉 12，接着第二支溃、第三支溃 ——
 * 六支连着来，等于全军自己把自己吓垮了。
 * 实测八百人能稳吃一千二的守军，那不是以少胜多，是雪崩。
 */
export const LEADER_LOST_MORALE = 6;

/**
 * 每损失全队的千分之一，士气掉多少（千分数）。
 *
 * 这个数直接决定一支队伍挨多少打才崩。
 * 260 的时候，掉一成五就溃 —— 太脆了，
 * 战场上于是全是一触即溃的小队。
 */
export const MORALE_PER_LOSS = 170;

/** 不在交战中的队伍，每这么多拍回一点士气 */
export const RALLY_EVERY = 12;
