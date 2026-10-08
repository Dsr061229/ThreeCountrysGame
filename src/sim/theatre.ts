/**
 * 战场的推演。
 *
 * 每一拍做四件事，顺序不能乱：
 *
 *   一、看  —— 谁看得见谁。林子和坡挡视线，藏着的伏兵没被看见就等于不在
 *   二、走  —— 各自朝奉命去的地方挪一步，地面决定快慢
 *   三、打  —— 够得着的就打。位置决定疼不疼：背后、侧面、高处、水里
 *   四、断  —— 士气见底的溃散；主将溃了别人跟着慌
 *
 * 「看」必须排在最前面。这一条是整套设计的地基：
 * 伏击不是一个判定，是**敌军确实没看见**——
 * 他看见了就绕开，没看见就一头撞进来。
 */
import { chancePermille, nextInt, nextRange } from './rng.ts';
import type { RngState } from './rng.ts';
import { cellAt, COLS, ROWS } from './theatre_map.ts';
import {
  AMBUSH_BLOW, AMBUSH_MORALE, AMBUSH_PATIENCE, AMBUSH_SHOCK, AMBUSH_SPRING,
  DUEL_CHANCE, DUEL_FATAL, DUEL_LEADERLESS_VALOR, DUEL_LOSER_UNIT,
  DUEL_REFUSE_MORALE, DUEL_WAIT,
  DUEL_LOSS_MORALE, DUEL_MARGIN, DUEL_PACE, DUEL_ROUNDS, DUEL_WIN_MORALE,
  type Duel,
  COMMAND_SPAN, COMMAND_STEADY, VALOR_FLOOR, VALOR_SPAN, WIT_HIDE,
  BACKSTAB, FLANKED, GROUND, GROUND_NAME, HIGH_GROUND, KIND,
  SHAKEN_DEAL, SHAKEN_TAKE,
  FORTIFIED, FORTIFIED_RANGE, LEADER_LOST_MORALE, LETHALITY,
  BARE_BITE, ENGINE_BITE, MORALE_PER_LOSS, RAID_CLEAR, RALLY_EVERY,
  REARGUARD, RESTLESS_AFTER, ROUT_AT, SUPPLY_LOST_MORALE, UNDER_WALL, UNDER_WALL_OUT,
  WITHDRAW_TICKS, WORKS_WATCH,
  WALL_RANGE,
  type Theatre, type TheatreLine, type Unit,
} from './theatre_types.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const dist = (a: Unit, b: Unit): number => Math.hypot(a.x - b.x, a.y - b.y);

/** 一拍推进多少。给界面用的「一拍」是若干次这个 */
const STEP = 1;

// ─────────────────────────────────────────────────────────────
// 一、看
// ─────────────────────────────────────────────────────────────

/**
 * 甲看不看得见乙。
 *
 * 三件事说了算：离得多远、乙站的地方藏不藏得住、甲站得高不高。
 * 藏着的伏兵要近得多才看得见 —— 这就是伏击。
 */
function canSee(cells: Theatre['cells'], watcher: Unit, other: Unit): boolean {
  const d = dist(watcher, other);
  let range = KIND[watcher.kind].sight;

  // 站得高看得远
  const here = cellAt(cells, watcher.x, watcher.y);
  range += here.height * 1.8;

  // 对方藏在什么地方
  const there = cellAt(cells, other.x, other.y);
  const cover = GROUND[there.ground].cover;
  range *= 1 - (cover / 1000) * 0.72;

  // 存心藏着的，还要近得多才看得见。
  // 而**藏得好不好看设伏的人有多少智略** —— 这才是「智」在战场上的实处
  if (other.hidden && !other.revealed) {
    range *= 0.42 * ((1000 - (other.wit / 100) * (1000 - WIT_HIDE)) / 1000);
  }

  return d <= range;
}

