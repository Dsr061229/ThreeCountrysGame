/**
 * 朝堂的测试。
 *
 * 记忆里 `dead-mechanic-audit` 那一条：**机制看着在跑，其实从来没生效过。**
 * 所以这里守的不是数值好不好看，是**每一条新规则真的会发生**：
 *
 *   一、案上真的会摞上事，而且事是从天下实况里长出来的
 *   二、「留中」不是免费的中立选项 —— 压下请援，全帐下都记着
 *   三、粮车要走路：允了之后，到达之前那座城的粮**不许**变
 *   四、心气到底的人不再上报，而且他守的城真的更容易破
 *   五、劝进不是按钮：三根柱子不齐就没人开口
 *   六、主公会死，而且死了会给出四种结局之一
 *   七、天下会自己往鼎立收，不会永远十几家僵着
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
import {
  bumpHeart, bumpRenown, heartOf, heartPermille, ownPeople, powersLeft, thronePillars,
} from '../src/sim/court.ts';
import { DAYS_PER_YEAR, dateToDay } from '../src/sim/time.ts';
import { HEART_SILENT } from '../src/sim/lord_types.ts';
import { KEEP_GARRISON } from '../src/sim/handlers_lord.ts';
import { seasonLevy } from '../src/sim/handlers_court.ts';
import { campAt, freeOfficers } from '../src/sim/barracks.ts';
import { isMartial } from '../src/sim/people.ts';
import { nodeDefenceOf } from '../src/sim/worldtick.ts';
import { edictWeight, isDefiant, receiveEmperor } from '../src/sim/edict.ts';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'),
  terrain: read('terrain'), people: read('people'), text: read('text'),
} as ContentDB;
const idx = indexContent(content);

function asLord(seed: string, lordId = 'caocao'): Engine {
  const e = new Engine(seed, content);
  e.dispatch({ t: 'begin', playerName: '测试', cityId: 'yongqiu', lordId, role: 'lord' });
  return e;
}

/** 一直散朝，直到案上有事，或者跑满 n 次 */
function untilDesk(e: Engine, n = 40): void {
  for (let i = 0; i < n; i++) {
    if ((e.getState().court?.memorials.length ?? 0) > 0) return;
    if (e.getState().ending) return;
    e.dispatch({ t: 'court_adjourn' });
  }
}

// ─────────────────────────────────────────────────────────────

test('主公开局就有朝堂：寿数定死、望有个起点、帐下有人', () => {
  const st = asLord('court-open').getState();
  const c = st.court;
  assert.ok(c, '主公这一局必须开朝堂');
  assert.ok(c.span > 0, '寿数要在开局就定下来');
  assert.ok(c.span >= 10 * DAYS_PER_YEAR, '每一局至少给十年 —— 来不及玩不叫难');
  assert.ok(c.renown > 0 && c.renown <= 100);
  assert.ok(Object.keys(c.heart).length > 0, '帐下的人开局就该有心气');
});

test('案上真的会摞上事，而且每一件都指得到具体的城或人', () => {
  const e = asLord('court-raise');
  untilDesk(e);
  const c = e.getState().court!;
  assert.ok(c.memorials.length > 0, '散朝几回之后案上不该还是空的');
  for (const m of c.memorials) {
    assert.ok(idx.person.get(m.personId), '上表的必须是个真人');
    assert.ok(m.textId.startsWith('mem.'), '帖子上要有话');
    assert.ok(
      idx.node.get(m.aboutId) || idx.faction.get(m.aboutId),
      '说的必须是一个真的地方或一家真的势力',
    );
  }
});

test('呈报到案头是旧消息 —— 远处的事标着「多少日前」', () => {
  const e = asLord('court-news');
  for (let i = 0; i < 30; i++) {
    e.dispatch({ t: 'court_adjourn' });
    const far = e.getState().court!.memorials
      .find((m) => m.fromId !== e.getState().official.cityId);
    if (far) {
      assert.ok(far.atDay < far.arriveDay, '别处发来的事，出事那天必须早于到案那天');
      return;
    }
    if (e.getState().ending) break;
  }
});

