/**
 * 朝堂到底活没活。
 *
 * 记忆里 `dead-mechanic-audit` 那一条：**胜率表正常不代表机制跑过。**
 * 这个工具不看平衡，只**数触发次数** —— 呈报发了几件、批了几件、
 * 有没有人自作主张、有没有人不再上报、四种结局是不是都有人拿到。
 *
 * 要盯的不是哪一档高，是**每一档都得有人拿到**：
 *   · 一百局里 0 次开国 → 这游戏不能赢
 *   · 一百局里 60 次开国 → 这游戏太好赢
 *   · 「不再上报」为 0   → 心气那一整套是死的
 *   · 「死于没时间了」为 0 → 寿数根本没在给压力
 *
 *   node tools/court.ts [局数]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import { thronePillars, powersLeft, reliefOffers } from '../src/sim/court.ts';
import { DAYS_PER_YEAR } from '../src/sim/time.ts';
import type { Answer } from '../src/sim/lord_types.ts';
import { idlePeople } from '../src/sim/handlers_lord.ts';
import { levyLook } from '../src/sim/handlers_court.ts';
import { campAt, campCap, freeOfficers } from '../src/sim/barracks.ts';
import { edictWeight, isDefiant } from '../src/sim/edict.ts';
import { KEEP_GARRISON } from '../src/sim/handlers_lord.ts';
import { planMarch } from '../src/sim/march.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'),
  terrain: read('terrain'), people: read('people'),
  // 漏了这一行，时局那一整层在推演里就是零次 —— 连带挟天子也验不到
  situations: read('situations'),
  text: read('text'),
} as ContentDB;
const idx = indexContent(content);

const LORDS = [
  'caocao', 'yuanshao', 'liubiao', 'taoqian', 'gongsunzan',
  'kongrong', 'liuyan', 'mateng', 'yuanshu', 'sunjian',
];

/**
 * 一个「寻常玩家」。
 *
 * 不是最优解，是一个会照常理办事的人：能允的都允，
 * 请援一定救，求去多半不放（人手总是不够），劝进辞一次再受。
 * 用它来跑，看的是**这条线在正常打法下长什么样**。
 */
function reply(e: Engine, kind: string, id: string): void {
  let a: Answer = 'allow';
  if (kind === 'leave') a = 'deny';
  if (kind === 'urge') {
    const c = e.getState().court!;
    a = c.declined >= 1 ? 'allow' : 'shelve';
  }
  /**
   * 请援：**先点将，再说「就这些」。**
   *
   * 这个「玩家」的规矩是「能到的都发」—— 挑两路最快的。
   * 少了这一段，`court_relief` 那条新路在推演里是零次，
   * 而「几路同时请缨」是这一版请援的全部意思。
   */
  if (kind === 'relief') {
    const st = e.getState();
    const m = st.court!.memorials.find((x) => x.id === id);
    if (m) {
      const offers = reliefOffers(st, idx, m.aboutId).filter((o) => !o.refused);
      for (const o of offers.slice(0, 2)) {
        e.dispatch({ t: 'court_relief', memorialId: id, sourceKey: o.key });
      }
    }
  }
  e.dispatch({ t: 'court_reply', memorialId: id, answer: a });
}

/**
 * 挨着的敌城若薄，就集结、然后打过去。
 *
 * **这个「玩家」故意做得保守**：非有两倍以上的优势不动手，
 * 动过一次就歇上大半年。
 * 头一版写成「有余兵就打」，三十局里十六局把自己打光了 ——
 * 那验的不是这条线好不好玩，是那个机器人蠢不蠢。
 */