/** 这一拍谁露了行迹 */
function look(t: Theatre): TheatreLine[] {
  const out: TheatreLine[] = [];
  for (const u of t.units) {
    if (!u.hidden || u.revealed || u.routed) continue;
    /**
     * **已经杀出去的伏兵不在这一段里。**
     *
     * 这是伏击从来没有成功过一次的原因，而且藏得很深：
     *
     * 「看」排在「打」前面（这是对的：先看见才打得着）。
     * 伏兵在五格外起身扑出去，可他一离开林子就没有遮蔽了 ——
     * 步卒的目力六格半，去掉藏身的对折还有两格七，
     * 而他要冲到不足一格才够得着人。
     * 于是**每一次**都是：冲到两格半 → look() 把他标成「已暴露」
     * → 下一拍真打上手时，fight() 里那句 `if (from.hidden)` 是假的。
     *
     * AMBUSH_BLOW、士气崩、乱阵 —— 那一整套从来没有执行过。
     * 实测十二局，伏兵起来的次数是 0。
     *
     * 真实的分寸是：**伏兵是靠出手暴露的，不是靠被看见。**
     * 蹲在圈里没动的，那才有藏不藏得住的问题 ——
     * 所以趴着的照旧会被发现（平地上伏兵一眼就看见），
     * 冲出去的那一段则一路藏到刀砍上去为止。
     */
    if (u.stance === 'ambush' && u.springing) continue;

    const foes = t.units.filter((o) => o.side !== u.side && !o.routed);
    for (const f of foes) {
      if (!canSee(t.cells, f, u)) continue;
      u.revealed = true;
      u.hidden = false;
      out.push({
        tick: t.tick,
        textId: u.side === 'own' ? 'th.spotted_ours' : 'th.spotted_theirs',
        tone: u.side === 'own' ? 'bad' : 'good',
        at: [u.x, u.y],
        vars: { who: u.name },
      });
      break;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 二、走
// ─────────────────────────────────────────────────────────────

/** 这一支这一拍想去哪儿 */
function aimOf(t: Theatre, u: Unit): [number, number] | null {
  if (u.routed) {
    // 溃兵往自己营的方向跑
    const home = u.side === 'own' ? t.ownCamp : t.foeCamp;
    return home;
  }

  // 鸣金了。全军脱离接触，往自家营退 —— 追不追是对面的事
  if (t.pullingAt >= 0 && u.side === 'own') return t.ownCamp;

  /**
   * 两军对峙久了，就得有人先动。
   *
   * 上一版的做法是「僵住九十拍就各自收兵」—— 那是拿判定去掩盖问题。
   * 真实的战场上不会这样：两支军队走到一处，要么打，要么有一方退走，
   * 不会隔着二里地站到天黑。
   *
   * 所以僵住之后**所有人都开始压上去**，不管原来奉的是什么命令。
   * 憋得越久压得越急 —— 伏兵等不到人就自己出来找，
   * 据守的部队也会忍不住往前挪。这才是那句「按兵不动」真正的分寸：
   * 它是一段时间，不是一辈子。
   */
  //
  // 但**伏兵不在此列**。伏兵的本分就是等 ——
  // 让他也跟着压上去，等于自己把自己交出去：
  // 实测三种地形一律在第五十拍暴露，「藏在林子里」彻底失去意义。
  //
  // 但这份耐心**不是无限的**。上一版写死了「伏兵永不压上」，
  // 于是一支三百人的伏兵会在林子里坐到打完 ——
  // 前头三路拼光了，他一箭没放。那不叫沉得住气，那叫失联。
  //
  // 真实的分寸是：圈是给走进来的人设的。人不来，而前头已经打起来了，
  // 那就没有什么可伏的了 —— 起身去打。
  const outOfPatience = u.waited > AMBUSH_PATIENCE && someoneFighting(t, u.side);
  const lyingInWait = u.stance === 'ambush' && u.hidden && !u.revealed
    && !outOfPatience
    && Math.hypot(u.x - u.toX, u.y - u.toY) < 1.2;

  /**
   * 守着工事的人**也不在此列**。
   *
   * 「僵久了谁都按不住」这条讲的是两支野战军隔着一片空地对望 ——
   * 那种局面确实有一方会先动。
   * 但一个守在自家鹿角壕沟后头的人没有这个道理：
   * 他等的就是你来撞，多等一个时辰对他只有好处。
   *
   * 上一版没分这一层，后果是**营寨的加成从来没有真正生效过**：
   * 守军在第七十拍全数涌出工事，跑到旷野上跟你打。
   * 实测九百人打七百六，只折六十二人 —— 那不叫攻营，叫收割。
   */
  const myCamp = u.side === 'own' ? t.ownCamp : t.foeCamp;
  const atWorks = u.stance === 'hold'
    && Math.hypot(u.x - myCamp[0], u.y - myCamp[1]) <= FORTIFIED_RANGE;
  /**
   * 但窝在工事里是**有前提的**：来犯的人得在你跟前。
   *
   * 少了这一句，会出现一种谁也收不了的场面 ——
   * 玩家把兵派到自家营门口按兵不动，守军也守着鹿角不动，
   * 两军隔着大半张图站到天黑。实测九百拍里只写出两行战报，
   * 最后还判玩家输了一场根本没打过的仗，
   * 而观战那一屏连个能点的按钮都没有。
   *
   * 现实里守将不会这么待着：你既然不来撞我，那我就出去赶你。
   */
  const threatened = t.units.some(
    (o) => o.side !== u.side && !o.routed
      && Math.hypot(o.x - myCamp[0], o.y - myCamp[1]) <= WORKS_WATCH,
  );
  const behindWorks = atWorks && threatened;

  if ((t.pressing || u.idle > RESTLESS_AFTER) && !lyingInWait && !behindWorks) {
    const prey = nearestFoe(t, u);
    if (prey) return [prey.x, prey.y];
    return u.side === 'own' ? t.foeCamp : t.ownCamp;
  }

  switch (u.stance) {
    case 'hold':
      // 「据守」是**走到那儿再守住**，不是原地生根。
      // 写成原地不动的后果是：你在图上点的那个位置毫无意义，
      // 兵永远待在营门口
      if (Math.hypot(u.x - u.toX, u.y - u.toY) > 0.6) return [u.toX, u.toY];
      return null;

    case 'ambush': {
      // 还没到位就先赶路；到了就趴着不动，直到猎物进了圈
      if (Math.hypot(u.x - u.toX, u.y - u.toY) > 0.8) return [u.toX, u.toY];
      /**
       * 伏兵看的是**路**，不是「看得见的敌人」。
       *
       * 藏与看是不对称的：趴在林子边上的人看得清道上过的是谁，
       * 道上的人却看不见林子里有什么。
       * 上一版这里用的是 nearestVisibleFoe —— 双向的目视判定，
       * 于是伏兵也被自己的遮蔽挡住了眼睛：
       * 敌军就在四格外站着，他「看不见」，一直不出手。
       * 实测十二局，伏兵出手的次数是 0。
       */
      const prey = nearestFoe(t, u);
      // 圈里空着的每一拍都记着。等得太久，上头那条 outOfPatience 会让他起身
      u.waited = prey && dist(u, prey) < 10 ? 0 : u.waited + 1;
      if (outOfPatience && prey) { u.springing = true; return [prey.x, prey.y]; }
      // 猎物走到侧旁就杀出去 —— 见 AMBUSH_SPRING
      if (prey && dist(u, prey) <= AMBUSH_SPRING) {
        u.springing = true;
        return [prey.x, prey.y];
      }
      return null;
    }

    case 'raid': {
      // 直取大营。路上的敌军能绕就绕
      const camp = u.side === 'own' ? t.foeCamp : t.ownCamp;
      return camp;
    }

    case 'reserve': {
      // 哪一路顶不住就去哪一路
      const friend = weakestFriend(t, u);
      if (friend) return [friend.x, friend.y];
      if (Math.hypot(u.x - u.toX, u.y - u.toY) > 0.8) return [u.toX, u.toY];
      return null;
    }

    default: {
      // 主攻：先奔指定的地方，到了就找敌人
      const prey = nearestVisibleFoe(t, u);
      if (prey) return [prey.x, prey.y];
      if (Math.hypot(u.x - u.toX, u.y - u.toY) > 0.8) return [u.toX, u.toY];
      // 无事可做就压向敌营
      return u.side === 'own' ? t.foeCamp : t.ownCamp;
    }
  }
}

/**
 * 最近的敌军，**不管看不看得见**。
 *
 * 只在两军僵住、要主动压上去的时候用 ——
 * 那种时候将领是知道对面大概在哪儿的（斥候、尘头、旗号），
 * 不必等到目视。
 */
function nearestFoe(t: Theatre, u: Unit): Unit | null {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const o of t.units) {
    if (o.side === u.side || o.routed) continue;
    const d = dist(u, o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

/** 自己这一边有没有人已经打上了。伏兵是不是该起身，看这个 */
function someoneFighting(t: Theatre, side: 'own' | 'foe'): boolean {
  return t.units.some((o) => o.side === side && !o.routed && o.target !== null);
}

function nearestVisibleFoe(t: Theatre, u: Unit): Unit | null {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const o of t.units) {
    if (o.side === u.side || o.routed) continue;
    if (o.hidden && !o.revealed) continue;
    if (!canSee(t.cells, u, o)) continue;
    const d = dist(u, o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

/** 自己人里打得最艰难的那一支 */
function weakestFriend(t: Theatre, u: Unit): Unit | null {
  let best: Unit | null = null;
  let worst = Infinity;
  for (const o of t.units) {
    if (o.side !== u.side || o.id === u.id || o.routed) continue;
    if (!o.target) continue;
    const share = o.men / Math.max(1, o.men0);
    if (share < worst) { worst = share; best = o; }
  }
  return best;
}

function move(t: Theatre, u: Unit): void {
  const aim = aimOf(t, u);
  if (!aim) return;

  const dx = aim[0] - u.x;
  const dy = aim[1] - u.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.05) return;

  const here = cellAt(t.cells, u.x, u.y);
  let pace = GROUND[here.ground].pace;
  // 骑兵进了林子沼地就施展不开 —— 这是骑兵唯一的软肋
  if (u.kind === 'horse' && (here.ground === 'forest' || here.ground === 'marsh')) {
    pace = Math.round(pace * 0.55);
  }
  // 溃兵跑得比谁都快
  const flee = u.routed ? 1.9 : 1;
  const speed = KIND[u.kind].speed * (pace / 1000) * flee * STEP;

  const step = Math.min(d, speed);
  u.x = clamp(u.x + (dx / d) * step, 0, COLS - 1);
  u.y = clamp(u.y + (dy / d) * step, 0, ROWS - 1);
  u.facing = Math.atan2(dy, dx);
}

// ─────────────────────────────────────────────────────────────
// 三、打
// ─────────────────────────────────────────────────────────────

/**
 * 这一下有多疼。
 *
 * 全部从位置算出来，不查表：
 *   背后挨的最疼，侧面次之；
 *   高处往下打占便宜；
 *   站在水里的最脆 —— 半渡而击就是这么回事；
 *   伏兵的头一下最狠。
 */
function blow(t: Theatre, from: Unit, to: Unit): number {
  const hereF = cellAt(t.cells, from.x, from.y);
  const hereT = cellAt(t.cells, to.x, to.y);

  let mult = 1000;
  mult = Math.round((mult * GROUND[hereF.ground].fight) / 1000);
  // 挨打的一方站在什么地方，也算他的账
  mult = Math.round((mult * 2000) / (1000 + GROUND[hereT.ground].fight));

  // 高差
  const climb = hereF.height - hereT.height;
  if (climb !== 0) mult += climb * HIGH_GROUND;

  // 从哪个方向打上来的。
  //
  // 算的是「挨打的人朝着的方向」与「敌人在哪个方向」之间的夹角：
  // 夹角小 = 他正面对着你，夹角大 = 你在他背后。
  //
  // 上一版这里符号写反了，正面迎战被判成了背后偷袭 ——
  // 两边同时享受这个 bug，所以从胜负上看不出来，
  // 但「绕到背后」这件事整个失去了意义。
  const toAttacker = Math.atan2(from.y - to.y, from.x - to.x);
  const diff = Math.abs(
    ((toAttacker - to.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI,
  );
  if (diff > Math.PI * 0.72) mult = Math.round((mult * BACKSTAB) / 1000);
  else if (diff > Math.PI * 0.38) mult = Math.round((mult * FLANKED) / 1000);

  // 伏兵那一下
  if (from.hidden && !from.revealed) mult = Math.round((mult * AMBUSH_BLOW) / 1000);

  // 守在自家营前的人占便宜 —— 鹿角、壕沟、熟悉的地面
  const homeT = to.side === 'own' ? t.ownCamp : t.foeCamp;
  if (Math.hypot(to.x - homeT[0], to.y - homeT[1]) <= FORTIFIED_RANGE) {
    mult = Math.round((mult * 1000) / FORTIFIED);
  }
  const homeF = from.side === 'own' ? t.ownCamp : t.foeCamp;
  if (Math.hypot(from.x - homeF[0], from.y - homeF[1]) <= FORTIFIED_RANGE) {
    mult = Math.round((mult * FORTIFIED) / 1000);
  }

  // 攻城：墙没破之前，墙下的人只有挨打的份。
  //
  // 这一条是「攻城」与「野战」真正分家的地方 ——
  // 少了它，一座城和一片空地没有分别
  if (t.kind === 'siege' && t.wall > 0) {
    const wallAt = t.foeCamp;
    const fromUnder = from.side === 'own'
      && Math.hypot(from.x - wallAt[0], from.y - wallAt[1]) <= WALL_RANGE;
    const toUnder = to.side === 'own'
      && Math.hypot(to.x - wallAt[0], to.y - wallAt[1]) <= WALL_RANGE;
    if (fromUnder) mult = Math.round((mult * UNDER_WALL_OUT) / 1000);
    if (toUnder) mult = Math.round((mult * UNDER_WALL) / 1000);
  }

  // 兵种相克：骑冲弓、弓射步、步挡骑
  if (from.kind === 'horse' && to.kind === 'bow') mult = Math.round(mult * 1.5);
  if (from.kind === 'bow' && to.kind === 'foot') mult = Math.round(mult * 1.2);
  if (from.kind === 'foot' && to.kind === 'horse') mult = Math.round(mult * 1.25);
  // 弓弩隔着打，杀伤要打折
  if (dist(from, to) > 1.4) mult = Math.round(mult * 0.62);

  // 乱着的队伍：挨打加倍，还手打折。伏击的账主要记在这里
  if (to.shaken > 0) mult = Math.round((mult * SHAKEN_TAKE) / 1000);
  if (from.shaken > 0) mult = Math.round((mult * SHAKEN_DEAL) / 1000);

  // 正在脱离接触的一方要挨断后的刀。撤退从来是最贵的一段
  if (t.pullingAt >= 0 && to.side === 'own') {
    mult = Math.round((mult * REARGUARD) / 1000);
  }

  // 勇：主将的分量。庸将八折，猛将一点二折 —— 见 VALOR_FLOOR
  const lead = (VALOR_FLOOR + (from.valor / 100) * VALOR_SPAN) / 1000;

  const power = from.men * KIND[from.kind].power * (0.55 + from.morale / 220) * lead;
  // 不进位 —— 零头由 Unit.wound 攒着。
  // 一进位，上面那一串乘数就全成了摆设
  return (power * LETHALITY * mult) / 1e9;
}

function fight(t: Theatre, rng: RngState): TheatreLine[] {
  const out: TheatreLine[] = [];
  const hits: { to: Unit; n: number; from: Unit }[] = [];

  for (const u of t.units) {
    if (u.routed || u.men <= 0) continue;
    // 藏着的人只在猎物进了扑击距离时才出手
    const reach = KIND[u.kind].reach;
    let picked: Unit | null = null;
    let bestD = Infinity;
    for (const o of t.units) {
      if (o.side === u.side || o.routed || o.men <= 0) continue;
      if (o.hidden && !o.revealed) continue;
      const d = dist(u, o);
      if (d > reach) continue;
      if (d < bestD) { bestD = d; picked = o; }
    }
    u.target = picked?.id ?? null;
    if (!picked) continue;
    /**
     * 接上手了。
     *
     * 这一句以前根本不报 —— 于是一场两百多拍的仗，
     * 从击鼓到第一支溃散之间是**整段的空白**：
     * 屏幕上什么字都没有，玩家以为卡住了。
     * 其实那正是全场最要紧的一段：谁先撞上谁。
     *
     * 只从我方这一头报，而且一支只报一次 ——
     * 两头都报就成了双份，每拍都报就成了刷屏。
     */
    if (u.side === 'own' && !u.toldEngaged) {
      u.toldEngaged = true;
      out.push({
        tick: t.tick,
        textId: 'th.engaged',
        tone: 'plain',
        at: [u.x, u.y],
        vars: {
          who: u.name,
          foe: picked.name,
          where: GROUND_NAME[cellAt(t.cells, u.x, u.y).ground],
        },
      });
    }
    hits.push({ to: picked, n: blow(t, u, picked), from: u });
  }

  /**
   * 伏兵一出手就不再是伏兵了。
   *
   * **这一段必须排在伤亡结算的前面。**
   *
   * 它原先写在下面那个循环里，而那个循环第一句就是
   * 「这一下还没攒够一个人，跳过」—— 伏兵扑出去的头一下往往
   * 正好只有零点几个人的账，于是 `continue` 把整段吃掉了：
   * 士气不掉、阵不乱、战报上一个字都没有。
   * 那一整套「伏击」的效果，从来没有执行过一次。
   *
   * 砍下去了就是砍下去了 —— 跟这一刀凑不凑得满一条人命无关。
   */
  for (const h of hits) {
    if (!h.from.hidden || h.from.revealed) continue;
    h.from.hidden = false;
    h.from.revealed = true;
    // 挨伏击的一方阵脚大乱 —— 伏击的分量在这里，不在那一下的伤害
    h.to.shaken = AMBUSH_SHOCK;
    h.to.morale = clamp(h.to.morale - AMBUSH_MORALE, 0, 100);
    out.push({
      tick: t.tick,
      textId: h.from.side === 'own' ? 'th.ambush_ours' : 'th.ambush_theirs',
      tone: h.from.side === 'own' ? 'good' : 'bad',
      at: [h.from.x, h.from.y],
      vars: {
        who: h.from.name,
        foe: h.to.name,
        where: GROUND_NAME[cellAt(t.cells, h.from.x, h.from.y).ground],
      },
    });
  }

  // 先全算完再一起结算 —— 否则先手的一方白占便宜
  for (const h of hits) {
    h.to.wound += h.n;
    const whole = Math.floor(h.to.wound);
    if (whole <= 0) continue;
    h.to.wound -= whole;
    const lost = Math.min(h.to.men, whole);
    h.to.men -= lost;
    /**
     * 统率压住的是**散**。
     *
     * 折同样多的人，统率高的队伍掉的士气少 ——
     * 他管的是队伍还成不成形，不是打得疼不疼。
     */
    const steady = (COMMAND_STEADY - (h.to.command / 100) * COMMAND_SPAN) / 1000;
    h.to.morale = clamp(
      h.to.morale
      - Math.round((lost * MORALE_PER_LOSS * steady) / Math.max(1, h.to.men0)),
      0, 100,
    );

    /**
     * 阵脚松了。
     *
     * 这是一场仗真正的转折点，而它以前只体现在一个慢慢变小的数字上。
     * 我方松了是「顶不住了，后援该动了」，
     * 敌方松了是「再推一把就散」—— 两句话都得说出口。
     *
     * 判的是**士气**不是人数：溃散本来就是士气驱动的，
     * 一支队伍掉一成五就崩，等它折到一半那一天永远不会来 ——
     * 按人数写的话这一句一次都报不出来。
     */
    if (!h.to.toldPressed && h.to.morale < 42) {
      h.to.toldPressed = true;
      out.push({
        tick: t.tick,
        textId: h.to.side === 'own' ? 'th.hard_ours' : 'th.hard_theirs',
        tone: h.to.side === 'own' ? 'bad' : 'good',
        at: [h.to.x, h.to.y],
        vars: { who: h.to.name, men: h.to.men },
      });
    }

  }

  // 攻城：到了墙下就开始砸墙。有器械砸得快，没器械就是拿人命撞
  if (t.kind === 'siege' && t.wall > 0) {
    let bite = 0;
    for (const u of t.units) {
      if (u.side !== 'own' || u.routed) continue;
      if (Math.hypot(u.x - t.foeCamp[0], u.y - t.foeCamp[1]) > WALL_RANGE) continue;
      bite += BARE_BITE + t.engines * ENGINE_BITE;
    }
    if (bite > 0) {
      t.wall = Math.max(0, t.wall - bite);
      if (t.wall <= 0) {
        out.push({ tick: t.tick, textId: 'th.wall_broken', tone: 'good', at: t.foeCamp });
        // 墙一破，守军就慌
        for (const o of t.units) {
          if (o.side === 'foe') o.morale = clamp(o.morale - 18, 0, 100);
        }
      }
    }
  }

  // 偷袭到了大营就烧粮 —— 但**营里不能还站着人**。
  //
  // 乌巢那一把火烧得成，是因为淳于琼的兵先被冲散了。
  // 少了这一条，一支骑兵绕过去就能一击定胜负，
  // 别的打法全没了意义
  for (const u of t.units) {
    if (u.stance !== 'raid' || u.routed) continue;
    const camp = u.side === 'own' ? t.foeCamp : t.ownCamp;
    if (Math.hypot(u.x - camp[0], u.y - camp[1]) > 1.8) continue;
    const guarded = t.units.some(
      (o) => o.side !== u.side && !o.routed
        && Math.hypot(o.x - camp[0], o.y - camp[1]) <= RAID_CLEAR,
    );
    if (guarded) continue;
    if (u.side === 'own' && t.foeSupply > 0) {
      t.foeSupply = 0;
      for (const o of t.units) {
        if (o.side === 'foe') o.morale = clamp(o.morale - SUPPLY_LOST_MORALE, 0, 100);
      }
      out.push({ tick: t.tick, textId: 'th.supply_burned', tone: 'good', at: camp });
    }
  }

  void rng;
  return out;
}

// ─────────────────────────────────────────────────────────────
// 四、断
// ─────────────────────────────────────────────────────────────

function morale(t: Theatre): TheatreLine[] {
  const out: TheatreLine[] = [];

  // 没在交战的队伍慢慢缓过来。
  // 少了这一条，士气只跌不涨 —— 一支被射了两轮又脱离接触的队伍
  // 会在原地一路萎到溃散，那不合情理
  if (t.tick % RALLY_EVERY === 0) {
    for (const u of t.units) {
      if (u.routed || u.target) continue;
      u.morale = clamp(u.morale + 1, 0, 100);
    }
  }

  for (const u of t.units) {
    if (u.shaken > 0) u.shaken -= 1;
    // 自己有没有在打。闲久了就该往前压 —— 见 Unit.idle
    u.idle = u.target ? 0 : u.idle + 1;
    if (u.routed) continue;
    if (u.men <= 0) {
      u.routed = true;
      out.push({
        tick: t.tick, textId: 'th.wiped',
        tone: u.side === 'own' ? 'bad' : 'good',
        at: [u.x, u.y], vars: { who: u.name },
      });
      continue;
    }
    if (u.morale > ROUT_AT) continue;
    u.routed = true;
    u.hidden = false;
    out.push({
      tick: t.tick,
      textId: u.side === 'own' ? 'th.routed_ours' : 'th.routed_theirs',
      tone: u.side === 'own' ? 'bad' : 'good',
      at: [u.x, u.y],
      vars: { who: u.name, where: GROUND_NAME[cellAt(t.cells, u.x, u.y).ground] },
    });
    // 一支垮了，旁边的人跟着慌；对面则来劲。
    //
    // 士气只在**这种时候**变，不按「打中一下加一点」来 ——
    // 那样赢的一方每拍都在涨，百来拍之后就成了无敌之师，
    // 一点小优势会滚成碾压。
    for (const o of t.units) {
      if (o.routed) continue;
      if (dist(o, u) > 9) continue;
      if (o.side === u.side) {
        o.morale = clamp(o.morale - LEADER_LOST_MORALE, 0, 100);
      } else {
        o.morale = clamp(o.morale + Math.round(LEADER_LOST_MORALE / 2), 0, 100);
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 一拍
// ─────────────────────────────────────────────────────────────

export function stepTheatre(t: Theatre, rng: RngState): TheatreLine[] {
  if (t.phase !== 'fighting') return [];
  t.tick += 1;

  const lines: TheatreLine[] = [];
  lines.push(...look(t));
  for (const u of t.units) move(t, u);
  lines.push(...fight(t, rng));
  lines.push(...morale(t));

  // 部将走样：性急的伏兵可能提前跳出来
  lines.push(...stray(t, rng));

  // 斗将。搦战出去之后就等玩家一句话 —— 界面那边会自己停下来
  lines.push(...challenge(t, rng));
  lines.push(...duelStep(t, rng));

  /**
   * 两军按不住了。
   *
   * 这一刻在模拟里早就存在（`pressing`），但从来没告诉过玩家 ——
   * 于是他只看见两团兵忽然一起动了，不知道为什么。
   * 说出来，那就是战场上真实发生过无数次的一句：僵持够久，谁都憋不住了。
   */
  if (t.pressing && !t.toldPressing) {
    t.toldPressing = true;
    lines.push({ tick: t.tick, textId: 'th.pressing', tone: 'plain' });
  }

  const done = checkDone(t);
  if (done) lines.push(done);

  t.log.push(...lines);
  return lines;
}

/**
 * 部将自作主张。
 *
 * 只在**憋着不动**的差事上发生 —— 伏兵与后援。
 * 冲锋没什么好走样的，按不住性子的人恰恰在等待时出事。
 */
function stray(t: Theatre, rng: RngState): TheatreLine[] {
  const out: TheatreLine[] = [];
  for (const u of t.units) {
    if (u.strayed || u.routed || !u.temper) continue;
    if (u.stance !== 'ambush' && u.stance !== 'reserve') continue;
    if (!u.hidden && u.stance === 'ambush') continue;

    // 性急的按不住，骄矜的嫌憋屈
    const risk = u.temper === 'rash' ? 9 : u.temper === 'proud' ? 5 : 0;
    if (risk === 0 || !chancePermille(rng, risk)) continue;

    // 附近有敌军才谈得上「忍不住」
    const foe = nearestVisibleFoe(t, u);
    if (!foe || dist(u, foe) > 14) continue;

    u.strayed = true;
    u.stance = 'assault';
    u.hidden = false;
    u.revealed = true;
    out.push({
      tick: t.tick,
      vars: { who: u.name },
      textId: u.side === 'own' ? 'th.strayed' : 'th.foe_strayed',
      tone: u.side === 'own' ? 'bad' : 'good',
      at: [u.x, u.y],
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 五、斗将
// ─────────────────────────────────────────────────────────────

/**
 * 有没有人出阵搦战。
 *
 * 条件卡得很紧，因为**单挑必须是稀罕事**：
 * 一仗至多一次；两边都得有个叫得出名字的将；两支兵正咬在一处；
 * 而且要么对面那位性子傲、性子急，要么他自忖打得过你。
 *
 * 满地都是单挑，那就成了另一个游戏。
 */
function challenge(t: Theatre, rng: RngState): TheatreLine[] {
  if (t.dueled || t.duel || t.pullingAt >= 0) return [];

  for (const f of t.units) {
    if (f.side !== 'foe' || f.routed || !f.leader || !f.target) continue;
    const mine = t.units.find((u) => u.id === f.target);
    if (!mine || mine.side !== 'own' || mine.routed || !mine.leader) continue;

    // 自忖打得过的才敢叫阵；性子傲的、急的更爱叫
    let odds = DUEL_CHANCE;
    if (f.valor > mine.valor) odds += 6;
    if (f.temper === 'proud' || f.temper === 'rash') odds += 5;
    if (!chancePermille(rng, odds)) continue;

    t.duel = {
      ownUnitId: mine.id,
      foeUnitId: f.id,
      ownName: mine.leader,
      foeName: f.leader,
      ownValor: mine.valor,
      foeValor: f.valor,
      ownOfficerId: mine.officerId,
      offeredAt: t.tick,
      round: 0,
      ownWins: 0,
      foeWins: 0,
      state: 'offered',
      outcome: null,
      fatal: false,
    };
    return [{
      tick: t.tick,
      textId: 'th.challenge',
      tone: 'plain',
      at: [f.x, f.y],
      vars: { foe: f.leader, who: mine.leader },
    }];
  }
  return [];
}

/**
 * 斗到第几合了。
 *
 * 一合一合地走，是为了让玩家**看得见**这件事在发生 ——
 * 一按就出结果的单挑，和掷一次骰子没有分别。
 *
 * 每一合按两人的勇力分胜负，净胜三合算分出高下；
 * 九合还分不出，那就是「不分胜负」—— 这在演义里本来就是最常见的收场。
 */
function duelStep(t: Theatre, rng: RngState): TheatreLine[] {
  const d = t.duel;
  // 迟迟不答话就当没理他。界面那边本来就会停拍，所以这只是道保险
  if (d && d.state === 'offered' && t.tick - d.offeredAt > DUEL_WAIT) {
    d.state = 'done';
    d.outcome = 'refused';
    for (const u of t.units) {
      if (u.routed || u.side !== 'own') continue;
      u.morale = clamp(u.morale - DUEL_REFUSE_MORALE, 0, 100);
    }
    return [{
      tick: t.tick, textId: 'th.duel_refused', tone: 'bad',
      vars: { who: d.ownName, foe: d.foeName },
    }];
  }
  if (!d || d.state !== 'fighting') return [];
  if ((t.tick - d.offeredAt) % DUEL_PACE !== 0) return [];

  const out: TheatreLine[] = [];
  d.round += 1;
  // 勇力定赢面，但**不是勇高就必胜** —— 留出翻船的余地
  const share = Math.round(
    (d.ownValor * 1000) / Math.max(1, d.ownValor + d.foeValor),
  );
  if (chancePermille(rng, share)) d.ownWins += 1;
  else d.foeWins += 1;

  const lead = d.ownWins - d.foeWins;
  const decided = Math.abs(lead) >= DUEL_MARGIN;

  if (!decided && d.round < DUEL_ROUNDS) {
    out.push({
      tick: t.tick,
      textId: lead > 0 ? 'th.duel_up' : lead < 0 ? 'th.duel_down' : 'th.duel_even',
      tone: lead > 0 ? 'good' : lead < 0 ? 'bad' : 'plain',
      vars: { who: d.ownName, foe: d.foeName, n: d.round },
    });
    return out;
  }

  d.state = 'done';
  if (!decided) {
    d.outcome = 'draw';
    out.push({
      tick: t.tick, textId: 'th.duel_draw', tone: 'plain',
      vars: { who: d.ownName, foe: d.foeName, n: d.round },
    });
    return out;
  }

  d.outcome = lead > 0 ? 'won' : 'lost';
  d.fatal = chancePermille(rng, DUEL_FATAL);
  out.push({
    tick: t.tick,
    textId: d.outcome === 'won'
      ? (d.fatal ? 'th.duel_slew' : 'th.duel_won')
      : (d.fatal ? 'th.duel_slain' : 'th.duel_lost'),
    tone: d.outcome === 'won' ? 'good' : 'bad',
    vars: { who: d.ownName, foe: d.foeName, n: d.round },
  });
  out.push(...settleDuel(t, d));
  return out;
}

/**
 * 斗完了怎么算。
 *
 * **赌注在士气不在人头。** 斗将的分量从来是三军看着 ——
 * 赢的那一边振奋，输的那一边夺气，而输的那一路自己额外再垮一截。
 * 折了主将的那一路，从此没了主心骨（勇跌到底）。
 */
function settleDuel(t: Theatre, d: Duel): TheatreLine[] {
  const win: 'own' | 'foe' = d.outcome === 'won' ? 'own' : 'foe';
  const lose: 'own' | 'foe' = win === 'own' ? 'foe' : 'own';

  for (const u of t.units) {
    if (u.routed) continue;
    if (u.side === win) u.morale = clamp(u.morale + DUEL_WIN_MORALE, 0, 100);
    else u.morale = clamp(u.morale - DUEL_LOSS_MORALE, 0, 100);
  }

  const loserId = lose === 'own' ? d.ownUnitId : d.foeUnitId;
  const loser = t.units.find((u) => u.id === loserId);
  if (loser) {
    loser.morale = clamp(loser.morale - DUEL_LOSER_UNIT, 0, 100);
    // 主将折了，这一路就没了主心骨
    if (d.fatal) {
      loser.valor = DUEL_LEADERLESS_VALOR;
      loser.leader = '';
    }
  }
  return [];
}

/** 不分胜负也好，没理他也好 —— 斗将这件事一仗只来一回 */
export function closeDuel(t: Theatre): void {
  t.dueled = true;
  t.duel = null;
}

function sideMen(t: Theatre, side: 'own' | 'foe'): number {
  return t.units
    .filter((u) => u.side === side && !u.routed)
    .reduce((a, u) => a + u.men, 0);
}

function checkDone(t: Theatre): TheatreLine | null {
  const own = sideMen(t, 'own');
  const foe = sideMen(t, 'foe');

  // 僵住了多久。用来催两军接战，**不是**用来提前收兵
  const alive = own + foe;
  if (alive !== t.lastAlive) {
    t.lastAlive = alive;
    t.staleFor = 0;
  } else {
    t.staleFor += 1;
    // 憋到头了就全军压上，而且再也回不去
    if (t.staleFor > RESTLESS_AFTER && !t.pressing) {
      t.pressing = true;
      t.pressedAt = t.tick;
    }
  }

  /**
   * 仗要收了，阵前那两个还绞着。
   *
   * 大军一散，斗将也就斗不下去了 —— 两边各自把人拉回来。
   * 这一句非有不可：少了它，玩家点了「出马」之后可能
   * **永远等不到结果**，那比没有这件事更糟。
   */
  if ((foe <= 0 || own <= 0 || t.tick >= t.maxTicks) && t.duel
    && t.duel.state !== 'done') {
    t.duel.state = 'done';
    t.duel.outcome = 'draw';
  }

  if (foe <= 0) {
    t.phase = 'done';
    t.outcome = 'won';
    return { tick: t.tick, textId: 'th.won', tone: 'good' };
  }
  if (own <= 0) {
    t.phase = 'done';
    t.outcome = 'lost';
    return { tick: t.tick, textId: 'th.lost', tone: 'bad' };
  }
  // 鸣金了。脱离接触之后就散场 —— 但必须有个头，不能又变成一段等不完的路
  if (t.pullingAt >= 0) {
    const clear = !t.units.some(
      (u) => u.side === 'own' && !u.routed && u.target !== null,
    );
    if (clear || t.tick - t.pullingAt >= WITHDRAW_TICKS) {
      t.phase = 'done';
      t.outcome = 'withdrew';
      return { tick: t.tick, textId: 'th.pulled_out', tone: 'plain' };
    }
  }

  if (t.tick >= t.maxTicks) {
    t.phase = 'done';
    /**
     * 天黑了怎么算。
     *
     * 原先是比**剩下的人数**：四百对九百，判你输 ——
     * 可那一仗你一个人都没折，对面也一个人都没折。
     * 一场没打过的仗判成败仗，是说不通的。
     *
     * 该比的是**这一天各自折了多少**：你伤他远多于他伤你，那是你赢；
     * 反过来是你输；两边都没怎么动手，那就是各自收兵。
     */
    const hurt = (side: 'own' | 'foe'): number => t.units
      .filter((u) => u.side === side)
      .reduce((a, u) => a + Math.max(0, u.men0 - u.men), 0);
    const mine = hurt('own');
    const theirs = hurt('foe');
    const started = t.units.reduce((a, u) => a + u.men0, 0);
    // 一天下来两边加起来还没折半成 —— 那不是仗，是对望
    const fought = mine + theirs > started * 0.05;
    t.outcome = !fought ? 'withdrew'
      : theirs > mine * 1.6 ? 'won'
        : mine > theirs * 1.6 ? 'lost'
          : 'withdrew';
    return { tick: t.tick, textId: fought ? 'th.dusk' : 'th.stared', tone: 'plain' };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────

export { dist, canSee, nearestVisibleFoe, nextInt, nextRange };