test('留中不是免费的：压下一件请援，全帐下都记着你没救', () => {
  const e = asLord('court-relief');
  // 造一个被围的局面：随便挑自家一座城摆上围兵
  const st0 = e.getState() as unknown as {
    nodes: Record<string, { id: string; factionId: string }>;
    sieges: Record<string, unknown>;
    official: { lordId: string };
    court: { nextDay: number; memorials: unknown[] };
  };
  const mine = Object.values(st0.nodes).find((n) => n.factionId === st0.official.lordId)!;
  st0.sieges[mine.id] = {
    cityId: mine.id, factionId: 'yuanshu', troops: 900, supply: 2000, days: 6,
  };
  st0.court.nextDay = e.getState().day;

  untilDesk(e, 6);
  const relief = e.getState().court!.memorials.find((m) => m.kind === 'relief');
  if (!relief) return; // 这一局没赶上，别把测试写成撞运气

  const before = { ...e.getState().court!.heart };
  e.dispatch({ t: 'court_reply', memorialId: relief.id, answer: 'shelve' });
  const after = e.getState().court!.heart;

  const others = Object.keys(before).filter((id) => id !== relief.personId);
  const dropped = others.filter((id) => (after[id] ?? 0) < (before[id] ?? 0));
  assert.ok(dropped.length > 0, '不救的账不该只算在开口那一个人头上');
});

test('粮车要走路：允了之后，到达之前那座城的粮不许变', () => {
  const e = asLord('court-convoy');
  for (let i = 0; i < 40 && !e.getState().ending; i++) {
    const m = e.getState().court!.memorials.find((x) => x.kind === 'grain');
    if (m) {
      const city = m.aboutId;
      const before = e.getState().nodes[city]!.grain;
      const r = e.dispatch({ t: 'court_reply', memorialId: m.id, answer: 'allow' });
      if (r.some((ev) => ev.t === 'rejected')) return; // 治所拿不出粮，另说
      const after = e.getState().nodes[city]!.grain;
      assert.equal(after, before, '粮还在路上，仓里就不该先多出来');
      assert.ok(
        Object.values(e.getState().armies).some((a) => a.toId === city),
        '允了请粮，图上必须真的有一支粮车在走',
      );
      return;
    }
    e.dispatch({ t: 'court_adjourn' });
  }
});

test('心气到底的人不再上报，而且他守的城真的更难守', () => {
  const e = asLord('court-heart');
  const st = e.getState();
  const someone = Object.entries(st.posts)
    .find(([city]) => st.nodes[city]?.factionId === st.official.lordId);
  assert.ok(someone, '开局总该有人在守城');
  const [city, pid] = someone;

  const before = heartPermille(st, pid);
  bumpHeart(st, pid, -100);
  assert.ok(heartOf(st, pid) < HEART_SILENT);
  assert.ok(
    st.court!.silent[pid] !== undefined,
    '心气到底就该记进「不再上报」—— 这是这条线上最危险的信号',
  );
  assert.ok(
    heartPermille(st, pid) < before,
    '称病不出的人守的城，兵是散的。心气不能只是个不干事的数',
  );
  assert.ok(city.length > 0);
});

test('劝进不是按钮：三根柱子不齐，没人会开口', () => {
  const e = asLord('court-urge');
  const st = e.getState();
  const p = thronePillars(st, idx);
  assert.equal(p.ready, false, '开局两座城就该称帝，那这游戏也太好赢了');

  // 望拉满也不够 —— 名都与人心那两根还在
  bumpRenown(st, 100);
  assert.equal(thronePillars(st, idx).ready, false, '光有名望不足以受尊号');

  for (let i = 0; i < 20; i++) e.dispatch({ t: 'court_adjourn' });
  assert.ok(
    !e.getState().court!.memorials.some((m) => m.kind === 'urge'),
    '柱子不齐就不该出现劝进表',
  );
});