function marchIfWorth(e: Engine, lordId: string, lastWar: { day: number }): void {
  const st = e.getState();
  if (st.day - lastWar.day < 200) return;
  const mine = Object.values(st.nodes).filter((n) => n.factionId === lordId);
  for (const src of mine.sort((a, b) => b.troops - a.troops)) {
    if (st.sieges[src.id]) continue;
    const spare = src.troops - 200;
    if (spare < 300) continue;
    for (const to of idx.node.get(src.id)?.links ?? []) {
      const foe = st.nodes[to];
      if (!foe || foe.factionId === lordId) continue;
      if (spare < foe.troops * 2.2) continue;
      e.dispatch({ t: 'lord_march', fromId: src.id, toId: to, troops: Math.floor(spare * 0.8) });
      lastWar.day = st.day;
      return;
    }
  }

  /**
   * 邻境没有可下之地，就**看看远处**。
   *
   * 这一段验的是远征那条路真的走得通（见 march.ts）：
   * 隔着一两个郡的一座薄城，借得到道就打得着。
   * 少了它，推演里 `march.far` 永远是零 —— 那条路等于没写。
   */
  /**
   * 只从**兵最多的那一座**去看远处，而且只看隔一两程的。
   *
   * 头一版对每一座自家城、每一座敌城都跑一遍 `planMarch` ——
   * 一轮上千次 Dijkstra，二十局跑了十分钟还没完。
   * 推演工具慢到跑不完，就等于没有推演工具。
   */
  for (const src of mine.sort((a, b) => b.troops - a.troops).slice(0, 2)) {
    if (st.sieges[src.id]) continue;
    const spare = src.troops - 200;
    if (spare < 500) continue;
    // 隔一程的那一圈：邻城的邻城
    const near2 = new Set<string>();
    for (const a of idx.node.get(src.id)?.links ?? []) {
      for (const b of idx.node.get(a)?.links ?? []) near2.add(b);
    }
    const far = [...near2].sort()
      .map((id) => st.nodes[id])
      .filter((n): n is NonNullable<typeof n> => !!n
        && n.factionId !== lordId && n.factionId !== 'bandit'
        && !(idx.node.get(src.id)?.links ?? []).includes(n.id))
      .sort((a, b) => a.troops - b.troops)
      .slice(0, 3)
      .map((n) => ({ n, p: planMarch(st, idx, src.id, n.id, lordId) }))
      .filter((x) => x.p && !x.p.refused && x.p.path.length <= 4)[0];
    if (!far) continue;
    // 远征折损大，门槛也得高
    if (spare < far.n.troops * 3) continue;
    e.dispatch({
      t: 'lord_march', fromId: src.id, toId: far.n.id, troops: Math.floor(spare * 0.8),
    });
    lastWar.day = st.day;
    return;
  }
}

/**
 * 立营、拨兵、有把握就从营出击。
 *
 * 这个「玩家」的规矩：治所之外挑一座粮多的城立营，
 * 城里的余兵往营里拨，营满了或者练熟了就找隔壁最薄的一处打。
 */
function tendCamps(e: Engine, lordId: string): void {
  const st = e.getState();
  const mine = Object.values(st.nodes).filter((n) => n.factionId === lordId);

  // 一、没营就立一座。**三座城才养得起一座营** —— 别一上来就把家底压进去
  if (Object.keys(st.court!.camps).length < Math.max(1, Math.floor(mine.length / 3))) {
    const officers = freeOfficers(st, idx);
    const spot = mine
      .filter((n) => !campAt(st, n.id) && !st.sieges[n.id])
      .sort((a, b) => b.grain - a.grain)[0];
    if (spot && officers[0]) {
      e.dispatch({ t: 'lord_camp_open', cityId: spot.id, personId: officers[0] });
    }
  }

  // 二、往营里拨兵，但城里要留够看家的
  for (const camp of Object.values(e.getState().court!.camps)) {
    const node = e.getState().nodes[camp.cityId];
    if (!node) continue;
    /**
     * 往营里拨兵，**城里要留厚**。
     *
     * 头一版只留到 `KEEP_GARRISON + 150`，于是各城常年只剩两百多人 ——
     * 四十局里二十六局被人一口气吃光。营是拿来打的，不是拿来搬家的。
     */
    const spare = node.troops - KEEP_GARRISON - 320;
    if (spare > 250 && camp.troops < campCap(e.getState(), camp)) {
      e.dispatch({ t: 'lord_draft', campId: camp.id, men: Math.min(300, spare) });
    }
  }

  // 三、练熟了就打隔壁最薄的一处
  for (const camp of Object.values(e.getState().court!.camps)) {
    if (camp.troops < 500 || camp.drill < 50) continue;
    const foes = (idx.node.get(camp.cityId)?.links ?? [])
      .map((id) => e.getState().nodes[id])
      .filter((n) => n && n.factionId !== lordId)
      .sort((a, b) => a!.troops - b!.troops);
    const target = foes[0];
    /**
     * 非有压倒性优势不出击。
     *
     * 头一版的门槛写成一点二三倍，等于「势均力敌就上」——
     * 围城本来就要两倍以上才拿得下，于是这个机器人把练了半年的营
     * 一次次送掉，四十局里二十五局全灭。那验的不是军营顶不顶事，
     * 是这个机器人蠢不蠢。
     */
    const power = camp.troops * (1 + camp.drill / 333);
    if (target && power >= target.troops * 2.0) {
      e.dispatch({
        t: 'lord_camp_march', campId: camp.id, toId: target.id,
        men: Math.floor(camp.troops * 0.85),
      });
    }
  }
}

