/**
 * 天下图 —— 主公主动的那一半。
 *
 * ── 为什么还要有这一屏 ──────────────────────────────
 *
 * 朝堂那一屏解决的是「别人替你想到的事」：有人请战、有人请粮，你批。
 * 但一个诸侯不能只会答复 —— **他得能自己看着地图说「打这儿」。**
 *
 * 所以两半是这样分的：
 *   引见 —— 事情找上你。**被动，有情绪，有人心。**
 *   天下 —— 你找事情。**主动，有算计，有方略。**
 *
 * ── 点一座城，看的是什么 ────────────────────────────
 *
 * 点自家的城 → 内政（派人、兴修）＋ 从这里出兵 ＋ 征调
 * 点别家的城 → **攻打**（哪几座自家城够得着、各能出多少兵）
 *              ＋ **遣使**（缓和与那一家的关系）
 *              ＋ 情报（守军、守将、他对你什么态度）
 *
 * 这就是「根据战略选外交还是攻打」那一下 —— 同一座城，两条路摆在一起。
 */
import { useState } from 'react';
import { Engine } from '../sim/engine.ts';
import type { ContentIndex } from '../sim/content.ts';
import { formatDate, SEASON_NAME, seasonOf } from '../sim/time.ts';
import { wardenOf } from '../sim/people.ts';
import { atWar } from '../sim/diplomacy.ts';
import {
  ENVOY_COST, idlePeople, investCost, KEEP_GARRISON,
} from '../sim/handlers_lord.ts';
import { CITY_DEV_PER_SCALE, type CityNode } from '../sim/world_types.ts';
import {
  EDICT_HINT, EDICT_NAME, LEVY_MORALE, ROAD_COST, roadKeyOf,
  type EdictKind,
} from '../sim/lord_types.ts';
import { edictWeight, isDefiant } from '../sim/edict.ts';
import { marchWait, roadWorks } from '../sim/court.ts';
import { planMarch, supplyFor } from '../sim/march.ts';
import { levyLook, seasonLevy } from '../sim/handlers_court.ts';
import {
  campAt, campCap, drillPermille, freeOfficers,
} from '../sim/barracks.ts';
import { CAMP_COST, DRAFT_STEP } from '../sim/lord_types.ts';
import { Portrait } from './portrait.tsx';
import { Audio } from '../audio/ambience.ts';

interface Props {
  engine: Engine;
  idx: ContentIndex;
  pickedCity: string | null;
  setPickedCity: (id: string | null) => void;
}

export function LordScreen({ engine, idx, pickedCity, setPickedCity }: Props) {
  const st = engine.getState();
  /**
   * 把面板收起来。
   *
   * 图是这一屏真正的主角 —— 城池、territory、烽烟、粮车都在图上，
   * 而右边那块面板一展开就压掉半张图。
   * **要看图的时候就该看得见图。** 收起来只留一条窄边，再点一下回来。
   */
  const [hidden, setHidden] = useState(false);
  const me = st.official.lordId;
  const f = idx.faction.get(me);

  const held = Object.values(st.nodes).filter((n) => n.factionId === me);
  const troops = held.reduce((a, n) => a + n.troops, 0);
  const grain = held.reduce((a, n) => a + n.grain, 0);
  const bare = held.filter((n) => !wardenOf(st, idx, n.id)).length;
  const free = idlePeople(st, idx).length;
  const marching = Object.values(st.armies).filter((a) => a.factionId === me);

  return (
    <>
      <div className="lm-top">
        <div className="lm-when">
          <div className="lm-date">{formatDate(st.day)}</div>
          <div className="lm-sub">{SEASON_NAME[seasonOf(st.day)]} · {f?.name} · 据 {held.length} 城</div>
        </div>
        <div className="lm-stats">
          <span><i>兵</i>{troops}</span>
          <span><i>粮</i>{grain}</span>
          <span className={free === 0 && bare > 0 ? 'bad' : ''}><i>闲人</i>{free}</span>
          {bare > 0 && <span className="bad"><i>无人守</i>{bare}</span>}
          {marching.length > 0 && <span><i>在路</i>{marching.length}</span>}
        </div>

        {/**
          * 收起面板的开关**摆在顶栏里**，不浮在面板上头。
          *
          * 头一版是一个贴着面板右缘的浮动按钮 —— 窄一点的屏上它正好压住
          * 那一栏右上角的「×」，玩家关不掉当前这座城。
          * 顶栏这一行本来就是空的，而且它和面板永不重叠。
          */}
        <button
          className={'lm-fold' + (hidden ? ' off' : '')}
          onClick={() => { Audio.click(); setHidden(!hidden); }}
          title={hidden ? '把方略面板放回来' : '收起面板，看图'}
        >
          {hidden ? '展开方略' : '收起面板'}
        </button>
      </div>

      {!hidden && (pickedCity
        ? <Plan engine={engine} idx={idx} id={pickedCity} onClose={() => setPickedCity(null)} />
        : <Realm engine={engine} idx={idx} onPick={setPickedCity} />)}
    </>
  );
}

