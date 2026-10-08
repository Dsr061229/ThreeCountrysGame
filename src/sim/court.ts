/**
 * 朝堂的运转。
 *
 * 这个文件管四件事，四件都是主公这条线上原先没有的：
 *
 *   一、**案头** —— 帐下的人隔些日子呈上几件事，你批。
 *       事情全从天下实况里长出来：请战的那座敌城真的挨着他，
 *       请援的那座城真的正被围。
 *   二、**心气** —— 你怎么答复，他记着。数在暗处，话在明处。
 *   三、**寿数** —— 主公会死。整局的问题因此变成「我还剩多少年」。
 *   四、**兼并** —— 撑不下去的势力会被吞、会来投。
 *       天下自己往鼎立收，而不是永远十几家在图上僵着。
 *
 * 一条纪律贯穿全篇：**新东西只拧现成的旋钮**。
 * 心气改的是守备乘数与出兵意愿，望改的是招人与外交漂移，
 * 兼并走的是现成的城池易主那一套。没有一条岔出去的新规则。
 */
import { chance, chancePermille, nextInt, nextRange } from './rng.ts';
import type { ContentIndex, PersonDef } from './content.ts';
import type { WorldState } from './state.ts';
import { mintId } from './state.ts';
import type { SimEvent } from './commands.ts';
import { wardenOf } from './people.ts';
import { roadKey } from './content.ts';
import { DAYS_PER_YEAR } from './time.ts';
import { atWar } from './diplomacy.ts';
import type { CityNode } from './world_types.ts';
import { AFTER_CAPTURE_QUIET } from './world_types.ts';
import { planMarch } from './march.ts';
import { assess, collectTribute, nextRankName, rankName, readyToRise } from './tribute.ts';
import { openMourning } from './succession.ts';
import { campAt } from './barracks.ts';
import { KEEP_GARRISON } from './handlers_lord.ts';
import {
  TRIBUTE_EVERY,
  CONSOLIDATE_EVERY, COURIER_PER_DAY, DESK_MAX, FAME_FOR_THRONE,
  INTERCEPT_ARMY, INTERCEPT_SIEGE, MARCH_COOLDOWN_BASE, MARCH_COOLDOWN_PER_CITY,
  ROAD_SAFER, ROAD_SPEED, roadKeyOf,
  HEART_ALLOW, HEART_DENY, HEART_DRIFT, HEART_IGNORE, HEART_LEAVE, HEART_LOYAL,
  HEART_QUIET, HEART_SHELVE, HEART_SILENT, HEART_START,
  HEARTS_FOR_THRONE, MEMORIAL_EVERY, MEMORIAL_LIFE, NEWS_DAYS_PER_LINK,
  RENOWN_FOR_SUBMIT, RENOWN_FOR_THRONE, RENOWN_RIGHTEOUS, heartTone,
  type Answer, type Court, type Memorial, type MemorialKind,
} from './lord_types.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ─────────────────────────────────────────────────────────────
// 开张
// ─────────────────────────────────────────────────────────────

/**
 * 主公上任那天的朝堂。
 *
 * 寿数在这里就定死了，而且**带抖动** ——
 * 史书上曹操活到六十六，但这一局的他不一定。
 * 照史实分毫不差地死，玩家第二局就会背下日子，
 * 那这条线上最要紧的那份不安就没了。
 */
export function openCourt(state: WorldState, idx: ContentIndex): void {
  const def = idx.faction.get(state.official.lordId);
  const age = def?.age ?? 40;
  const until = def?.until ?? 210;

  // 史实卒年折成天数，再抖 ±3 年
  const historical = Math.max(1, until - 190) * DAYS_PER_YEAR;
  const jitter = nextRange(state.rng, -3 * DAYS_PER_YEAR, 3 * DAYS_PER_YEAR);
  /**
   * 底线十年。
   *
   * 孙坚史实上第二年就没了 —— 照抄的话那一局根本来不及玩，
   * 而「来不及」和「不好玩」之间只隔一层纸。
   * 给每一局至少十年，紧张感来自「够不够」，不是来自「莫名其妙就结束了」。
   */
  const span = Math.max(10 * DAYS_PER_YEAR, historical + jitter);

  const heart: Record<string, number> = {};
  for (const p of idx.byFaction.get(state.official.lordId) ?? []) {
    // 心气不等于忠诚：忠诚是他这个人的底子，心气是他此刻对你的态度
    heart[p.id] = clamp(HEART_START + Math.floor((p.loyalty - 80) / 4), 30, 88);
  }

  state.court = {
    age,
    span,
    renown: def?.renown ?? 40,
    heart,
    silent: {},
    enlisted: [],
    gone: [],
    memorials: [],
    onStage: null,
    ledger: {},
    levied: {},
    marchedDay: -9999,
    camps: {},
    emperor: false,
    edictYear: -1,
    edictCount: 0,
    defiant: [],
    plotWho: null,
    plotDay: 0,
    plotIgnored: 0,
    situation: null,
    pastSituations: [],
    roads: {},
    nextDay: state.day + 20,
    deeds: [{
      day: state.day, textId: 'deed.begin',
      vars: { name: def?.name ?? '', age }, tone: 'plain',
    }],
    throne: 'none',
    declined: 0,
    urgedDay: -1,
    merit: {},
    rank: {},
    reign: 1,
    reigns: [],
    lordName: def?.name ?? '',
    lordPersonId: null,
    mourning: null,
    tally: {},
  };
}

/** 记一笔。推演工具靠这些数确认机制真的跑过 */
export function tally(court: Court, key: string, n = 1): void {
  court.tally[key] = (court.tally[key] ?? 0) + n;
}

/** 记一件生平大事。结局那一屏的时间轴就是这些 */
export function addDeed(
  state: WorldState, textId: string,
  vars: Record<string, string | number> = {}, tone: 'plain' | 'good' | 'bad' = 'plain',
): void {
  state.court?.deeds.push({ day: state.day, textId, vars, tone });
}

// ─────────────────────────────────────────────────────────────
// 心气与望
// ─────────────────────────────────────────────────────────────

export function heartOf(state: WorldState, personId: string): number {
  return state.court?.heart[personId] ?? HEART_START;
}

/** 拨一下某个人的心气。到底了他就不再上报 —— 那是最危险的信号 */
export function bumpHeart(state: WorldState, personId: string, delta: number): void {
  const court = state.court;
  if (!court) return;
  const was = court.heart[personId] ?? HEART_START;
  const now = clamp(was + delta, 0, 100);
  court.heart[personId] = now;

  if (now < HEART_SILENT && court.silent[personId] === undefined) {
    court.silent[personId] = state.day;
    tally(court, 'silent');
  } else if (now >= HEART_QUIET && court.silent[personId] !== undefined) {
    delete court.silent[personId];
  }
}

export function bumpRenown(state: WorldState, delta: number): void {
  const court = state.court;
  if (!court) return;
  court.renown = clamp(court.renown + delta, 0, 100);
}

/**
 * 守将的心气顶多少事。
 *
 * 这是心气**真的在跑**的地方之一：一个称病不出的人守的城，
 * 兵是散的。以一为轴 —— 别写成往上加，写成加会把全天下的城防一起抬高
 * （这条教训见 wardenPermille 上面那一大段）。
 */
export function heartPermille(state: WorldState, personId: string | null): number {
  if (!personId || state.role !== 'lord') return 1000;
  const h = heartOf(state, personId);
  // 心气 62（初值）约等于一。闭门不出的只剩八成半，誓以死报的多一成
  return clamp(880 + Math.round((h - 62) * 2.2), 820, 1120);
}

