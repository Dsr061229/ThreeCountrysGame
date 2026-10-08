/**
 * 武将的界面。
 *
 * 与文官最大的不同：**武将不看城，看地图**。
 * 所以这条线的主视图就是天下图，营里的事压在左边一条，
 * 中间那片地留给「往哪儿打」。
 *
 * 这里最要紧的一块是点将台（WarCouncil）——
 * 它是武将与文官真正拉开的地方：文官那条线上没有这一层。
 * 所以它不能是一张表单，得是一张**舆图**：
 * 三条道画出来，你把兵摆到道上，看得见谁走哪条、几日能到。
 */
import { useState } from 'react';
import { Engine } from '../sim/engine.ts';
import type { ContentIndex } from '../sim/content.ts';
import { vacantPosts } from '../sim/handlers_general.ts';
import {
  busyOn, campOutput, daysOfGrain, facilityCost, facilityCount, grainFlowOf,
  harvestOf, moraleTargetOf, rationCapOf, strengthOf,
} from '../sim/camp.ts';
import {
  COURT_DAYS, COURT_GRAIN, DRILL_DAYS, FACILITY_SLOTS, GEAR_DAYS, GEAR_GRAIN, STARTING_CAMP,
  LEVIES, LEVY_NAME, MILITARY_RANKS, SITE_NAME, SITE_NOTE, TRACK_NAME, trackOf,
  type Camp, type Levy,
} from '../sim/general_types.ts';
import {
  APPROACH_NAME, MAX_COLUMNS, MIN_COLUMN_MEN, MISSION_DESC, MISSION_NAME,
  ROUTE_NAME, type Campaign, type Mission, type Route,
} from '../sim/campaign_types.ts';
import { TEMPER_DESC, TEMPER_NAME, type Officer } from '../sim/officer_types.ts';
import { Audio } from '../audio/ambience.ts';

// ─────────────────────────────────────────────────────────────
// 顶栏
// ─────────────────────────────────────────────────────────────

export function CampMeters({ camp, idx }: { camp: Camp; idx: ContentIndex }) {
  const days = daysOfGrain(camp);
  const flow = grainFlowOf(camp);
  const target = moraleTargetOf(camp);
  const out = campOutput(camp, idx);
  return (
    <>
      <div className="meter" title="营中之兵">
        <div className="m-label">兵</div>
        <div className="m-value">{camp.troops}<span className="m-cap"> 人</span></div>
        <div className="m-bar"><i style={{ width: Math.min(100, camp.troops / 25) + '%' }} /></div>
        {camp.retainers > 0 && <div className="m-rate">部曲 {camp.retainers}</div>}
      </div>

      <div
        className={'meter' + (days < 30 ? ' full' : '')}
        title={'营中存粮。仓容 ' + out.grainCap + ' 石，还够吃 ' + days + ' 日'}
      >
        <div className="m-label">粮</div>
        <div className="m-value">{camp.grain}<span className="m-cap"> 石</span></div>
        <div className="m-bar">
          <i style={{ width: Math.min(100, (camp.grain / out.grainCap) * 100) + '%' }} />
        </div>
        <div className={'m-rate' + (flow < 0 ? ' neg' : '')}>
          {flow >= 0 ? '+' : ''}{flow}／日
        </div>
      </div>

      <div className="meter" title={camp.farming ? '兵在地里，训练度掉得快' : '不练就生疏'}>
        <div className="m-label">训练</div>
        <div className="m-value">{camp.training}</div>
        <div className="m-bar">
          <i style={{ width: camp.training + '%' }} />
          {/* 上限画一道刻线 —— 练到那儿就再也上不去了 */}
          <b className="m-cap-tick" style={{ left: out.trainCap + '%' }} />
        </div>
        <div className="m-rate">
          {camp.farming ? '屯田中' : '上限 ' + out.trainCap}
        </div>
      </div>

      <div className="meter" title={'安处的军心在 ' + target + ' 上下'}>
        <div className="m-label">军心</div>
        <div className="m-value">{camp.morale}</div>
        <div className="m-bar"><i style={{ width: camp.morale + '%' }} /></div>
        <div className="m-rate">{camp.morale < target ? '↑' : camp.morale > target ? '↓' : ''}</div>
      </div>

      <div className="meter" title="战力：兵数 × 训练 × 军心 × 器械">
        <div className="m-label">战力</div>
        <div className="m-value">{strengthOf(camp)}</div>
        <div className="m-bar"><i style={{ width: Math.min(100, strengthOf(camp) / 20) + '%' }} /></div>
        <div className="m-rate">器械 {camp.gear}／{out.gearCap}</div>
      </div>
    </>
  );
}

