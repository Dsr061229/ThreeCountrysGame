/**
 * 天下的日结算 —— 城池自己长，势力自己打，玩家在其中做一个县令。
 *
 * 这一层刻意做得比玩家那座城**粗**：几十座城不需要各自跑二十五块地，
 * 它们只需要「看起来在活着」并且偶尔派兵来敲你的门。
 * 算力应当花在玩家看得见的地方。
 */
import { chance, nextInt, nextRange } from './rng.ts';
import { mintId, type WorldState } from './state.ts';
import { roadKey, type ContentIndex } from './content.ts';
import type { SimEvent } from './commands.ts';
import { computeOutput, eachBuilt } from './city.ts';
import { appointWarden, civilPermille, wardenOf } from './people.ts';
import { heartPermille } from './court.ts';
import { bumpMerit, rankBoost } from './tribute.ts';
/**
 * 围到第几日，攻方才开始考虑蚁附。
 *
 * 之前先耗着 —— 耗是为了逼降、为了等对方粮尽，
 * 真要爬墙是要死人的，没有哪个将领上来就干这个。
 */
const SIEGE_STORM_AFTER = 12;
import { campAt, drillPermille } from './barracks.ts';
import { MERIT_HELD_SIEGE, MERIT_LOST_CITY, MERIT_TAKE_CITY, SEAT_GRAIN_MULT } from './lord_types.ts';
import { angerFrom, tickDiplomacy } from './diplomacy.ts';
import { passageOf } from './march.ts';
import type { City } from './types.ts';
import {
  AFTER_CAPTURE_QUIET, AFTER_SIEGE_QUIET, ARMY_UPKEEP_PER_1000,
  CITY_DEV_PER_SCALE, CITY_GRAIN_PER_DEV, CITY_UPKEEP_PER_1000, GRACE_DAYS,
  WARDEN_BASE, WARDEN_GOOD_AT, WARDEN_NONE, WARDEN_PER_COMMAND,
  MARCH_PER_DAY, MILITIA_BASE,
  type Army, type CityNode,
} from './world_types.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ─────────────────────────────────────────────────────────────
// 守备力
// ─────────────────────────────────────────────────────────────

/**
 * 玩家那座城的守军：兵营里的兵 + 乡勇。
 *
 * 乡勇跟着户口走 —— 一座有几百户人家的县，临事总凑得出些拿锄头的人。
 * 但乡勇顶不了事，真要守城还得靠兵营。
 */
export function garrisonOf(city: City, idx: ContentIndex): number {
  let n = MILITIA_BASE + Math.floor(city.households / 5);
  eachBuilt(city, idx, (def, level) => {
    if (def.garrison) n += def.garrison * level;
  });
  return n;
}

/**
 * 守城的实际强度。
 *
 * 城墙是乘数而不是加数 —— 一堵好墙让同样的人守得住三倍的敌人，
 * 这也是为什么修城值得占用一整季的钱粮。
 */
export function defenceOf(city: City, idx: ContentIndex): number {
  const men = garrisonOf(city, idx);
  const wall = 1000 + city.wall * 420;
  // 民心低的城，守军也没有斗志
  const spirit = 600 + Math.floor((clamp(city.morale, 0, 100) * 600) / 100);
  return Math.floor((men * wall * spirit) / 1_000_000);
}

/**
 * NPC 城的守备强度。规则与玩家的一致，只是数据来源简化。
 *
 * **守将是要算进来的** —— 见 WARDEN_NONE 上头那一段。
 * 少了这一层，「任命」在机制上等于不存在。
 */
/** 一座城眼下守得住多少。测试要拿它当尺子，所以导出一个按 id 查的壳 */
export function nodeDefenceOf(
  state: WorldState, idx: ContentIndex, cityId: string,
): number {
  const node = state.nodes[cityId];
  return node ? nodeDefence(state, idx, node) : 0;
}

