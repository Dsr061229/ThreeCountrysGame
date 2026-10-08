/**
 * 朝堂。主公这一屏。
 *
 * ── 为什么不是一张案，而是一次引见 ──────────────────
 *
 * 上一版案上五件事一起摊着，玩家做的是**挨个点**。
 * 信息一样，但那是一份待办清单，不是一个朝堂。
 *
 * 现在一次只站一个人：他走上来，说他的话，你答复，
 * **他有一个反应，再退下去。** 心气这条线全部的情绪出口就是那 0.6 秒 ——
 * 心气高的人被你驳了也还躬身，心气低的人一言不发转身就走。
 *
 * 「散朝」也跟着变了意思：案上还有人时它叫「传下一位」，时间不动；
 * 人见完了它才是「退朝」，日子才往前走。
 *
 * ── 三个场景 ────────────────────────────────────────
 *
 *   引见 —— 事。一次一个人，站在阶下跟你说话。
 *   班列 —— 人。文东武西站两班，谁称病、谁不说话，一眼看得见。
 *   天下 —— 地。那张图还在，只是不再是主屏。
 *
 * ── 全程零数值条 ────────────────────────────────────
 *
 * 心气是一个动作，望是天下人的一句评语，寿数一个数字也不给。
 */
import { useEffect, useState } from 'react';
import { Engine } from '../sim/engine.ts';
import { type ContentIndex, type PersonDef, renderText } from '../sim/content.ts';
import { formatDate, SEASON_NAME, seasonOf, DAYS_PER_YEAR } from '../sim/time.ts';
import {
  agoWord, ANSWER_NAME, FAME_FOR_FORCE, heartWord, HEIR_HEART_KEEP, HEIR_LEAVE_UNDER,
  MEMORIAL_NAME, NOTED_ANSWER_NAME,
  REACTION_NOTE, REACTION_SAY, renownWord, URGE_ANSWER_NAME,
  type Answer, type Memorial, type Reaction,
} from '../sim/lord_types.ts';
import {
  fameHeld, heartOf, ownPeople, powersLeft, reliefOffers, roadWorks, thronePillars,
} from '../sim/court.ts';
import { rankName, rankOf, tributeDue } from '../sim/tribute.ts';
import { TRIBUTE_EVERY } from '../sim/lord_types.ts';
import { Figure, Portrait } from './portrait.tsx';
import { Audio } from '../audio/ambience.ts';

type Tab = 'audience' | 'hall' | 'store';

/** 他行完礼、退下去，要多久 */
const REACT_MS = 1500;
/**
 * 堂下无人时，隔多久自己往前走一步。
 *
 * 慢一点是故意的：**日子要看得见地在走**，
 * 快到一闪而过，玩家就只看到日期在跳，而不是天下在动。
 */
const AUTO_MS = 620;

interface Props {
  engine: Engine;
  idx: ContentIndex;
  onRealm: () => void;
}

interface Reacting { personId: string; name: string; reaction: Reaction }

export function CourtScreen({ engine, idx, onRealm }: Props) {
  const st = engine.getState();
  const court = st.court;
  const [tab, setTab] = useState<Tab>('audience');
  const [reacting, setReacting] = useState<Reacting | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  /**
   * 自动临朝。
   *
   * ── 为什么非有这一条不可 ────────────────────────────
   *
   * 案头空了的时候，玩家做的事是**一遍遍点「退朝」**，
   * 屏幕上一次次回到同一句「堂下无人」—— 那不是节奏，那是空转。
   * 而一个诸侯本来也不必亲手推动时间：没事的日子，日子自己会过。
   *
   * 所以堂下没人的时候，日子自己往前走，一直走到**有人上堂**为止。
   * 玩家要停就按一下「按住」—— 停的权力在他手上，但默认不该由他出力。
   */
  const [running, setRunning] = useState(true);

  /**
   * 他行完礼就退下，下一位自己上来。
   *
   * 让玩家每见一个人都多按一下「传下一位」，那是在给流程加摩擦，
   * 不是在给决定加分量。**摩擦要加在决定上，不是加在翻页上。**
   */
  useEffect(() => {
    if (!reacting) return;
    const t = setTimeout(() => {
      setReacting(null);
      if ((engine.getState().court?.memorials.length ?? 0) > 0) {
        engine.dispatch({ t: 'court_next' });
      }
    }, REACT_MS);
    return () => clearTimeout(t);
  }, [reacting, engine]);

  /**
   * 堂下无人的时候，日子自己走。
   *
   * **一有人上堂就自己停住** —— 那正是 `court_adjourn` 已经在做的事
   * （它走到下一件要你拍板的事为止）。这里只是不再要玩家去按那一下。
   */
  const idle = !!court && court.memorials.length === 0
    && !court.mourning && !court.situation && !court.plotWho
    && !reacting && !st.ending;
  useEffect(() => {
    if (!running || !idle) return;
    const t = setTimeout(() => { engine.dispatch({ t: 'court_adjourn' }); }, AUTO_MS);
    return () => clearTimeout(t);
  }, [running, idle, engine, st.day]);

  if (!court) return null;

  const me = st.official.lordId;
  const f = idx.faction.get(me);
  const held = Object.values(st.nodes).filter((n) => n.factionId === me);
  const besieged = held.filter((n) => st.sieges[n.id]);
  const pillars = thronePillars(st, idx);

  return (
    <div className="court">
      <Hall />

      <header className="ct-top">
        <div className="ct-when">
          <div className="ct-date">{formatDate(st.day)}</div>
          <div className="ct-sub">{SEASON_NAME[seasonOf(st.day)]} · 据 {held.length} 城</div>
        </div>
        <div className="ct-who">
          <div className="ct-banner" style={{ color: f?.color }}>{f?.banner}</div>
          <div className="ct-name">{court.lordName || f?.name}</div>
          {court.reign > 1 && <div className="ct-reign">第 {court.reign} 代</div>}
        </div>
        <div className="ct-fame">
          <div className="ct-fame-w">「{renownWord(court.renown)}」</div>
          <div className="ct-fame-s">天下{powersLeft(st).length}家</div>
        </div>
      </header>

      {besieged.length > 0 && (
        <div className="ct-alarm">
          {besieged.map((n) => (
            <span key={n.id}>
              <b>{idx.node.get(n.id)?.name}</b> 被围 {st.sieges[n.id]!.days} 日
            </span>
          ))}
        </div>
      )}

      <nav className="ct-tabs">
        {([['audience', '引见'], ['hall', '班列'], ['store', '太仓']] as const).map(([k, label]) => (
          <button
            key={k}
            className={'ct-tab' + (tab === k ? ' on' : '')}
            onClick={() => { Audio.click(); setTab(k); setPicked(null); }}
          >
            {label}
            {k === 'audience' && court.memorials.length > 0 && (
              <i className="ct-badge">{court.memorials.length}</i>
            )}
          </button>
        ))}
        <button className="ct-tab" onClick={() => { Audio.click(); onRealm(); }}>天下</button>
      </nav>

      {/**
        * 时局压过一切。
        *
        * **天下同时摊上一件事的时候，别的都得让开** ——
        * 那正是这条线上唯一一个「你不是在处理工单，你在下天下这盘棋」的时刻。
        */}
      {/**
        * 衣带诏压过一切 —— 连时局也让开。
        * 有人告发你帐下的人与天子密谋，这件事没有正确答案。
        */}
      {court.mourning
        ? <Mourning engine={engine} idx={idx} />
        : court.plotWho
        ? <Plot engine={engine} idx={idx} />
        : court.situation && !court.situation.mine
        ? <SituationAsk engine={engine} idx={idx} />
        : court.situation
          ? <SituationTally engine={engine} idx={idx} />
          : tab === 'audience'
        ? (
          <Audience
            engine={engine} idx={idx}
            reacting={reacting} setReacting={setReacting}
            running={running} setRunning={setRunning}
          />
        )
            : tab === 'store'
              ? <Store engine={engine} idx={idx} />
              : (
                <Roll
                  engine={engine} idx={idx}
                  picked={picked} setPicked={setPicked}
                  claiming={claiming} setClaiming={setClaiming}
                  pillars={pillars}
                />
              )}
    </div>
  );
}

