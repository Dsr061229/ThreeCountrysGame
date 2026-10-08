/**
 * 军营 —— 主公的野战军。
 *
 * ── 这一层要治的那条硬伤 ────────────────────────────
 *
 * 分职之前，城里那些人既是守军又是野战军。
 * 于是**出兵就是掏空守军**：你派他们出去打，城就空了；
 * 打赢了回来，别人已经摸到你后院。
 * 玩家因此不敢打；不打就不长；不长就等着被吃掉 ——
 * 推演里「前期占几座城、之后一路失守」那条曲线，一半来自这里。
 *
 * 分开之后是两笔账：
 *
 *   **城里的兵守家。** 受 `dev × 26` 的顶约束 —— 他们本来就是乡勇，
 *   农忙回家，农隙上城，不脱产，所以也不多吃粮。
 *
 *   **营里的兵野战。** 脱产，不受那个顶，能练，能远征 ——
 *   **但每天都要吃粮**，而且吃得比守城的贵三倍。
 *   一座养不起的营会自己饿散，和图上断粮的军队是同一条规则。
 *
 * 这也正是汉末的实情：郡兵是郡兵，部曲是部曲。
 *
 * ── 一将不能分身 ────────────────────────────────────
 *
 * 一个人要么守一座城，要么领一座营。
 * 所以「能立几座营」直接受制于帐下有几个**带得了兵**的人 ——
 * 「城多了管不过来」在这里第三次成立（第一次是人不够，第二次是消息跟不上）。
 */
import type { ContentIndex } from './content.ts';
import type { WorldState } from './state.ts';
import { mintId } from './state.ts';
import type { Command, CommandResult, SimEvent } from './commands.ts';
import { isMartial } from './people.ts';
import { marchWait, ownPeople, tally } from './court.ts';
import {
  CAMP_COST, CAMP_DRILL_BONUS, CAMP_DRILL_MAX, CAMP_DRILL_PER_DAY,
  CAMP_GROW_GRAIN, CAMP_GROW_STEP, CAMP_PER_DEV, CAMP_UPKEEP_PER_1000, MERIT_CAMP_STARVED,
  type Barracks,
} from './lord_types.ts';
import { bumpMerit, rankBoost } from './tribute.ts';
import { KEEP_GARRISON } from './handlers_lord.ts';
import type { Army } from './world_types.ts';
import { payBorrow, planMarch, supplyFor } from './march.ts';

function ok(...events: SimEvent[]): CommandResult {
  return { ok: true, events };
}
function reject(cmd: Command['t'], reasonId: string): CommandResult {
  return { ok: false, events: [{ t: 'rejected', cmd, reasonId }] };
}

// ─────────────────────────────────────────────────────────────
// 查
// ─────────────────────────────────────────────────────────────

/** 这个人是不是已经有差事了 —— 守着一座城，或者领着一座营 */
export function isBusy(state: WorldState, personId: string): boolean {
  if (Object.values(state.posts).includes(personId)) return true;
  return Object.values(state.court?.camps ?? {})
    .some((c) => c.officerId === personId);
}

/** 依托这座城的那座营。没有就是 null */
export function campAt(state: WorldState, cityId: string): Barracks | null {
  return Object.values(state.court?.camps ?? {})
    .find((c) => c.cityId === cityId) ?? null;
}

/**
 * 这座营最多养得起多少人。
 *
 * 依托城的开发度打底，再乘领营那位的**品秩** ——
 * 一个中郎将开得起的幕府，不是一个军侯比得了的（见 tribute.ts）。
 */
export function campCap(state: WorldState, camp: Barracks): number {
  const node = state.nodes[camp.cityId];
  const base = Math.max(300, (node?.dev ?? 10) * CAMP_PER_DEV);
  return Math.round((base * rankBoost(state, camp.officerId)) / 1000);
}

/**
 * 营里这些人，打起来顶多少（千分数，一为轴）。
 *
 * 操练是唯一的乘数 —— 一支练熟的兵和一群刚拉来的农夫，
 * 人数一样，打出来完全是两回事。
 */