/** 给挨着的敌国下诏 —— 从了赚一笔，不从就立个名目 */
function useEdicts(e: Engine, lordId: string): void {
  const st = e.getState();
  if (!st.court!.emperor || edictWeight(st) <= 0) return;
  const near = new Set<string>();
  for (const n of Object.values(st.nodes)) {
    if (n.factionId !== lordId) continue;
    for (const to of idx.node.get(n.id)?.links ?? []) {
      const o = st.nodes[to];
      if (o && o.factionId !== lordId && o.factionId !== 'bandit') near.add(o.factionId);
    }
  }
  /**
   * **一次只立一个名目。**
   *
   * 头一版挨家下「让地」，六十六道诏下去五十九家抗诏 ——
   * 等于把每一个邻居都得罪了一遍（抗诏还要再掉十六点态度）。
   * 名目是拿来打一家的，不是拿来跟天下结仇的。
   */
  if (st.court!.defiant.some((f) => near.has(f))) return;
  for (const f of [...near].sort()) {
    if (isDefiant(st, f)) continue;
    // 先讨一笔粮；讨不到就立个名目
    e.dispatch({ t: 'lord_edict', to: f, kind: 'tribute' });
    if (!isDefiant(e.getState(), f) && edictWeight(e.getState()) > 0) {
      e.dispatch({ t: 'lord_edict', to: f, kind: 'yield' });
    }
    return;
  }
}

interface Run {
  lord: string;
  end: string;
  years: number;
  held: number;
  powers: number;
  pillars: { land: number; name: number; men: number };
  tally: Record<string, number>;
  /** 三根柱子齐了两根，第三根没齐就死了 —— 「死于没时间了」 */
  ranOut: boolean;
  /** 传了几代，历代各是什么收场 */
  reigns: string[];
}