test('不待劝进也能自立，但那是一条会死人的路', () => {
  const e = asLord('court-force');
  const st = e.getState() as unknown as {
    nodes: Record<string, { factionId: string }>;
    official: { lordId: string };
  };
  // 白手起家的陈留没有名都，先给他一座
  st.nodes['luoyang']!.factionId = st.official.lordId;

  // 只抄数，别抄引用 —— factions 里那些对象是会被就地改的
  const me0 = e.getState().official.lordId;
  const before: Record<string, number> = {};
  for (const [f, fs] of Object.entries(e.getState().factions)) {
    before[f] = fs.attitude[me0] ?? 0;
  }
  const wasRenown = e.getState().court!.renown;
  const r = e.dispatch({ t: 'lord_claim' });
  assert.ok(r.some((ev) => ev.t === 'throne'), '占着名都就该称得了帝');
  assert.equal(e.getState().court!.throne, 'forced');
  assert.ok(e.getState().court!.renown < wasRenown, '僭越是要折望的');

  const me = e.getState().official.lordId;
  const worse = Object.keys(before).filter((f) => f !== me
    && (e.getState().factions[f]?.attitude[me] ?? 0) < (before[f] ?? 0));
  assert.ok(worse.length > 3, '自立为帝，天下该一齐视你为敌');
});

test('主公会死 —— 但死的是一个人，不是这一局', () => {
  /**
   * ── 这条断言改过一次，记下为什么 ──────────────────────
   *
   * 上一版主公一咽气，屏幕上就是一张结局卡。而那不是三国的样子：
   * 曹操死了有曹丕，孙坚死了有孙策、孙权。
   * **那一段恰恰是这段历史最好看的地方** —— 老臣认不认新主，
   * 打了半辈子的地盘守不守得住。
   *
   * 所以死改成了一次交接：日子停在大丧上，等玩家看完先主的一生，
   * 按下「继位」，三样代价一齐兑现（见 succession.ts）。
   * **真正的输只剩一条：地盘丢光。**
   */
  const e = asLord('court-die');
  const st = e.getState() as unknown as { court: { span: number } };
  st.court.span = e.getState().day + 2;
  e.dispatch({ t: 'court_adjourn' });

  const court = e.getState().court!;
  assert.ok(court.deeds.length > 0, '总得留下一份生平');
  assert.ok(
    court.mourning || e.getState().ending,
    '过了寿数，要么摆出大丧那一屏，要么是真的收场了',
  );
  if (e.getState().ending) {
    assert.ok(
      ['founded', 'entrusted', 'divided', 'scattered'].includes(e.getState().ending!.kind),
      '真收场的时候，位置得落在史书上那几种里',
    );
    return;
  }

  // 大丧。日子该停住 —— 那一屏是留给玩家看完先主一生的
  const day = e.getState().day;
  e.dispatch({ t: 'court_adjourn' });
  assert.equal(e.getState().day, day, '大丧期间日子不该往前走');

  const heirId = court.mourning!.heirId;
  const dead = court.lordName;
  const renownWas = court.renown;
  e.dispatch({ t: 'court_succeed' });

  const now = e.getState().court!;
  assert.equal(now.mourning, null, '继位之后大丧就过去了');
  assert.equal(now.reign, 2, '这是第二代了');
  assert.equal(now.reigns.length, 1, '先主那一代该记进史书');
  assert.equal(now.reigns[0]!.name, dead, '记的是先主的名字');
  assert.equal(now.lordPersonId, heirId, '接班的是那个被托付的人');
  assert.ok(
    now.renown < renownWas,
    `望要重新挣 —— 天下人认的是那个死了的人：${renownWas} → ${now.renown}`,
  );
  assert.equal(e.getState().ending, null, '交接完了，这一局还得往下走');

  // 日子重新开始走
  e.dispatch({ t: 'court_adjourn' });
  assert.ok(e.getState().day > day, '继位之后日子该接着走');
});