/**
 * 大丧 —— 一代人走了，这一局还没完。
 *
 * ── 这一屏是这条线上最重的一屏 ──────────────────────
 *
 * 上一版主公一咽气，屏幕上就是一张结局卡，玩家点「再来一局」。
 * 而那不是三国的样子：曹操死了有曹丕，孙坚死了有孙策、孙权，
 * 刘备死在白帝城，托的是诸葛亮。
 * **那一段恰恰是这段历史最好看的地方。**
 *
 * 所以这一屏做两件事：
 *
 *   **先结账。** 先主这一代干成了什么，一条一条摆出来 ——
 *   那是玩家十几年真的做过的事，不是一句评语。
 *
 *   **再交接。** 三样代价写在明处，不藏：
 *   望要重新挣、心气一齐掉、有人不肯事二主。
 *   于是「你这一辈子怎么待人」在这一刻**第二次结账** ——
 *   待人厚的接得住，待人薄的父死而国分。
 */
function Mourning({ engine, idx }: { engine: Engine; idx: ContentIndex }) {
  const st = engine.getState();
  const court = st.court!;
  const m = court.mourning!;
  const heir = idx.person.get(m.heirId);
  const since = court.reigns.reduce((a, r) => Math.max(a, r.toDay), 0);
  const life = court.deeds.filter((d) => d.day >= since);
  const kindWord: Record<string, string> = {
    founded: '开　国', entrusted: '托　孤', divided: '身死业分',
  };
  const kindSay: Record<string, string> = {
    founded: '他到底是开了国的。这一朝的第一代，到此为止。',
    entrusted: '他没有称帝，但他死时的安排立住了 —— 这是最「三国」的一种收场。',
    divided: '他确实做大过。能不能守住，从今天起是别人的事了。',
  };
  const willLeave = ownPeople(st, idx)
    .filter((p) => p.id !== m.heirId
      && Math.round(heartOf(st, p.id) * HEIR_HEART_KEEP) < HEIR_LEAVE_UNDER);

  return (
    <div className="ct-mourn">
      <div className="cm-inner">
        <div className="cm-kind">{kindWord[m.ending] ?? ''}</div>
        <div className="cm-dead">{m.deadName}　薨</div>
        <p className="cm-say">{kindSay[m.ending] ?? ''}</p>

        {life.length > 0 && (
          <div className="cm-life">
            <div className="cm-life-t">这一代</div>
            {life.slice(-9).map((d, i) => (
              <div key={i} className={'cm-deed t-' + d.tone}>
                <span className="cd-y">{Math.floor(d.day / DAYS_PER_YEAR) + 190} 年</span>
                <span className="cd-w">{renderText(idx.db.text, d.textId, d.vars)}</span>
              </div>
            ))}
          </div>
        )}

        <div className="cm-heir">
          {heir && (
            <Figure
              who={heir} color={idx.faction.get(st.official.lordId)?.color}
              height={300} pose="bow_deep"
            />
          )}
          <div className="cm-heir-txt">
            <div className="cm-heir-t">受　遗</div>
            <div className="cm-heir-n">
              {heir ? rankName(st, heir) : ''}　<b>{heir?.name}</b>
              <em>{heir?.courtesy}</em>
            </div>
            <p className="cm-heir-p">「{heir?.praise}」</p>
            {/**
              * 三样代价写在明处。
              * **这不是提示，是账单** —— 玩家该在按下去之前就知道要付什么。
              */}
            <ul className="cm-cost">
              <li>天下人认的是先主，不是你 ——<b>望要从头挣</b></li>
              <li>帐下的人跟的是先主 ——<b>心气一齐往下掉</b></li>
              <li>
                {willLeave.length > 0
                  ? <>不肯事二主的：<b>{willLeave.slice(0, 4).map((p) => p.name).join('、')}
                    {willLeave.length > 4 ? ` 等 ${willLeave.length} 人` : ''}</b></>
                  : <>帐下无人离心 —— <b>你这一辈子待人不薄</b></>}
              </li>
            </ul>
          </div>
        </div>

        <button
          className="cm-go"
          onClick={() => { Audio.drum(); engine.dispatch({ t: 'court_succeed' }); }}
        >
          继　位
          <em>国祚不绝。地盘丢光才是真的完了</em>
        </button>
      </div>
    </div>
  );
}

/**
 * 衣带诏。
 *
 * **三条路都不好走，而且没有正确答案。**
 * 杀 —— 一了百了，但望崩、帐下集体寒心。
 * 查 —— 花时间，多半查不出什么，被查的那个从此记着你。
 * 不理 —— 眼下什么也不付，但那件事不会自己过去。
 */