/** 帐下有几个人肯替你说话 */
export function loyalHearts(state: WorldState, idx: ContentIndex): number {
  return ownPeople(state, idx).filter((p) => heartOf(state, p.id) >= HEART_LOYAL).length;
}

/**
 * 帐下都有谁。
 *
 * 出身那一家的人，加上举荐来的、随地归附来的，减去已经走了的。
 * **这是「人」那根柱子的分母** —— 所以它必须是状态，不能只看内容库。
 */
export function ownPeople(state: WorldState, idx: ContentIndex): PersonDef[] {
  const court = state.court;
  const base = idx.byFaction.get(state.official.lordId) ?? [];
  if (!court) return [...base];
  const gone = new Set(court.gone);
  const seen = new Set<string>();
  const out: PersonDef[] = [];
  for (const p of [...base, ...court.enlisted.map((id) => idx.person.get(id))]) {
    if (!p || gone.has(p.id) || seen.has(p.id)) continue;
    // 主公本人不站在班列里 —— 他坐在上头
    if (p.id === court.lordPersonId) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ─────────────────────────────────────────────────────────────
// 土：名都之分
// ─────────────────────────────────────────────────────────────

/**
 * 你占着的名都值多少分。
 *
 * **不是数城，是数分量。** 洛阳与长安是旧都新都，各值五分；
 * 邺、许、寿春、襄阳、成都这一档三分；其余名城一到二分；
 * 寻常小县一分不值。
 *
 * 用它当「土」这根柱子，是为了不让胜利变成涂满地图 ——
 * 设计方案里那一整套防滚雪球的机制，才不会反过来变成「拖延你赢的障碍」。
 */
export function fameHeld(state: WorldState, idx: ContentIndex): number {
  let sum = 0;
  for (const n of Object.values(state.nodes)) {
    if (n.factionId !== state.official.lordId) continue;
    sum += idx.node.get(n.id)?.fame ?? 0;
  }
  return sum;
}

/** 三根柱子齐了没有。只有一根是打出来的 */
export function thronePillars(
  state: WorldState, idx: ContentIndex,
): { land: number; name: number; men: number; ready: boolean } {
  const land = fameHeld(state, idx);
  const name = state.court?.renown ?? 0;
  const men = loyalHearts(state, idx);
  return {
    land, name, men,
    ready: land >= FAME_FOR_THRONE && name >= RENOWN_FOR_THRONE && men >= HEARTS_FOR_THRONE,
  };
}

// ─────────────────────────────────────────────────────────────
// 消息要走路
// ─────────────────────────────────────────────────────────────

/**
 * 从某处到治所要经过哪几座城。
 *
 * 广度优先，返回**不含出发地、末一个是治所**的一串。
 * 走不到（中间被别家的地界隔断也照走 —— 信使是一个人，不是一支军队）
 * 就返回 null。
 */
export function routeTo(
  state: WorldState, idx: ContentIndex, fromId: string,
): string[] | null {
  const seat = state.official.cityId;
  if (fromId === seat) return [];
  const prev = new Map<string, string>();
  const seen = new Set<string>([fromId]);
  let edge = [fromId];
  for (let step = 0; step < 10 && edge.length > 0; step++) {
    const next: string[] = [];
    for (const id of edge) {
      for (const to of (idx.node.get(id)?.links ?? []).slice().sort()) {
        if (seen.has(to)) continue;
        seen.add(to);
        prev.set(to, id);
        if (to === seat) {
          const path: string[] = [];
          let cur = seat;
          while (cur !== fromId) { path.unshift(cur); cur = prev.get(cur)!; }
          return path;
        }
        next.push(to);
      }
    }
    edge = next.sort();
  }
  return null;
}

/** 这一段有没有驿，而且眼下通不通 —— 两头有一头被围，驿就断了 */
export function roadWorks(state: WorldState, a: string, b: string): boolean {
  const court = state.court;
  if (!court) return false;
  if (!court.roads[roadKeyOf(a, b)]) return false;
  return !state.sieges[a] && !state.sieges[b];
}

/**
 * 从某处到治所，消息走几天。
 *
 * 呈报到你案头永远是旧消息。你批的时候，那座城可能已经破了 ——
 * 战争迷雾的味道，完全建在现成的路网上，不需要新系统。
 */
export function newsDays(state: WorldState, idx: ContentIndex, fromId: string): number {
  const seat = state.official.cityId;
  if (fromId === seat) return 0;
  // 广度优先数几段路。天下图不大，这点开销无所谓
  const seen = new Set<string>([fromId]);
  let edge = [fromId];
  for (let step = 1; step <= 8; step++) {
    const next: string[] = [];
    for (const id of edge) {
      for (const to of idx.node.get(id)?.links ?? []) {
        if (seen.has(to)) continue;
        if (to === seat) return step * NEWS_DAYS_PER_LINK;
        seen.add(to);
        next.push(to);
      }
    }
    if (next.length === 0) break;
    edge = next.sort();
  }
  return 8 * NEWS_DAYS_PER_LINK;
}

/**
 * 出师的间歇。
 *
 * 和 NPC 那条一模一样：摊子越大，重整旗鼓越慢。
 * 返回还要等几天，零就是这会儿发得出去。
 */
export function marchWait(state: WorldState): number {
  const court = state.court;
  if (!court) return 0;
  const holdings = Object.values(state.nodes)
    .filter((n) => n.factionId === state.official.lordId).length;
  const need = MARCH_COOLDOWN_BASE + holdings * MARCH_COOLDOWN_PER_CITY;
  return Math.max(0, need - (state.day - court.marchedDay));
}

// ─────────────────────────────────────────────────────────────
// 驿传
// ─────────────────────────────────────────────────────────────

/**
 * 把一件事发出去。
 *
 * 治所自己出的事当场就到案上（劝进、举荐、来使都是在你眼皮底下发生的）；
 * 别处的事变成一骑，**在图上真的跑**。
 */
export function sendCourier(
  state: WorldState, idx: ContentIndex, m: Memorial,
): SimEvent[] {
  const court = state.court!;
  if (m.fromId === state.official.cityId) return [deliver(state, m)];

  const route = routeTo(state, idx, m.fromId);
  if (!route || route.length === 0) return [deliver(state, m)];

  const id = mintId(state, 'ride');
  state.couriers[id] = {
    id, carry: m, fromId: m.fromId,
    legFrom: m.fromId, legTo: route[0]!,
    progress: 0, route: route.slice(1),
  };
  tally(court, 'courier');
  return [{ t: 'courier_sent', fromId: m.fromId, kind: m.kind }];
}

/** 到了。这时候才落到案上，也才开始计过期 */
function deliver(state: WorldState, m: Memorial): SimEvent {
  const court = state.court!;
  m.arriveDay = state.day;
  m.dueDay = state.day + MEMORIAL_LIFE;
  court.memorials.push(m);
  tally(court, 'raised');
  tally(court, 'raised.' + m.kind);
  return { t: 'memorial_raised', kind: m.kind, personId: m.personId, id: m.id };
}

/**
 * 一天的路。
 *
 * ── 他会被截 ────────────────────────────────────────
 *
 * **这才是这套东西真正的价值。** 一骑没了，那件事你永远不会知道 ——
 * 一座城求援，信使死在半路，等你听说的时候城已经破了。
 *
 * 而玩家是**看着他从驿传里消失**的，不是收到一句「有信使阵亡」的提示：
 * 少了一骑这件事本身就是消息，用不着旁白。
 */
export function tickCouriers(state: WorldState, idx: ContentIndex): SimEvent[] {
  const events: SimEvent[] = [];
  for (const id of Object.keys(state.couriers).sort()) {
    const c = state.couriers[id]!;

    // 一、这一程险不险
    const safe = roadWorks(state, c.legFrom, c.legTo) ? ROAD_SAFER : 1;
    let risk = 0;
    if (state.sieges[c.legTo] || state.sieges[c.legFrom]) risk += INTERCEPT_SIEGE;
    for (const a of Object.values(state.armies)) {
      if (a.factionId === state.official.lordId) continue;
      const same = (a.fromId === c.legFrom && a.toId === c.legTo)
        || (a.fromId === c.legTo && a.toId === c.legFrom);
      if (same) { risk += INTERCEPT_ARMY; break; }
    }
    if (risk > 0 && chancePermille(state.rng, Math.round(risk * 10 * safe))) {
      delete state.couriers[id];
      tally(state.court!, 'courier.lost');
      events.push({ t: 'courier_lost', fromId: c.fromId, kind: c.carry.kind });
      continue;
    }

    // 二、走一天
    const len = idx.roadLength.get(roadKey(c.legFrom, c.legTo)) ?? 12;
    const boost = roadWorks(state, c.legFrom, c.legTo) ? ROAD_SPEED : 1000;
    c.progress += Math.max(60, Math.floor((COURIER_PER_DAY * 12 * boost) / (len * 1000)));
    if (c.progress < 1000) continue;

    // 三、到了这一程的头
    if (c.route.length === 0) {
      delete state.couriers[id];
      events.push(deliver(state, c.carry));
      events.push({ t: 'courier_arrived', fromId: c.fromId, kind: c.carry.kind });
      continue;
    }
    c.legFrom = c.legTo;
    c.legTo = c.route.shift()!;
    c.progress = 0;
  }
  return events;
}

// ─────────────────────────────────────────────────────────────
// 一天
// ─────────────────────────────────────────────────────────────

/**
 * 主公的一天。
 *
 * 上一版这里是空的（「主公的一天里，他自己什么也不做」）——
 * 那句话当时是设计意图，后来成了病因。
 */
export function tickCourt(state: WorldState, idx: ContentIndex): SimEvent[] {
  const court = state.court;
  if (!court || state.ending) return [];
  // 大丧。日子停在这儿，等玩家看完先主的一生（见 succession.ts）
  if (court.mourning) return [];
  const events: SimEvent[] = [];

  events.push(...tickCouriers(state, idx));
  events.push(...expireMemorials(state, idx));

  // 每季一次：人心自己往它该在的地方走
  if (state.day % 90 === 0) driftHearts(state, idx);

  /**
   * 季末上计。**这是太仓唯一的进项。**
   *
   * 各城的守官把余粮解到治所 —— 和当文官时你给主公缴的那一笔，
   * 是同一件事的两头（见 tribute.ts）。
   * 跟着一并考课：办砸了的人自己掉下去，不用你点头。
   */
  if (state.day > 0 && state.day % TRIBUTE_EVERY === 0) {
    events.push(...collectTribute(state, idx));
    events.push(...assess(state, idx));
  }

  // 各处的粮车。够就发，不够就没有 —— 不再拿这件事去烦主公
  if (state.day % 12 === 0) events.push(...feedCities(state));

  /**
   * 一年一次：境内无事，望自己往上走一点。
   *
   * **望必须有一个跟打仗无关的稳定来源**，否则「名」那根柱子就是死的：
   * 早先它只在辞让、赈灾这些偶发的事上动，一路飘在四十上下，
   * 于是「来附」永远够不着门槛，劝进也就永远上不来。
   *
   * 治下不丢城、民心不崩 —— 这是一个诸侯最本分的事，
   * 天下人看的正是这个。
   */
  if (state.day % DAYS_PER_YEAR === 0) {
    const held = heldNodes(state);
    const calm = held.length > 0
      && held.every((n) => state.day - n.takenDay > DAYS_PER_YEAR || n.takenDay < 0)
      && held.reduce((a, n) => a + n.morale, 0) / held.length > 52;
    if (calm) bumpRenown(state, 3);
  }

  // 天下自己往鼎立收
  if (state.day % CONSOLIDATE_EVERY === 0) events.push(...consolidate(state, idx));

  // 新的一批呈报
  if (state.day >= court.nextDay && court.memorials.length < DESK_MAX) {
    events.push(...raiseMemorials(state, idx));
    court.nextDay = state.day + MEMORIAL_EVERY + nextInt(state.rng, 14);
  }

  // 春秋高了。一年之内必有征兆 —— 但永远不给数字
  const left = court.span - state.day;
  if (left === 360 || left === 200 || left === 90) {
    events.push({
      t: 'notice', textId: 'court.aging', vars: {}, tone: 'bad',
    });
  }

  // 大限
  if (state.day >= court.span) events.push(...settleDeath(state, idx));

  return events;
}

/**
 * 每季一次的人心自走。
 *
 * **原先这里是单向下滑的**，于是推演里跑十四年下来，
 * 帐下四十几个人全部沉到底：「肯替你说话的」平均 0.2 个，
 * 劝进表一百局也上不来一次 —— 「人」那根柱子形同虚设。
 *
 * 真正的道理是：**人不满的是闲着，不是活着。**
 * 有差事的人心气自己会长，闲着的人自己会凉。
 * 于是「任命」从往字典里写一个键，变成了**给一个人一份差事** ——
 * 这条线上最老的那个动词，到这里才第一次有了分量。
 */
function driftHearts(state: WorldState, idx: ContentIndex): void {
  const court = state.court!;
  const posted = new Set(Object.values(state.posts));
  const wellKnown = court.renown >= 70;

  for (const p of ownPeople(state, idx)) {
    let d = 0;
    if (posted.has(p.id)) {
      // 有差事，而且差事办得下去
      const city = Object.entries(state.posts).find(([, pid]) => pid === p.id)?.[0];
      const node = city ? state.nodes[city] : undefined;
      const besieged = city ? !!state.sieges[city] : false;
      d = besieged ? -HEART_DRIFT : 2;
      if (node && node.unrest > 40) d -= 1;
    } else {
      // 闲着。一个没有事做的人，早晚会想别的
      d = -HEART_DRIFT;
    }
    // 主公有名望，跟着他脸上有光
    if (wellKnown) d += 1;
    bumpHeart(state, p.id, d);
  }
}

// ─────────────────────────────────────────────────────────────
// 粮车 —— 不必主公点头的那一种
// ─────────────────────────────────────────────────────────────

/** 押送粮车的兵。粮不会自己走路 */
export const CONVOY_ESCORT = 30;
/** 一座城拨粮之前先给自己留下这些 */
export const SEAT_RESERVE = 150;

/**
 * 拨粮从哪儿出。
 *
 * 自家存粮最多的那一座 —— 治所在同等存粮下优先（它本来就是总仓）。
 * 被围的城调不出粮，要拨给的那座自己也不算。
 *
 * **早先一律从治所拨**，于是治所是一个必然的瓶颈：
 * 一座城的产出要养全境的告急，太仓永远见底。
 * 现实里转运本来就是就近调。
 */
export function bestGranary(
  state: WorldState, exceptId: string,
): CityNode | null {
  const me = state.official.lordId;
  const seatId = state.official.cityId;
  const pool = Object.values(state.nodes).filter(
    (n) => n.factionId === me && n.id !== exceptId && !state.sieges[n.id],
  );
  pool.sort((a, b) => (b.grain - a.grain)
    || (a.id === seatId ? -1 : b.id === seatId ? 1 : a.id.localeCompare(b.id)));
  return pool[0] ?? null;
}

/**
 * 各处告匮，仓里有就发。
 *
 * ── 为什么这一件不该再摆上案头 ──────────────────────
 *
 * 「请粮」这一件曾经是案上出现得最勤的呈报，而它**从头到尾没有一个决定**：
 * 仓里有你就允，仓里没有你允了也是一句「办不成」。
 * 玩家做的事是一遍遍点同一个「允」—— 那不是治国，那是签收。
 *
 * 一个诸侯本来也不必亲自过问某个县今年的口粮。
 * 郡府该做的事，郡府自己会做：**够就发，不够就没有。**
 *
 * 案头因此空出一格来 —— 留给真正要你拿主意的事（请援、请战、叙功）。
 *
 * 代价照旧在：接济不上的城民心自己往下滑，
 * 而那件事你是在天下图上看见的，不是在案头上被人告知的。
 */
function feedCities(state: WorldState): SimEvent[] {
  const events: SimEvent[] = [];
  const seatId = state.official.cityId;

  for (const node of heldNodes(state)) {
    if (node.id === seatId) continue;
    // 被围的城送不进去 —— 那是「请援」的事，不是拨粮的事
    if (state.sieges[node.id]) continue;
    const need = Math.min(900, Math.max(300, node.troops * 2));
    if (node.grain > need) continue;

    const from = bestGranary(state, node.id);
    if (!from) { node.morale = Math.max(6, node.morale - 2); continue; }
    const spare = from.grain - SEAT_RESERVE;
    const amount = Math.min(need, spare);
    if (amount < 200 || from.troops < CONVOY_ESCORT + 80) {
      // 各处都拨不出。那座城自己往下滑 —— 你在图上看得见
      node.morale = Math.max(6, node.morale - 2);
      continue;
    }

    from.grain -= amount;
    from.troops -= CONVOY_ESCORT;
    const id = mintId(state, 'army');
    state.armies[id] = {
      id, factionId: state.official.lordId, troops: CONVOY_ESCORT, supply: amount,
      fromId: from.id, toId: node.id, progress: 0, intent: 'reinforce',
    };
    tally(state.court!, 'convoy');
    events.push({ t: 'convoy_auto', fromId: from.id, toId: node.id, grain: amount });
  }
  return events;
}

// ─────────────────────────────────────────────────────────────
// 请缨 —— 几路人马一齐来解围
// ─────────────────────────────────────────────────────────────

export interface ReliefOffer {
  /** 'camp:<营id>' 或 'city:<城id>' */
  key: string;
  fromId: string;
  /** 领兵的那位。城出的兵是守将带，营出的兵是营将带 */
  personId: string | null;
  troops: number;
  days: number;
  /** 要向这几家借道 */
  borrow: string[];
  /** 走不通的话，是谁挡着 */
  refused: string | null;
}

/**
 * 一座城被围了，帐下有哪几处能去救。
 *
 * ── 为什么非改成这样不可 ────────────────────────────
 *
 * 原先「允」了请援，代码替你在**挨着那座城的邻城**里挑一个 ——
 * 挑不出来就一句「邻城派不出援兵」。
 * 于是玩家眼看着自己还有两座营、四座城，却被告知没人能去。
 * 那既不真实（兵本来就走得了远路），也把一个决定变成了一句拒绝。
 *
 * 真实的样子是：城下告急传到堂上，**几个人同时出列请缨** ——
 * 张郃说他的营三千人十二日可到，李典说他那座城抽得出八百、但要六日，
 * 而从北边来的那一路要向别家借道。
 * 你看着这几行字，挑一路，或者几路都发。
 */
export function reliefOffers(
  state: WorldState, idx: ContentIndex, cityId: string,
): ReliefOffer[] {
  const court = state.court;
  if (!court) return [];
  const me = state.official.lordId;
  const out: ReliefOffer[] = [];

  // 一、各营。脱产的部曲本来就是拿来走远路的
  for (const camp of Object.values(court.camps).sort((a, b) => a.id.localeCompare(b.id))) {
    if (camp.cityId === cityId) continue;
    if (camp.troops < 120) continue;
    const plan = planMarch(state, idx, camp.cityId, cityId, me);
    if (!plan) continue;
    const src = state.nodes[camp.cityId];
    const fed = src ? Math.floor(src.grain / Math.max(2, Math.round(plan.days * 0.08))) : 0;
    const troops = Math.min(camp.troops, Math.max(0, fed));
    if (troops < 120) continue;
    out.push({
      key: 'camp:' + camp.id, fromId: camp.cityId, personId: camp.officerId,
      troops, days: plan.days, borrow: plan.borrow, refused: plan.refused,
    });
  }

  // 二、各城的余兵。远的近的都算 —— 远近写在脸上，由你权衡
  for (const node of heldNodes(state)) {
    if (node.id === cityId) continue;
    if (state.sieges[node.id]) continue;
    if (campAt(state, node.id)) continue; // 有营的城，兵该由营出
    const plan = planMarch(state, idx, node.id, cityId, me);
    if (!plan) continue;
    const spare = Math.floor((node.troops - KEEP_GARRISON) * 0.7);
    const fed = Math.floor(node.grain / Math.max(2, Math.round(plan.days * 0.08)));
    const troops = Math.min(spare, fed);
    if (troops < 120) continue;
    out.push({
      key: 'city:' + node.id, fromId: node.id,
      personId: wardenOf(state, idx, node.id)?.id ?? null,
      troops, days: plan.days, borrow: plan.borrow, refused: plan.refused,
    });
  }

  /**
   * 排序：**先到的排前面，同样快的兵多的排前面。**
   * 一屏最多四路 —— 硬规矩四，任何时刻不超过五个可操作项。
   */
  out.sort((a, b) => {
    if (!!a.refused !== !!b.refused) return a.refused ? 1 : -1;
    return a.days - b.days || b.troops - a.troops || a.key.localeCompare(b.key);
  });
  return out.slice(0, 4);
}

// ─────────────────────────────────────────────────────────────
// 呈报：过期
// ─────────────────────────────────────────────────────────────

/**
 * 到期还没批的，自己走向坏结果。
 *
 * **不批也是一种批。** 而且比驳回还伤 ——
 * 驳回好歹是个答复，不理会连答复都没有。
 */
function expireMemorials(state: WorldState, idx: ContentIndex): SimEvent[] {
  const court = state.court!;
  const events: SimEvent[] = [];
  const kept: Memorial[] = [];

  for (const m of court.memorials) {
    if (state.day < m.dueDay) { kept.push(m); continue; }
    tally(court, 'expired');
    bumpHeart(state, m.personId, -HEART_IGNORE);
    const who = idx.person.get(m.personId);
    events.push({
      t: 'memorial_lapsed', kind: m.kind, personId: m.personId,
      name: who?.name ?? '',
    });

    // 请战的人连着没被理会，某一天会自己动手
    if (m.kind === 'war' && heartOf(state, m.personId) < HEART_QUIET) {
      events.push(...actAlone(state, idx, m));
    }
  }
  court.memorials = kept;
  return events;
}

/**
 * 自作主张。
 *
 * 「主公若不允我，我便自己看着办」—— 这是心气这套东西
 * 最后落在天下图上的样子。他真的会带兵出去。
 */
function actAlone(state: WorldState, idx: ContentIndex, m: Memorial): SimEvent[] {
  const src = state.nodes[m.fromId];
  const dst = state.nodes[m.aboutId];
  if (!src || !dst) return [];
  if (src.factionId !== state.official.lordId) return [];
  if (dst.factionId === state.official.lordId) return [];
  const troops = Math.floor(Math.min(m.amount, Math.max(0, src.troops - 90)));
  if (troops < 80) return [];

  const supply = Math.min(src.grain, troops * 2);
  src.troops -= troops;
  src.grain -= supply;
  const id = mintId(state, 'army');
  state.armies[id] = {
    id, factionId: state.official.lordId, troops, supply,
    fromId: m.fromId, toId: m.aboutId, progress: 0, intent: 'attack',
  };
  tally(state.court!, 'defied');
  const who = idx.person.get(m.personId);
  addDeed(state, 'deed.defied', {
    name: who?.name ?? '', city: idx.node.get(m.aboutId)?.name ?? '',
  }, 'bad');
  return [{
    t: 'memorial_defied', personId: m.personId, name: who?.name ?? '',
    cityId: m.aboutId, troops,
  }];
}

// ─────────────────────────────────────────────────────────────
// 呈报：生成
// ─────────────────────────────────────────────────────────────

/**
 * 摞上新的一批。
 *
 * 挑人有讲究：**心气低的人少说话，到底的人一件也不上。**
 * 所以案头安静下来不是太平，是你已经把人得罪光了 ——
 * 这一条故意不做任何提示。
 */
function raiseMemorials(state: WorldState, idx: ContentIndex): SimEvent[] {
  const court = state.court!;
  const events: SimEvent[] = [];
  /**
   * 案上放得下几件 —— **路上那些也要算**。
   *
   * 少了这一句，信使一多，案头会在他们同时抵达的那一天挤爆，
   * 「一次只见一个人」当场变成排队十几号。
   */
  const inFlight = Object.keys(state.couriers).length;
  const room = DESK_MAX - court.memorials.length - inFlight;
  if (room <= 0) return events;

  const taken = new Set(court.memorials.map((m) => m.kind + ':' + m.aboutId));
  const candidates: Memorial[] = [];

  // 劝进最要紧，先看它
  const urge = makeUrge(state, idx);
  if (urge) candidates.push(urge);

  /**
   * **空城先说。**
   *
   * 早先这里是 `if (!warden) continue` —— 没有守将的城直接跳过，
   * 于是守将一走光，案头就永远空了。空城恰恰是最该报上来的事。
   */
  for (const node of heldNodes(state)) {
    if (wardenOf(state, idx, node.id)) continue;
    const m = makeVacancy(state, idx, node);
    if (m && !taken.has(m.kind + ':' + m.aboutId)) candidates.push(m);
  }

  for (const node of heldNodes(state)) {
    const warden = wardenOf(state, idx, node.id);
    if (!warden) continue;

    /**
     * 不再上报的人**只剩一件事会说**：请你放他走。
     *
     * 别的一概不提了 —— 他已经不指望你了。
     * 早先这里把沉默的人整个跳过，于是辞呈永远递不上来：
     * 一个人心气跌到底之后，就此从案头上消失，
     * 玩家连「他要走」都不知道，那条路等于不存在。
     */
    if (court.silent[warden.id] !== undefined) {
      const bye = makeLeave(state, idx, node, warden);
      if (bye && !taken.has(bye.kind + ':' + bye.aboutId)) candidates.push(bye);
      continue;
    }
    // 心气低的人少开口
    const h = heartOf(state, warden.id);
    if (h < HEART_QUIET && !chance(state.rng, 30)) continue;

    /**
     * **请粮不在这儿了。**
     *
     * 它曾经是案上最勤的一件，而它从头到尾没有一个决定：
     * 仓里有你就允，仓里没有你允了也是一句「办不成」。
     * 现在郡府自己办（见 feedCities），案头空出来的那一格
     * 留给真正要你拿主意的事。
     */
    for (const m of [
      makeRelief(state, idx, node, warden),
      makeWar(state, idx, node, warden),
      makeLeave(state, idx, node, warden),
    ]) {
      if (m && !taken.has(m.kind + ':' + m.aboutId)) candidates.push(m);
    }
  }

  const merit = makeMerit(state, idx);
  if (merit) candidates.push(merit);
  const rec = makeRecommend(state, idx);
  if (rec) candidates.push(rec);
  const sub = makeSubmit(state, idx);
  if (sub) candidates.push(sub);

  // 急的排前面：劝进 > 请援 > 求去 > 来附 > 请粮 > 请战 > 举荐
  const rank: Record<MemorialKind, number> = {
    // 空城排在最前 —— 一座没人主事的城，比什么都急
    vacancy: 0, urge: 1, relief: 2, leave: 3, submit: 4, war: 5, merit: 6, recommend: 7,
    // 请粮不再上案头：够就发，不够就没有（见 feedCities）
    grain: 8,
    // 露布不进这条队列，它由天下的事直接生成（见 noteWorldEvents）
    dispatch: 9,
  };
  candidates.sort((a, b) => rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id));

  for (const m of candidates.slice(0, room)) {
    events.push(...sendCourier(state, idx, m));
  }
  return events;
}

function heldNodes(state: WorldState): CityNode[] {
  return Object.values(state.nodes)
    .filter((n) => n.factionId === state.official.lordId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 一件帖子的壳。话在 textId 上，口气随心气而变 */
function shell(
  state: WorldState, _idx: ContentIndex, kind: MemorialKind,
  who: PersonDef, fromId: string, aboutId: string, amount: number,
  vars: Record<string, string | number>,
): Memorial {
  const tone = heartTone(heartOf(state, who.id));
  return {
    id: mintId(state, 'mem'),
    kind, personId: who.id, fromId, aboutId, amount,
    // 事就发生在今天。到案是哪天，等信使真的到了再填（见 deliver）
    atDay: state.day,
    arriveDay: -1,
    dueDay: -1,
    textId: `mem.${kind}.${tone}`,
    vars: { name: who.name, ...vars },
  };
}

/**
 * 无人主事 —— 有人自请前往。
 *
 * **呈报本身就是那个人在毛遂自荐**，所以「允」的意思很干净：派他去。
 * 挑谁来自请也有讲究：先挑擅守备的，其次挑心气高的 ——
 * 一个称病不出的人不会主动请缨。
 */
function makeVacancy(
  state: WorldState, idx: ContentIndex, node: CityNode,
): Memorial | null {
  const court = state.court!;
  const posted = new Set(Object.values(state.posts));
  const free = ownPeople(state, idx)
    .filter((p) => !posted.has(p.id) && court.silent[p.id] === undefined
      && heartOf(state, p.id) >= 30)
    .sort((a, b) => {
      const score = (x: typeof a): number =>
        x.command + (x.good.includes('守备') ? 30 : 0) + heartOf(state, x.id);
      return score(b) - score(a);
    });
  const who = free[0];
  if (!who) return null;

  return shell(state, idx, 'vacancy', who, node.id, node.id, 0, {
    city: idx.node.get(node.id)?.name ?? node.id,
  });
}

/** 请援 —— 城正被围。这是案上最急的一件 */
function makeRelief(
  state: WorldState, idx: ContentIndex, node: CityNode, who: PersonDef,
): Memorial | null {
  const sg = state.sieges[node.id];
  if (!sg) return null;
  return shell(state, idx, 'relief', who, node.id, node.id, sg.troops, {
    city: idx.node.get(node.id)?.name ?? node.id,
    foe: idx.faction.get(sg.factionId)?.name ?? sg.factionId,
    troops: sg.troops, days: sg.days,
  });
}

/** 请战 —— 隔壁那座敌城看着薄 */
function makeWar(
  state: WorldState, idx: ContentIndex, node: CityNode, who: PersonDef,
): Memorial | null {
  if (state.sieges[node.id]) return null;
  const spare = node.troops - 120;
  if (spare < 200) return null;
  if (node.grain < 400) return null;

  const foes = (idx.node.get(node.id)?.links ?? [])
    .map((id) => state.nodes[id])
    .filter((n): n is CityNode => {
      if (!n || n.factionId === state.official.lordId) return false;
      if (n.takenDay >= 0 && state.day - n.takenDay < AFTER_CAPTURE_QUIET) return false;
      return atWar(state, state.official.lordId, n.factionId)
        || (state.factions[n.factionId]?.attitude[state.official.lordId] ?? 0) < 10;
    })
    .sort((a, b) => a.troops - b.troops);

  const target = foes[0];
  if (!target) return null;
  // 性急的人门槛低，持重的人非得有把握才开口
  const bold = who.temper === 'rash' ? 0.8 : who.temper === 'cautious' ? 1.4 : 1.05;
  if (spare < target.troops * bold) return null;

  return shell(state, idx, 'war', who, node.id, target.id, spare, {
    city: idx.node.get(node.id)?.name ?? node.id,
    target: idx.node.get(target.id)?.name ?? target.id,
    foe: idx.faction.get(target.factionId)?.name ?? target.factionId,
    troops: spare, theirs: target.troops,
  });
}

/** 求去 —— 心气跌到底的人请辞。不放他，他就自己走 */
function makeLeave(
  state: WorldState, idx: ContentIndex, node: CityNode, who: PersonDef,
): Memorial | null {
  if (heartOf(state, who.id) >= HEART_LEAVE) return null;
  if (!chance(state.rng, 40)) return null;
  return shell(state, idx, 'leave', who, node.id, node.id, 0, {
    city: idx.node.get(node.id)?.name ?? node.id,
  });
}

/**
 * 叙功 —— 有人替某某请一个更高的位子。
 *
 * ── 为什么升要你点头，贬不用 ────────────────────────
 *
 * 贬是考课：一年年办砸下去，位子自己就没了（见 `assess`）。
 * 那不该来问你 —— 一个连贬谪都要主公亲口说的朝廷，是没有制度的。
 *
 * 而升是**恩典**。名位是主公手上最便宜也最有分量的一样东西：
 * 不花一石粮，却能让一个人的心气一下涨上去，
 * 也能让另一个没被提到的人记着这件事。
 * 所以它必须经你的手。
 *
 * 上表的不是本人 —— 自己替自己请官是不成体统的。
 * 挑帐下心气最高的那一个来说这句话。
 */
function makeMerit(state: WorldState, idx: ContentIndex): Memorial | null {
  const court = state.court!;
  const mine = ownPeople(state, idx);
  /**
   * **同一个人不要议第二回。**
   *
   * `readyToRise` 在你批复之前一直是真的，于是下一批呈报又替他上一道 ——
   * 实测堂下站着两个李典，都说同一件事。
   * 路上那些也要算：信使还没到，案上看不见，但它已经在路上了。
   */
  const already = new Set<string>();
  for (const m of court.memorials) if (m.kind === 'merit') already.add(m.aboutId);
  for (const c of Object.values(state.couriers)) {
    if (c.carry.kind === 'merit') already.add(c.carry.aboutId);
  }
  const ripe = mine
    .filter((p) => court.silent[p.id] === undefined && !already.has(p.id)
      && readyToRise(state, p.id))
    .sort((a, b) => (court.merit[b.id] ?? 0) - (court.merit[a.id] ?? 0));
  const who = ripe[0];
  if (!who) return null;

  const sponsor = mine
    .filter((p) => p.id !== who.id && court.silent[p.id] === undefined
      && heartOf(state, p.id) >= 50)
    .sort((a, b) => heartOf(state, b.id) - heartOf(state, a.id))[0] ?? who;

  const seat = state.official.cityId;
  const where = Object.entries(state.posts).find(([, pid]) => pid === who.id)?.[0]
    ?? Object.values(court.camps).find((c) => c.officerId === who.id)?.cityId
    ?? seat;
  return shell(state, idx, 'merit', sponsor, seat, who.id, 0, {
    who: who.name,
    now: rankName(state, who),
    next: nextRankName(state, who),
    city: idx.node.get(where)?.name ?? '',
    praise: who.praise,
  });
}

/**
 * 举荐 —— **这是招人的主要途径。**
 *
 * 望高才有人肯来。所以「名」这根柱子不是装饰：
 * 它直接决定你帐下将来有几个人。
 */
function makeRecommend(state: WorldState, idx: ContentIndex): Memorial | null {
  const court = state.court!;
  /**
   * 帐下够用了就没人再往里荐人。
   *
   * 少了这一句，推演里十四年荐进来两百多个人 ——
   * 「城多了管不过来」当场作废，而且望被一路推到八十几。
   * 人是荐来做事的，不是收藏的。
   */
  const room = heldNodes(state).length + 2;
  if (ownPeople(state, idx).length >= room) return null;

  /**
   * 称了帝的人可以用朝廷名义封赏 —— 招人的权重跟着涨。
   *
   * **天子在你城里也一样。** 朝廷在哪儿，天下的士人就往哪儿去 ——
   * 荀彧、郭嘉那一批人投曹操，图的正是「奉天子」这三个字。
   * 少了这一条，迎天子就只剩供养和离心，是个纯粹的坑。
   */
  const crowned = court.throne === 'claimed' || court.throne === 'forced' ? 10 : 0;
  const hasSon = court.emperor ? 9 : 0;
  if (!chance(state.rng, Math.max(3, Math.floor(court.renown / 6) + crowned + hasSon))) {
    return null;
  }

  const mine = ownPeople(state, idx)
    .filter((p) => court.silent[p.id] === undefined && heartOf(state, p.id) >= 50);
  const sponsor = mine.find((p) => p.good.includes('举荐')) ?? mine[0];
  if (!sponsor) return null;

  // 在野的人：没有出身，或出身那一家已经没了地盘
  const free = idx.db.people.filter((p) => {
    if (p.faction === state.official.lordId) return false;
    if (court.enlisted.includes(p.id) || court.gone.includes(p.id)) return false;
    if (p.faction === '') return true;
    return !Object.values(state.nodes).some((n) => n.factionId === p.faction);
  });
  const pick = free[nextInt(state.rng, Math.max(1, free.length))];
  if (!pick) return null;

  const seat = state.official.cityId;
  return shell(state, idx, 'recommend', sponsor, seat, pick.id, 0, {
    who: pick.name, praise: pick.praise, good: pick.good.join(' · '),
  });
}

/**
 * 来附 —— 一家撑不下去的势力愿举州归附。
 *
 * **这是「望」变成地盘的地方，也是天下往鼎立收的一条和平路径。**
 * 望不够高就没人来 —— 谁愿意把祖宗基业交给一个名声不好的人。
 */
function makeSubmit(state: WorldState, idx: ContentIndex): Memorial | null {
  const court = state.court!;
  if (court.renown < RENOWN_FOR_SUBMIT) return null;
  if (!chance(state.rng, 5)) return null;

  // 只有挨着你的才谈得上归附 —— 隔着三个州把地送给你，说不通
  const touching = new Set<string>();
  for (const n of heldNodes(state)) {
    for (const to of idx.node.get(n.id)?.links ?? []) {
      const other = state.nodes[to];
      if (other && other.factionId !== state.official.lordId) touching.add(other.factionId);
    }
  }
  const weak = weakFactions(state).filter((f) => {
    if (f.id === state.official.lordId || !touching.has(f.id)) return false;
    const att = state.factions[f.id]?.attitude[state.official.lordId] ?? 0;
    return att > -30;
  });
  const target = weak[0];
  if (!target) return null;

  const envoy = (idx.byFaction.get(target.id) ?? [])[0];
  if (!envoy) return null;
  const seat = state.official.cityId;
  return shell(state, idx, 'submit', envoy, seat, target.id, target.cities, {
    faction: idx.faction.get(target.id)?.name ?? target.id,
    cities: target.cities,
  });
}

/**
 * 劝进 —— 「赢」唯一的入口。
 *
 * 三根柱子齐了，才会有人上这道表。而第三根是**人** ——
 * 你可以有全天下的地，但如果这一路把人得罪光了，
 * 没人肯替你说这句话，你就走不到那个结局。
 */
function makeUrge(state: WorldState, idx: ContentIndex): Memorial | null {
  const court = state.court!;
  if (court.throne === 'claimed' || court.throne === 'forced') return null;
  if (court.throne === 'refused') return null;
  if (court.urgedDay >= 0 && state.day - court.urgedDay < 200) return null;
  if (!thronePillars(state, idx).ready) return null;

  // 挑帐下心气最高、最有分量的那个人来上表
  const mine = ownPeople(state, idx)
    .filter((p) => heartOf(state, p.id) >= HEART_LOYAL)
    .sort((a, b) => (heartOf(state, b.id) + b.wit) - (heartOf(state, a.id) + a.wit));
  const sponsor = mine[0];
  if (!sponsor) return null;

  court.urgedDay = state.day;
  const seat = state.official.cityId;
  return shell(state, idx, 'urge', sponsor, seat, state.official.lordId, court.declined, {
    times: court.declined,
  });
}

// ─────────────────────────────────────────────────────────────
// 露布
// ─────────────────────────────────────────────────────────────

/**
 * 前方的事，得有人来报。
 *
 * **案上不该全是要你拍板的事。** 一屋子人只在有求于你的时候才出现，
 * 那个朝堂是假的 —— 打赢了要有人来报捷，城丢了也得有人来说。
 *
 * 露布不要你批，只要你知道。它的价值全在**节奏**上：
 * 一连三件都在向你伸手之后，来一件「破敌于濮阳城下」，
 * 这一屏才像一个真的朝堂。
 */
export function noteWorldEvents(
  state: WorldState, idx: ContentIndex, events: readonly SimEvent[],
): SimEvent[] {
  const court = state.court;
  if (!court || state.ending) return [];
  const me = state.official.lordId;
  const out: SimEvent[] = [];

  for (const ev of events) {
    let textId = '';
    let cityId = '';
    let vars: Record<string, string | number> = {};

    if (ev.t === 'city_fell') {
      cityId = ev.cityId;
      const city = idx.node.get(ev.cityId)?.name ?? ev.cityId;
      if (ev.to === me) {
        textId = 'dispatch.won';
        vars = { city, foe: idx.faction.get(ev.from)?.name ?? ev.from };
        /**
         * **奉诏讨逆，打赢了望还涨。**
         *
         * 平时打谁都是无故兴兵、要折望；打一个抗过诏的人不一样 ——
         * 这是全局唯一一处让「攻城略地」变成「涨名声」的开关。
         * 「挟天子以令诸侯」那句话的分量，全在这里。
         */
        if (court.defiant.includes(ev.from)) {
          bumpRenown(state, RENOWN_RIGHTEOUS);
          textId = 'dispatch.righteous';
        }
      } else if (ev.from === me) {
        textId = 'dispatch.lost';
        vars = { city, foe: idx.faction.get(ev.to)?.name ?? ev.to };
      } else continue;
    } else if (ev.t === 'siege_lifted' && !ev.taken) {
      const node = state.nodes[ev.cityId];
      if (!node || node.factionId !== me) continue;
      cityId = ev.cityId;
      textId = 'dispatch.held';
      vars = {
        city: idx.node.get(ev.cityId)?.name ?? ev.cityId,
        foe: idx.faction.get(ev.factionId)?.name ?? ev.factionId,
      };
    } else continue;

    // 报信的是那座城的守将；没有守将就是一个无名的偏将
    const warden = wardenOf(state, idx, cityId);
    const teller = warden ?? ownPeople(state, idx)[0];
    if (!teller) continue;

    const m: Memorial = {
      id: mintId(state, 'mem'),
      kind: 'dispatch',
      personId: teller.id,
      fromId: cityId,
      aboutId: cityId,
      amount: 0,
      atDay: state.day,
      arriveDay: -1,
      dueDay: -1,
      textId,
      vars: { name: teller.name, ...vars },
    };
    out.push(...sendCourier(state, idx, m));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 兼并：天下往鼎立收
// ─────────────────────────────────────────────────────────────

interface Weak { id: string; cities: number; troops: number }

/** 撑不下去的几家，最弱的排前面 */
function weakFactions(state: WorldState): Weak[] {
  const tallyBy = new Map<string, Weak>();
  for (const n of Object.values(state.nodes)) {
    if (n.factionId === 'bandit') continue;
    const w = tallyBy.get(n.factionId) ?? { id: n.factionId, cities: 0, troops: 0 };
    w.cities += 1;
    w.troops += n.troops;
    tallyBy.set(n.factionId, w);
  }
  const year = Math.floor(state.day / DAYS_PER_YEAR);
  /**
   * **头两年谁也吞不掉谁。**
   *
   * 开局十八家里有一大半只据一座城，门槛一放开就被邻居一口气吃干净 ——
   * 实测第一年天下就从十八家掉到十一家，「群雄并起」那一段直接没了。
   * 乱世刚起的时候，各家都在自己站稳，顾不上并人。
   */
  if (year < 2) return [];
  /**
   * 之后年头越久，门槛越松 —— **天下自己往少数几家收。**
   *
   * 这是「最后要收成三国鼎立的样子」那条要求的落点。
   * 头几年谁也吞不掉谁（乱世刚起，各家都在自己站稳）；
   * 越往后，撑不住的越撑不住 —— 到十年上下，
   * 一家三四座城的中等势力也会被邻居并掉。
   */
  const cap = year < 4 ? 1 : year < 6 ? 2 : year < 9 ? 3 : year < 12 ? 5 : 8;
  return [...tallyBy.values()]
    .filter((w) => w.cities <= cap)
    .sort((a, b) => a.troops - b.troops || a.id.localeCompare(b.id));
}

/**
 * 兼并。
 *
 * 天下不该永远十几家在图上僵着 —— 那不是乱世，那是一盘冻住的棋。
 * 收敛靠两条，都不新造规则：
 *
 * 一、**主亡则乱**：一家的主死了，那一家人心散、兵少、久不出战，
 *    于是更容易被人吃掉（袁绍死后诸子相争就是这么回事）。
 * 二、**弱者归附**：撑不下去的一家，把地交给挨着的一个强邻。
 *    交给谁看两样：谁强、谁跟他不结仇。
 *
 * 玩家那一家永远不会被自动归附掉 —— 他要么打赢，要么被打光。
 * 但他**收得到**别人的归附：那是一件呈报（见 makeSubmit）。
 */
function consolidate(state: WorldState, idx: ContentIndex): SimEvent[] {
  const events: SimEvent[] = [];

  // 一、诸侯的大限。NPC 的主也会死
  for (const fid of Object.keys(state.factions).sort()) {
    if (fid === state.official.lordId || fid === 'bandit') continue;
    const def = idx.faction.get(fid);
    if (!def?.until) continue;
    const dieDay = Math.max(1, def.until - 190) * DAYS_PER_YEAR;
    if (state.day < dieDay || state.day >= dieDay + CONSOLIDATE_EVERY) continue;

    const fs = state.factions[fid];
    if (!fs) continue;
    // 主亡则乱：人心散、久不能战
    fs.cooldown = Math.max(fs.cooldown, 200);
    for (const n of Object.values(state.nodes)) {
      if (n.factionId !== fid) continue;
      n.troops = Math.floor(n.troops * 0.86);
      n.unrest = Math.min(80, n.unrest + 22);
      n.morale = Math.max(8, n.morale - 8);
    }
    events.push({ t: 'lord_died', factionId: fid, name: def.name });
    addDeed(state, 'deed.rival_died', { name: def.name }, 'plain');
  }

  // 二、弱者归附
  for (const w of weakFactions(state)) {
    if (w.id === state.official.lordId) continue;
    if (!chance(state.rng, 38)) continue;

    const theirs = Object.values(state.nodes)
      .filter((n) => n.factionId === w.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (theirs.length === 0) continue;

    /**
     * 挨着的强邻里挑一个：够强，而且没结死仇。
     *
     * **比的是那一家的全部家底，不是边境那两座城的守军。**
     * 头一版拿边境几座城的兵去比，于是一个三城的小势力
     * 要求邻居在边境上摆出四千人才肯归附 —— 门槛高得几乎没人过得去，
     * 推演里十四年下来天下还剩九到十家，压根谈不上鼎立。
     * 一家肯不肯低头，看的是对方整个的分量。
     */
    const power = new Map<string, number>();
    for (const n of Object.values(state.nodes)) {
      if (n.factionId === 'bandit') continue;
      power.set(n.factionId, (power.get(n.factionId) ?? 0) + n.troops);
    }
    const neighbours = new Set<string>();
    for (const n of theirs) {
      for (const to of idx.node.get(n.id)?.links ?? []) {
        const other = state.nodes[to];
        if (!other || other.factionId === w.id || other.factionId === 'bandit') continue;
        neighbours.add(other.factionId);
      }
    }
    const ranked = [...neighbours]
      .map((fid) => [fid, power.get(fid) ?? 0] as const)
      .filter(([fid, troops]) => {
        const att = state.factions[w.id]?.attitude[fid] ?? 0;
        return troops > w.troops * 1.5 && att > -70;
      })
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const to = ranked[0]?.[0];
    if (!to) continue;

    /**
     * 挨着的强邻里，最够格的那个正是玩家。
     *
     * 这时候**不自动划过去** —— 走那道「来附」的呈报，让他自己点头。
     * 少了这一段，天下一边并成三两家，玩家一边原地不动：
     * 推演里各家收到四五家的时候，玩家平均只剩两座城。
     * 兼并是天下的大势，玩家不该被这股势排除在外，
     * 只是他那一份要经过他的手。
     */
    if (state.role === 'lord' && to === state.official.lordId) {
      const court = state.court;
      if (!court || court.renown < RENOWN_FOR_SUBMIT) continue;
      if (court.memorials.length >= DESK_MAX) continue;
      if (court.memorials.some((m) => m.kind === 'submit' && m.aboutId === w.id)) continue;
      const envoy = (idx.byFaction.get(w.id) ?? [])[0];
      if (!envoy) continue;
      const m = shell(state, idx, 'submit', envoy, state.official.cityId, w.id, w.cities, {
        faction: idx.faction.get(w.id)?.name ?? w.id, cities: w.cities,
      });
      court.memorials.push(m);
      tally(court, 'raised');
      tally(court, 'raised.submit');
      events.push({ t: 'memorial_raised', kind: 'submit', personId: envoy.id, id: m.id });
      continue;
    }

    for (const n of theirs) {
      n.factionId = to;
      n.takenDay = state.day;
      // 归附不是打下来的，人心散得没那么厉害
      n.unrest = Math.min(60, n.unrest + 18);
      delete state.posts[n.id];
    }
    events.push({
      t: 'faction_absorbed', factionId: w.id, intoId: to, cities: theirs.length,
    });
    addDeed(state, 'deed.absorbed', {
      who: idx.faction.get(w.id)?.name ?? w.id,
      into: idx.faction.get(to)?.name ?? to,
    }, 'plain');
  }

  return events;
}

/** 天下还剩几家。鼎立与否看它 */
export function powersLeft(state: WorldState): string[] {
  const set = new Set<string>();
  for (const n of Object.values(state.nodes)) {
    if (n.factionId !== 'bandit') set.add(n.factionId);
  }
  return [...set].sort();
}

// ─────────────────────────────────────────────────────────────
// 盖棺论定
// ─────────────────────────────────────────────────────────────

/**
 * 大限到了。
 *
 * 不给「Victory / Defeat」，给**史书上的一段**。
 * 失败不是「游戏结束」，是「那一段写得不好看」——
 * 这一条比任何胜负判定都更让人想再来一局。
 */
export function settleDeath(state: WorldState, idx: ContentIndex): SimEvent[] {
  const court = state.court;
  if (!court || state.ending) return [];

  const held = heldNodes(state).length;
  const pillars = thronePillars(state, idx);
  const crowned = court.throne === 'claimed' || court.throne === 'forced';

  let kind: 'founded' | 'entrusted' | 'divided' | 'scattered';
  if (held === 0) {
    kind = 'scattered';
  } else if (crowned && held >= 4 && !court.reigns.some((r) => r.ending === 'founded')) {
    // **开国只有一次。** 之后再怎么传，那都是守成，不是开国
    kind = 'founded';
  } else if (crowned && held >= 3) {
    kind = 'entrusted';
  } else if (pillars.men >= 3 && held >= 3 && court.renown >= 45) {
    // 你没称帝，但你死时的安排立得住 —— 最「三国」的那个结局
    kind = 'entrusted';
  } else {
    kind = 'divided';
  }

  addDeed(state, 'deed.died', {
    name: court.lordName,
    age: court.age + Math.floor(
      (state.day - court.reigns.reduce((a, r) => Math.max(a, r.toDay), 0)) / DAYS_PER_YEAR,
    ),
  }, 'bad');

  /**
   * **地盘丢光才是真的完了。**
   *
   * 别的都不是 —— 曹操死了有曹丕，孙坚死了有孙策。
   * 一代人走了只是一次交接，而交接是要付账的（见 succession.ts）：
   * 望重新挣、心气一齐掉、有人不肯事二主。
   */
  if (kind === 'scattered') {
    state.ending = { kind, day: state.day };
    tally(court, 'end.' + kind);
    return [{ t: 'game_over', kind }];
  }
  return openMourning(state, idx, kind);
}

// ─────────────────────────────────────────────────────────────
// 批复的结算 —— 每一种呈报允了、压了、驳了各是什么后果
// ─────────────────────────────────────────────────────────────

export const HEART_BY_ANSWER: Record<Answer, number> = {
  allow: HEART_ALLOW,
  shelve: -HEART_SHELVE,
  deny: -HEART_DENY,
};

