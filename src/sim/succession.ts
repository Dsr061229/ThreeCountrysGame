/**
 * 继位 —— 一代人走了，这一局还没完。
 *
 * ── 为什么「主公死了」不该等于「游戏结束」 ──────────
 *
 * 上一版主公一咽气，屏幕上就是一张结局卡。而那不是三国的样子：
 * 曹操死了有曹丕，孙坚死了有孙策、孙权，刘备死了有诸葛亮扶着刘禅。
 * **那一段恰恰是这段历史最好看的地方** —— 老臣认不认新主、
 * 打了半辈子的地盘守不守得住、父亲没做成的事儿子做不做得成。
 *
 * 所以死改成了一次**交接**。而交接是有代价的，三样：
 *
 *   **一、望要重新挣。** 天下人认的是那个死了的人，不是你。
 *        「关东多归之」一夜之间变回「人未深知」。
 *
 *   **二、心气一齐往下掉。** 他们跟的是先主。
 *
 *   **三、有人索性就走。** 不肯事二主 —— 而走的是本来就心气低的那些。
 *
 * 于是「你这一辈子怎么待人」在这一刻**第二次结账**：
 * 待人厚的，接得住；待人薄的，父死而国分。
 * 这条线上所有的东西最后都会流回人心，这是对的。
 *
 * ── 真正的输只剩一条 ────────────────────────────────
 *
 * **地盘丢光。** 那才叫国破（见 `checkLordEnding`）。
 * 另有一条走不下去的：还有地，但帐下没有一个人肯接这副担子 ——
 * 那一局收在「身死业分」上，而那是他自己一辈子攒出来的结果。
 */
import { nextInt, nextRange } from './rng.ts';
import type { ContentIndex, PersonDef } from './content.ts';
import type { WorldState } from './state.ts';
import type { Command, CommandResult, SimEvent } from './commands.ts';
import { DAYS_PER_YEAR } from './time.ts';
import { addDeed, heartOf, ownPeople, tally } from './court.ts';
import { rankName } from './tribute.ts';
import {
  HEIR_HEART_KEEP, HEIR_LEAVE_CAP, HEIR_LEAVE_UNDER, HEIR_MIN_HEART,
  HEIR_RENOWN_BASE, HEIR_RENOWN_KEEP,
  type Reign,
} from './lord_types.ts';

function ok(...events: SimEvent[]): CommandResult {
  return { ok: true, events };
}
function reject(cmd: Command['t'], reasonId: string): CommandResult {
  return { ok: false, events: [{ t: 'rejected', cmd, reasonId }] };
}

/**
 * 谁接得了这副担子。
 *
 * **挑的是心气，不是本事。** 一个才略过人却早就跟你离心的人，
 * 先主一死他想的是自立，不是守成 —— 白帝城托孤托的是那个
 * 「臣敢竭股肱之力，效忠贞之节，继之以死」的人。
 *
 * 心气够了，才轮到看他的分量（智略、统率、品秩）。
 */
export function heirOf(state: WorldState, idx: ContentIndex): PersonDef | null {
  const court = state.court;
  if (!court) return null;
  const pool = ownPeople(state, idx)
    .filter((p) => p.id !== court.lordPersonId)
    .filter((p) => court.silent[p.id] === undefined)
    .filter((p) => heartOf(state, p.id) >= HEIR_MIN_HEART);
  if (pool.length === 0) return null;

  const weight = (p: PersonDef): number =>
    heartOf(state, p.id) * 2 + p.wit + p.command
    + (court.rank[p.id] ?? 0) * 20
    + (p.good.includes('谋断') ? 15 : 0);
  return pool.slice().sort((a, b) => weight(b) - weight(a) || a.id.localeCompare(b.id))[0] ?? null;
}

/**
 * 大丧。
 *
 * **这里只把日子停住，不改任何东西。** 交接真正发生在
 * 玩家按下「继位」那一下（见 `cmdSucceed`）——
 * 中间那一屏是留给他看完先主一生的，不该在他没看的时候就把账结了。
 */
export function openMourning(
  state: WorldState, idx: ContentIndex,
  kind: 'founded' | 'entrusted' | 'divided',
): SimEvent[] {
  const court = state.court!;
  const heir = heirOf(state, idx);
  if (!heir) {
    // 还有地，却没有一个人肯接 —— 这一局就收在这儿了
    state.ending = { kind: 'divided', day: state.day };
    tally(court, 'end.divided');
    tally(court, 'end.noheir');
    return [{ t: 'game_over', kind: 'divided' }];
  }
  court.mourning = { deadName: court.lordName, ending: kind, heirId: heir.id };
  tally(court, 'reign.' + kind);
  return [{
    // **不要叫 lord_died** —— 那个名字天下那边早就在用了（别家诸侯病故）。
    // 撞名的后果很隐蔽：谁都不报错，但监听那个事件的人分不清是谁死了。
    t: 'court_mourning', name: court.lordName, ending: kind,
    heirId: heir.id, heirName: heir.name,
  }];
}