function nodeDefence(state: WorldState, idx: ContentIndex, node: CityNode): number {
  const spirit = 600 + Math.floor((clamp(node.morale, 0, 100) * 600) / 100);
  /**
   * **城外那座营也在守。**
   *
   * 营在城外几里，敌军兵临城下的时候它当然要打 ——
   * 郡兵守墙，部曲野战，这本来就是一处的两支兵。
   *
   * 少了这一句，营就成了一个只出不进的坑：
   * 推演里陶谦第十年营里三千八百人、城里六百六十人，
   * 而那座城照样被人围死 —— 三千八百人在几里外看着。
   * 那既不合情理，也把「立营」变成了纯粹的自杀。
   *
   * 练熟的兵按操练折算，和出兵时是同一把尺子。
   */
  /**
   * **只顶六成。** 营在城外，不在墙后 ——
   * 同样的人，站在垛口后头和站在旷野里，不是一回事。
   *
   * 顶满的那一版实测把主公变成了不倒翁：四十局里只死一局，
   * 平均活到十四年、终局据城七座。守得住不该等于打不死。
   */
  const camp = campAt(state, node.id);
  const extra = camp
    ? Math.round((camp.troops * drillPermille(camp) * 0.6) / 1000)
    : 0;
  return Math.floor(((node.troops + extra) * 1200 * spirit
    * wardenPermille(state, idx, node.id)) / 1_000_000_000);
}

/** 这座城的守将顶多少事（千分数） */
export function wardenPermille(
  state: WorldState, idx: ContentIndex, nodeId: string,
): number {
  /**
   * 玩家亲自坐镇的那座城不吃这一层。
   *
   * 「有没有守将」问的是主公派没派人去。玩家自己就在城里 ——
   * 拿「他没给自己派个守将」去扣他的城防，是说不通的。
   */
  // 主公不亲自守城，他治下每一座都按「派没派人」算
  if (state.role !== 'lord' && nodeId === state.official.cityId) return 1000;
  const w = wardenOf(state, idx, nodeId);
  if (!w) return WARDEN_NONE;
  // 统率按十分数算，寻常守将（统 70）落在一附近
  const able = Math.round(
    (WARDEN_BASE + Math.round((w.command * WARDEN_PER_COMMAND) / 10)
      + (w.good.includes('守备') ? WARDEN_GOOD_AT : 0))
    // 品秩：一位太守调得动的人力物力，不是一个县丞比得了的
    * rankBoost(state, w.id) / 1000,
  );
  /**
   * 再乘一层心气。
   *
   * **这是心气真的在跑的地方之一**：一个称病不出的人守的城，兵是散的。
   * 少了这一乘，心气就又是一条「有数据、没行为」的东西 ——
   * 那正是记忆里 dead-mechanic-audit 抓过好几回的毛病。
   */
  return Math.round((able * heartPermille(state, state.posts[nodeId] ?? null)) / 1000);
}

/** 城墙系数。玩家的城看 wall 等级，NPC 的城按规模估 —— 治所本来就比小县难打 */
function wallPermilleOf(
  playerCity: City | undefined, nodeId: string, idx: ContentIndex,
): number {
  if (playerCity) return 1000 + playerCity.wall * 450;
  const scale = idx.node.get(nodeId)?.scale ?? 1;
  return 1000 + scale * 130;
}

// ─────────────────────────────────────────────────────────────
// 日结算
// ─────────────────────────────────────────────────────────────

export function tickWorld(state: WorldState, idx: ContentIndex): SimEvent[] {
  const events: SimEvent[] = [];
  syncPlayerNodes(state, idx);
  growNodes(state, idx);
  events.push(...marchArmies(state, idx));
  events.push(...resolveSieges(state, idx));
  events.push(...decideFactions(state, idx));
  // 天下大势：共同的敌人、强邻可畏、旧怨淡去。见 diplomacy.ts
  events.push(...tickDiplomacy(state, idx));
  return events;
}

/** 把玩家那座城的完整状态，折算成天下图上的一个节点 */
function syncPlayerNodes(state: WorldState, idx: ContentIndex): void {
  for (const id of Object.keys(state.cities)) {
    const city = state.cities[id]!;
    const node = state.nodes[id];
    if (!node) continue;
    const out = computeOutput(city, idx);
    node.dev = out.dev;
    node.grain = city.grain;
    node.morale = city.morale;
    node.troops = garrisonOf(city, idx);
  }
}