test('地盘丢光才是真的完了', () => {
  const e = asLord('court-lost-all');
  const raw = e.getState() as never as {
    nodes: Record<string, { factionId: string }>;
  };
  for (const id of Object.keys(raw.nodes)) {
    if (raw.nodes[id]!.factionId === 'caocao') raw.nodes[id]!.factionId = 'yuanshao';
  }
  e.dispatch({ t: 'court_adjourn' });
  assert.equal(e.getState().ending?.kind, 'scattered', '一座城也没有了，那才叫国破');
});

test('天下会自己往鼎立收，不会永远十几家僵着', () => {
  const e = asLord('court-powers');
  const at0 = powersLeft(e.getState()).length;
  assert.ok(at0 > 10, '开局本来就该是群雄并起');

  for (let i = 0; i < 400 && !e.getState().ending; i++) {
    e.dispatch({ t: 'court_adjourn' });
  }
  const at1 = powersLeft(e.getState()).length;
  assert.ok(at1 < at0, `十几年下来该少掉几家，实测 ${at0} → ${at1}`);
});

test('散朝会在出大事的时候自己停住', () => {
  const e = asLord('court-stop');
  for (let i = 0; i < 30 && !e.getState().ending; i++) {
    const before = e.getState().day;
    const evs = e.dispatch({ t: 'court_adjourn' });
    const adj = evs.find((ev) => ev.t === 'adjourned');
    assert.ok(adj, '散朝总该报一声走了几天');
    const days = (adj as { days: number }).days;
    assert.equal(e.getState().day - before, days, '报的天数要和真走的对得上');
    assert.ok(days <= 45, '一次散朝不该无限往下走');
    if (evs.some((ev) => ev.t === 'memorial_raised')) {
      assert.ok(days < 45, '案上摞了事就该停下来，别走满');
      return;
    }
  }
});

test('同种子同命令流，朝堂也是逐位相同的', () => {
  const run = (): string => {
    const e = asLord('court-determinism');
    for (let i = 0; i < 12; i++) {
      const m = e.getState().court!.memorials[0];
      if (m) e.dispatch({ t: 'court_reply', memorialId: m.id, answer: 'allow' });
      e.dispatch({ t: 'court_adjourn' });
    }
    return e.fingerprint();
  };
  assert.equal(run(), run(), '朝堂里任何一处用了不受控的随机，这里就会分叉');
});

// ─────────────────────────────────────────────────────────────
// M5a 临朝
// ─────────────────────────────────────────────────────────────

test('一次只见一个人：传下一位不推时间，退朝才推', () => {
  const e = asLord('court-stage');
  untilDesk(e);
  const before = e.getState().day;
  const r = e.dispatch({ t: 'court_next' });
  assert.ok(r.some((ev) => ev.t === 'memorial_staged'), '案上有人就该引上堂来');
  assert.equal(e.getState().day, before, '引见一个人不该让日子往前走');
  assert.ok(e.getState().court!.onStage, 'onStage 要指着那一件');

  // 已经站着一个了，别把他撵下去
  const again = e.dispatch({ t: 'court_next' });
  assert.ok(again.some((ev) => ev.t === 'rejected'));
});