export function drillPermille(camp: Barracks): number {
  return 1000 + Math.round((camp.drill / CAMP_DRILL_MAX) * CAMP_DRILL_BONUS);
}

/** 帐下还有谁带得了兵 —— 立营只能从这里挑 */
export function freeOfficers(state: WorldState, idx: ContentIndex): string[] {
  return ownPeople(state, idx)
    .filter((p) => isMartial(p) && !isBusy(state, p.id))
    .map((p) => p.id);
}

// ─────────────────────────────────────────────────────────────
// 立营、撤营
// ─────────────────────────────────────────────────────────────

export function cmdCampOpen(
  state: WorldState, cmd: Extract<Command, { t: 'lord_camp_open' }>, idx: ContentIndex,
): CommandResult {
  if (state.role !== 'lord') return reject('lord_camp_open', 'not_lord');
  if (state.ending) return reject('lord_camp_open', 'game_over');
  const court = state.court;
  if (!court) return reject('lord_camp_open', 'no_court');

  const node = state.nodes[cmd.cityId];
  if (!node || node.factionId !== state.official.lordId) {
    return reject('lord_camp_open', 'not_ours');
  }
  if (state.sieges[cmd.cityId]) return reject('lord_camp_open', 'besieged');
  if (campAt(state, cmd.cityId)) return reject('lord_camp_open', 'camp_here');

  const who = idx.person.get(cmd.personId);
  if (!who) return reject('lord_camp_open', 'no_such_person');
  // **领营只有武将做得了。** 文吏带不了脱产的野战军
  if (!isMartial(who)) return reject('lord_camp_open', 'not_martial');
  if (isBusy(state, cmd.personId)) return reject('lord_camp_open', 'busy');
  if (node.grain < CAMP_COST + 200) return reject('lord_camp_open', 'no_grain');

  node.grain -= CAMP_COST;
  const id = mintId(state, 'camp');
  court.camps[id] = {
    id, cityId: cmd.cityId, officerId: cmd.personId,
    troops: 0, drill: 10, since: state.day,
  };
  tally(court, 'camp');
  return ok({ t: 'camp_opened', campId: id, cityId: cmd.cityId, personId: cmd.personId });
}

/** 撤营。兵归城 —— 但城里塞不下的那些就散了 */
export function cmdCampClose(
  state: WorldState, cmd: Extract<Command, { t: 'lord_camp_close' }>,
): CommandResult {
  const court = state.court;
  if (state.role !== 'lord' || !court) return reject('lord_camp_close', 'not_lord');
  const camp = court.camps[cmd.campId];
  if (!camp) return reject('lord_camp_close', 'no_camp');

  const node = state.nodes[camp.cityId];
  if (node) node.troops += camp.troops;
  delete court.camps[cmd.campId];
  return ok({ t: 'camp_closed', campId: cmd.campId });
}

// ─────────────────────────────────────────────────────────────
// 拨兵
// ─────────────────────────────────────────────────────────────

/**
 * 城营之间拨兵。
 *
 * 正数是从城里拨进营，负数是退回城里。
 * **城里永远要留够看家的** —— 这一条和调兵那边是同一个规矩。
 */
export function cmdDraft(
  state: WorldState, cmd: Extract<Command, { t: 'lord_draft' }>,
): CommandResult {
  const court = state.court;
  if (state.role !== 'lord' || !court) return reject('lord_draft', 'not_lord');
  const camp = court.camps[cmd.campId];
  if (!camp) return reject('lord_draft', 'no_camp');
  const node = state.nodes[camp.cityId];
  if (!node) return reject('lord_draft', 'no_such_place');

  if (cmd.men > 0) {
    const room = campCap(state, camp) - camp.troops;
    const spare = node.troops - KEEP_GARRISON;
    const men = Math.min(cmd.men, room, spare);
    if (men < 20) {
      return reject('lord_draft', room <= 20 ? 'camp_full' : 'would_empty');
    }
    node.troops -= men;
    camp.troops += men;
    /**
     * 新兵进营，把操练冲淡了。
     *
     * 一支练熟的兵掺进一半生手，整营的成色就下来了 ——
     * 这是「练兵要时间」这件事唯一诚实的写法。
     */
    camp.drill = Math.round((camp.drill * (camp.troops - men)) / Math.max(1, camp.troops));
    return ok({ t: 'drafted', campId: camp.id, men });
  }

  const back = Math.min(-cmd.men, camp.troops);
  if (back < 20) return reject('lord_draft', 'too_few');
  camp.troops -= back;
  node.troops += back;
  return ok({ t: 'drafted', campId: camp.id, men: -back });
}

