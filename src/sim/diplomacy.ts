/**
 * 外交。
 *
 * `FactionState.attitude` 这张表**开局摆好之后就再没有变过** ——
 * 十年打下来，各家的恩怨还是初平元年那一天的样子。
 * 有数据，没有行为：又一条看着在运转、其实一次也没跑过的机制。
 *
 * 补上的是四件事，每一件都能在天下图上看出来：
 *
 *   一、**打了就结仇**。挨打的那一方记得最牢 —— 这是恩怨的来源。
 *   二、**共同的敌人**。你我都在跟他打，你我之间就好说话。
 *   三、**强邻可畏**。一家做得太大，四邻自然连成一气 ——
 *      这是设计方案 8.1「主公滚雪球」那条问题的解法：
 *      不靠给赢家加惩罚，靠让别人怕他。
 *   四、**时间弥合**。没有永远的仇，隔得久了总要淡下去。
 *
 * 态度决定打不打（见 worldtick 的 `att < 20`）。所以这四条一接上，
 * 天下的战线就会自己长出形状来，而不是各家挨着谁打谁。
 */
import type { ContentIndex } from './content.ts';
import type { WorldState } from './state.ts';
import type { SimEvent } from './commands.ts';

/** 隔多少天算一次账。天天算既费事又看不出分别 */
export const DIPLO_EVERY = 30;

/** 挨了打的那一方，对动手的人掉多少 */
export const ANGER_VICTIM = 42;
/** 动手的一方对挨打的也掉一些 —— 打了人的总要给自己找个理由 */
export const ANGER_AGGRESSOR = 14;
/** 城被夺了，再加一笔 */
export const ANGER_LOST_CITY = 30;

/**
 * 每有一个共同的敌人，一次算账涨多少。
 *
 * 这个数原先是 5，且每次最多按三个敌人算 —— 一年十二次账，
 * 一对关系能涨一百八。实测十年之后「曹操看袁术」从 -20 涨到 +98：
 * 两家在图上打得你死我活，账面上却成了唇齿。
 *
 * 共患难是会拉近距离，但它是**慢的**，而且到不了「生死之交」。
 */
export const COMMON_FOE = 3;
/** 共患难拉得再近也就到这儿。再往上得有别的缘故 */
export const WARMTH_CEIL = 45;
/** 时间弥合：每次算账往零走多少 */
export const HEAL = 2;

/**
 * 一家占了天下几成算「大」。超出的部分才招人忌惮。
 *
 * 门槛定得低了，开局就人人自危；定得高了，等他忌惮起来天下已经定了。
 * 两成是「明显比别人大一截」的那个位置。
 */
export const BIG_SHARE = 200;
/**
 * 忌惮有多重。
 *
 * 原先写的是「每超出一个千分点掉 0.9」—— 两头都不对：
 * 刚过门槛时一次只掉四点，被时间弥合的 +2 抵掉大半；
 * 而真到了四成天下，一次要掉一百八，当场砸到 -100。
 * 一条又迟钝又暴烈的曲线。
 *
 * 现在按「超出门槛多少」平缓地长，并且封顶 ——
 * 忌惮是持续的压力，不是一记闷棍。
 */
export const FEAR_MAX = 15;
export const FEAR_DIVISOR = 10;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function shift(state: WorldState, from: string, to: string, by: number): void {
  const fs = state.factions[from];
  if (!fs || from === to) return;
  fs.attitude[to] = clamp((fs.attitude[to] ?? 0) + by, -100, 100);
}

/**
 * 打了人就结仇。
 *
 * 从围城这件事上直接记账 —— 谁围了谁的城，两边的态度当场就变。
 * 挨打的记得牢，动手的记得浅，这是不对称的，也该是不对称的。
 */
export function angerFrom(
  state: WorldState, attackerId: string, victimId: string, tookCity: boolean,
): void {
  shift(state, victimId, attackerId, -(ANGER_VICTIM + (tookCity ? ANGER_LOST_CITY : 0)));
  shift(state, attackerId, victimId, -ANGER_AGGRESSOR);
}

/**
 * 隔一段日子算一次天下大势。
 *
 * 只做三件事：共同的敌人拉近距离、强邻招人忌惮、旧怨随时间淡去。
 */
export function tickDiplomacy(state: WorldState, idx: ContentIndex): SimEvent[] {
  if (state.day % DIPLO_EVERY !== 0) return [];

  const ids = Object.keys(state.factions).sort();
  // 各家现在占多少城
  const holds = new Map<string, number>();
  for (const n of Object.values(state.nodes)) {
    holds.set(n.factionId, (holds.get(n.factionId) ?? 0) + 1);
  }
  const total = Math.max(1, Object.keys(state.nodes).length);

  // 谁跟谁在敌对。这是下面两条的依据
  const hostile = (a: string, b: string): boolean =>
    (state.factions[a]?.attitude[b] ?? 0) < -20;

  const events: SimEvent[] = [];

  for (const a of ids) {
    // 已经没城的势力不参与天下大势
    if ((holds.get(a) ?? 0) === 0) continue;

    for (const b of ids) {
      if (a === b) continue;
      if ((holds.get(b) ?? 0) === 0) continue;

      // 一、共同的敌人
      let common = 0;
      for (const c of ids) {
        if (c === a || c === b) continue;
        if (hostile(a, c) && hostile(b, c)) common += 1;
      }
      // 共患难是慢的，而且到不了生死之交 —— 见 WARMTH_CEIL
      if (common > 0 && (state.factions[a]!.attitude[b] ?? 0) < WARMTH_CEIL) {
        shift(state, a, b, Math.min(2, common) * COMMON_FOE);
      }

      // 二、强邻可畏。**这是滚雪球的解药**：
      // 不给赢家加惩罚，而是让所有人都开始防着他
      const share = Math.round(((holds.get(b) ?? 0) * 1000) / total);
      if (share > BIG_SHARE) {
        shift(state, a, b, -Math.min(
          FEAR_MAX, Math.round((share - BIG_SHARE) / FEAR_DIVISOR),
        ));
      }

      // 三、时间弥合。没有永远的仇
      const now = state.factions[a]!.attitude[b] ?? 0;
      if (now !== 0) shift(state, a, b, now > 0 ? -HEAL : HEAL);
    }
  }

  /**
   * 天下第一家是谁，什么时候变的。
   *
   * 报出来是为了让玩家看得见大势 ——「袁绍已据九城」这句话
   * 比地图上多出来一块颜色更早地告诉你风向变了。
   */
  let topId = '';
  let topN = 0;
  for (const [f, n] of holds) if (n > topN) { topN = n; topId = f; }
  const was = state.flags['topFaction'];
  const idNum = ids.indexOf(topId);
  if (topId && idNum >= 0 && was !== idNum && topN >= 5) {
    state.flags['topFaction'] = idNum;
    events.push({
      t: 'notice',
      textId: 'notice.top_faction',
      vars: { name: idx.faction.get(topId)?.name ?? topId, cities: topN },
      tone: 'plain',
    });
  }

  return events;
}

/** 甲乙两家是不是在敌对。界面拿它讲「谁跟谁交恶」 */
export function atWar(state: WorldState, a: string, b: string): boolean {
  return (state.factions[a]?.attitude[b] ?? 0) < -20;
}