function Plot({ engine, idx }: { engine: Engine; idx: ContentIndex }) {
  const st = engine.getState();
  const who = idx.person.get(st.court!.plotWho!);
  const again = st.court!.plotIgnored > 0;
  return (
    <div className="ct-sit cs-plot">
      <div className="cs-scroll">
        <div className="csx-tag">密　告</div>
        <p className="csx-text">
          有人告发：{who?.name}与天子密谋，欲图明公。{'\n'}
          告者不肯具名，只留下一幅带血的绢书。
          {again && '\n上一回你没有理会。这一回递上来的东西，写得更细了。'}
        </p>
        {who && (
          <div className="csx-eyes">
            <div className="csx-eyes-t">被告发的人</div>
            <div className="csx-eye">
              <span className="csx-f">{who.name}</span>
              <em>「{who.praise}」　忌：{who.flaw}</em>
            </div>
          </div>
        )}
        <div className="csx-me">你怎么办</div>
        <div className="csx-opts">
          {([
            ['kill', '诛之', '一了百了。望要崩，帐下从此人人自危'],
            ['probe', '穷治其狱', '查。多半查不出什么，而他从此记着你'],
            ['ignore', '不问', '眼下什么也不付。但这件事不会自己过去'],
          ] as const).map(([how, name, hint]) => (
            <button key={how} className="csx-opt" onClick={() => {
              Audio.drum();
              engine.dispatch({ t: 'lord_plot', how });
            }}>
              <b>{name}</b><em>{hint}</em>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 时局
// ─────────────────────────────────────────────────────────────

/**
 * 天下摊上一件事，各家都要表态。
 *
 * ── 这一屏的全部要点是「分两批」──────────────────────
 *
 * 先给你看三四家已经表过的态（「袁绍已出兵」「刘表按兵不动」），
 * **然后才轮到你答**。你是看着风向做的决定 ——
 * 一次亮完就只是一张公告，分两批它才是一场博弈。
 *
 * 这也是主公这条线上唯一一个能让玩家感到
 * 「那十几家不是背景板，是十几个跟我一样在做选择的人」的地方。
 */
function SituationAsk({ engine, idx }: { engine: Engine; idx: ContentIndex }) {
  const st = engine.getState();
  const sit = st.court!.situation!;
  const def = idx.db.situations?.find((d) => d.id === sit.id);
  if (!def) return null;
  const left = sit.dueDay - st.day;

  return (
    <div className="ct-sit">
      <div className="cs-scroll">
        <div className="csx-tag">时局</div>
        <p className="csx-text">{renderText(idx.db.text, def.textId)}</p>

        <div className="csx-eyes">
          <div className="csx-eyes-t">天下已有表态</div>
          {sit.revealed.length === 0
            ? <div className="csx-none">还没有人先开口。</div>
            : sit.revealed.map((fid) => {
              const f = idx.faction.get(fid);
              const pick = def.options.find((o) => o.id === sit.answers[fid]);
              return (
                <div key={fid} className="csx-eye">
                  <b style={{ color: f?.color }}>{f?.banner}</b>
                  <span className="csx-f">{f?.name}</span>
                  <em>{pick ? renderText(idx.db.text, pick.textId) : '未表态'}</em>
                </div>
              );
            })}
        </div>

        <div className="csx-me">该你了　<i>{left > 0 ? `还有 ${left} 日` : '今日必须表态'}</i></div>
        <div className="csx-opts">
          {def.options.map((o) => (
            <button
              key={o.id}
              className="csx-opt"
              onClick={() => {
                Audio.drum();
                engine.dispatch({ t: 'situation_answer', option: o.id });
              }}
            >
              <b>{renderText(idx.db.text, o.textId)}</b>
              <em>{renderText(idx.db.text, o.hintId)}</em>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 你答完了，剩下的跟着揭晓 —— 一张天下表态一览 */
function SituationTally({ engine, idx }: { engine: Engine; idx: ContentIndex }) {
  const st = engine.getState();
  const sit = st.court!.situation!;
  const def = idx.db.situations?.find((d) => d.id === sit.id);
  if (!def) return null;
  const me = st.official.lordId;

  // 按选项分栏 —— 谁跟谁站在一边，这才是玩家真正要看的东西
  const camps = def.options.map((o) => ({
    o,
    who: Object.entries(sit.answers)
      .filter(([, pick]) => pick === o.id)
      .map(([fid]) => fid)
      .sort(),
  }));

  return (
    <div className="ct-sit">
      <div className="cs-scroll">
        <div className="csx-tag">天下表态</div>
        <p className="csx-text short">{renderText(idx.db.text, def.textId)}</p>

        <div className="csx-camps">
          {camps.map(({ o, who }) => (
            <div key={o.id} className={'csx-camp' + (sit.mine === o.id ? ' mine' : '')}>
              <div className="csx-camp-t">
                {renderText(idx.db.text, o.textId)}
                <i>{who.length} 家</i>
              </div>
              <div className="csx-camp-l">
                {who.length === 0 && <span className="csx-none">无人</span>}
                {who.map((fid) => {
                  const f = idx.faction.get(fid);
                  return (
                    <span key={fid} className={'csx-w' + (fid === me ? ' me' : '')}>
                      <b style={{ color: f?.color }}>{f?.banner}</b>{f?.name}
                      {fid === me && <i>（你）</i>}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <button
          className="ct-adjourn"
          onClick={() => { Audio.click(); engine.dispatch({ t: 'situation_close' }); }}
        >
          知　道　了
          <em>站在同一边的，从此彼此近了一层</em>
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 引见
// ─────────────────────────────────────────────────────────────

function Audience(
  { engine, idx, reacting, setReacting, running, setRunning }: {
    engine: Engine; idx: ContentIndex;
    reacting: Reacting | null; setReacting: (r: Reacting | null) => void;
    running: boolean; setRunning: (b: boolean) => void;
  },
) {
  const st = engine.getState();
  const court = st.court!;
  const onStage = court.memorials.find((m) => m.id === court.onStage) ?? null;
  const waiting = court.memorials.filter((m) => m.id !== court.onStage);

  // ── 他正在行礼 ──
  if (reacting) {
    const who = idx.person.get(reacting.personId);
    return (
      <div className="ct-stage">
        <div className="cs-floor" />
        {who && (
          <Figure
            who={who} color={idx.faction.get(who.faction)?.color}
            height={400} pose={reacting.reaction}
          />
        )}
        <div className="cs-react">
          {REACTION_SAY[reacting.reaction] && (
            <div className="cs-react-say">「{REACTION_SAY[reacting.reaction]}」</div>
          )}
          <div className="cs-react-note">{reacting.name}{REACTION_NOTE[reacting.reaction]}</div>
        </div>
      </div>
    );
  }

  // ── 堂上站着一个人 ──
  if (onStage) {
    return (
      <Standing
        engine={engine} idx={idx} m={onStage}
        waiting={waiting.length}
        onReact={setReacting}
      />
    );
  }

  // ── 堂下候见 ──
  return (
    <div className="ct-stage empty">
      <div className="cs-floor" />
      {court.memorials.length === 0
        ? <Quiet engine={engine} idx={idx} />
        : (
          <div className="cs-queue">
            <div className="cq-t">堂下候见　{court.memorials.length} 人</div>
            <div className="cq-row">
              {court.memorials.slice(0, 6).map((m) => {
                const who = idx.person.get(m.personId);
                if (!who) return null;
                return (
                  <div key={m.id} className="cq-one">
                    <Figure
                      who={who} color={idx.faction.get(who.faction)?.color}
                      height={128} faded
                    />
                    <span className="cq-n">{who.name}</span>
                    <span className="cq-k">{MEMORIAL_NAME[m.kind]}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

      <Riding engine={engine} idx={idx} />

      <footer className="ct-foot">
        {court.memorials.length > 0
          ? (
            <button
              className="ct-adjourn"
              onClick={() => { Audio.click(); engine.dispatch({ t: 'court_next' }); }}
            >
              传下一位
              <em>{idx.person.get(court.memorials[0]!.personId)?.name}
                {MEMORIAL_NAME[court.memorials[0]!.kind]}</em>
            </button>
          )
          : (
            /**
             * 堂下无人。**这里不该再有一个要你点的按钮。**
             * 日子自己在走，走到有人上堂为止 —— 你只要看得见它在走，
             * 以及需要的时候按得住它。
             */
            <div className={'ct-flow' + (running ? ' on' : '')}>
              <span className="cf-dots" aria-hidden="true"><i /><i /><i /></span>
              <span className="cf-say">
                {running ? '日子自己在走 —— 有人上堂就停' : '按住了。天下也停在这儿'}
              </span>
              <button
                className="cf-btn"
                onClick={() => { Audio.click(); setRunning(!running); }}
              >{running ? '按　住' : '接着走'}</button>
              {!running && (
                <button
                  className="cf-btn step"
                  onClick={() => { Audio.drum(); engine.dispatch({ t: 'court_adjourn' }); }}
                >走一步</button>
              )}
            </div>
          )}
      </footer>
    </div>
  );
}

/**
 * 堂下无人的那一屏。
 *
 * ── 「没事」也得是有内容的 ──────────────────────────
 *
 * 原先这儿只有一句「堂下无人。」，配一个要玩家一遍遍去点的「退朝」。
 * 于是这条线上时间最长的那一段 —— **什么都没发生的日子** ——
 * 屏幕上是一片死的。
 *
 * 可一个诸侯的大部分日子本来就是这样：没有人来告状，
 * 外面在下雪、在收麦、在闹蝗，前方的骑手还在路上。
 * 所以这一屏改成**看得见的安静**：
 *
 *   · 时令一句话 —— 屋外是什么天气，田里在做什么
 *   · 近事三条 —— 你上个月做过的、天下刚发生的
 *   · 驿传 —— 路上还有几骑，各自还有几天到
 *
 * 加上日子自己在走（见 CourtScreen 里那个 effect），
 * 这一段就从「等」变成了「看」。
 */
function Quiet({ engine, idx }: { engine: Engine; idx: ContentIndex }) {
  const st = engine.getState();
  const court = st.court!;
  const deeds = court.deeds.slice(-3).reverse();
  const quietFolk = Object.keys(court.silent).length;

  /**
   * 时令。**按日子算，不掷骰** —— 同一天进来看到的是同一句。
   * 模拟层不认得表现层，所以这句话只是照日子取模，没有随机。
   */
  const month = Math.floor((st.day % DAYS_PER_YEAR) / 30);
  const line = SEASON_LINES[month] ?? '';

  return (
    <div className="cs-quiet">
      <div className="cq-line">{line}</div>
      {deeds.length > 0 && (
        <div className="cq-deeds">
          {deeds.map((d, i) => (
            <div key={i} className={'cq-deed t-' + d.tone}>
              <em>{agoWord(st.day - d.day)}</em>
              {renderText(idx.db.text, d.textId, d.vars)}
            </div>
          ))}
        </div>
      )}
      {quietFolk > 0 && (
        <div className="cq-still">堂上很静。</div>
      )}
    </div>
  );
}

/**
 * 一年十二个月，屋外各是什么光景。
 *
 * **写的是农事和天气，不是数值。** 这一条也是硬规矩一：
 * 「春耕抽壮丁伤收成」那件事玩家在募兵按钮上会读到，
 * 这里只负责让他知道现在是什么时候。
 */
const SEASON_LINES = [
  '正月。冰未解，河上的漕船还停着。',
  '二月。开耕了。城外的田里开始有人。',
  '三月。桃花水下来了，道上泥深。',
  '四月。麦子起身，粮价一天比一天低。',
  '五月。麦收。仓门整日开着。',
  '六月。暑气盛。营里的操练挪到早晚。',
  '七月。多雨。有几段驿路走不得车。',
  '八月。秋粟灌浆。这些日子最怕蝗。',
  '九月。收成毕，上计的簿册往治所送。',
  '十月。农隙。这时候招人最招得动。',
  '十一月。北风起。远处的兵多半要收了。',
  '十二月。岁暮。堂下这几日都清静。',
];

/**
 * 驿传。
 *
 * 路上还有几骑、从哪儿来、大约还有几天到 —— **只报这些，不报他带的是什么事。**
 * 那是他到了之后才知道的。
 *
 * 这一条的真正用处在于：**少了一骑，你是看得见的。**
 * 一骑被截了不会有任何提示（见 tickCouriers 上面那段），
 * 但下一次你瞟一眼驿传，那一行不见了。
 */
function Riding({ engine, idx }: { engine: Engine; idx: ContentIndex }) {
  const st = engine.getState();
  const riders = Object.values(st.couriers);
  if (riders.length === 0) return null;

  return (
    <div className="ct-ride">
      <span className="cr-t">驿传</span>
      {riders.slice(0, 5).map((c) => {
        const legs = c.route.length + 1;
        const left = Math.max(1, Math.round(legs * 5 - (c.progress / 1000) * 5));
        const risky = !!st.sieges[c.legTo] || !!st.sieges[c.legFrom];
        const paved = roadWorks(st, c.legFrom, c.legTo);
        return (
          <span key={c.id} className={'cr-one' + (risky ? ' risky' : '')}>
            <i className="cr-horse" aria-hidden="true">
              <svg viewBox="0 0 30 20"><path
                d="M3 16 L6 9 Q9 5 15 6 L21 4 L24 6 L22 9 Q24 13 22 17
                   L19 17 L20 12 L13 12 L11 17 L8 17 L9 12 L6 16 Z"
                fill="currentColor" /></svg>
            </i>
            {idx.node.get(c.fromId)?.name}
            <em>{left} 日</em>
            {paved && <b title="有驿">驿</b>}
          </span>
        );
      })}
      {riders.length > 5 && <span className="cr-one">…另 {riders.length - 5} 骑</span>}
    </div>
  );
}

/**
 * 堂上那一个人。
 *
 * 立像在阶下，他的话写在一面简牍上，三个答复在最底下。
 * **屏上一次只有三个可操作项** —— 硬规矩四从来没这么好守过。
 */
function Standing(
  { engine, idx, m, waiting, onReact }: {
    engine: Engine; idx: ContentIndex; m: Memorial;
    waiting: number; onReact: (r: Reacting) => void;
  },
) {
  const st = engine.getState();
  const court = st.court!;
  const who = idx.person.get(m.personId);
  const ago = st.day - m.atDay;
  const names = m.kind === 'dispatch' ? NOTED_ANSWER_NAME
    : m.kind === 'urge' ? URGE_ANSWER_NAME : ANSWER_NAME;
  const noted = m.kind === 'dispatch';
  const cannot = whyNot(engine, idx, m);
  const owed = oldDebt(engine, idx, m.personId);

  const say = (answer: Answer): void => {
    Audio.chime();
    const evs = engine.dispatch({ t: 'court_reply', memorialId: m.id, answer });
    const r = evs.find((e) => e.t === 'memorial_reacted');
    if (r && r.t === 'memorial_reacted') {
      onReact({ personId: r.personId, name: r.name, reaction: r.reaction });
    }
  };

  return (
    <div className={'ct-stage k-' + m.kind}>
      <div className="cs-floor" />

      <div className="cs-who">
        {who && (
          <Figure who={who} color={idx.faction.get(who.faction)?.color} height={400} />
        )}
      </div>

      <div className="cs-slip">
        <div className="cs-head">
          <span className="cs-kind">{MEMORIAL_NAME[m.kind]}</span>
          <span className="cs-name">{who?.name}</span>
          {who?.courtesy && <span className="cs-zi">{who.courtesy}</span>}
          <span className="cs-where">{idx.node.get(m.fromId)?.name ?? ''}</span>
          <span className="cs-ago">{agoWord(ago)}</span>
        </div>

        <p className="cs-say">{renderText(idx.db.text, m.textId, m.vars)}</p>

        {owed && <p className="cs-owed">{owed}</p>}

        {m.kind === 'relief' && <Rally engine={engine} idx={idx} m={m} />}

        <div className="cs-acts">
          {(noted ? (['allow'] as const) : (['allow', 'shelve', 'deny'] as const)).map((a) => (
            <button
              key={a}
              className={'cs-act a-' + a + (a === 'allow' && cannot ? ' cant' : '')
                + (noted ? ' only' : '')}
              onClick={() => say(a)}
            >
              {a === 'allow' && m.kind === 'relief' && (m.sent ?? 0) > 0 ? '就这些' : names[a]}
              {a === 'allow' && cannot && <em>{cannot}</em>}
            </button>
          ))}
        </div>
      </div>

      {waiting > 0 && <div className="cs-more">堂下还有 {waiting} 人候见</div>}
      {court.memorials.length === 1 && <div className="cs-more">此外堂下无人</div>}
    </div>
  );
}

/**
 * 请缨。
 *
 * ── 这一段是这一版请援的全部意思 ────────────────────
 *
 * 原先「允」了请援，是代码替你在**挨着那座城的邻城**里挑一个 ——
 * 挑不出来就一句「邻城派不出援兵」。
 * 于是玩家眼看着自己还有两座营、四座城，却被告知没人能去；
 * 而且他从头到尾没有做过任何一个选择。
 *
 * 真实的样子是几个人同时出列请缨，各自报上兵数和路程：
 * 张郃的营三千人十二日可到，李典那座城抽得出八百、六日就到，
 * 北边那一路要向刘表借道 —— **快的兵少，多的兵慢，还有一路要看别人脸色。**
 * 你挑一路，或者几路都发。挑完再按「就这些」。
 */
function Rally(
  { engine, idx, m }: { engine: Engine; idx: ContentIndex; m: Memorial },
) {
  const st = engine.getState();
  const offers = reliefOffers(st, idx, m.aboutId);
  const sg = st.sieges[m.aboutId];
  const sent = m.sent ?? 0;

  if (offers.length === 0) {
    return <div className="cs-rally none">帐下无一路抽得出兵来 —— 这座城要靠自己了。</div>;
  }

  return (
    <div className="cs-rally">
      <div className="cs-rally-t">
        请缨　<em>城下 {sg?.troops ?? 0} 人{sent > 0 ? `　已发 ${sent} 路` : ''}</em>
      </div>
      {offers.map((o) => {
        const who = o.personId ? idx.person.get(o.personId) : null;
        const camp = o.key.startsWith('camp:');
        const borrow = o.borrow
          .map((f) => idx.faction.get(f)?.name ?? f).join('、');
        return (
          <button
            key={o.key}
            className={'cs-rally-one' + (o.refused ? ' no' : '')}
            disabled={!!o.refused}
            onClick={() => {
              Audio.drum();
              engine.dispatch({ t: 'court_relief', memorialId: m.id, sourceKey: o.key });
            }}
          >
            <span className="csr-w">
              {who ? who.name : '偏将'}
              <i>{camp ? '营' : '城'}</i>
            </span>
            <span className="csr-n">
              自{idx.node.get(o.fromId)?.name}　{o.troops} 人
            </span>
            <span className="csr-d">
              {o.refused
                ? `${idx.faction.get(o.refused)?.name ?? o.refused}不肯借道`
                : borrow
                  ? `约 ${o.days} 日　要向${borrow}借道`
                  : `约 ${o.days} 日可至`}
            </span>
            <span className="csr-go">{o.refused ? '去不了' : '准'}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 旧账里挑一句他此刻会想起来的话。
 *
 * **这是唯一会让玩家记得自己两年前干过什么的东西。**
 * 只挑最相干的一笔：同一件事上你上次是怎么答的。
 */
function oldDebt(engine: Engine, idx: ContentIndex, personId: string): string | null {
  const st = engine.getState();
  const book = st.court?.ledger[personId] ?? [];
  if (book.length === 0) return null;
  const last = book[book.length - 1]!;
  const years = Math.floor((st.day - last.day) / DAYS_PER_YEAR);
  if (years < 1) return null;
  const when = years === 1 ? '去岁' : years === 2 ? '前年' : `${years}年前`;
  const what = idx.node.get(last.aboutId)?.name ?? idx.faction.get(last.aboutId)?.name ?? '';
  if (last.answer === 'allow') return null;
  return `（${when}${MEMORIAL_NAME[last.kind]}${what ? '·' + what : ''}，`
    + `主公${last.answer === 'deny' ? '不许' : '留中不发'}。）`;
}

/**
 * 允了办得成吗。
 *
 * 允了却办不成是最伤人心的一种答复 —— 比驳回还伤。
 * 能先看出来的就先写在按钮底下：玩家可以照旧点，但他是知情之后点的。
 */
function whyNot(engine: Engine, idx: ContentIndex, m: Memorial): string | null {
  const st = engine.getState();
  if (m.kind === 'relief') {
    // 已经点过将了 —— 那一下的意思是「就这些」，办不办得成不再是问题
    if ((m.sent ?? 0) > 0) return null;
    const offers = reliefOffers(st, idx, m.aboutId).filter((o) => !o.refused);
    if (offers.length === 0) return '帐下无一路抽得出兵来';
    return null;
  }
  if (m.kind === 'merit') {
    // 名位不花一石粮 —— 这一件永远办得成
    return null;
  }
  if (m.kind === 'war') {
    const src = st.nodes[m.fromId];
    if (!src) return null;
    if (st.sieges[m.fromId]) return '这座城正被围着';
    /**
     * 呈报是几十天前发的。等它到你手上，那座城的兵和粮早就变了 ——
     * 所以这里按**眼下**的账算，不按帖子上写的数。
     */
    const fed = Math.floor(Math.min(src.troops - 110, src.grain / 2));
    if (fed < 100) return src.troops - 110 < 100 ? '城里的兵不够' : '城里的粮不够';
    if (fed < m.amount) return `只发得出 ${fed} 人`;
    return null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 班列
// ─────────────────────────────────────────────────────────────

/**
 * 一屋子人，文东武西站两班。
 *
 * **不再上报的人站在最后一排，画得极淡，不写一个字。**
 * 那是这条线上最危险的信号 —— 得让玩家自己在某一天发现那儿站着个人。
 */
function Roll(
  { engine, idx, picked, setPicked, claiming, setClaiming, pillars }: {
    engine: Engine; idx: ContentIndex;
    picked: string | null; setPicked: (id: string | null) => void;
    claiming: boolean; setClaiming: (b: boolean) => void;
    pillars: { land: number; name: number; men: number; ready: boolean };
  },
) {
  const st = engine.getState();
  const court = st.court!;
  const people = ownPeople(st, idx);
  const postOf = new Map<string, string>();
  for (const [city, pid] of Object.entries(st.posts)) postOf.set(pid, city);

  // 文东武西。武的按勇力，文的按智略
  const isWu = (p: PersonDef): boolean => p.valor >= 74
    || p.good.some((g) => ['冲阵', '宿卫', '先登', '统众', '野战'].includes(g));
  const wen = people.filter((p) => !isWu(p));
  const wu = people.filter(isWu);
  const rank = (p: PersonDef): number =>
    (court.silent[p.id] !== undefined ? -1000 : 0) + heartOf(st, p.id)
    + (postOf.has(p.id) ? 40 : 0);
  wen.sort((a, b) => rank(b) - rank(a));
  wu.sort((a, b) => rank(b) - rank(a));

  const canForce = fameHeld(st, idx) >= FAME_FOR_FORCE
    && court.throne !== 'claimed' && court.throne !== 'forced' && court.throne !== 'refused';
  const one = picked ? idx.person.get(picked) : null;

  return (
    <div className="ct-roll">
      <div className="cr-floor" />

      <div className="cr-ranks">
        <Column
          title="文" side="left" people={wen}
          st={st} idx={idx} postOf={postOf} onPick={setPicked}
        />
        <Column
          title="武" side="right" people={wu}
          st={st} idx={idx} postOf={postOf} onPick={setPicked}
        />
      </div>

      {one && (
        <div className="cr-card" onClick={() => setPicked(null)}>
          <div className="crc-inner" onClick={(e) => e.stopPropagation()}>
            <Portrait
              who={one} color={idx.faction.get(one.faction)?.color} size={104} bare
            />
            <div className="crc-txt">
              <div className="crc-n">
                {one.name} <em>{one.courtesy}</em>
                <span className="crc-rank">{rankName(st, one)}</span>
              </div>
              <div className="crc-p">「{one.praise}」</div>
              <div className="crc-g">擅　{one.good.join(' · ')}</div>
              <div className="crc-f">忌　{one.flaw}</div>
              <div className="crc-m">{heartWord(heartOf(st, one.id))}
                {postOf.has(one.id)
                  ? `　守 ${idx.node.get(postOf.get(one.id)!)?.name}`
                  : '　闲居'}
              </div>
              <Ledger st={st} idx={idx} personId={one.id} />
            </div>
            <button className="crc-x" onClick={() => setPicked(null)}>×</button>
          </div>
        </div>
      )}

      <div className="cr-throne">
        <div className="crt-t">尊号</div>
        {court.throne === 'claimed' && <div className="crt-n">已受尊号。</div>}
        {court.throne === 'forced' && <div className="crt-n bad">不待劝进而自立。天下皆敌。</div>}
        {court.throne === 'refused' && <div className="crt-n">已明言终身不受。</div>}
        {(court.throne === 'none' || court.throne === 'declined') && (
          <>
            <Pillars p={pillars} declined={court.declined} />
            {canForce && !claiming && (
              <button className="crt-force" onClick={() => { Audio.click(); setClaiming(true); }}>
                不待劝进，自立为帝
              </button>
            )}
            {canForce && claiming && (
              <div className="crt-ask">
                <p>
                  袁术走过这条路。天下会一齐视你为敌，帐下重义的人当场就走 ——
                  但从此你可以用朝廷的名义封赏人。
                </p>
                <div className="crt-btns">
                  <button
                    className="crt-force yes"
                    onClick={() => {
                      Audio.drum();
                      engine.dispatch({ t: 'lord_claim' });
                      setClaiming(false);
                    }}
                  >称帝</button>
                  <button className="crt-no" onClick={() => setClaiming(false)}>再想想</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 太仓。
 *
 * ── 为什么要有这一屏 ────────────────────────────────
 *
 * 主公的粮原先是一个**没有来处的数**：屏上只显示「粮 8231」，
 * 而它涨落的原因全埋在代码里。玩家看到的永远是「不够」，
 * 却看不出是哪儿漏了、也不知道该去拧哪个旋钮。
 *
 * 现在它有来处了：**各城的守官每季把余粮解上来**（见 tribute.ts）。
 * 这一屏就是那本账 —— 而账上每一行都指着一个你做过的决定：
 *
 *   · 无人主事的城 —— 一粒也解不上来。那是你没派人
 *   · 「心不在此，解得不足」 —— 那是你驳过他几回
 *   · 「武人守之，账是糊涂的」 —— 那是你把一员猛将放在了案牍上
 *   · 品秩高的解得多 —— 那是你准过他的叙功
 *
 * **不做数值面板**：一行一句话，没有一根条。
 */
function Store({ engine, idx }: { engine: Engine; idx: ContentIndex }) {
  const st = engine.getState();
  const court = st.court!;
  const seat = st.nodes[st.official.cityId];
  const lines = tributeDue(st, idx);
  const soon = TRIBUTE_EVERY - (st.day % TRIBUTE_EVERY);
  const due = lines.reduce((a, l) => a + l.grain, 0);
  const deeds = court.deeds.slice(-7).reverse();

  return (
    <div className="ct-store">
      <div className="cs-store-top">
        <div className="cst-one">
          <em>太仓</em>
          <b>{seat?.grain ?? 0}</b>
          <i>石　（{idx.node.get(st.official.cityId)?.name}）</i>
        </div>
        <div className="cst-one">
          <em>下次上计</em>
          <b>{soon}</b>
          <i>日后　预计解 {due} 石</i>
        </div>
      </div>

      <div className="cst-t">各郡上计</div>
      <div className="cst-list">
        {lines.length === 0 && <div className="cst-none">治所之外别无城池。</div>}
        {lines.map((l) => {
          const who = l.personId ? idx.person.get(l.personId) : null;
          return (
            <div key={l.cityId} className={'cst-row' + (l.grain <= 0 ? ' none' : '')}>
              <span className="cst-c">{idx.node.get(l.cityId)?.name}</span>
              <span className="cst-w">
                {who ? rankName(st, who) + ' ' + who.name : '——'}
              </span>
              <span className="cst-g">{l.grain > 0 ? l.grain + ' 石' : '不上'}</span>
              <span className="cst-y">{l.why}</span>
            </div>
          );
        })}
      </div>

      <div className="cst-t">近事</div>
      <div className="cst-deeds">
        {deeds.length === 0 && <div className="cst-none">无事。</div>}
        {deeds.map((d, i) => (
          <div key={i} className={'cst-deed ' + d.tone}>
            <em>{formatDate(d.day)}</em>
            {renderText(idx.db.text, d.textId, d.vars)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 一班人。站得越靠后越淡 —— 这就是「远近」 */
function Column(
  { title, side, people, st, idx, postOf, onPick }: {
    title: string; side: 'left' | 'right'; people: PersonDef[];
    st: ReturnType<Engine['getState']>; idx: ContentIndex;
    postOf: Map<string, string>; onPick: (id: string) => void;
  },
) {
  return (
    <div className={'cr-col ' + side}>
      <div className="crc-t">{title}</div>
      <div className="crc-list">
        {people.length === 0 && <div className="crc-none">空</div>}
        {people.map((p, i) => {
          const quiet = st.court!.silent[p.id] !== undefined;
          /**
           * 越靠后站得越远：小一点、淡一点。
           *
           * 底线不能太低 —— 立像高一百五时那颗头只有四十几像素，
           * 冠、眉、须三团暗色一挤，脸就没了。**人得认得出是谁。**
           */
          const h = Math.max(150, 210 - i * 14);
          return (
            <button
              key={p.id}
              className={'cr-p' + (quiet ? ' quiet' : '')}
              style={{ opacity: quiet ? 0.32 : Math.max(0.45, 1 - i * 0.09) }}
              title={p.name}
              onClick={() => { Audio.click(); onPick(p.id); }}
            >
              <Figure
                who={p} color={idx.faction.get(p.faction)?.color}
                height={h} faded={quiet}
              />
              <span className="cr-p-n">{p.name}</span>
              {/* 职衔。**升迁第一次看得见的地方** —— 名字底下多了两个字 */}
              <span className={'cr-p-r' + (rankOf(st, p.id) >= 2 ? ' high' : '')}>
                {rankName(st, p)}
              </span>
              {postOf.has(p.id) && (
                <span className="cr-p-c">{idx.node.get(postOf.get(p.id)!)?.name}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 你对他做过的事 */
function Ledger(
  { st, idx, personId }: {
    st: ReturnType<Engine['getState']>; idx: ContentIndex; personId: string;
  },
) {
  const book = st.court?.ledger[personId] ?? [];
  if (book.length === 0) return <div className="crc-l none">还没求过你什么。</div>;
  return (
    <div className="crc-l">
      {[...book].reverse().map((e, i) => (
        <div key={i} className={'crc-le a-' + e.answer}>
          <span>{Math.floor(e.day / DAYS_PER_YEAR) + 190} 年</span>
          <span>{MEMORIAL_NAME[e.kind]}
            {idx.node.get(e.aboutId)?.name ? '·' + idx.node.get(e.aboutId)!.name : ''}</span>
          <span>{ANSWER_NAME[e.answer]}</span>
        </div>
      ))}
    </div>
  );
}

/** 三根柱子。不画进度条，写的是「还差什么」 */
function Pillars(
  { p, declined }: {
    p: { land: number; name: number; men: number; ready: boolean }; declined: number;
  },
) {
  if (p.ready) {
    return (
      <div className="crt-n good">
        土、名、人皆备。只等有人开口。
        {declined > 0 && <span>　已辞 {declined} 次。</span>}
      </div>
    );
  }
  const lack: string[] = [];
  if (p.land < 8) lack.push('名都未足');
  if (p.name < 58) lack.push('名未孚于天下');
  if (p.men < 4) lack.push('帐下无人肯言此事');
  return <div className="crt-n">{lack.join('，')}。</div>;
}

// ─────────────────────────────────────────────────────────────
// 这一屋子
// ─────────────────────────────────────────────────────────────

/**
 * 朝堂。
 *
 * 藻井、朱柱、帷幔、阶陛、烛与香 —— 全是渐变和几条线，
 * **不用一张图片**：表现层零外部美术资源，项目立起来就定的规矩。
 *
 * 分层用 div 而不是一整张 SVG：一整张要么被拉变形，要么柱子跑到屏幕外。
 * 现在梁贴顶、柱贴边、地贴底，各管各的，什么比例都立得住。
 *
 * 顶和地都用 CSS 的 `perspective + rotateX` 做真透视 ——
 * 一分钱不花，但**这一下把一块背景板变成了一间屋子**。
 */
function Hall() {
  return (
    <div className="ct-room" aria-hidden="true">
      <div className="cr-sky" />

      {/* 藻井。真透视，往里收 */}
      <div className="cr-ceil"><div className="cr-ceil-grid" /></div>

      {/* 地。也是真透视，砖缝往里收 */}
      <div className="cr-ground"><div className="cr-ground-grid" /></div>

      {/* 帷幔 */}
      <svg className="cr-drape" viewBox="0 0 480 52" preserveAspectRatio="none">
        <defs>
          <linearGradient id="crd" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8a2b1e" />
            <stop offset="55%" stopColor="#5e1c14" />
            <stop offset="100%" stopColor="#280e0a" />
          </linearGradient>
        </defs>
        <path
          d="M0 0 H480 V4
             Q450 46 420 4 Q390 46 360 4 Q330 46 300 4 Q270 46 240 4
             Q210 46 180 4 Q150 46 120 4 Q90 46 60 4 Q30 46 0 4 Z"
          fill="url(#crd)"
        />
        {/* 褶。一道浅一道深，帷幔才不是一块布片 */}
        {[30, 90, 150, 210, 270, 330, 390, 450].map((x) => (
          <path key={x} d={`M${x} 4 q0 22 0 34`} stroke="#2a0e09" strokeOpacity="0.5"
            strokeWidth="2" fill="none" />
        ))}
      </svg>

      {/* 柱。近两根粗，远两根细 —— 深度全靠这个 */}
      <div className="cr-pillar far left" />
      <div className="cr-pillar far right" />
      <div className="cr-pillar near left" />
      <div className="cr-pillar near right" />

      {/* 阶 */}
      <div className="cr-dais" />

      {/* 灯与香 */}
      <div className="cr-lamp l"><i /></div>
      <div className="cr-lamp r"><i /></div>
      <div className="cr-smoke s1" />
      <div className="cr-smoke s2" />

      <div className="cr-vignette" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 盖棺论定
// ─────────────────────────────────────────────────────────────

/**
 * 结局那一屏。
 *
 * **不给「Victory / Defeat」，给史书上的一段** —— 外加一张生平时间轴。
 * 失败不是「游戏结束」，是那一段写得不好看，
 * 而这一条比任何胜负判定都更让人想再来一局。
 */
export function CourtEnding(
  { engine, idx, onAgain }: { engine: Engine; idx: ContentIndex; onAgain: () => void },
) {
  const st = engine.getState();
  const court = st.court;
  const kind = st.ending?.kind ?? 'divided';
  const key = kind === 'scattered' ? 'end.scattered.lord' : 'end.' + kind;
  const title: Record<string, string> = {
    founded: '开　国', entrusted: '托　孤', divided: '身死业分', scattered: '无人肯为之死',
  };

  return (
    <div className="ct-end">
      <Hall />
      <div className="ce-inner">
        <div className="ce-kind">{title[kind] ?? ''}</div>
        <p className="ce-text">{renderText(idx.db.text, key)}</p>

        {court && court.reigns.length > 0 && (
          <div className="ce-life">
            <div className="ce-life-t">历　代</div>
            {court.reigns.map((r, i) => (
              <div key={i} className="ce-deed t-plain">
                <span className="cd-y">{Math.floor(r.fromDay / DAYS_PER_YEAR) + 190}
                  –{Math.floor(r.toDay / DAYS_PER_YEAR) + 190}</span>
                <span className="cd-w">
                  <b>{r.name}</b>　在位 {Math.max(1, Math.floor(
                    (r.toDay - r.fromDay) / DAYS_PER_YEAR,
                  ))} 年，卒年 {r.age}，据 {r.cities} 城
                </span>
              </div>
            ))}
            <div className="ce-deed t-plain">
              <span className="cd-y">{Math.floor((court.reigns[court.reigns.length - 1]?.toDay
                ?? 0) / DAYS_PER_YEAR) + 190}–</span>
              <span className="cd-w"><b>{court.lordName}</b>　末代</span>
            </div>
          </div>
        )}

        {court && (
          <div className="ce-life">
            <div className="ce-life-t">生平</div>
            {court.deeds.map((d, i) => (
              <div key={i} className={'ce-deed t-' + d.tone}>
                <span className="cd-y">{Math.floor(d.day / DAYS_PER_YEAR) + 190} 年</span>
                <span className="cd-w">{renderText(idx.db.text, d.textId, d.vars)}</span>
              </div>
            ))}
          </div>
        )}

        <button className="ce-again" onClick={() => { Audio.click(); onAgain(); }}>
          再来一局
        </button>
      </div>
    </div>
  );
}