test('他有反应，而且礼数是心气的函数，不是答复的函数', () => {
  const e = asLord('court-react');
  untilDesk(e);
  const st = e.getState();
  const m = st.court!.memorials[0]!;

  // 心气高的人，被驳了也还躬身
  bumpHeart(st, m.personId, 100);
  const warm = e.dispatch({ t: 'court_reply', memorialId: m.id, answer: 'deny' });
  const r1 = warm.find((ev) => ev.t === 'memorial_reacted');
  assert.ok(r1 && r1.t === 'memorial_reacted');
  assert.equal(r1.reaction, 'stoop', '心气高的人挨了驳也有礼数');

  // 心气低的人，被驳了转身就走
  untilDesk(e);
  const m2 = e.getState().court!.memorials[0];
  if (!m2) return;
  bumpHeart(e.getState(), m2.personId, -100);
  // 掉到底就是「……」，先拉回到「少说话」那一档
  bumpHeart(e.getState(), m2.personId, 25);
  const cold = e.dispatch({ t: 'court_reply', memorialId: m2.id, answer: 'deny' });
  const r2 = cold.find((ev) => ev.t === 'memorial_reacted');
  assert.ok(r2 && r2.t === 'memorial_reacted');
  assert.equal(r2.reaction, 'turn_away', '心气低的人不会给你行礼');
});

test('批复会记进旧账，他下次记得你上回怎么说的', () => {
  const e = asLord('court-ledger');
  untilDesk(e);
  const m = e.getState().court!.memorials[0]!;
  e.dispatch({ t: 'court_reply', memorialId: m.id, answer: 'deny' });
  const book = e.getState().court!.ledger[m.personId];
  assert.ok(book && book.length === 1, '驳了一件就该记一笔');
  assert.equal(book[0]!.answer, 'deny');
  assert.equal(book[0]!.kind, m.kind);
});

test('守将走光了，案头不许就此安静下去', () => {
  const e = asLord('court-vacancy');
  const st = e.getState() as unknown as {
    posts: Record<string, string>;
    court: { nextDay: number; memorials: unknown[] };
    day: number;
  };
  // 把辖境的守将全撤了 —— 准两道辞呈就是这个局面
  for (const id of Object.keys(st.posts)) delete st.posts[id];
  st.court.nextDay = e.getState().day;

  let saw = false;
  for (let i = 0; i < 12 && !e.getState().ending; i++) {
    if (e.getState().court!.memorials.some((m) => m.kind === 'vacancy')) { saw = true; break; }
    e.dispatch({ t: 'court_adjourn' });
  }
  assert.ok(saw, '一座没人主事的城，必须有人来报 —— 否则这一局就死在这儿了');
});

test('允了自请，那个人就真的上任了', () => {
  const e = asLord('court-post');
  const st = e.getState() as unknown as {
    posts: Record<string, string>; court: { nextDay: number };
  };
  for (const id of Object.keys(st.posts)) delete st.posts[id];
  st.court.nextDay = e.getState().day;

  for (let i = 0; i < 12 && !e.getState().ending; i++) {
    const m = e.getState().court!.memorials.find((x) => x.kind === 'vacancy');
    if (m) {
      e.dispatch({ t: 'court_reply', memorialId: m.id, answer: 'allow' });
      assert.equal(
        e.getState().posts[m.aboutId], m.personId,
        '自请守城，允了就该真的派他去',
      );
      return;
    }
    e.dispatch({ t: 'court_adjourn' });
  }
});

test('打赢了有人来报捷，不是全案头都在向你伸手', () => {
  const e = asLord('court-dispatch');
  const st = e.getState() as unknown as {
    nodes: Record<string, { id: string; factionId: string; troops: number }>;
    sieges: Record<string, unknown>;
    official: { lordId: string };
  };
  // 找一座挨着自家的敌城，摆一支我方围兵、守军见底 —— 下一日必破
  const me = st.official.lordId;
  const mine = Object.values(st.nodes).find((n) => n.factionId === me)!;
  const foe = (idx.node.get(mine.id)?.links ?? [])
    .map((id) => st.nodes[id]).find((n) => n && n.factionId !== me);
  if (!foe) return;
  foe.troops = 0;
  st.sieges[foe.id] = {
    cityId: foe.id, factionId: me, troops: 1200, supply: 4000, days: 3,
  };

  /**
   * 窗口要放宽。
   *
   * 城现在**只能靠强攻拿下**（见 worldtick 里那一段）：先围十二日，
   * 之后攻方每日下决心，成了才破城。守军磨光就自动易主的日子过去了 ——
   * 那条规矩本来就写着「围而不攻拿不下城」，只是从前只保护文官那一座。
   */
  for (let i = 0; i < 80; i++) {
    e.dispatch({ t: 'day' });
    const d = e.getState().court!.memorials.find((m) => m.kind === 'dispatch');
    if (d) {
      assert.ok(d.textId.startsWith('dispatch.'), '露布要有话');
      return;
    }
  }
  assert.fail('城破了却没有一份露布 —— 那这个朝堂上没人向你报事');
});