/** NPC 城池自己长。长得快慢取决于所属势力的治理水平 */
function growNodes(state: WorldState, idx: ContentIndex): void {
  for (const id of Object.keys(state.nodes).sort()) {
    const node = state.nodes[id]!;
    if (state.cities[id]) continue; // 玩家的城由完整模型驱动
    const f = idx.faction.get(node.factionId);
    const gov = f?.governance ?? 40;

    // 离心逐日消退，新附之地要时间才吃得下
    if (node.unrest > 0) node.unrest -= 1;

    /**
     * 这座城的政事办得怎么样。
     *
     * 势力的治理水平打底，减掉离心 —— 再乘一层**守将的文治**：
     * 派个纯武人去守，墙是牢的，账是糊涂的（见 `civilPermille`）。
     * 「文官占城池」这句话的分量就落在这一乘上。
     */
    /**
     * 守将的文治，再乘一层他的**品秩**（见 tribute.ts）。
     * 一个太守办得动的事比一个县丞多 —— 升迁因此不是一个头衔，是产出。
     */
    const w = wardenOf(state, idx, id);
    const civil = Math.round((civilPermille(w) * rankBoost(state, w?.id ?? null)) / 1000);
    const effective = Math.max(
      0, Math.round(((gov - Math.floor(node.unrest / 2)) * civil) / 1000),
    );
    // 被围的城长不了
    if (state.sieges[id]) continue;

    if (state.day % 6 === 0) {
      // 小县再怎么经营也还是小县 —— 见 CITY_DEV_PER_SCALE
      const devCap = Math.max(1, idx.node.get(id)?.scale ?? 1) * CITY_DEV_PER_SCALE;
      if (node.dev < devCap) node.dev += chance(state.rng, effective) ? 1 : 0;
      node.morale = clamp(
        node.morale + (effective > 50 ? 1 : -1) - (node.unrest > 40 ? 1 : 0),
        10, 92,
      );
    }
    /**
     * 粮：收进来，也吃出去，而且仓是有底的。
     *
     * 上一版只有 `grain +=` 那一句 —— 不消耗，也没有上限。
     * 两年下来一座民心只剩十的小城能攒下三万六千石，
     * 而玩家点开它就看得见这个数。
     *
     * 更要紧的是它把一道门槛作废了：势力出兵要「粮足」
     * （见 decideFactions 里的 `src.grain < 400`），
     * 而粮无限涨之后那句判断永远为真 —— 粮从来不曾拦住过谁。
     */
    node.grain += Math.floor((node.dev * effective) / 40);
    // 守军要吃饭 —— 但守在城里比在外头行军省得多
    node.grain -= Math.max(1, Math.floor((node.troops * CITY_UPKEEP_PER_1000) / 1000));
    /**
     * 仓廪有底。存不下的粮会烂掉、会被吃掉、会被上头调走。
     *
     * **治所另算。** 它是总仓 —— 全境解上来的粮都堆在这儿（见 tribute.ts）。
     * 少了这一条，季末解上来的粮当天就被这句 clamp 削掉，
     * 太仓永远见底，而玩家找不出是哪儿漏的。
     */
    const seatOfLord = state.role === 'lord' && id === state.official.cityId;
    node.grain = clamp(node.grain, 0, Math.max(800, node.dev * CITY_GRAIN_PER_DEV)
      * (seatOfLord ? SEAT_GRAIN_MULT : 1));

    /**
     * 郡兵自己长。
     *
     * 原先是 `nextInt(rng, 3)` —— 不论城大城小，一律每日零到二人。
     * 于是一座通都大邑和一个小县长得一样慢，天下的兵力
     * 到中期就一齐贴着 `dev × 26` 那条顶不动了：
     * 玩家看到的是「谁也不发育，兵永远缺」。
     *
     * 户口多的地方本来就募得快 —— 按开发度算，再乘民心。
     * 民不聊生的地方，招不上人。
     */
    const troopCap = node.dev * 26;
    if (node.troops < troopCap) {
      const pace = Math.max(1, Math.floor((node.dev * clamp(node.morale, 0, 100)) / 260));
      node.troops = Math.min(troopCap, node.troops + 1 + nextInt(state.rng, pace));
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 行军
// ─────────────────────────────────────────────────────────────

function marchArmies(state: WorldState, idx: ContentIndex): SimEvent[] {
  const events: SimEvent[] = [];
  for (const id of Object.keys(state.armies).sort()) {
    const army = state.armies[id]!;

    // 口粮。断粮的军队会自己散掉 —— 掐粮道之所以有用，就在这里
    const eat = Math.max(1, Math.floor((army.troops * ARMY_UPKEEP_PER_1000) / 1000));
    army.supply -= eat;
    if (army.supply <= 0) {
      army.troops -= Math.max(4, Math.floor(army.troops / 12));
      if (army.troops <= 20) {
        delete state.armies[id];
        events.push({ t: 'army_dispersed', factionId: army.factionId, toId: army.toId });
        continue;
      }
    }

    const len = idx.roadLength.get(roadKey(army.fromId, army.toId)) ?? 12;
    army.progress += Math.max(40, Math.floor((MARCH_PER_DAY * 12) / len));
    if (army.progress < 1000) continue;

    // 抵达
    const target = state.nodes[army.toId];
    if (!target) { delete state.armies[id]; continue; }

    /**
     * **这一程到了，路还没完。**
     *
     * 远征是一程一程走的（见 march.ts）。每落一次脚：
     * 散一批人（逃亡、疾病、掉队），然后接着走下一程。
     *
     * 半路那座城要是在这段日子里换了旗号、成了拦路的，
     * 军队就地停下来围它 —— **路被堵死了，只好先打这一座。**
     * 这一条不是补丁，是远征真正会出的事。
     */
    const route = army.route ?? [];
    if (route.length > 0) {
      const nextId = route[0]!;
      const blocked = target.factionId !== army.factionId
        && passageOf(state, army.factionId, target.factionId) === 'no';
      if (!blocked) {
        army.troops -= Math.floor((army.troops * (army.waste ?? 0)) / 1000);
        if (army.troops <= 20) {
          delete state.armies[id];
          events.push({ t: 'army_dispersed', factionId: army.factionId, toId: army.toId });
          continue;
        }
        // 借道的地界上补不到粮；自家的城顺路添一点
        if (target.factionId === army.factionId) {
          const top = Math.min(target.grain, army.troops * 2);
          target.grain -= top;
          army.supply += top;
        }
        army.fromId = army.toId;
        army.toId = nextId;
        army.route = route.slice(1);
        army.progress = 0;
        continue;
      }
      // 路断了 —— 就地围城，不再往前
      army.route = [];
      army.finalId = army.toId;
    }

    delete state.armies[id];

    if (army.intent === 'reinforce' || target.factionId === army.factionId) {
      target.troops += army.troops;
      target.grain += army.supply;
      events.push({
        t: 'reinforced', cityId: army.toId, factionId: army.factionId, troops: army.troops,
      });
      continue;
    }

    const existing = state.sieges[army.toId];
    if (existing && existing.factionId === army.factionId) {
      existing.troops += army.troops;
      existing.supply += army.supply;
      if (!existing.officerId && army.officerId) existing.officerId = army.officerId;
    } else {
      state.sieges[army.toId] = {
        cityId: army.toId,
        factionId: army.factionId,
        troops: army.troops,
        supply: army.supply,
        days: 0,
        ...(army.officerId ? { officerId: army.officerId } : {}),
      };
    }
    // 兵临城下就是结仇的那一刻 —— 不必等到城破
    const victim = state.nodes[army.toId]?.factionId;
    if (victim) angerFrom(state, army.factionId, victim, false);
    events.push({
      t: 'siege_started', cityId: army.toId, factionId: army.factionId, troops: army.troops,
    });
  }
  return events;
}

// ─────────────────────────────────────────────────────────────
// 围城
// ─────────────────────────────────────────────────────────────

function resolveSieges(state: WorldState, idx: ContentIndex): SimEvent[] {
  const events: SimEvent[] = [];

  for (const cityId of Object.keys(state.sieges).sort()) {
    const siege = state.sieges[cityId]!;
    const node = state.nodes[cityId];
    if (!node) { delete state.sieges[cityId]; continue; }

    siege.days += 1;
    const playerCity = state.cities[cityId];
    const isPlayers = playerCity !== undefined && state.official.cityId === cityId;

    const defence = playerCity ? defenceOf(playerCity, idx) : nodeDefence(state, idx, node);

    // 攻方每日耗粮，也每日折损。
    //
    // 双方的日损失都只是对方兵力的**百分之几** —— 围城是耗，不是一天分胜负。
    // 这一条很要紧：给玩家留出反应的时间（修城、等援军、逼退），
    // 否则敌军一到城下就直接破城，所有守备投入都没有意义。
    siege.supply -= Math.max(2, Math.floor((siege.troops * ARMY_UPKEEP_PER_1000) / 1000));
    const wallPermille = wallPermilleOf(playerCity, cityId, idx);

    // 守方每日折损：攻方兵力的 5.5%，被城墙除掉一部分
    const defenderLoss = Math.max(
      1, Math.floor((siege.troops * 55) / wallPermille) + nextInt(state.rng, 3),
    );
    // 攻方每日折损：守备强度的 4.8%，城墙让守军打得更狠
    const attackerLoss = Math.max(
      2, Math.floor((defence * 48 * wallPermille) / 1_000_000) + nextInt(state.rng, 4),
    );

    /**
     * 城外那座营**天天跟着挨打**。
     *
     * 既然它算进了守备，围城的消耗就该分它一份 ——
     * 只算好处不算损失，那不是守城，那是白捡的加成。
     * 按它在守备里占的分量摊，摊完了营也就打光了。
     */
    const campHere = campAt(state, cityId);
    if (campHere && campHere.troops > 0) {
      const share = campHere.troops / Math.max(1, campHere.troops + node.troops);
      const hit = Math.max(1, Math.round(defenderLoss * share * 0.9));
      campHere.troops = Math.max(0, campHere.troops - hit);
    }

    siege.troops -= attackerLoss;
    /**
     * **日常消耗磨不死人 —— 对每一座城都一样。**
     *
     * 这条规矩本来就写在这儿，但只保护了文官亲手守的那一座：
     * `isPlayers` 要 `state.cities[cityId]` 存在，而主公那一局
     * `state.cities` 是空的（他不亲手治城）。
     * 于是主公治下每一座城都走「磨光就破」——
     * 三千围兵每日磨掉一百四十人，一千二守军撑八天，
     * **你从别处调多少兵去都只是多撑几天**，而且中间没有任何一次可以翻盘的交锋。
     *
     * 围而不攻拿不下城，这是这套设计从一开始就定的：
     * 破城只能靠强攻（见下面那一段）。现在它终于对所有人成立。
     */
    node.troops = Math.max(1, node.troops - Math.ceil(defenderLoss * 0.5));
    // 每两日才掉一点民心。连着被围几次就把民心砸到个位数，
    // 之后产出崩、守备崩、再也翻不了身 —— 那是死亡螺旋，不是难度
    if (siege.days % 2 === 0) node.morale = clamp(node.morale - 1, 0, 100);
    if (playerCity) {
      if (siege.days % 2 === 0) playerCity.morale = clamp(playerCity.morale - 1, 0, 100);
      // 围城断了外面的粮，城里先紧一紧
      playerCity.grain = Math.max(0, playerCity.grain - Math.floor(defenderLoss / 2));
    }

    if (isPlayers) {
      events.push({
        t: 'siege_day', cityId, days: siege.days,
        attackers: Math.max(0, siege.troops), defenders: node.troops,
      });
    }

    // 攻方粮尽或损失过半 → 退兵
    if (siege.supply <= 0 || siege.troops <= 30) {
      delete state.sieges[cityId];
      node.lastSiegeDay = state.day;
      /**
       * **守住了是功。** 一场围城熬到敌军自己退兵，
       * 这比打下一座空城难得多 —— 记在守将头上（见 tribute.ts）。
       */
      if (state.role === 'lord' && node.factionId === state.official.lordId) {
        const held = wardenOf(state, idx, cityId);
        if (held) bumpMerit(state, held.id, MERIT_HELD_SIEGE);
      }
      events.push({ t: 'siege_lifted', cityId, factionId: siege.factionId, taken: false });
      continue;
    }

    /**
     * 强攻。**这是城易主唯一的路。**
     *
     * 玩家亲手守的那一座交给守城战小游戏（见 maybeAssault），
     * 其余的（含主公治下的、以及天下各家彼此的）在这里自动判：
     *
     *   攻方的力气 = 围兵，被城墙折掉一截
     *   守方的力气 = 那座城的守备（已含民心、守将、城外的营）
     *
     * 攻不下不是白攻 —— 蚁附一次要折三成人，多半也就没有下一次了。
     * 于是「增兵」这件事第一次真的管用：调够了兵，这一场就攻不进来。
     */
    const stormDay = siege.assaultAfter ?? SIEGE_STORM_AFTER;
    if (!isPlayers && siege.days >= stormDay
      && chance(state.rng, siege.assaultAfter !== undefined ? 40 : 14)) {
      const atk = Math.floor((siege.troops * 1000) / wallPermille);
      const luck = 90 + nextInt(state.rng, 25);
      const won = atk * 100 > defence * luck;
      if (!won) {
        // 蚁附而不克，折兵三成。守方也不轻松
        siege.troops -= Math.max(20, Math.floor(siege.troops * 0.3));
        node.troops = Math.max(1, node.troops - Math.floor(node.troops * 0.12));
        node.morale = clamp(node.morale + 3, 0, 100);
        events.push({
          t: 'siege_day', cityId, days: siege.days,
          attackers: Math.max(0, siege.troops), defenders: node.troops,
        });
        continue;
      }
      // 破城
      node.troops = 0;
    }

    // 城破
    if (node.troops <= 0 && !isPlayers) {
      const from = node.factionId;
      /**
       * 论功过。**这一笔是「用人」这件事最有分量的一次结算。**
       * 丢了城的守将折功，攻下城的将领得功 —— 两边都记在人头上。
       */
      if (state.role === 'lord') {
        if (from === state.official.lordId) {
          const lost = wardenOf(state, idx, cityId);
          if (lost) bumpMerit(state, lost.id, MERIT_LOST_CITY);
        }
        if (siege.factionId === state.official.lordId && siege.officerId) {
          bumpMerit(state, siege.officerId, MERIT_TAKE_CITY);
        }
      }
      node.factionId = siege.factionId;
      // 得胜之军就地驻防。留一半的做法会让这座城立刻被邻居抢回去
      node.troops = Math.max(80, siege.troops);
      node.unrest = 70;
      node.takenDay = state.day;
      node.lastSiegeDay = state.day;
      node.morale = clamp(node.morale - 20, 0, 100);
      delete state.sieges[cityId];
      // 夺城的仇是最重的一笔
      angerFrom(state, siege.factionId, from, true);
      // 打下来了就得派人守 —— 少了这一句，这座城从此没有守将
      const warden = appointWarden(state, idx, cityId);
      events.push({ t: 'city_fell', cityId, from, to: siege.factionId });
      if (warden) {
        events.push({ t: 'warden_posted', cityId, personId: warden.id });
      }
      continue;
    }

    // 玩家的城被围时，主公救不救，全看他信不信得过你 ——
    // 「信任」这个数字在这里第一次变成实感
    if (isPlayers && siege.days === 5 && state.official.trust >= 45) {
      const help = 120 + state.official.trust * 3;
      node.troops += help;
      events.push({ t: 'lord_relief', cityId, troops: help });
    }
  }

  return events;
}

// ─────────────────────────────────────────────────────────────
// 势力出兵
// ─────────────────────────────────────────────────────────────

function decideFactions(state: WorldState, idx: ContentIndex): SimEvent[] {
  const events: SimEvent[] = [];

  for (const fid of Object.keys(state.factions).sort()) {
    /**
     * **玩家自己那一家不由这里代打。**
     *
     * 少了这一句，当主公的玩家会发现：他什么都不做，地盘照样在长 ——
     * 因为 AI 一直在替他出兵。实测「什么都不做」十年长到三点八城，
     * 而「认真经营再出兵」反倒只有二点八：
     * 玩家做的每一个决定都在跟一个看不见的自己抢兵。
     *
     * 主公这一身份的全部意思，是那几道令由**你**来下。
     */
    if (state.role === 'lord' && fid === state.official.lordId) continue;
    const fs = state.factions[fid]!;
    if (fs.cooldown > 0) { fs.cooldown -= 1; continue; }
    const def = idx.faction.get(fid);
    if (!def) continue;

    // 好战程度决定出兵的频率。配上冷却，各家大约一到两个月动一次心思
    if (!chance(state.rng, Math.max(2, Math.floor(def.aggression / 12)))) continue;

    // 自家有城正被围，先顾着救火，不往外扑
    const underSiege = Object.values(state.sieges)
      .some((sg) => state.nodes[sg.cityId]?.factionId === fid);
    if (underSiege) continue;

    // 找一座自己的城当出发地：兵多、粮足、且邻境有可下之地
    const mine = Object.values(state.nodes)
      .filter((n) => n.factionId === fid && !state.sieges[n.id])
      .sort((a, b) => b.troops - a.troops);

    for (const src of mine) {
      const srcDef = idx.node.get(src.id);
      if (!srcDef) continue;
      // 留够守军，不能倾巢而出
      const spare = src.troops - Math.max(120, Math.floor(src.troops * 0.45));
      if (spare < 150 || src.grain < 400) continue;

      const targets = srcDef.links
        .map((id) => state.nodes[id])
        .filter((n): n is CityNode => {
          if (!n || n.factionId === fid) return false;
          // 头三季不打玩家的城。讨董联军还没散，各方都在观望，
          // 而新上任的县令需要这段时间先把粮种出来、把兵营立起来。
          if (n.id === state.official.cityId && state.day < GRACE_DAYS) return false;
          // 新破之城，敌军尚锐，谁也不会立刻扑上去
          if (n.takenDay >= 0 && state.day - n.takenDay < AFTER_CAPTURE_QUIET) return false;
          // 刚打过一场围城的地方，双方都要缓一缓
          if (n.lastSiegeDay >= 0 && state.day - n.lastSiegeDay < AFTER_SIEGE_QUIET) return false;
          const att = fs.attitude[n.factionId] ?? 0;
          return att < 20;
        })
        .sort((a, b) => nodeDefence(state, idx, a) - nodeDefence(state, idx, b));

      const target = targets[0];
      if (!target) continue;
      // 一场战役是从整个辖境征调的，不是只靠边境那一座城出兵。
      // 少了这一条，各城兵力一旦长到相当，谁也够不着出兵的门槛，
      // 战线会在第三年就彻底冻死 —— 而那不叫乱世。
      // 附带的好处：地盘大的势力自然更能投送兵力，滚雪球有了来源，
      // 也仍然受制于「打下来不等于吃得下」。
      const rear = mine.filter((n) => n.id !== src.id && !state.sieges[n.id]).slice(0, 3);
      let mustered = Math.floor(spare * 0.8);
      const drawn: { node: CityNode; men: number }[] = [];
      for (const r of rear) {
        const give = Math.floor(Math.max(0, r.troops - Math.max(100, r.troops * 0.6)) * 0.7);
        if (give < 40) continue;
        drawn.push({ node: r, men: give });
        mustered += give;
      }

      // 优势不够就不动手。兵力相当的强攻只会两败俱伤。
      //
      // 门槛跟好战程度走：孙坚那样的人五成优势就敢上，
      // 刘虞、刘表这种守成之主要有压倒性优势才肯动 ——
      // 否则「好战」就只是出兵频率的别名，闭关自守的刘焉照样会打下半个天下。
      const edge = 1.25 + ((100 - def.aggression) * 15) / 1000;
      if (mustered < nodeDefence(state, idx, target) * edge) continue;

      const troops = mustered;
      const supply = Math.min(src.grain, troops * 2 + 200);
      src.troops -= Math.floor(spare * 0.8);
      src.grain -= supply;
      for (const d of drawn) d.node.troops -= d.men;

      const id = mintId(state, 'army');
      const army: Army = {
        id, factionId: fid, troops, supply,
        fromId: src.id, toId: target.id, progress: 0, intent: 'attack',
      };
      state.armies[id] = army;
      // 摊子越大，重整旗鼓越慢。这是压制滚雪球的又一道闸
      const holdings = Object.values(state.nodes).filter((n) => n.factionId === fid).length;
      fs.cooldown = Math.floor(nextRange(state.rng, 30, 70) * (1 + holdings / 7));
      events.push({
        t: 'army_launched', factionId: fid, fromId: src.id, toId: target.id, troops,
      });
      break;
    }
  }

  return events;
}