/**
 * 主公的军令。
 *
 * 这是武将这条线的心跳，所以它压在屏幕正中上方 —— 躲不开。
 *
 * **抗命是一个真的选项。**「将在外，君命有所不受」这句话
 * 若只是句台词，那这条线就还是任务栏。
 * 所以拒绝就在旁边摆着，代价写清楚，你自己掂量。
 */
export function OrderBanner(
  { engine, idx }: { engine: Engine; idx: ContentIndex },
) {
  const st = engine.getState();
  const o = st.order;
  if (!o || o.outcome !== 'pending') return null;

  const where = o.targetNodeId ? idx.node.get(o.targetNodeId)?.name ?? o.targetNodeId : '';
  const left = Math.max(0, o.dueDay - st.day);
  const camp = st.camps[STARTING_CAMP];

  const what = o.kind === 'relieve' ? '驰援 ' + where + '，击退城下之敌'
    : o.kind === 'assault' ? '进取 ' + where
      : o.kind === 'tribute' ? '输粮 ' + o.amount + ' 石至中军'
        : '按兵不动，守好你的营';

  return (
    <div className={'order-banner' + (left < 20 ? ' urgent' : '')}>
      <div className="ob-head">
        主公有令
        <span className="ob-days">{left} 日内</span>
      </div>
      <div className="ob-what">{what}</div>
      {!o.accepted ? (
        <div className="ob-row">
          <button
            className="ob-take"
            onClick={() => { Audio.click(); engine.dispatch({ t: 'order_accept' }); }}
          >
            领 命
          </button>
          <button
            className="ob-defy"
            title="将在外，君命有所不受。但主公会记着"
            onClick={() => { Audio.click(); engine.dispatch({ t: 'order_defy' }); }}
          >
            抗 命
          </button>
        </div>
      ) : o.kind === 'tribute' ? (
        <div className="ob-row">
          <button
            className="ob-take"
            disabled={(camp?.grain ?? 0) < o.amount}
            onClick={() => { Audio.click(); engine.dispatch({ t: 'order_tribute' }); }}
          >
            {(camp?.grain ?? 0) < o.amount ? '粮不够' : '发 粮'}
          </button>
        </div>
      ) : (
        <div className="ob-note">
          {o.kind === 'garrison' ? '守着就是了。' : '在天下图上点那座城，出兵。'}
        </div>
      )}
    </div>
  );
}