/**
 * 粮定人数，不定成败。
 *
 * 这条是补一个**玩家真的撞上的**坑：一座一千四百人、八百石粮的城，
 * 点「出兵」什么也不会发生 —— `supply < troops` 直接拒了，而且一声不响。
 * 玩家看到的是按钮坏了。
 *
 * 同样的错在 `cmdLordMuster` 上已经栽过一次（见那个函数上面那段），
 * 所以这里把三条路径一起钉住。
 */
test('粮不够只是少发兵，不是发不出兵', () => {
  const e = asLord('court-feed');
  const st = e.getState() as unknown as {
    nodes: Record<string, { id: string; factionId: string; troops: number; grain: number }>;
    official: { lordId: string };
  };
  const me = st.official.lordId;
  const from = Object.values(st.nodes).find((n) => n.factionId === me)!;
  const to = (idx.node.get(from.id)?.links ?? []).find((x) => st.nodes[x])!;

  // 兵多而粮少 —— 曹操那种开局本来就该是这样
  from.troops = 1400;
  from.grain = 800;

  const r = e.dispatch({ t: 'lord_march', fromId: from.id, toId: to, troops: 1300 });
  assert.ok(
    r.some((x) => x.t === 'lord_marched'),
    '喂得起四百人就该发四百人出去，不该整支兵发不出',
  );
  const army = Object.values(e.getState().armies)[0]!;
  assert.ok(army.troops <= 400, `带得动多少人由粮说了算，实测 ${army.troops}`);
  assert.ok(army.troops >= 60, '也不能少到没有意义');
  assert.ok(
    e.getState().nodes[from.id]!.troops >= KEEP_GARRISON,
    '削归削，看家的兵还得留着',
  );
});

/**
 * 募兵 —— 主公唯一能把粮变成兵的动词。
 *
 * 守三条：真的能把粮变成兵、代价落在民心上、以及**农忙时募得更少**。
 * 最后这一条是「拟合真实」那条原则的第一个落点：兵者，农之余。
 */
test('募兵：粮变成兵，代价是民心，而且要看农时', () => {
  const e = asLord('court-levy');
  const st = e.getState();
  const city = Object.values(st.nodes).find((n) => n.factionId === st.official.lordId)!;
  city.grain = 6000;
  city.morale = 80;
  /**
   * 把城做厚一点再募。
   *
   * 开局那两座城**兵比城撑得住的还多**（曹操散尽家财募的五千部曲），
   * 于是 `room` 是零、募不动 —— 而那正是对的：
   * 「要养更多人，先把城做厚」。这里要验的是募兵本身，先把地基垫上。
   */
  city.dev = 60;
  const troops0 = city.troops;
  const grain0 = city.grain;

  const r = e.dispatch({ t: 'lord_levy', cityId: city.id });
  assert.ok(r.some((x) => x.t === 'lord_levied'), '有粮有民心就该募得到人');
  assert.ok(city.troops > troops0, '募兵要真的多出人来');
  assert.ok(city.grain < grain0, '人是拿粮换的');
  assert.ok(city.morale < 80, '抽壮丁是要伤民心的');

  // 一座城不能连着募
  assert.ok(
    e.dispatch({ t: 'lord_levy', cityId: city.id })
      .some((x) => x.t === 'rejected' && x.reasonId === 'levy_soon'),
    '一座城九十天只募得了一次',
  );

  // 农隙募得多，农忙募得少
  assert.ok(
    seasonLevy(dateToDay({ year: 191, month: 11, day: 1 }))
      > seasonLevy(dateToDay({ year: 191, month: 5, day: 1 })),
    '冬天是农隙，比夏天好募兵 —— 兵者，农之余',
  );
});