function play(seed: string, lordId: string): Run {
  const e = new Engine(seed, content);
  e.dispatch({ t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId, role: 'lord' });
  const lastWar = { day: -999 };

  /**
   * 一局要跑多少轮。
   *
   * 这个数从九百提到两千五 —— **国祚改制之后一局会传好几代**
   * （见 succession.ts），九百轮连第一位主公的大限都走不到，
   * 三十局里十七局跑不完，继位那一整层在推演里是零次。
   */
  for (let round = 0; round < 2500; round++) {
    const st = e.getState();
    if (st.ending) break;
    /**
     * 国祚改制之后一局会传好几代，理论上可以一直传下去 ——
     * 推演得有个头。**六十年**：够看三四代，也够看出这一家立不立得住。
     */
    if (st.day > 60 * DAYS_PER_YEAR) break;

    // 有空城就派人。主公总得有人替他守着
    const bare = Object.values(st.nodes)
      .filter((n) => n.factionId === lordId && !st.posts[n.id]);
    const free = idlePeople(st, idx);
    for (let i = 0; i < Math.min(bare.length, free.length); i++) {
      e.dispatch({ t: 'lord_appoint', cityId: bare[i]!.id, personId: free[i]! });
    }

    /**
     * 大丧。**先主没了不等于这一局完了** —— 接着继位（见 succession.ts）。
     * 少了这一段，推演跑到第一位主公咽气就卡在那儿：
     * `cmdDay` 从此一律回 `in_mourning`，日子再也不走，
     * 而那一局在表上显示成「没跑完」—— 一条很难看出来的死路。
     */
    if (e.getState().court!.mourning) {
      e.dispatch({ t: 'court_succeed' });
      continue;
    }

    // 案上的事，一件件批
    const desk = [...e.getState().court!.memorials];
    for (const m of desk) reply(e, m.kind, m.id);

    /**
     * 表态。
     *
     * 少了这一段，`lapseSituation` 会替他挑**最不出格**的那一项，
     * 于是「奉迎天子」永远轮不到 —— 挟天子那一整层在推演里是零次。
     * 这个「玩家」的性子：能结盟的结盟，天子来了就迎，衣带诏一概不问。
     */
    const sit = e.getState().court!.situation;
    if (sit && !sit.mine) {
      const def = idx.db.situations?.find((d) => d.id === sit.id);
      /**
       * 掂量着答。
       *
       * 头一版一味挑望最高的那一项，于是它把粮全花在名声上 ——
       * 大饥开仓、迎天子、迎公卿一路花下去，四十局里十七局饿垮。
       * **名声要挣，饭也得吃。** 手上宽裕才做面子上的事。
       */
      const rich = Object.values(e.getState().nodes)
        .filter((n) => n.factionId === lordId)
        .reduce((a, n) => a + n.grain, 0);
      const afford = (o: { effect: { grain?: number } }): boolean =>
        rich + (o.effect.grain ?? 0) * 2 > 2500;
      const pick = def?.options.find((o) => o.effect.blocAgainst && afford(o))
        ?? def?.options.find((o) => (o.effect.renown ?? 0) > 6 && afford(o))
        ?? def?.options.find((o) => (o.effect.grain ?? 0) >= 0)
        ?? def?.options[0];
      if (pick) e.dispatch({ t: 'situation_answer', option: pick.id });
      e.dispatch({ t: 'situation_close' });
    }
    if (e.getState().court!.plotWho) {
      e.dispatch({ t: 'lord_plot', how: 'ignore' });
    }

    /**
     * 主公自己那两个动词。
     *
     * 案头是他的心跳，但**征调和发兵仍然是他自己发起的** ——
     * 呈报是别人替你想到的事，征调是你自己想打。
     * 少了这一段，推演里的「玩家」只会等着别人请战，
     * 而那不是一个玩家会有的样子。
     */
    /**
     * 募兵。**粮是拿来变成兵的。**
     * 早先这个机器人只会挪已有的兵，于是它的曲线和玩家一样卡在硬顶上 ——
     * 那验不出这条线到底有没有出路。
     */
    for (const n of Object.values(e.getState().nodes)) {
      if (n.factionId !== lordId) continue;
      const lv = levyLook(e.getState(), idx, n.id);
      // 民心留一手，别把城募垮了
      if (lv.men > 0 && n.morale > 45) e.dispatch({ t: 'lord_levy', cityId: n.id });
    }

    /**
     * 军营。**城里的兵守家，营里的兵野战。**
     * 机器人也得会用这一层，否则验不出它到底顶不顶事。
     */
    tendCamps(e, lordId);

    /**
     * 下诏。
     *
     * **迎了天子却不下诏，等于只付代价不拿好处** ——
     * 供养要粮、忠汉的人要凉，而那根唯一能让进攻涨望的杠杆搁着不用。
     * 这个「玩家」的用法很直白：给挨着自己的那家下一道「让地」——
     * 几乎没人会从，但不从的那一家从此背着一个「逆」字。
     */
    useEdicts(e, lordId);

    marchIfWorth(e, lordId, lastWar);

    // 散朝。天下自己走到下一件事
    const r = e.dispatch({ t: 'court_adjourn' });
    if (r.length === 0) break;
  }

  const st = e.getState();
  const court = st.court!;
  const p = thronePillars(st, idx);
  const two = [p.land >= 8, p.name >= 58, p.men >= 4].filter(Boolean).length;
  return {
    lord: lordId,
    end: st.ending?.kind ?? '未终',
    years: Math.floor(st.day / DAYS_PER_YEAR),
    held: Object.values(st.nodes).filter((n) => n.factionId === lordId).length,
    powers: powersLeft(st).length,
    pillars: { land: p.land, name: p.name, men: p.men },
    tally: court.tally,
    ranOut: two === 2 && st.ending?.kind !== 'founded',
    reigns: court.reigns.map((r) => r.ending),
  };
}

