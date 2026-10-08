/**
 * 人物库怎么用。
 *
 * 天下所有叫得出名字的人都在 `content/people.json` 里，按出身分属各家。
 * 这个模块管两件事：**谁在守哪座城**，以及**从哪一家里挑一个人出来**。
 *
 * ── 为什么要有守将这张表 ────────────────────────────
 *
 * 上一版敌将的名字是从一份没有归属的名单里随手抽的，
 * 于是「攻孔融的城，董卓帐下的华雄出来单挑」这种事真的会发生。
 * 名字给对了人，天下才是一张有人的图，而不是一堆写着数字的方块。
 *
 * 而且它得**常驻**：这一趟去打濮阳是张郃守，下一趟还得是他。
 * 一座城的守将换人，只该发生在城易主、或者主公另有任命的时候 ——
 * 这正是 M4「任命」要动的那张表。
 */
import { nextInt, type RngState } from './rng.ts';
import type { ContentIndex, PersonDef } from './content.ts';
import type { WorldState } from './state.ts';

/**
 * 开局给天下每一座城派一个守将。
 *
 * 人少城多的时候会有城派不到人 —— 那就没有守将，
 * 打起来只有一个无名的「偏将」。这是对的：
 * 袁绍手底下就那么几个能叫得出名字的人，摊到几座城上本来就不够。
 */
export function seedPosts(state: WorldState, idx: ContentIndex): void {
  const left = new Map<string, PersonDef[]>();
  for (const [f, list] of idx.byFaction) left.set(f, [...list]);

  // 按城的分量排：大城先派人，好人先去要紧的地方
  const nodes = Object.values(state.nodes).slice().sort((a, b) => {
    const da = idx.node.get(a.id);
    const db = idx.node.get(b.id);
    return (db?.scale ?? 0) - (da?.scale ?? 0);
  });

  for (const node of nodes) {
    const pool = left.get(node.factionId);
    if (!pool || pool.length === 0) continue;
    // 越要紧的城派越能干的人。这也是主公本该有的用人之道
    pool.sort((a, b) => (b.command + b.valor) - (a.command + a.valor));
    const who = pool.shift();
    if (who) state.posts[node.id] = who.id;
  }
}

/**
 * 这个人这会儿算不算某一家的。
 *
 * 出身写在人物库里，是死的；但**举荐来的、随地归附来的人，
 * 出身还是原来那一家** —— 只有 `court` 知道他这一局在谁帐下。
 * 少了这一句，你刚请来的人转身就不认你，任命他去守城等于没派人。
 */
export function servesFaction(
  state: WorldState, personId: string, factionId: string, born: string,
): boolean {
  const court = state.court;
  if (court && state.role === 'lord' && factionId === state.official.lordId) {
    if (court.gone.includes(personId)) return false;
    if (court.enlisted.includes(personId)) return true;
  }
  return born === factionId;
}

/** 这座城谁在守。没人守就返回 null */
export function wardenOf(
  state: WorldState, idx: ContentIndex, nodeId: string,
): PersonDef | null {
  const id = state.posts[nodeId];
  if (!id) return null;
  const who = idx.person.get(id);
  if (!who) return null;
  // 城易了主，原来的守将就不作数了 —— 他要么死了，要么跟着旧主走了
  const node = state.nodes[nodeId];
  if (node && !servesFaction(state, who.id, node.factionId, who.faction)) return null;
  return who;
}

// ─────────────────────────────────────────────────────────────
// 文与武
// ─────────────────────────────────────────────────────────────

/**
 * 这个人是带兵的，还是治民的。
 *
 * ── 为什么不搞成互斥的两类 ──────────────────────────
 *
 * 设计上文武是分职的：**文官占城池，武将有军营。**
 * 但人物库五十三个人里，擅长标签是「统众 13、野战 11、守备 11」——
 * 一边倒的武。硬性规定「只有文官能守城」，一半的城当场没人守。
 *
 * 而且那也不合汉末的实情：曹仁、李典、于禁都是既能带兵又能牧民的人。
 *
 * 所以分职落在**各有所长**上：
 *   · **领营只有武将做得了** —— 这一条是硬的，文吏带不了脱产的野战军
 *   · 守城谁都做得，但文官把账管明白、把田种出来（治理），
 *     武将把墙守住（守备）。**派错人不出错，只是长得慢**。
 */