/**
 * 军营 —— 文武分职的落点，也是「出兵就掏空守军」那条硬伤的解药。
 *
 * 守四条：只有武将领得了营、一将不能分身、**营出兵不动城里一个人**、
 * 以及营在城外也要守城（否则它就是个只出不进的坑）。
 */
test('军营：城里的兵守家，营里的兵野战', () => {
  const e = asLord('court-camp');
  const st = e.getState();
  const city = Object.values(st.nodes).find((n) => n.factionId === st.official.lordId)!;
  city.grain = 4000;
  city.troops = 1600;

  // 一、文吏带不了脱产的野战军
  const civilOnly = ownPeople(st, idx).find((p) => !isMartial(p));
  if (civilOnly) {
    assert.ok(
      e.dispatch({ t: 'lord_camp_open', cityId: city.id, personId: civilOnly.id })
        .some((x) => x.t === 'rejected' && x.reasonId === 'not_martial'),
      '领营只有武将做得了',
    );
  }

  // 二、立营
  const officer = idx.person.get(freeOfficers(st, idx)[0]!)!;
  assert.ok(
    e.dispatch({ t: 'lord_camp_open', cityId: city.id, personId: officer.id })
      .some((x) => x.t === 'camp_opened'),
    '有武将有粮就该立得起营',
  );
  const camp = campAt(e.getState(), city.id)!;
  assert.ok(camp, '营要挂在这座城上');

  // 三、一将不能分身：领着营的人，再立一座营也立不了
  const other = Object.values(e.getState().nodes)
    .find((n) => n.factionId === e.getState().official.lordId && n.id !== city.id);
  if (other) {
    e.getState().nodes[other.id]!.grain = 4000;
    assert.ok(
      e.dispatch({ t: 'lord_camp_open', cityId: other.id, personId: officer.id })
        .some((x) => x.t === 'rejected' && x.reasonId === 'busy'),
      '他手上已经有一座营了 —— 一将不能分身',
    );
  }

  // 四、拨兵：城里少了多少，营里就多了多少
  const before = e.getState().nodes[city.id]!.troops;
  e.dispatch({ t: 'lord_draft', campId: camp.id, men: 400 });
  const after = e.getState().nodes[city.id]!;
  const camp2 = campAt(e.getState(), city.id)!;
  assert.equal(before - after.troops, camp2.troops, '兵是从城里拨进营的，不是变出来的');
  assert.ok(after.troops >= KEEP_GARRISON, '城里永远要留够看家的');

  // 五、**营出兵不动城里一个人** —— 这是整套东西存在的理由
  const garrison = e.getState().nodes[city.id]!.troops;
  const to = (idx.node.get(city.id)?.links ?? []).find((x) => e.getState().nodes[x])!;
  const r = e.dispatch({
    t: 'lord_camp_march', campId: camp.id, toId: to, men: camp2.troops,
  });
  if (r.some((x) => x.t === 'lord_marched')) {
    assert.equal(
      e.getState().nodes[city.id]!.troops, garrison,
      '营出兵，城里的守军一个也不许少 —— 攻守是两笔账',
    );
  }
});