// ─────────────────────────────────────────────────────────────

const games = Number(process.argv[2] ?? 60);
const runs: Run[] = [];
for (let i = 0; i < games; i++) {
  runs.push(play('court-' + i, LORDS[i % LORDS.length]!));
}

const sum = (k: string): number => runs.reduce((a, r) => a + (r.tally[k] ?? 0), 0);
const count = (fn: (r: Run) => boolean): number => runs.filter(fn).length;
const avg = (fn: (r: Run) => number): string =>
  (runs.reduce((a, r) => a + fn(r), 0) / runs.length).toFixed(1);

console.log(`\n═══ 朝堂推演 · ${games} 局 ═══\n`);

console.log('结局分布');
for (const [kind, label] of [
  ['founded', '开国'], ['entrusted', '托孤'],
  ['divided', '身死业分'], ['scattered', '无人肯为之死'], ['未终', '没跑完'],
] as const) {
  const n = count((r) => r.end === kind);
  const bar = '█'.repeat(Math.round((n / games) * 40));
  console.log(`  ${label.padEnd(7, '　')} ${String(n).padStart(3)}  ${bar}`);
}

console.log('\n国祚 —— 主公死了不等于这一局完了');
{
  const gens = runs.map((r) => r.reigns.length + 1);
  console.log(`  平均传          ${(gens.reduce((a, b) => a + b, 0) / runs.length).toFixed(1)} 代`);
  console.log(`  最长            ${Math.max(...gens)} 代`);
  for (const [k, label] of [
    ['founded', '开国'], ['entrusted', '托孤'], ['divided', '身死业分'],
  ] as const) {
    const n = runs.reduce((a, r) => a + r.reigns.filter((x) => x === k).length, 0);
    console.log(`  其中某代收在 ${label.padEnd(5, '　')} ${String(n).padStart(4)} 次`);
  }
  console.log(`  继位            ${String(sum('succeed')).padStart(4)} 次`
    + `，不肯事二主而去 ${sum('succeed.left')} 人`);
  console.log(`  无人肯继        ${String(sum('end.noheir')).padStart(4)} 局`);
}

console.log('\n案头');
console.log(`  呈报发出        ${String(sum('raised')).padStart(5)}`);
console.log(`    允            ${String(sum('answer.allow')).padStart(5)}`);
console.log(`    留中          ${String(sum('answer.shelve')).padStart(5)}`);
console.log(`    不许          ${String(sum('answer.deny')).padStart(5)}`);
console.log(`    过期未理      ${String(sum('expired')).padStart(5)}`);
for (const k of [
  'war', 'relief', 'recommend', 'leave', 'submit', 'urge', 'vacancy', 'merit', 'dispatch',
]) {
  console.log(`  其中 ${k.padEnd(10)} ${String(sum('raised.' + k)).padStart(5)}`);
}

console.log('\n太仓');
console.log(`  上计            ${String(sum('tribute.times')).padStart(5)} 次`
  + `，共解粮 ${sum('tribute')} 石`);
console.log(`  无人主事而未上  ${String(sum('tribute.bare')).padStart(5)} 城次`);
console.log(`  郡府自发粮车    ${String(sum('convoy')).padStart(5)} 趟`);

console.log('\n考课');
console.log(`  升              ${String(sum('rank.up')).padStart(5)} 次`);
console.log(`  贬              ${String(sum('rank.down')).padStart(5)} 次`);
console.log(`  免官            ${String(sum('rank.dismiss')).padStart(5)} 次`);

console.log('\n远征');
console.log(`  隔郡出兵        ${String(sum('march.far')).padStart(5)} 次`);
console.log(`  其中要借道      ${String(sum('march.borrow')).padStart(5)} 次`);
console.log(`  请缨赴援        ${String(sum('relief.force')).padStart(5)} 路`);