const MARTIAL_TAGS = [
  '统众', '野战', '骑战', '冲阵', '先登', '攻坚', '水战', '山地',
  '宿卫', '陷阵', '破骑', '袭扰', '劫掠', '单骑', '骑射', '断后', '设伏',
];
const CIVIL_TAGS = [
  '屯政', '谋断', '聚财', '结交', '安民', '治军', '持重', '屯守', '举荐', '治理',
];

/** 带得了兵吗 —— 领营的硬条件 */
export function isMartial(p: PersonDef): boolean {
  return p.valor >= 70 || p.good.some((g) => MARTIAL_TAGS.includes(g));
}

/** 治得了民吗 */
export function isCivil(p: PersonDef): boolean {
  return p.wit >= 66 || p.good.some((g) => CIVIL_TAGS.includes(g));
}

/**
 * 这位守将把这座城的政事管得怎么样（千分数，一为轴）。
 *
 * **以一为轴，不能往上加** —— 这条教训见 `wardenPermille` 上面那一大段：
 * 写成往上加会把全天下的城一起抬高，而玩家的城相对之下反倒成了最软的。
 *
 * 无人主事的最差（账没人管、田没人劝），
 * 文吏最好，纯粹的武人差一档 —— 他会守，不会算。
 */
export function civilPermille(p: PersonDef | null): number {
  if (!p) return 860;
  const civil = isCivil(p);
  const martial = isMartial(p);
  if (civil && !martial) return 1120;   // 纯文吏
  if (civil && martial) return 1040;    // 出将入相的那几个
  return 940;                            // 纯武人
}

/**
 * 从某一家里挑一个人出来，避开已经用过的。
 *
 * 挑不出来就返回 null —— 调用方自己去写「偏将」这种无名的称呼。
 * 硬凑一个别家的人出来，比没有名字更糟。
 */
export function someoneFrom(
  idx: ContentIndex, rng: RngState, factionId: string, used: Set<string>,
): PersonDef | null {
  const pool = (idx.byFaction.get(factionId) ?? []).filter((p) => !used.has(p.id));
  if (pool.length === 0) return null;
  const pick = pool[nextInt(rng, pool.length)];
  if (pick) used.add(pick.id);
  return pick ?? null;
}

/**
 * 城易主了，新主人派谁来守。
 *
 * **这是「任命」的第一个真实场合。**
 *
 * 少了这一段，打下来的城从此没有守将：`wardenOf` 认得出
 * 城头换了旗号，于是返回 null，那座城就永远无名了。
 * 天下打了十年之后满地都是没人守的城 —— 那不是乱世，那是空城。
 *
 * 派谁有讲究：城是要守的，所以先挑**擅长守备**的人；
 * 没有那样的人，就挑统率最高的。
 * 一个人都腾不出来就空着 —— 一家势力吞得太快，本来就会无人可派。
 * 这一条不该拿凑数的假人去填。
 */
export function appointWarden(
  state: WorldState, idx: ContentIndex, nodeId: string,
): PersonDef | null {
  const node = state.nodes[nodeId];
  if (!node) return null;

  // 旧守将随着旧旗号一起走了
  delete state.posts[nodeId];

  const posted = new Set(Object.values(state.posts));
  const extra = state.role === 'lord' && node.factionId === state.official.lordId
    ? (state.court?.enlisted ?? []).map((id) => idx.person.get(id))
    : [];
  const pool = [...(idx.byFaction.get(node.factionId) ?? []), ...extra]
    .filter((p): p is PersonDef => !!p
      && !posted.has(p.id)
      && servesFaction(state, p.id, node.factionId, p.faction));
  if (pool.length === 0) return null;

  const score = (p: PersonDef): number =>
    p.command + (p.good.includes('守备') ? 30 : 0) + (p.good.includes('持重') ? 12 : 0);
  pool.sort((a, b) => score(b) - score(a));

  const who = pool[0];
  if (who) state.posts[nodeId] = who.id;
  return who ?? null;
}

/**
 * 天下有多少城还没人守。
 *
 * 用来盯住上面那件事有没有真的在办 —— 空城多起来就是出事了。
 */
export function unmannedCities(state: WorldState, idx: ContentIndex): number {
  return Object.keys(state.nodes).filter((id) => !wardenOf(state, idx, id)).length;
}