/** 粮快断的时候，这一条要顶在最上面 */
export function GrainAlarm({ camp }: { camp: Camp }) {
  const days = daysOfGrain(camp);
  if (days > 45) return null;
  return (
    <div className={'grain-alarm' + (days < 15 ? ' dire' : '')}>
      {days <= 0
        ? '断粮了。每日都有人逃。'
        : '营中之粮只够 ' + days + ' 日。'}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 营内
// ─────────────────────────────────────────────────────────────

const LEVY_ORDER: Levy[] = ['refugee', 'frontier', 'retainer'];

const LEVY_NOTE: Record<Levy, string> = {
  refugee: '流民多而弱。招得快、要的安家粮少，但拉来就是一群不会打仗的人。',
  frontier: '边民少而悍。人不多，个个能打，安家粮要得也重。',
  retainer: '豪族部曲不吃你的粮——他们自有主人。也正因如此，人心不在你这里。',
};

export function CampPanel(
  { engine, idx, camp, campId }:
  { engine: Engine; idx: ContentIndex; camp: Camp; campId: string },
) {
  const st = engine.getState();
  const out = campOutput(camp, idx);
  const cap = rationCapOf(st.official.rank);
  const asked = st.ration && st.ration.outcome === 'pending' ? st.ration : null;

  const start = (job: 'levy' | 'drill' | 'gear', levy?: Levy): void => {
    Audio.click();
    engine.dispatch(levy
      ? { t: 'camp_work', campId, job, levy }
      : { t: 'camp_work', campId, job });
  };

  const here = idx.node.get(camp.nodeId);

  return (
    <div className="camp-panel">
      {/*
        多栏必须套在滚动条**里面**。
        一个限了高度的多栏容器不会往下滚，它会往右**溢出成更多列** ——
        实测三百像素宽的面板内容铺到五百八，右半边的字全在框外，
        而且横着也滚不到。所以外层管滚动，内层才分栏。
      */}
      <div className="cp-flow">
      <div className="cp-title">
        营中
        <span className="cp-site" title={SITE_NOTE[camp.site]}>
          {SITE_NAME[camp.site]}
          {here && <span className="dim">　{here.name}外</span>}
        </span>
      </div>
      <div className="cp-sitenote">{SITE_NOTE[camp.site]}</div>

      {/* 手上的几摊活。募、练、工三摊人各干各的，
          所以这里可能同时挂着三条 */}
      <Ongoing engine={engine} idx={idx} camp={camp} campId={campId} />


      {/* 屯田是这条线上唯一自己长粮的路子，所以摆在最上面 */}
      <button
        className={'cp-farm' + (camp.farming ? ' on' : '')}
        onClick={() => {
          Audio.click();
          engine.dispatch({ t: 'camp_farm', campId, on: !camp.farming });
        }}
      >
        {camp.farming ? '收 屯' : '开 屯'}
        <em>
          {camp.farming
            ? '每日得粮 ' + harvestOf(camp) + '，但兵在生疏'
            : '兵去种地：每日可得粮约 ' + Math.floor((camp.troops * 5) / 100)
              + '，代价是训练度掉得快'}
        </em>
      </button>

      {camp.farming ? (
        <div className="cp-hint">
          兵在地里就不在校场上。要练兵、要出征，都得先收屯。
        </div>
      ) : (
        <>
          <div className="cp-row">
            <button
              className="cp-act"
              disabled={camp.training >= out.trainCap || busyOn(camp, 'train') !== null}
              onClick={() => start('drill')}
            >
              操 练
              <em>
                {busyOn(camp, 'train') ? '校场上有人了'
                  : camp.training >= out.trainCap
                    ? '练到头了（上限 ' + out.trainCap + '，要修校场）'
                  : DRILL_DAYS + ' 日 · 每次 +' + out.drillGain
                    + ' · 上限 ' + out.trainCap}
              </em>
            </button>
            <button
              className="cp-act"
              disabled={
                camp.gear >= out.gearCap || camp.grain < GEAR_GRAIN
                || busyOn(camp, 'craft') !== null
              }
              onClick={() => start('gear')}
            >
              造 械
              <em>
                {busyOn(camp, 'craft') ? '匠人另有活在身'
                  : camp.gear >= out.gearCap ? '到顶了（要修工坊）'
                  : camp.grain < GEAR_GRAIN ? '尚缺 ' + (GEAR_GRAIN - camp.grain) + ' 石'
                    : GEAR_DAYS + ' 日 · ' + GEAR_GRAIN + ' 石'}
              </em>
            </button>
          </div>

          <div className="cp-sub">招兵</div>
          {LEVY_ORDER.map((k) => {
            const def = LEVIES[k];
            const cost = Math.ceil((def.men * def.grainPer100) / 100);
            return (
              <button
                key={k}
                className="cp-levy"
                disabled={camp.grain < cost || busyOn(camp, 'recruit') !== null}
                title={LEVY_NOTE[k]}
                onClick={() => start('levy', k)}
              >
                <span className="cl-name">{LEVY_NAME[k]}</span>
                <span className="cl-men">+{def.men} 人</span>
                <span className="cl-cost">{cost > 0 ? cost + ' 石' : '不费粮'}</span>
                <span className="cl-days">{def.days} 日</span>
              </button>
            );
          })}
          <div className="cp-hint">{LEVY_NOTE.retainer}</div>
        </>
      )}

      <Facilities engine={engine} idx={idx} camp={camp} campId={campId} out={out} />

      <Retinue engine={engine} idx={idx} camp={camp} campId={campId} />

      <div className="cp-sub">粮</div>
      {asked ? (
        <div className="cp-waiting">
          已具文请粮 <b>{asked.asked}</b> 石，还要 {asked.replyDay - st.day} 日才有回音。
        </div>
      ) : (
        <button
          className="cp-act wide"
          onClick={() => { Audio.click(); engine.dispatch({ t: 'ration_ask', amount: cap }); }}
        >
          向主公请粮
          <em>{MILITARY_RANKS[st.official.rank]}一季的份例是 {cap} 石。他给不给，看他自己还剩多少</em>
        </button>
      )}
      <button
        className="cp-act wide danger"
        onClick={() => { Audio.click(); engine.dispatch({ t: 'forage', campId }); }}
      >
        就地征粮
        <em>立刻有粮。刮的是你自己驻守那座城的民心，刮得勤了还会被参一本</em>
      </button>
      </div>
    </div>
  );
}

/**
 * 手上正在办的几件事。
 *
 * 募、练、工是三摊人，各干各的 —— 所以这里可能同时挂着三条。
 * 一次只做一件事的营是不真实的：招兵的人在外头跑，
 * 匠人在棚子底下，校场上还有一群兵在站队列，
 * 这三拨人本来就互不耽误。
 */
function Ongoing(
  { engine, idx, camp, campId }:
  { engine: Engine; idx: ContentIndex; camp: Camp; campId: string },
) {
  if (camp.jobs.length === 0) return null;
  return (
    <div className="cp-jobs">
      {camp.jobs.map((w) => {
        const track = trackOf(w.job);
        const what = w.job === 'levy' ? '招募' + LEVY_NAME[w.levy!]
          : w.job === 'drill' ? '操练'
            : w.job === 'build'
              ? '修' + (idx.facility.get(w.facilityId ?? '')?.name ?? '营')
                + ' 至 ' + w.toLevel + ' 级'
              : '打造器械';
        const pct = Math.round(((w.days - w.daysLeft) / Math.max(1, w.days)) * 100);
        return (
          <div key={track} className="cp-job">
            <span className={'cj-track t-' + track}>{TRACK_NAME[track]}</span>
            <div className="cj-mid">
              <div className="cj-what">{what}</div>
              <div className="cj-bar"><i style={{ width: pct + '%' }} /></div>
            </div>
            <span className="cj-days">{w.daysLeft} 日</span>
            <button
              className="cj-stop"
              title="撂下这一件。已花的粮退一半"
              onClick={() => {
                Audio.click();
                engine.dispatch({ t: 'camp_cancel', campId, track });
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 帐下的部将。
 *
 * **开局是空的** —— 一个刚受命的裨将手底下没有名将。
 * 而出征时**一路必须有一位将，一将不能分身**，
 * 所以「你能分几路兵」直接等于「你手上有几个能用的人」。
 *
 * 这就是招揽这件事的分量：它不是一个收集，是你排兵布阵的上限。
 */
function Retinue(
  { engine, idx, camp, campId }:
  { engine: Engine; idx: ContentIndex; camp: Camp; campId: string },
) {
  const st = engine.getState();
  const mine = st.retinue
    .map((id) => idx.person.get(id))
    .filter((o): o is NonNullable<typeof o> => !!o);
  const courting = busyOn(camp, 'recruit')?.job === 'court';
  const pool = (idx.byFaction.get(st.official.lordId) ?? [])
    .filter((o) => !Object.values(st.posts).includes(o.id));
  const allTaken = pool.length === mine.length;
  /**
   * 主公治下还有哪些城没人守。
   *
   * 举荐要有地方去。一家势力吞得快就会无人可派 ——
   * 而你手上恰好有人。舍不舍得，是你的事。
   */
  const vacant = vacantPosts(st, idx);
  const [offering, setOffering] = useState<string | null>(null);

  return (
    <>
      <div className="cp-sub">
        帐下
        <span className="cp-slots">{mine.length + 1} 路</span>
      </div>

      <div className="cp-officer self">
        <span className="co-name">你</span>
        <span className="co-note">亲领一路</span>
      </div>
      {mine.map((o) => {
        // 阵前挂了彩的要养伤，这段日子他上不了阵 —— 帐下这里得看得见
        const well = st.hurt[o.id] ?? 0;
        const hurt = well > st.day;
        return (
          <div
            key={o.id}
            className={'cp-officer' + (hurt ? ' hurt' : '')}
            title={o.note}
          >
            <span className="co-name">{o.name}</span>
            {hurt ? (
              <span className="co-hurt">负伤 · 还需 {well - st.day} 日</span>
            ) : (
              <>
                <span className={'co-temper t-' + o.temper}>{TEMPER_NAME[o.temper]}</span>
                <span className="co-num">统 {o.command}</span>
                <span className="co-num">勇 {o.valor}</span>
                {vacant.length > 0 && (
                  <button
                    className="co-rec"
                    title={'举荐他去替主公守一座城。你少一路兵，换主公的信任'}
                    onClick={() => {
                      Audio.click();
                      setOffering(offering === o.id ? null : o.id);
                    }}
                  >
                    举荐
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}

      {/* 举荐去哪儿。列的是主公治下真的没人守的城 */}
      {offering && (
        <div className="cp-vacant">
          <div className="cv-head">
            举荐 {idx.person.get(offering)?.name} 去守 ——
            <button className="cv-x" onClick={() => setOffering(null)}>×</button>
          </div>
          {vacant.map((id) => (
            <button
              key={id}
              className="cv-city"
              onClick={() => {
                Audio.chime();
                engine.dispatch({ t: 'recommend', officerId: offering, cityId: id });
                setOffering(null);
              }}
            >
              {idx.node.get(id)?.name ?? id}
              <em>{idx.node.get(id)?.commandery}　守军 {st.nodes[id]?.troops ?? 0}</em>
            </button>
          ))}
          <div className="cv-note">
            他从此有自己的城，不再是你帐下的一路。主公会记着这份人情。
          </div>
        </div>
      )}

      <button
        className="cp-act wide"
        disabled={courting || allTaken || camp.grain < COURT_GRAIN
          || busyOn(camp, 'recruit') !== null}
        onClick={() => {
          Audio.click();
          engine.dispatch({ t: 'camp_work', campId, job: 'court' });
        }}
      >
        招 揽
        <em>
          {allTaken ? '天下英雄尽在帐中'
            : courting ? '正在延请'
              : busyOn(camp, 'recruit') ? '招兵的人还没回来'
                : camp.grain < COURT_GRAIN ? '尚缺 ' + (COURT_GRAIN - camp.grain) + ' 石'
                  : COURT_DAYS + ' 日 · ' + COURT_GRAIN
                    + ' 石 · 请不请得动，看你的战功与主公的信任'}
        </em>
      </button>
    </>
  );
}

/**
 * 营中的设施。
 *
 * 这是武将的发育。与文官盖房子最大的分别：
 * 城里盖房子是为了**多收粮**，修营是为了改变自己军队的**形状** ——
 * 有厩栏才有骑兵，有弓弩坊才有弓弩，没有校场练到六十就到顶。
 *
 * 所以每一项都要写清楚「它给你什么」，而不是「它是几级」。
 */
function Facilities(
  { engine, idx, camp, campId, out }:
  {
    engine: Engine; idx: ContentIndex; camp: Camp; campId: string;
    out: ReturnType<typeof campOutput>;
  },
) {
  const [open, setOpen] = useState(false);
  const used = facilityCount(camp);

  return (
    <>
      <div className="cp-sub">
        营中设施
        <span className="cp-slots">{used}／{FACILITY_SLOTS}</span>
      </div>

      <div className="cp-caps">
        <span>弓弩至多 <b>{Math.round(out.bowCap / 10)}%</b></span>
        <span>骑兵至多 <b>{Math.round(out.horseCap / 10)}%</b></span>
        <span>可带部将 <b>{out.officerSlots}</b></span>
      </div>

      <button className="cp-act wide" onClick={() => { Audio.click(); setOpen(!open); }}>
        {open ? '收 起' : '修 营'}
        <em>
          {open ? '' : '仓 ' + out.grainCap + ' 石 · 训练上限 ' + out.trainCap
            + ' · 器械上限 ' + out.gearCap}
        </em>
      </button>

      {open && (
        <div className="cp-facs">
          {idx.db.facilities.map((def) => {
            const have = camp.works[def.id] ?? 0;
            const maxed = have >= def.maxLevel;
            const cost = facilityCost(def, have + 1);
            const noRoom = have === 0 && used >= FACILITY_SLOTS;
            const poor = camp.grain < cost.grain;
            return (
              <button
                key={def.id}
                className={'cp-fac' + (have > 0 ? ' on' : '')}
                disabled={maxed || noRoom || poor || busyOn(camp, 'craft') !== null}
                title={def.note}
                onClick={() => {
                  Audio.click();
                  engine.dispatch({
                    t: 'camp_work', campId, job: 'build', facilityId: def.id,
                  });
                }}
              >
                <span className="cf-name">
                  {def.name}
                  {have > 0 && <i className="cf-lv">{have}</i>}
                </span>
                <span className="cf-desc">{def.desc}</span>
                <span className="cf-cost">
                  {maxed ? '已到顶'
                    : busyOn(camp, 'craft') ? '匠人另有活在身'
                      : noRoom ? '营中摆不下了'
                      : (poor ? '尚缺 ' + (cost.grain - camp.grain) + ' 石'
                        : cost.grain + ' 石 · ' + cost.days + ' 日')}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// 点将台
// ─────────────────────────────────────────────────────────────

interface Draft {
  men: number;
  routeId: string;
  mission: Mission;
  officerId: string | null;
}

const MISSION_ORDER: Mission[] = ['assault', 'flank', 'ambush', 'feint', 'raid'];

export function WarCouncil(
  { engine, idx, campaign, camp }:
  { engine: Engine; idx: ContentIndex; campaign: Campaign; camp: Camp },
) {
  const c = campaign;
  const [drafts, setDrafts] = useState<Draft[]>(() => [{
    men: Math.round(camp.troops * 0.6),
    routeId: c.routes[0]!.id,
    mission: 'assault',
    officerId: null,
  }]);
  const [picked, setPicked] = useState(0);

  const target = idx.node.get(c.targetNodeId);
  const used = drafts.reduce((a, d) => a + d.men, 0);
  const left = camp.troops - used;

  // 斥候探来的是个估计。探得越清楚，报得越准 ——
  // 你按着一个错的数字分兵，分错了怪不得别人
  const blur = Math.max(0, 100 - c.scouting);
  const lo = Math.round((c.foeTroops * (100 - blur / 2)) / 100 / 10) * 10;
  const hi = Math.round((c.foeTroops * (100 + blur / 2)) / 100 / 10) * 10;

  const taken = new Set(drafts.map((d) => d.officerId).filter(Boolean) as string[]);
  const roster = idx.byFaction.get(engine.getState().official.lordId) ?? [];

  const edit = (i: number, patch: Partial<Draft>): void => {
    setDrafts((ds) => ds.map((d, k) => (k === i ? { ...d, ...patch } : d)));
  };

  const send = (): void => {
    Audio.drum();
    engine.dispatch({
      t: 'campaign_plan',
      columns: drafts.map((d) => ({
        men: d.men, routeId: d.routeId, mission: d.mission, officerId: d.officerId,
      })),
    });
    engine.dispatch({ t: 'campaign_go' });
  };

  const problem = checkPlan(drafts, camp.troops);

  return (
    <div className="council">
      <div className="wc-head">
        <div className="wc-title">军 议</div>
        <div className="wc-target">
          取 <b>{target?.name ?? c.targetNodeId}</b>
          <span className="dim">
            　斥候报：城中约 {lo}–{hi} 人
            {c.scouting < 45 ? '（探得不清）' : c.scouting > 75 ? '（探得明白）' : ''}
          </span>
        </div>
        <button
          className="wc-close"
          onClick={() => { Audio.click(); engine.dispatch({ t: 'campaign_close' }); }}
        >
          不打了
        </button>
      </div>

      <LandBrief idx={idx} campaign={c} />

      <RouteMap
        routes={c.routes}
        drafts={drafts}
        picked={picked}
        fromName="本营"
        toName={target?.name ?? '敌城'}
        onPick={(routeId) => edit(picked, { routeId })}
      />

      <div className="wc-cols">
        {drafts.map((d, i) => (
          <ColumnCard
            key={i}
            index={i}
            draft={d}
            routes={c.routes}
            roster={roster}
            taken={taken}
            on={picked === i}
            onFocus={() => setPicked(i)}
            onEdit={(patch) => edit(i, patch)}
            onDrop={drafts.length > 1
              ? () => {
                setDrafts((ds) => ds.filter((_, k) => k !== i));
                setPicked(0);
              }
              : null}
          />
        ))}
        {drafts.length < MAX_COLUMNS && (
          <button
            className="wc-add"
            onClick={() => {
              Audio.click();
              setDrafts((ds) => [...ds, {
                men: Math.max(MIN_COLUMN_MEN, Math.floor(left / 2)),
                routeId: c.routes[Math.min(ds.length, c.routes.length - 1)]!.id,
                mission: ds.some((x) => x.mission === 'ambush') ? 'flank' : 'ambush',
                officerId: null,
              }]);
              setPicked(drafts.length);
            }}
          >
            ＋<em>再分一路</em>
          </button>
        )}
      </div>

      <div className="wc-foot">
        <div className="wc-tally">
          营中 {camp.troops} 人　已派 {used} 人
          <b className={left < 0 ? 'bad' : ''}>留守 {left} 人</b>
        </div>
        <button className="wc-go" disabled={problem !== null} onClick={send}>
          {problem ?? '击 鼓 发 兵'}
        </button>
      </div>
    </div>
  );
}

function checkPlan(drafts: Draft[], have: number): string | null {
  const used = drafts.reduce((a, d) => a + d.men, 0);
  if (used > have) return '兵不够';
  if (drafts.some((d) => d.men < MIN_COLUMN_MEN)) return '有一路不成军';
  const seen = new Set<string>();
  for (const d of drafts) {
    if (!d.officerId) continue;
    if (seen.has(d.officerId)) return '一个人分不了身';
    seen.add(d.officerId);
  }
  if (!drafts.some((d) => d.mission === 'assault' || d.mission === 'ambush')) {
    return '没有一路是去打的';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────

/**
 * 这一带是什么地方。
 *
 * 「中间隔着伏牛山与南阳林」这一句，是玩家看懂那三条道的钥匙 ——
 * 没有它，「小道 9 日、隐蔽」就只是三个数字；
 * 有了它，玩家才知道自己为什么能在这儿设伏。
 */
function LandBrief({ idx, campaign }: { idx: ContentIndex; campaign: Campaign }) {
  const c = campaign;
  const names = new Set<string>();
  for (const r of c.routes) {
    const m = /(?:取道|穿|翻)(.+?)(?:而过)?$/.exec(r.through);
    if (m?.[1]) names.add(m[1]);
  }
  const regions = idx.terrain.filter((t) => names.has(t.name));
  if (regions.length === 0) {
    return <div className="wc-land">一路坦途，无险可依。</div>;
  }
  return (
    <div className="wc-land">
      {regions.map((t) => (
        <span key={t.id} className={'wl-item k-' + t.kind}>
          <b>{t.name}</b>{t.note}
        </span>
      ))}
    </div>
  );
}

/**
 * 舆图。
 *
 * 这一块是点将台的心脏。三条道画出来，长短、曲直、虚实各不相同 ——
 * 大道笔直，小道绕，山道虚线穿山。你把一路兵指到哪条道上，
 * 那条道就亮起来，旁边写上是谁、多少人、几日能到。
 *
 * 做成图而不是下拉框，是因为「分兵走哪条道」这件事本来就是**空间的**。
 * 一个 select 能装下同样的信息，但装不下那个念头。
 */
function RouteMap(
  { routes, drafts, picked, fromName, toName, onPick }:
  {
    routes: Route[]; drafts: Draft[]; picked: number;
    fromName: string; toName: string;
    onPick: (routeId: string) => void;
  },
) {
  const W = 760;
  const H = 190;
  const x0 = 74;
  const x1 = W - 74;

  return (
    <div className="wc-map">
      <svg viewBox={`0 0 ${W} ${H}`} className="wcm-svg">
        {/* 两头 */}
        <circle cx={x0} cy={H / 2} r={9} className="wcm-node" />
        <text x={x0} y={H / 2 + 30} className="wcm-label">{fromName}</text>
        <circle cx={x1} cy={H / 2} r={11} className="wcm-node foe" />
        <text x={x1} y={H / 2 + 32} className="wcm-label">{toName}</text>

        {routes.map((r, i) => {
          const bend = routeBend(r.kind, i, routes.length);
          const cy = H / 2 + bend;
          const path = `M ${x0} ${H / 2} Q ${(x0 + x1) / 2} ${cy} ${x1} ${H / 2}`;
          const mine = drafts
            .map((d, k) => ({ d, k }))
            .filter((x) => x.d.routeId === r.id);
          const isPicked = drafts[picked]?.routeId === r.id;
          return (
            <g key={r.id} className={'wcm-route k-' + r.kind + (isPicked ? ' on' : '')}>
              <path d={path} className="wcm-hit" onClick={() => { Audio.click(); onPick(r.id); }} />
              <path d={path} className="wcm-line" />
              <text
                x={(x0 + x1) / 2}
                y={H / 2 + bend / 2 - 12}
                className="wcm-road"
              >
                {ROUTE_NAME[r.kind]}
                <tspan className="wcm-dim">　{r.days} 日 · {APPROACH_NAME[r.arrive]}</tspan>
              </text>
              {/* 这条道要过哪儿 —— 「翻秦岭」三个字比任何数字都说明问题 */}
              <text x={(x0 + x1) / 2} y={H / 2 + bend / 2 + 5} className="wcm-through">
                {r.through}
              </text>
              <text x={(x0 + x1) / 2} y={H / 2 + bend / 2 + 20} className="wcm-cover">
                {coverWord(r.cover)}
              </text>
              {mine.map((x, j) => (
                <text
                  key={x.k}
                  x={x0 + 150 + j * 130}
                  y={H / 2 + bend * 0.62 + 4}
                  className="wcm-col"
                >
                  ◆ {x.d.men} 人 · {MISSION_NAME[x.d.mission]}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
      <div className="wcm-hint">点一条道，把选中的那一路指过去。</div>
    </div>
  );
}

function routeBend(kind: string, i: number, n: number): number {
  if (kind === 'main') return 0;
  const dir = i % 2 === 0 ? 1 : -1;
  const mag = kind === 'mountain' ? 118 : 74;
  return dir * mag * (n > 2 ? 1 : 1);
}

function coverWord(cover: number): string {
  if (cover >= 75) return '极隐蔽';
  if (cover >= 50) return '隐蔽';
  if (cover >= 25) return '半明';
  return '一望可见';
}

// ─────────────────────────────────────────────────────────────

function ColumnCard(
  { index, draft, routes, roster, taken, on, onFocus, onEdit, onDrop }:
  {
    index: number; draft: Draft; routes: Route[]; roster: Officer[];
    taken: Set<string>; on: boolean;
    onFocus: () => void;
    onEdit: (patch: Partial<Draft>) => void;
    onDrop: (() => void) | null;
  },
) {
  const officer = roster.find((o) => o.id === draft.officerId) ?? null;
  const route = routes.find((r) => r.id === draft.routeId);
  const warn = riskWord(officer, draft.mission);

  return (
    <div className={'wc-col' + (on ? ' on' : '')} onClick={onFocus}>
      <div className="wcc-head">
        第{'一二三'[index]}路
        {onDrop && (
          <button className="wcc-drop" onClick={(e) => { e.stopPropagation(); onDrop(); }}>×</button>
        )}
      </div>

      <div className="wcc-men">
        <input
          type="range"
          min={0}
          max={1200}
          step={10}
          value={draft.men}
          onChange={(e) => onEdit({ men: Number(e.target.value) })}
        />
        <span>{draft.men} 人</span>
      </div>

      <select
        className="wcc-sel"
        value={draft.officerId ?? ''}
        onChange={(e) => onEdit({ officerId: e.target.value || null })}
      >
        <option value="">（你亲自领）</option>
        {roster.map((o) => (
          <option key={o.id} value={o.id} disabled={taken.has(o.id) && o.id !== draft.officerId}>
            {o.name} · {TEMPER_NAME[o.temper]} · 统率 {o.command}
          </option>
        ))}
      </select>

      {officer && (
        <div className="wcc-who">
          {TEMPER_DESC[officer.temper]}
        </div>
      )}

      <div className="wcc-missions">
        {MISSION_ORDER.map((m) => (
          <button
            key={m}
            className={'wcc-m' + (draft.mission === m ? ' on' : '')}
            title={MISSION_DESC[m]}
            onClick={(e) => { e.stopPropagation(); Audio.click(); onEdit({ mission: m }); }}
          >
            {MISSION_NAME[m]}
          </button>
        ))}
      </div>
      <div className="wcc-desc">{MISSION_DESC[draft.mission]}</div>
      <div className="wcc-road">
        走 <b>{route ? ROUTE_NAME[route.kind] : '—'}</b>
        {route && <span className="dim">　{route.days} 日</span>}
      </div>
      {warn && <div className="wcc-warn">{warn}</div>}
    </div>
  );
}

/**
 * 派这个人去做这件事，靠不靠得住。
 *
 * 直说，不藏 —— 街亭那种事的乐趣不在于「你猜不到」，
 * 在于「你知道有风险，还是派了他」。
 */
function riskWord(officer: Officer | null, mission: Mission): string | null {
  if (!officer) return null;
  if (mission === 'assault') return null;
  if (officer.temper === 'rash') {
    return mission === 'ambush' || mission === 'feint'
      ? officer.name + '按不住性子，多半等不到时候。'
      : null;
  }
  if (officer.temper === 'proud' && mission === 'ambush') {
    return officer.name + '眼里没有难走的路，未必肯守在小道上。';
  }
  if (officer.temper === 'cautious' && (mission === 'flank' || mission === 'ambush')) {
    return officer.name + '行事持重，怕的是来晚。';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 行军途中
// ─────────────────────────────────────────────────────────────

export function Marching(
  { idx, campaign }: { idx: ContentIndex; campaign: Campaign },
) {
  const c = campaign;
  const target = idx.node.get(c.targetNodeId);
  return (
    <div className="marching">
      <div className="mg-title">兵发 {target?.name ?? c.targetNodeId}</div>
      {c.columns.map((col, i) => {
        const o = col.officerId ? idx.person.get(col.officerId) : null;
        const r = c.routes.find((x) => x.id === col.routeId);
        const need = (r?.days ?? 1) + (col.deviated === 'late' ? 3 : 0);
        const pct = Math.min(100, Math.round((col.progress / Math.max(1, need)) * 100));
        return (
          <div key={col.id} className="mg-col">
            <div className="mg-who">
              第{'一二三'[i]}路　{o ? o.name : '你'}　{col.men} 人
              <span className="dim">{r ? ROUTE_NAME[r.kind] : ''} · {MISSION_NAME[col.mission]}</span>
            </div>
            <div className="mg-bar"><i style={{ width: pct + '%' }} /></div>
            <div className="mg-eta">
              {col.progress >= need ? '已到，候令' : '还有 ' + (need - col.progress) + ' 日'}
            </div>
          </div>
        );
      })}
      <div className="mg-hint">各路到齐才接战。走得慢的那一路，全军都在等他。</div>
    </div>
  );
}