// ─────────────────────────────────────────────────────────────
// 出兵
// ─────────────────────────────────────────────────────────────

/**
 * 营出兵。
 *
 * **这一下不动城里一个人。** 攻守两笔账分开，就分在这里 ——
 * 你可以放心地把一支野战军派出去，而后方还是那个后方。
 */
export function cmdCampMarch(
  state: WorldState, cmd: Extract<Command, { t: 'lord_camp_march' }>, idx: ContentIndex,
): CommandResult {
  const court = state.court;
  if (state.role !== 'lord' || !court) return reject('lord_camp_march', 'not_lord');
  if (state.ending) return reject('lord_camp_march', 'game_over');
  const camp = court.camps[cmd.campId];
  if (!camp) return reject('lord_camp_march', 'no_camp');

  const src = state.nodes[camp.cityId];
  const dst = state.nodes[cmd.toId];
  if (!src || !dst) return reject('lord_camp_march', 'no_such_place');
  const attacking = dst.factionId !== state.official.lordId;
  if (attacking && marchWait(state) > 0) return reject('lord_camp_march', 'march_soon');

  /**
   * **野战军本来就是拿来走远路的。**
   *
   * 脱产的部曲不必守着自家城头，那正是它和郡兵的分别 ——
   * 所以「远征」这条路第一个该对它开（见 march.ts）。
   */
  const plan = planMarch(state, idx, camp.cityId, cmd.toId, state.official.lordId);
  if (!plan) return reject('lord_camp_march', 'no_route');
  if (plan.refused) return reject('lord_camp_march', 'refused');

  const men = Math.min(Math.floor(cmd.men), camp.troops);
  if (men < 60) return reject('lord_camp_march', 'too_few');

  // 随军的口粮从依托的城里出。带不够就少带人 —— 路越远，同样的粮带得动的人越少
  const per = Math.max(2, Math.round(supplyFor(1000, plan.days) / 1000));
  const canFeed = Math.floor(src.grain / per);
  const troops = Math.min(men, canFeed);
  if (troops < 60) return reject('lord_camp_march', 'no_grain');
  const supply = Math.min(src.grain, supplyFor(troops, plan.days));

  camp.troops -= troops;
  src.grain -= supply;
  payBorrow(state, state.official.lordId, plan.borrow);
  if (attacking) court.marchedDay = state.day;

  /**
   * 练熟的兵按操练折成「有效人数」。
   *
   * 图上那套围城判定只认人数，所以这里把操练折进去 ——
   * 一支练满的兵，一千人打得出一千三百人的仗。
   */
  const id = mintId(state, 'army');
  const army: Army = {
    id,
    factionId: state.official.lordId,
    troops: Math.round((troops * drillPermille(camp)) / 1000),
    supply,
    officerId: camp.officerId,
    fromId: camp.cityId,
    toId: plan.path[1]!,
    progress: 0,
    intent: attacking ? 'attack' : 'reinforce',
    route: plan.path.slice(2),
    waste: plan.legWaste,
    finalId: cmd.toId,
  };
  state.armies[id] = army;
  tally(court, 'camp.march');
  return ok(
    { t: 'lord_marched', fromId: camp.cityId, toId: cmd.toId, troops, attack: attacking },
    {
      t: 'notice',
      textId: attacking ? 'notice.lord_attack' : 'notice.lord_reinforce',
      vars: {
        troops,
        from: idx.node.get(camp.cityId)?.name ?? camp.cityId,
        to: idx.node.get(cmd.toId)?.name ?? cmd.toId,
      },
      tone: 'plain',
    },
  );
}