/**
 * 辖境一览。
 *
 * **「哪几处没人守」要一眼看得见** —— 那是主公线上唯一会不断追着你的事。
 */
function Realm(
  { engine, idx, onPick }:
  { engine: Engine; idx: ContentIndex; onPick: (id: string) => void },
) {
  const st = engine.getState();
  const me = st.official.lordId;
  const held = Object.values(st.nodes)
    .filter((n) => n.factionId === me)
    .sort((a, b) => b.troops - a.troops);

  return (
    <div className="lm-panel">
      <div className="lm-t">辖境<b>{held.length} 城</b></div>
      <div className="lm-list">
        {held.map((n) => {
          const w = wardenOf(st, idx, n.id);
          const sg = st.sieges[n.id];
          return (
            <button key={n.id} className={'lm-city' + (sg ? ' sieged' : '')}
              onClick={() => { Audio.click(); onPick(n.id); }}>
              <span className="lc-n">{idx.node.get(n.id)?.name}</span>
              <span className={'lc-w' + (w ? '' : ' none')}>{w ? w.name : '无人守'}</span>
              <span className="lc-t">兵 {n.troops}</span>
              <span className="lc-g">粮 {n.grain}</span>
              {sg && <span className="lc-s">被围 {sg.days} 日</span>}
            </button>
          );
        })}
      </div>
      <div className="lm-hint">点地图上任意一座城 —— 自家的下令，别家的看要打还是要谈。</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 方略
// ─────────────────────────────────────────────────────────────

/**
 * 一座城这会儿真发得出多少兵。
 *
 * 两道坎：留够看家的（`KEEP_GARRISON`），以及**喂得起**。
 * 后面这一条界面上一定要照实说 —— 早先只按「余兵」标数，
 * 玩家点下去却什么也不发生，因为粮不够；他看到的是按钮坏了。
 */
function sendable(n: CityNode): { spare: number; fed: number } {
  const spare = Math.max(0, n.troops - KEEP_GARRISON);
  return { spare, fed: Math.min(spare, Math.floor(n.grain / 2)) };
}

/**
 * 从我这边出兵打这里，有哪几条路。
 *
 * ── 为什么不再只看「挨不挨着」 ──────────────────────
 *
 * 原先这里只列**紧挨着目标的自家城**，别的一律一句
 * 「这地方不挨着你的任何一座城」—— 天下图上大半座城点开都是这句话，
 * 而它既不合地理也不合史实（见 march.ts）。
 *
 * 现在每一座自家的城、每一座营都算一条路，各自报上：
 * **走多少天、经谁的地界、一路折多少人、到得了多少人。**
 * 近的兵少、远的兵多、还有一路要看别人肯不肯借道 —— 那才叫权衡。
 */
interface Route {
  key: string;
  fromId: string;
  campId: string | null;
  personId: string | null;
  /** 出发时带多少人 */
  send: number;
  /** 折过损耗，到地方大约剩多少 */
  arrive: number;
  days: number;
  wastePermille: number;
  borrow: string[];
  refused: string | null;
  /** 发不出兵的话，是为什么 */
  why: string | null;
}

function routesTo(
  st: ReturnType<Engine['getState']>, idx: ContentIndex, target: string,
): Route[] {
  const me = st.official.lordId;
  const out: Route[] = [];

  const push = (
    fromId: string, campId: string | null, personId: string | null, pool: number,
  ): void => {
    const plan = planMarch(st, idx, fromId, target, me);
    const src = st.nodes[fromId];
    if (!plan || !src) return;
    // 路越远，同样的粮带得动的人越少
    const per = Math.max(2, Math.round(supplyFor(1000, plan.days) / 1000));
    const fed = Math.floor(src.grain / per);
    const send = Math.max(0, Math.min(pool, fed));
    const arrive = Math.round(send * (1 - plan.wastePermille / 1000));
    out.push({
      key: (campId ? 'camp:' + campId : 'city:' + fromId),
      fromId, campId, personId, send, arrive,
      days: plan.days, wastePermille: plan.wastePermille,
      borrow: plan.borrow, refused: plan.refused,
      why: plan.refused
        ? `${idx.faction.get(plan.refused)?.name ?? plan.refused}不肯借道`
        : send < 60 ? (pool < 60 ? '抽不出兵' : '粮不够走这一趟') : null,
    });
  };

  for (const n of Object.values(st.nodes)) {
    if (n.factionId !== me || n.id === target || st.sieges[n.id]) continue;
    const camp = campAt(st, n.id);
    if (camp) {
      push(n.id, camp.id, camp.officerId, camp.troops);
    }
    push(n.id, null, wardenOf(st, idx, n.id)?.id ?? null, sendable(n).spare);
  }

  /** 到得了多少人排前面 —— 那才是这一路的分量 */
  out.sort((a, b) => {
    if (!!a.refused !== !!b.refused) return a.refused ? 1 : -1;
    if (!a.why !== !b.why) return a.why ? 1 : -1;
    return b.arrive - a.arrive || a.days - b.days || a.key.localeCompare(b.key);
  });
  return out.slice(0, 5);
}

function Plan(
  { engine, idx, id, onClose }:
  { engine: Engine; idx: ContentIndex; id: string; onClose: () => void },
) {
  const st = engine.getState();
  const node = st.nodes[id];
  const def = idx.node.get(id);
  const [picking, setPicking] = useState(false);
  if (!node || !def) return null;

  const me = st.official.lordId;
  const ours = node.factionId === me;
  const w = wardenOf(st, idx, id);
  const theirs = idx.faction.get(node.factionId);
  const att = st.factions[node.factionId]?.attitude[me] ?? 0;
  const hostile = !ours && atWar(st, me, node.factionId);

  return (
    <div className="lm-panel plan">
      <div className="lm-t">
        {def.name}
        {def.fame ? <em className="lm-fame">名都</em> : null}
        <button className="lm-x" onClick={() => { Audio.click(); onClose(); }}>×</button>
      </div>
      <div className="lm-desc">{def.desc}</div>

      {/* ── 情报。别家的城先看清楚再决定打还是谈 ── */}
      <div className="lm-intel">
        <span className="li-f" style={{ color: theirs?.color }}>{theirs?.name}</span>
        <span>守军 {node.troops}</span>
        <span>{w ? '守将 ' + w.name : '无人守'}</span>
        {!ours && (
          <span className={hostile ? 'li-war' : ''}>
            {hostile ? '与你交恶' : att > 20 ? '与你亲善' : '眼下无仇'}
          </span>
        )}
        {ours && <span>开发 {node.dev}／{Math.max(1, def.scale) * CITY_DEV_PER_SCALE}</span>}
      </div>

      {ours
        ? <Ours engine={engine} idx={idx} id={id} node={node} w={w}
            picking={picking} setPicking={setPicking} />
        : <Theirs engine={engine} idx={idx} id={id} node={node} />}
    </div>
  );
}

/** 自家的城：内政、出兵、征调 */
function Ours(
  { engine, idx, id, node, w, picking, setPicking }: {
    engine: Engine; idx: ContentIndex; id: string; node: CityNode;
    w: ReturnType<typeof wardenOf>;
    picking: boolean; setPicking: (b: boolean) => void;
  },
) {
  const st = engine.getState();
  const def = idx.node.get(id)!;
  const cost = investCost(node.dev);
  const cap = Math.max(1, def.scale) * CITY_DEV_PER_SCALE;
  const { spare, fed } = sendable(node);
  const free = idlePeople(st, idx)
    .map((pid) => idx.person.get(pid))
    .filter((p): p is NonNullable<typeof p> => !!p);
  const outs = def.links.filter((x) => st.nodes[x]);

  return (
    <>
      <div className="lm-sec">内政</div>

      <div className={'lm-warden' + (w ? '' : ' none')}>
        {w
          ? (
            <>
              <Portrait who={w} color={idx.faction.get(w.faction)?.color} size={42} bare />
              <div className="lw-txt">
                <b>{w.name}</b><span>「{w.praise}」</span>
                <em>{w.good.join(' · ')}</em>
              </div>
            </>
          )
          : <div className="lw-txt none">无人守 —— 兵是散的</div>}
        <button className="lm-mini" onClick={() => { Audio.click(); setPicking(!picking); }}>
          {w ? '换人' : '派人'}
        </button>
      </div>

      {picking && (
        <div className="lm-pick">
          {free.length === 0
            ? <div className="lm-none">帐下没有闲人了。城多了就是这样。</div>
            : free.map((p) => (
              <button key={p.id} className="lm-cand" onClick={() => {
                Audio.chime();
                engine.dispatch({ t: 'lord_appoint', cityId: id, personId: p.id });
                setPicking(false);
              }}>
                <Portrait who={p} color={idx.faction.get(p.faction)?.color} size={38} bare />
                <span><b>{p.name}</b>　{p.praise}<em>擅 {p.good.join(' · ')}　忌 {p.flaw}</em></span>
              </button>
            ))}
        </div>
      )}

      <button
        className="lm-act"
        disabled={node.dev >= cap || node.grain < cost || !!st.sieges[id]}
        onClick={() => { Audio.click(); engine.dispatch({ t: 'lord_invest', cityId: id }); }}
      >
        拨粮兴修
        <em>{node.dev >= cap ? '到顶了 —— 小县做不成大邑'
          : st.sieges[id] ? '正被围着' : `${cost} 石 · 开发 +1`}</em>
      </button>

      <div className="lm-sec">
        军事<b>余兵 {spare}{fed < spare ? `，粮只够 ${fed}` : ''}</b>
      </div>

      {/**
        * 募兵。**主公唯一能把粮变成兵的动词。**
        * 摆在军事这一段的头一个 —— 兵不够的时候，玩家第一眼该看见它。
        */}
      {(() => {
        const lv = levyLook(st, idx, id);
        return (
          <button
            className="lm-act"
            disabled={lv.men <= 0}
            onClick={() => { Audio.drum(); engine.dispatch({ t: 'lord_levy', cityId: id }); }}
          >
            募兵
            <em>
              {lv.why ?? (`募 ${lv.men} 人 · 出 ${lv.men * 3} 石 · `
                + `民心 −${Math.round(LEVY_MORALE / seasonLevy(st.day))}`
                + `　${seasonLevy(st.day) >= 1.3 ? '农隙，正是募兵的时候'
                  : seasonLevy(st.day) >= 1 ? '秋收方毕，招得上人'
                    : '农忙，抽壮丁伤这一年的收成'}`)}
            </em>
          </button>
        );
      })()}

      <button
        className="lm-act"
        disabled={!!st.sieges[id]}
        onClick={() => { Audio.drum(); engine.dispatch({ t: 'lord_muster', cityId: id }); }}
      >
        征调各城之兵
        <em>辖境各城的余兵往这儿集结。这些日子你的后方是空的</em>
      </button>

      {/**
        * 驿。
        *
        * **消息跟不上是「城多了管不过来」的第二个形态。**
        * 第一个是人不够 —— 那个玩家很快就会撞上；
        * 这一个要等地盘铺开、某一封求援走了二十天才到，他才会想起来这儿有个按钮。
        */}
      {/**
        * 军营。
        *
        * **城里的兵守家，营里的兵野战。** 出兵不再掏空守军 ——
        * 这一段是这条线上攻守两笔账真正分开的地方。
        */}
      <Camp engine={engine} idx={idx} id={id} node={node} />

      <div className="lm-sec sub">驿路</div>
      {outs.map((to) => {
        const key = roadKeyOf(id, to);
        const has = !!st.court?.roads[key];
        const open = roadWorks(st, id, to);
        const seat = st.nodes[st.official.cityId];
        const can = !has && (seat?.grain ?? 0) >= ROAD_COST + 150
          && (node.factionId === st.official.lordId
            || st.nodes[to]?.factionId === st.official.lordId);
        return (
          <button
            key={to}
            className={'lm-march' + (has ? ' own' : '')}
            disabled={has || !can}
            onClick={() => { Audio.click(); engine.dispatch({ t: 'lord_road', fromId: id, toId: to }); }}
          >
            <span className="lm-n">往 {idx.node.get(to)?.name}</span>
            <span className="lm-d">
              {has ? (open ? '驿路已通　信使快一半，也不易被截' : '驿断了 —— 两头有一头正被围')
                : `${ROAD_COST} 石`}
            </span>
            <span className="lm-go">{has ? (open ? '已通' : '断') : can ? '修驿' : '粮不够'}</span>
          </button>
        );
      })}

      <div className="lm-sec sub">从这里出兵</div>
      {outs.map((to) => {
        const n = st.nodes[to]!;
        const mine = n.factionId === st.official.lordId;
        const tw = wardenOf(st, idx, to);
        return (
          <button
            key={to}
            className={'lm-march' + (mine ? ' own' : '')}
            disabled={fed < 60 || (!mine && marchWait(st) > 0)}
            onClick={() => {
              Audio.drum();
              engine.dispatch({ t: 'lord_march', fromId: id, toId: to, troops: fed });
            }}
          >
            <span className="lm-n">{idx.node.get(to)?.name}</span>
            <span className="lm-f" style={{ color: idx.faction.get(n.factionId)?.color }}>
              {idx.faction.get(n.factionId)?.name}
            </span>
            <span className="lm-d">守 {n.troops}{tw ? '　' + tw.name : ''}</span>
            <span className="lm-go">
              {fed < 60 ? (spare < 60 ? '兵不够' : '粮不够')
                : !mine && marchWait(st) > 0 ? `还要 ${marchWait(st)} 日`
                  : `${mine ? '增援' : '出兵'} ${fed}`}
            </span>
          </button>
        );
      })}
    </>
  );
}

/**
 * 城外那座营。
 *
 * 没有营 → 立营（只挑得出武将）。
 * 有营   → 兵、操练、拨兵、以及**从营出兵**（不动城里一个人）。
 */
function Camp(
  { engine, idx, id, node }: {
    engine: Engine; idx: ContentIndex; id: string; node: CityNode;
  },
) {
  const st = engine.getState();
  const camp = campAt(st, id);
  const [picking, setPicking] = useState(false);

  if (!camp) {
    const free = freeOfficers(st, idx)
      .map((pid) => idx.person.get(pid))
      .filter((p): p is NonNullable<typeof p> => !!p);
    const can = node.grain >= CAMP_COST + 200 && !st.sieges[id];
    return (
      <>
        <div className="lm-sec sub">军营</div>
        <button
          className="lm-act"
          disabled={!can}
          onClick={() => { Audio.click(); setPicking(!picking); }}
        >
          立营
          <em>
            {st.sieges[id] ? '正被围着，立不了营'
              : node.grain < CAMP_COST + 200 ? `粮不够（要 ${CAMP_COST} 石）`
                : `${CAMP_COST} 石 · 城里的兵守家，营里的兵野战 —— 出兵不再掏空守军`}
          </em>
        </button>
        {picking && (
          <div className="lm-pick">
            {free.length === 0
              ? <div className="lm-none">帐下没有闲着的武将了。一将不能分身。</div>
              : free.map((p) => (
                <button key={p.id} className="lm-cand" onClick={() => {
                  Audio.drum();
                  engine.dispatch({ t: 'lord_camp_open', cityId: id, personId: p.id });
                  setPicking(false);
                }}>
                  <Portrait who={p} color={idx.faction.get(p.faction)?.color} size={38} bare />
                  <span><b>{p.name}</b>　{p.praise}<em>擅 {p.good.join(' · ')}</em></span>
                </button>
              ))}
          </div>
        )}
      </>
    );
  }

  const who = idx.person.get(camp.officerId);
  const cap = campCap(st, camp);
  const spare = node.troops - KEEP_GARRISON;
  const outs = (idx.node.get(id)?.links ?? []).filter((x) => st.nodes[x]);
  const wait = marchWait(st);

  return (
    <>
      <div className="lm-sec sub">军营<b>{camp.troops}／{cap} 人</b></div>
      <div className="lm-camp">
        {who && <Portrait who={who} color={idx.faction.get(who.faction)?.color} size={42} bare />}
        <div className="lc-txt">
          <b>{who?.name}</b>　领 {camp.troops} 人
          <em>
            操练 {drillWord(camp.drill)}　—— 战力约 {(drillPermille(camp) / 10).toFixed(0)}%
            {camp.troops < campCap(st, camp)
              ? '　他自己在募部曲（每旬一批，出安家费）'
              : '　营已满员'}
          </em>
        </div>
        <button
          className="lm-mini"
          onClick={() => { Audio.click(); engine.dispatch({ t: 'lord_camp_close', campId: camp.id }); }}
        >撤营</button>
      </div>

      <div className="lm-draft">
        <button
          className="lm-mini"
          disabled={spare < DRAFT_STEP / 4 || camp.troops >= cap}
          onClick={() => {
            Audio.click();
            engine.dispatch({ t: 'lord_draft', campId: camp.id, men: DRAFT_STEP });
          }}
        >城 → 营 {Math.min(DRAFT_STEP, Math.max(0, spare))}</button>
        <button
          className="lm-mini"
          disabled={camp.troops < 20}
          onClick={() => {
            Audio.click();
            engine.dispatch({ t: 'lord_draft', campId: camp.id, men: -DRAFT_STEP });
          }}
        >营 → 城 {Math.min(DRAFT_STEP, camp.troops)}</button>
      </div>

      {camp.troops >= 60 && outs.map((to) => {
        const n = st.nodes[to]!;
        const mine = n.factionId === st.official.lordId;
        const blocked = !mine && wait > 0;
        return (
          <button
            key={to}
            className={'lm-march' + (mine ? ' own' : '')}
            disabled={blocked}
            onClick={() => {
              Audio.drum();
              engine.dispatch({
                t: 'lord_camp_march', campId: camp.id, toId: to, men: camp.troops,
              });
            }}
          >
            <span className="lm-n">营出 {idx.node.get(to)?.name}</span>
            <span className="lm-d">
              {camp.troops} 人（练成 {(drillPermille(camp) / 10).toFixed(0)}%）　守 {n.troops}
            </span>
            <span className="lm-go">
              {blocked ? `还要 ${wait} 日` : mine ? '驰援' : '出击'}
            </span>
          </button>
        );
      })}
    </>
  );
}

/** 操练成什么样了。**不摆数字条** —— 一句话就够 */
function drillWord(d: number): string {
  if (d >= 90) return '如臂使指';
  if (d >= 70) return '行伍已成';
  if (d >= 45) return '粗知进退';
  if (d >= 20) return '尚在教习';
  return '新集之众';
}

/**
 * 别家的城：**打，还是谈。**
 *
 * 两条路摆在同一屏上，而且各自的代价写在按钮上 ——
 * 这才叫「根据战略选」，不是两个藏在不同菜单里的按钮。
 */
function Theirs(
  { engine, idx, id, node }: {
    engine: Engine; idx: ContentIndex; id: string; node: CityNode;
  },
) {
  const st = engine.getState();
  const me = st.official.lordId;
  const from = routesTo(st, idx, id);
  const seat = st.nodes[st.official.cityId];
  const canEnvoy = (seat?.grain ?? 0) >= ENVOY_COST
    && seat?.factionId === me && node.factionId !== 'bandit';
  const best = from.find((r) => !r.refused && !r.why);
  const wait = marchWait(st);

  return (
    <>
      <div className="lm-sec">攻</div>
      {from.length === 0
        ? <div className="lm-none">你手上一座城也没有了。</div>
        : from.map((r) => {
          const edge = r.arrive / Math.max(1, node.troops);
          const feel = edge >= 2 ? '胜算很大' : edge >= 1.3 ? '有胜算'
            : edge >= 0.9 ? '五五之数' : '兵力不足';
          const who = r.personId ? idx.person.get(r.personId) : null;
          const borrow = r.borrow.map((f) => idx.faction.get(f)?.name ?? f).join('、');
          const stop = r.refused ? r.why : r.why ? r.why : wait > 0 ? `还要 ${wait} 日` : null;
          return (
            <button
              key={r.key}
              className={'lm-march' + (stop ? '' : edge >= 1.3 ? ' good' : edge < 0.9 ? ' risky' : '')}
              disabled={!!stop}
              onClick={() => {
                Audio.drum();
                if (r.campId) {
                  engine.dispatch({
                    t: 'lord_camp_march', campId: r.campId, toId: id, men: r.send,
                  });
                } else {
                  engine.dispatch({
                    t: 'lord_march', fromId: r.fromId, toId: id, troops: r.send,
                  });
                }
              }}
            >
              <span className="lm-n">
                {r.campId ? '营出' : '自'} {idx.node.get(r.fromId)?.name}
                {who ? '　' + who.name : ''}
              </span>
              <span className="lm-d">
                {/**
                  * **路上要付的账，写在按钮上。**
                  * 走几天、经谁的地界、一路折多少人 —— 这三样是远征唯一的成本，
                  * 玩家该在点下去之前就看见。
                  */}
                {r.send} 人 · {r.days} 日
                {r.wastePermille > 0
                  ? `　途中折 ${Math.round(r.wastePermille / 10)}%，到 ${r.arrive}`
                  : ''}
                {borrow ? `　经${borrow}之境` : ''}
                　对 {node.troops}
              </span>
              <span className="lm-go">{stop || feel}</span>
            </button>
          );
        })}
      {best && best.arrive < node.troops * 1.3 && (
        <div className="lm-tip">兵不够就先回自家城「征调」，把各处余兵调到一处再来。</div>
      )}
      {from.some((r) => r.refused) && (
        <div className="lm-tip">
          不肯借道的那几家，遣使缓一缓关系就通了 —— 假道伐虢，从来先要一句话。
        </div>
      )}

      <div className="lm-sec">谈</div>

      {/**
        * 下诏。
        *
        * **一道诏下去，动的是别人的兵。** 而且抗诏的那一家从此背着一个「逆」字 ——
        * 你打他名正言顺，打赢望还涨。这是全局唯一一处让进攻涨望的开关。
        */}
      {st.court?.emperor && (
        <>
          {isDefiant(st, node.factionId) && (
            <div className="lm-tip def">此家抗诏在先 —— 讨之名正言顺，克城之日望反而涨。</div>
          )}
          {(['disband', 'tribute', 'yield', 'denounce'] as EdictKind[]).map((k) => (
            <button
              key={k}
              className="lm-act"
              disabled={edictWeight(st) <= 0}
              onClick={() => {
                Audio.chime();
                engine.dispatch({ t: 'lord_edict', to: node.factionId, kind: k });
              }}
            >
              诏{idx.faction.get(node.factionId)?.name}{EDICT_NAME[k]}
              <em>
                {edictWeight(st) <= 0
                  ? '今年的诏下得太多了 —— 再下，天下就知道那是谁写的了'
                  : `${EDICT_HINT[k]}　（这一道还剩 ${Math.round(edictWeight(st) * 100)} 分力气）`}
              </em>
            </button>
          ))}
        </>
      )}

      <button
        className="lm-act"
        disabled={!canEnvoy}
        onClick={() => {
          Audio.click();
          engine.dispatch({ t: 'lord_envoy', factionId: node.factionId });
        }}
      >
        遣使{idx.faction.get(node.factionId)?.name}
        <em>{canEnvoy
          ? `治所出 ${ENVOY_COST} 石。结下的仇不是一趟使节化得开的，但能少一面是一面`
          : '治所的粮不够，或那一家已经没了地盘'}</em>
      </button>
    </>
  );
}