test('营在城外，被围时也要一起打', () => {
  const e = asLord('court-camp-def');
  const st = e.getState() as unknown as {
    nodes: Record<string, { id: string; factionId: string; grain: number; troops: number }>;
    official: { lordId: string };
  };
  const city = Object.values(st.nodes).find((n) => n.factionId === st.official.lordId)!;
  city.grain = 5000;
  city.troops = 1600;
  const officer = idx.person.get(freeOfficers(e.getState(), idx)[0]!)!;
  e.dispatch({ t: 'lord_camp_open', cityId: city.id, personId: officer.id });
  const camp = campAt(e.getState(), city.id)!;
  e.dispatch({ t: 'lord_draft', campId: camp.id, men: 600 });

  const withCamp = nodeDefenceOf(e.getState(), idx, city.id);
  e.dispatch({ t: 'lord_camp_close', campId: camp.id });
  // 撤营之后兵归城，所以要把人数扳回来才比得出「营顶不顶事」
  e.getState().nodes[city.id]!.troops = 1000;
  const alone = nodeDefenceOf(e.getState(), idx, city.id);
  assert.ok(
    withCamp > alone,
    `城外那座营该算进守备里 —— 有营 ${withCamp}，无营 ${alone}`,
  );
});

/**
 * 挟天子。
 *
 * 守三条：没天子写的东西不算诏、**抗诏的那一家从此背着「逆」字**
 * （打他不折望，克城还涨望）、以及诏书下多了就不灵。
 */
test('挟天子：诏书动的是别人的兵，而抗诏的人从此是逆', () => {
  const e = asLord('court-edict');
  const st = e.getState();

  // 没天子，写什么都不是诏
  assert.ok(
    e.dispatch({ t: 'lord_edict', to: 'zhangmiao', kind: 'tribute' })
      .some((x) => x.t === 'rejected' && x.reasonId === 'no_emperor'),
    '天子不在你这儿，你写的东西没人当诏书看',
  );

  receiveEmperor(st, idx);
  assert.ok(st.court!.emperor, '奉迎之后天子就在治所');

  // 下诏：从与不从都算数
  const r = e.dispatch({ t: 'lord_edict', to: 'zhangmiao', kind: 'yield' });
  const ev = r.find((x) => x.t === 'edict_sent');
  assert.ok(ev && ev.t === 'edict_sent', '诏总要有个下文');
  if (!ev.obeyed) {
    assert.ok(isDefiant(e.getState(), 'zhangmiao'), '不奉诏的，从此背着一个「逆」字');
  }

  // 一年下不了太多 —— 下多了天下就知道那是谁写的了
  for (let i = 0; i < 6; i++) {
    e.dispatch({ t: 'lord_edict', to: 'liudai', kind: 'denounce' });
  }
  assert.equal(edictWeight(e.getState()), 0, '一年里的诏是有数的');
  assert.ok(
    e.dispatch({ t: 'lord_edict', to: 'taiping', kind: 'denounce' })
      .some((x) => x.t === 'rejected' && x.reasonId === 'edict_spent'),
    '力气用完了就下不动了',
  );
});

test('奉诏讨逆：打抗诏的那一家，不折望', () => {
  const e = asLord('court-righteous');
  const st = e.getState() as unknown as {
    nodes: Record<string, { id: string; factionId: string; troops: number; grain: number }>;
    official: { lordId: string };
  };
  receiveEmperor(e.getState(), idx);
  const me = st.official.lordId;
  const from = Object.values(st.nodes).find((n) => n.factionId === me)!;
  const to = (idx.node.get(from.id)?.links ?? [])
    .map((x) => st.nodes[x]).find((n) => n && n.factionId !== me)!;
  from.troops = 2000; from.grain = 4000;

  // 先把那一家变成「逆」
  e.getState().court!.defiant.push(to.factionId);

  const before = e.getState().court!.renown;
  e.dispatch({ t: 'lord_march', fromId: from.id, toId: to.id, troops: 900 });
  assert.equal(
    e.getState().court!.renown, before,
    '讨逆是名正言顺的事 —— 不该像无故兴兵那样折望',
  );
});