/**
 * 继位。
 *
 * 三样代价一齐兑现 —— 望打折、心气打折、心气本来就低的人走。
 * 这是「你这一辈子怎么待人」的第二次结账。
 */
export function cmdSucceed(
  state: WorldState, idx: ContentIndex,
): CommandResult {
  if (state.role !== 'lord') return reject('court_succeed', 'not_lord');
  const court = state.court;
  if (!court || !court.mourning) return reject('court_succeed', 'no_mourning');
  const heir = idx.person.get(court.mourning.heirId);
  if (!heir) return reject('court_succeed', 'no_heir');

  const held = Object.values(state.nodes)
    .filter((n) => n.factionId === state.official.lordId).length;

  // 一、先把这一代记进史书
  const reign: Reign = {
    name: court.lordName,
    fromDay: court.reigns.reduce((a, r) => Math.max(a, r.toDay), 0),
    toDay: state.day,
    age: court.age + Math.floor((state.day - court.reigns.reduce(
      (a, r) => Math.max(a, r.toDay), 0,
    )) / DAYS_PER_YEAR),
    ending: court.mourning.ending,
    cities: held,
    renown: court.renown,
  };
  court.reigns.push(reign);
  court.reign += 1;

  // 二、新主。他从此不再是帐下的人 —— 位子空了出来，案头会有人来报
  const title = rankName(state, heir);
  for (const [city, pid] of Object.entries(state.posts)) {
    if (pid === heir.id) delete state.posts[city];
  }
  for (const [cid, camp] of Object.entries(court.camps)) {
    if (camp.officerId === heir.id) {
      const node = state.nodes[camp.cityId];
      if (node) node.troops += camp.troops;
      delete court.camps[cid];
    }
  }
  court.lordName = heir.name;
  court.lordPersonId = heir.id;
  court.age = 20 + nextInt(state.rng, 18);
  // 新主自己的寿数，仍然是暗的
  court.span = state.day + nextRange(state.rng, 9 * DAYS_PER_YEAR, 34 * DAYS_PER_YEAR);

  /**
   * 三、望要重新挣。
   *
   * **天下人认的是那个死了的人，不是你。**
   * 「关东多归之」一夜之间变回「人未深知」—— 这是继位最疼的一下，
   * 因为望是招人、来附、劝进三样东西共同的源头。
   */
  court.renown = Math.round(court.renown * HEIR_RENOWN_KEEP + HEIR_RENOWN_BASE);

  // 四、心气一齐掉；掉到底的人不肯事二主
  const leaving: string[] = [];
  for (const p of ownPeople(state, idx)) {
    if (p.id === heir.id) continue;
    const was = heartOf(state, p.id);
    const now = Math.round(was * HEIR_HEART_KEEP);
    court.heart[p.id] = now;
    if (now < HEIR_LEAVE_UNDER) leaving.push(p.id);
  }
  // 一次最多走掉四成。全走光那不叫交接，那叫断头
  const room = Math.floor(ownPeople(state, idx).length * HEIR_LEAVE_CAP);
  leaving.sort((a, b) => (court.heart[a] ?? 0) - (court.heart[b] ?? 0));
  const gone = leaving.slice(0, Math.max(0, room));
  for (const id of gone) {
    court.gone.push(id);
    delete court.silent[id];
    for (const [city, pid] of Object.entries(state.posts)) {
      if (pid === id) delete state.posts[city];
    }
    for (const [cid, camp] of Object.entries(court.camps)) {
      if (camp.officerId === id) {
        const node = state.nodes[camp.cityId];
        if (node) node.troops += camp.troops;
        delete court.camps[cid];
      }
    }
  }

  // 五、案头重新开张
  court.mourning = null;
  court.memorials = [];
  court.onStage = null;
  court.nextDay = state.day + 12;
  court.marchedDay = -9999;
  court.urgedDay = -1;
  // 辞让过的那几回是先主的事，新主从头算
  if (court.throne === 'declined') court.throne = 'none';
  court.declined = 0;

  addDeed(state, 'deed.succeed', {
    dead: reign.name, name: heir.name, title,
    left: gone.length,
  }, gone.length > 2 ? 'bad' : 'plain');
  tally(court, 'succeed');
  tally(court, 'succeed.left', gone.length);

  return ok(
    {
      t: 'lord_succeeded',
      name: heir.name, reign: court.reign, left: gone.length,
      renown: court.renown,
    },
    ...gone.map((id): SimEvent => ({
      // 不告而别 —— 不肯事二主的人不会来递辞呈
      t: 'person_left', personId: id, name: idx.person.get(id)?.name ?? '', defected: true,
    })),
  );
}