console.log('\n兵');
console.log(`  募兵            ${String(sum('levy')).padStart(5)} 次`);
console.log(`  立营            ${String(sum('camp')).padStart(5)} 座`);
console.log(`  营出兵          ${String(sum('camp.march')).padStart(5)} 次`);
console.log(`  营将自募        ${String(sum('camp.grow')).padStart(5)} 次`);

console.log('\n名分');
console.log(`  迎天子          ${String(sum('emperor')).padStart(5)} 局`);
console.log(`  下诏            ${String(sum('edict')).padStart(5)} 道`
  + `（奉 ${sum('edict.obeyed')}／抗 ${sum('edict.defied')}）`);
console.log(`  衣带诏发作      ${
  String(sum('plot.kill') + sum('plot.probe') + sum('plot.ignore')).padStart(5)} 次`);

console.log('\n驿传');
console.log(`  发出一骑        ${String(sum('courier')).padStart(5)} 次`);
console.log(`  被截            ${String(sum('courier.lost')).padStart(5)} 次`
  + '   ← 0 就是「会被截」这条从没生效');
console.log(`  修驿            ${String(sum('road')).padStart(5)} 段`);

console.log('\n人');
console.log(`  自作主张        ${String(sum('defied')).padStart(5)} 次`);
console.log(`  「不再上报」    ${String(sum('silent')).padStart(5)} 人`);
console.log(`  辞去            ${String(sum('left')).padStart(5)} 人`);
console.log(`  不告而别        ${String(sum('defected')).padStart(5)} 人`);
console.log(`  举荐入帐        ${String(sum('enlisted')).padStart(5)} 人`);

console.log('\n礼数 —— 心气看得见的地方');
for (const [k, label] of [
  ['bow_deep', '深揖'], ['bow', '抱拳'], ['stoop', '躬身'],
  ['nod', '颔首'], ['turn_away', '转身就走'], ['silent', '无言'],
] as const) {
  console.log(`  ${label.padEnd(5, '　')} ${String(sum('react.' + k)).padStart(5)}`);
}

console.log('\n尊号');
console.log(`  劝进 · 受       ${String(sum('urge.claimed')).padStart(5)}`);
console.log(`  劝进 · 辞       ${String(sum('urge.declined')).padStart(5)}`);
console.log(`  劝进 · 斥       ${String(sum('urge.refused')).padStart(5)}`);
console.log(`  不待劝进自立    ${String(sum('forced')).padStart(5)}`);

console.log('\n天下');
console.log(`  平均寿终        第 ${avg((r) => r.years)} 年`);
console.log(`  终局尚存势力    ${avg((r) => r.powers)} 家`);
console.log(`  终局据城        ${avg((r) => r.held)} 座`);
console.log(`  举州来附        ${String(sum('submitted')).padStart(5)} 次`);
console.log(`  死于「没时间了」${String(count((r) => r.ranOut)).padStart(5)} 局`);

console.log('\n三根柱子（终局时）');
console.log(`  土 名都之分     ${avg((r) => r.pillars.land)}　（要 8）`);
console.log(`  名 望           ${avg((r) => r.pillars.name)}　（要 58）`);
console.log(`  人 肯说话的     ${avg((r) => r.pillars.men)}　（要 4）`);

console.log('\n鼎立与否 —— 终局天下剩几家');
const dist = new Map<number, number>();
for (const r of runs) dist.set(r.powers, (dist.get(r.powers) ?? 0) + 1);
for (const n of [...dist.keys()].sort((a, b) => a - b)) {
  console.log(`  ${String(n).padStart(2)} 家   ${'█'.repeat(dist.get(n)!)}`);
}

console.log('\n各家');
for (const l of LORDS) {
  const mine = runs.filter((r) => r.lord === l);
  if (mine.length === 0) continue;
  const good = mine.filter((r) => r.end === 'founded' || r.end === 'entrusted').length;
  console.log(`  ${(idx.faction.get(l)?.name ?? l).padEnd(4, '　')} ${mine.length} 局，`
    + `善终 ${good}，平均 ${(mine.reduce((a, r) => a + r.held, 0) / mine.length).toFixed(1)} 城`);
}
console.log('');