// ─────────────────────────────────────────────────────────────
// 一天
// ─────────────────────────────────────────────────────────────

/**
 * 营的一天：吃粮，操练。
 *
 * **养不起的营会自己饿散** —— 和图上断粮的军队是同一条规则。
 * 脱产的兵是要用粮堆着的，这是一支野战军真正的价格。
 */
export function tickBarracks(state: WorldState, idx: ContentIndex): SimEvent[] {
  const court = state.court;
  if (!court) return [];
  const events: SimEvent[] = [];

  for (const id of Object.keys(court.camps).sort()) {
    const camp = court.camps[id]!;
    const node = state.nodes[camp.cityId];

    // 依托的城丢了，营也就散了 —— 没有郡府供粮的营撑不了几天
    if (!node || node.factionId !== state.official.lordId) {
      delete court.camps[id];
      events.push({ t: 'camp_lost', campId: id, cityId: camp.cityId });
      continue;
    }

    /**
     * **营是那位武将自己带起来的，不必主公一勺一勺喂。**
     *
     * 原先每二百人都要玩家点一次「城 → 营」，
     * 于是一座营从零长到一千五要点八次，中间还得记着回来点 ——
     * 那不是治军，那是搬砖。而且实测大半的营长期是空的：
     * 玩家早就忘了这儿有个按钮。
     *
     * 现实里也没有哪个校尉等着主公一批一批发人。
     * 他自己在依托的郡里募部曲：**城里有余丁就招，仓里有余粮才招。**
     * 主公那两个按钮留着 —— 那是他要插手的时候用的。
     */
    if (state.day % 10 === 0 && !state.sieges[camp.cityId]) {
      /**
       * **他招的是新人，不是把城头的兵拉下来。**
       *
       * 头一版是从守军里拨 —— 那是灾难：各城被自家的营抽到只剩看家的八十人，
       * 四十局里二十二局丢光地盘。而且它也不对：
       * 郡兵是郡兵，部曲是部曲，一个校尉募部曲募的是乡里的丁壮，
       * 不是去把城墙上站岗的人喊下来。
       *
       * 所以这一笔的价钱和「募兵」是同一个价钱：**粮换人**。
       * 而营的贵在后头 —— 脱产的兵每天都要吃（见下面那几行），
       * 那才是一支野战军真正的账。
       */
      const room = campCap(state, camp) - camp.troops;
      const men = Math.min(room, CAMP_GROW_STEP);
      const pay = men * CAMP_GROW_GRAIN;
      // 仓里要付得起安家费，还要留够这座营两个月的口粮
      const keep = Math.round((camp.troops * CAMP_UPKEEP_PER_1000 * 60) / 1000) + 300;
      if (men >= 20 && node.morale >= 30 && node.grain >= pay + keep) {
        node.grain -= pay;
        camp.troops += men;
        camp.drill = Math.round((camp.drill * (camp.troops - men)) / Math.max(1, camp.troops));
        tally(court, 'camp.grow');
      }
    }

    const eat = Math.max(1, Math.round((camp.troops * CAMP_UPKEEP_PER_1000) / 1000));
    if (node.grain >= eat) {
      node.grain -= eat;
      if (camp.drill < CAMP_DRILL_MAX) {
        camp.drill = Math.min(CAMP_DRILL_MAX, camp.drill + CAMP_DRILL_PER_DAY);
      }
    } else {
      // 断粮。先散人，再散营
      node.grain = 0;
      camp.troops -= Math.max(4, Math.floor(camp.troops / 20));
      camp.drill = Math.max(0, camp.drill - 1.5);
      if (camp.troops <= 40) {
        delete court.camps[id];
        // 把一座营饿散了是折功的事 —— 粮是他自己该看着的
        bumpMerit(state, camp.officerId, MERIT_CAMP_STARVED);
        events.push({ t: 'camp_starved', campId: id, cityId: camp.cityId });
      }
    }
  }
  void idx;
  return events;
}
