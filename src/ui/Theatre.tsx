/**
 * 战场的界面。
 *
 * 这里刻意做得**薄**：中间那片地是战场本身，界面只在四边留一条。
 * 玩家要做的事只有三样 ——
 *
 *   在图上点一个位置 → 弹出一个框：派谁、带多少、什么兵种、去干什么
 *   派完了击鼓
 *   然后看着打，中间偶尔喊一声
 *
 * 没有阵型台，没有回合，没有一屏的按钮。
 */
import { useEffect, useRef, useState } from 'react';
import { Engine } from '../sim/engine.ts';
import { renderText, type ContentIndex } from '../sim/content.ts';
import {
  GROUND, GROUND_NAME, KIND_NAME, MAX_UNITS, MIN_MEN, SCOUT_MAX, SCOUT_MEN,
  STANCE_DESC, STANCE_NAME,
  type Duel, type Stance, type Theatre, type Unit, type UnitKind,
} from '../sim/theatre_types.ts';
import { TEMPER_NAME } from '../sim/officer_types.ts';
import { campOutput } from '../sim/camp.ts';
import { STARTING_CAMP } from '../sim/general_types.ts';
import { Audio } from '../audio/ambience.ts';

const KINDS: UnitKind[] = ['foot', 'bow', 'horse'];
const STANCES: Stance[] = ['assault', 'ambush', 'hold', 'reserve', 'raid'];

interface Props {
  engine: Engine;
  idx: ContentIndex;
  theatre: Theatre;
  /** 玩家刚点的那一格。由 3D 那边喂进来 */
  picked: { col: number; row: number } | null;
  onClearPick: () => void;
}

export function TheatreScreen({ engine, idx, theatre: t, picked, onClearPick }: Props) {
  if (t.phase === 'orders') {
    return (
      <Orders engine={engine} idx={idx} theatre={t} picked={picked} onClearPick={onClearPick} />
    );
  }
  return <Watching engine={engine} idx={idx} theatre={t} />;
}

// ─────────────────────────────────────────────────────────────
// 派将
// ─────────────────────────────────────────────────────────────

/**
 * 为什么这个兵种不能选。
 *
 * 灰着一个按钮却不说理由，玩家只会以为「点不动」——
 * 这一条是真事故：有人试了半天以为是 bug。
 * 骑兵不是招来的，是营里养出来的；这句话必须写在按钮上。
 */
function kindWhy(k: UnitKind, out: { bowCap: number; horseCap: number }): string {
  if (k === 'horse') {
    return out.horseCap <= 0 ? '营中无厩栏，养不出马' : '马太少，凑不成一队';
  }
  if (k === 'bow') {
    return out.bowCap <= 130 ? '弓弩坊未修，配不齐弓弩' : '弓弩太少，凑不成一队';
  }
  return '没兵了';
}

function Orders({ engine, idx, theatre: t, picked, onClearPick }: Props) {
  const mine = t.units.filter((u) => u.side === 'own');
  const foes = t.units.filter((u) => u.side === 'foe' && (!u.hidden || u.revealed));
  const left = t.pool.foot + t.pool.bow + t.pool.horse;

  // 斥候探得越清楚，敌情报得越准
  const blur = Math.max(0, 100 - t.intel);
  const foeSeen = foes.reduce((a, u) => a + u.men, 0);
  const lo = Math.round((foeSeen * (100 - blur / 2)) / 100 / 10) * 10;
  const hi = Math.round((foeSeen * (100 + blur / 2)) / 100 / 10) * 10;

  /**
   * 细作带回来的那句话。
   *
   * **它和真话在这里长得一模一样** —— 这是存心的。
   * 假情报要是带个记号，那就不叫假情报了，叫提示。
   * 你只能从「这一拨是第几次派的、营里练得怎么样」去掂量它，
   * 掂量不出来就只好赌。真伪是击鼓之后才揭晓的事。
   */
  const said = t.report;
  const canScout = t.scouts < SCOUT_MAX && t.pool.foot >= SCOUT_MEN;

  return (
    <>
      <div className="th-top">
        <div className="th-title">
          攻 {t.foeName}
          <span className="dim">
            {said
              ? `　细作报：城下约 ${said.men} 人`
              : `　斥候报：城下约 ${lo}–${hi} 人`}
            {said
              ? ''
              : t.intel < 45 ? '（探得不清，未必全）'
                : t.intel > 75 ? '（探得明白）' : ''}
          </span>
        </div>
        <button
          className="th-quit"
          onClick={() => { Audio.click(); engine.dispatch({ t: 'theatre_close' }); }}
        >
          收兵回营
        </button>
      </div>

      {/* 手上还剩多少兵 */}
      <div className="th-pool">
        <div className="tp-title">营中带来</div>
        {KINDS.map((k) => (
          <div key={k} className={'tp-row' + (t.pool[k] <= 0 ? ' out' : '')}>
            <span className="tp-name">{KIND_NAME[k]}</span>
            <span className="tp-men">{t.pool[k]}</span>
          </div>
        ))}
        <div className="tp-hint">
          {left > 0
            ? '在图上点一个位置，把兵派过去。'
            : '兵都派出去了。'}
        </div>

        {/* 细作。花三十个人去问一句可能是谎话的话 */}
        <div className="tp-title">细作</div>
        <button
          className="tp-scout"
          disabled={!canScout}
          title={
            t.scouts >= SCOUT_MAX ? '能派的都派出去了'
              : t.pool.foot < SCOUT_MEN ? '凑不出人手'
                : `派 ${SCOUT_MEN} 人去探。探得明白能指出他藏的兵；`
                  + '探不明白就白搭这些人 —— 也可能带回来一句假话'
          }
          onClick={() => { Audio.click(); engine.dispatch({ t: 'theatre_scout' }); }}
        >
          派 细 作
          <em>
            {t.scouts >= SCOUT_MAX
              ? '已派 ' + t.scouts + ' 拨，没人手了'
              : SCOUT_MEN + ' 人 · 还可派 ' + (SCOUT_MAX - t.scouts) + ' 拨'}
          </em>
        </button>
        {t.scouts > 0 && (
          <div className="tp-hint dim">
            细作说的话不一定是真的。派得越多，越是往难处探。
          </div>
        )}

        {mine.length > 0 && <div className="tp-title">已派</div>}
        {mine.map((u) => (
          <div key={u.id} className="tp-sent">
            <span className="ts-kind">{KIND_NAME[u.kind]}</span>
            <span className="ts-men">{u.men}</span>
            <span className={'ts-stance s-' + u.stance}>{STANCE_NAME[u.stance]}</span>
            <button
              className="ts-back"
              title="收回来"
              onClick={() => {
                Audio.click();
                engine.dispatch({ t: 'theatre_recall', unitId: u.id });
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {picked && (
        <SendDialog
          engine={engine}
          idx={idx}
          theatre={t}
          col={picked.col}
          row={picked.row}
          onClose={onClearPick}
        />
      )}

      <div className="th-bottom">
        <div className="th-tally">
          已派 {mine.length}／{MAX_UNITS} 路
          {mine.reduce((a, u) => a + u.men, 0)} 人上阵，{left} 人留营
        </div>
        <button
          className="th-go"
          disabled={mine.length === 0}
          onClick={() => { Audio.drum(); engine.dispatch({ t: 'theatre_begin' }); }}
        >
          {mine.length === 0 ? '还没派兵' : '击 鼓'}
        </button>
      </div>
    </>
  );
}

/**
 * 点了一个位置之后弹出来的框。
 *
 * 这个框是整套玩法的入口，所以它必须把**这块地是什么**讲清楚 ——
 * 玩家是照着地形做决定的，不是照着按钮。
 */
function SendDialog(
  { engine, idx, theatre: t, col, row, onClose }:
  {
    engine: Engine; idx: ContentIndex; theatre: Theatre;
    col: number; row: number; onClose: () => void;
  },
) {
  const st = engine.getState();
  const camp = st.camps[STARTING_CAMP];
  const out = camp ? campOutput(camp, idx) : { bowCap: 0, horseCap: 0 };
  const cell = t.cells[Math.round(row) * t.cols + Math.round(col)]
    ?? t.cells[0]!;
  const g = GROUND[cell.ground];
  const canHide = cell.ground === 'forest' || cell.ground === 'hill'
    || cell.ground === 'marsh';

  const [kind, setKind] = useState<UnitKind>(() =>
    (KINDS.find((k) => t.pool[k] >= MIN_MEN) ?? 'foot'));
  const [men, setMen] = useState(() => Math.min(t.pool[kind], 200));
  const [stance, setStance] = useState<Stance>('assault');

  /**
   * 谁领这一路。
   *
   * **一路必须有一位将，一将不能分身。**
   * 你自己算一位（亲领），但你也只有一个人。
   * 所以「能分几路」不是一个可以随便点的数字，
   * 是「你手上有几个能用的人」。
   */
  const taken = new Set(
    t.units.filter((u) => u.side === 'own').map((u) => u.officerId ?? '__self'),
  );
  const retinue = st.retinue
    .map((id) => idx.person.get(id))
    .filter((o): o is NonNullable<typeof o> => !!o);
  /** 挂了彩的上不了阵。伤是要养的 —— 见 WorldState.hurt */
  const hurt = (id: string): boolean => (st.hurt[id] ?? 0) > st.day;
  const freeSelf = !taken.has('__self');
  const freeOfficers = retinue.filter((o) => !taken.has(o.id) && !hurt(o.id));
  const [officerId, setOfficerId] = useState<string | null>(
    () => (freeSelf ? null : freeOfficers[0]?.id ?? null),
  );
  const noLeader = !freeSelf && freeOfficers.length === 0;
  const avail = t.pool[kind];

  useEffect(() => {
    setMen((m) => Math.min(Math.max(MIN_MEN, m), Math.max(MIN_MEN, avail)));
  }, [kind, avail]);

  const bad = noLeader ? '没有将了 —— 一路要一位将'
    : (officerId === null && !freeSelf) ? '你已经领了一路'
      : (officerId !== null && hurt(officerId)) ? '他还伤着，上不了阵'
        : (officerId !== null && taken.has(officerId)) ? '这位将已在别处'
          : avail < MIN_MEN ? kindWhy(kind, out)
            : cell.ground === 'water' ? '水里站不住人'
              : (stance === 'ambush' && !canHide) ? '这块地藏不住人'
                : null;

  return (
    <div className="th-send">
      <div className="ts-head">
        {GROUND_NAME[cell.ground]}
        <span className="dim">
          　{col.toFixed(0)}，{row.toFixed(0)}
          {cell.height > 0 ? '　高处' : ''}
        </span>
        <button className="ts-close" onClick={onClose}>×</button>
      </div>

      {/* 这块地什么脾气。玩家照这个做决定 */}
      <div className="ts-ground">
        <span className={g.cover > 400 ? 'on' : ''}>
          {g.cover > 600 ? '藏得住人' : g.cover > 200 ? '略可遮蔽' : '一望可见'}
        </span>
        <span className={g.fight > 1050 ? 'on' : g.fight < 900 ? 'bad' : ''}>
          {g.fight > 1050 ? '居高易守' : g.fight < 900 ? '施展不开' : '利于列阵'}
        </span>
        <span className={g.pace < 800 ? 'bad' : g.pace > 1100 ? 'on' : ''}>
          {g.pace > 1100 ? '行军快' : g.pace < 600 ? '举步维艰' : g.pace < 800 ? '行军慢' : '常速'}
        </span>
      </div>

      <div className="ts-kinds">
        {KINDS.map((k) => (
          <button
            key={k}
            className={'ts-kind-btn' + (kind === k ? ' on' : '')}
            disabled={t.pool[k] < MIN_MEN}
            title={t.pool[k] < MIN_MEN ? kindWhy(k, out) : ''}
            onClick={() => { Audio.click(); setKind(k); }}
          >
            {KIND_NAME[k]}
            <em>{t.pool[k] < MIN_MEN ? kindWhy(k, out) : String(t.pool[k])}</em>
          </button>
        ))}
      </div>

      <div className="ts-men">
        <input
          type="range"
          min={MIN_MEN}
          max={Math.max(MIN_MEN, avail)}
          step={10}
          value={men}
          onChange={(e) => setMen(Number(e.target.value))}
        />
        <span>{men} 人</span>
      </div>

      <select
        className="ts-officer"
        value={officerId ?? ''}
        onChange={(e) => setOfficerId(e.target.value || null)}
      >
        <option value="" disabled={!freeSelf}>
          {freeSelf ? '你亲自领' : '你已领了一路'}
        </option>
        {retinue.map((o) => (
          <option key={o.id} value={o.id} disabled={taken.has(o.id) || hurt(o.id)}>
            {o.name} · {TEMPER_NAME[o.temper]}
            {' · 统 ' + o.command + ' 勇 ' + o.valor + ' 智 ' + o.wit}
            {hurt(o.id)
              ? '（伤着，还要养 ' + ((st.hurt[o.id] ?? 0) - st.day) + ' 日）'
              : taken.has(o.id) ? '（已在别处）' : ''}
          </option>
        ))}
      </select>
      {retinue.length === 0 ? (
        <div className="ts-noone">
          帐下无人。回营招揽了部将，才分得开兵。
        </div>
      ) : (
        /* 三个数各管一件事。不写出来，玩家只会挑那个最大的 */
        <div className="ts-statnote">
          统率压住溃散，武勇加接战的分量，智略让伏兵藏得更深。
        </div>
      )}

      <div className="ts-stances">
        {STANCES.map((s) => (
          <button
            key={s}
            className={'ts-st' + (stance === s ? ' on' : '')
              + (s === 'ambush' && !canHide ? ' off' : '')}
            onClick={() => { Audio.click(); setStance(s); }}
          >
            {STANCE_NAME[s]}
          </button>
        ))}
      </div>
      <div className="ts-desc">{STANCE_DESC[stance]}</div>

      <button
        className="ts-send-go"
        disabled={bad !== null}
        onClick={() => {
          Audio.click();
          engine.dispatch({
            t: 'theatre_send',
            kind, men,
            col: Math.round(col), row: Math.round(row),
            stance, officerId,
          });
          onClose();
        }}
      >
        {bad ?? '就 这 么 办'}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 观战
// ─────────────────────────────────────────────────────────────

/**
 * 第几拍是什么时辰。
 *
 * 战报上写「第 417 拍」是没有意义的 —— 那是模拟的内部计数。
 * 一场野战从辰时列阵到申时收兵，写成时辰，
 * 玩家一眼看得出「伏兵是巳时起的，午时才崩」这件事有多快。
 */
const SHICHEN = ['辰时', '巳时', '午时', '未时', '申时', '酉时'];
/** 多少拍算一个时辰。一场仗二百来拍，正好从早晨打到黄昏 */
const TICKS_PER_HOUR = 46;
function shichen(tick: number): string {
  const i = Math.min(SHICHEN.length - 1, Math.floor(tick / TICKS_PER_HOUR));
  return SHICHEN[i] ?? '酉时';
}

/**
 * 值得写进战报的那几行。
 *
 * 战报不是把日志抄一遍 —— 三百拍里有一百多行「某部与某部接战」，
 * 全抄上去就等于什么都没写。留下的是**转折**：
 * 伏兵起了、哪一路崩了、粮烧了、墙破了、谁没听令。
 */
const TURNING = new Set([
  'th.ambush_ours', 'th.ambush_theirs',
  'th.routed_ours', 'th.routed_theirs',
  'th.supply_burned', 'th.wall_broken', 'th.strayed', 'th.wiped',
  'th.hard_ours', 'th.hard_theirs',
  'th.spotted_ours', 'th.spotted_theirs',
  'th.challenge', 'th.duel_slew', 'th.duel_slain', 'th.duel_won',
  'th.duel_lost', 'th.duel_draw', 'th.duel_refused', 'th.pressing',
  'th.won', 'th.lost',
]);

/** 一路人马在战报里占的那一行 */
function unitName(u: Unit, idx: ContentIndex): string {
  if (u.officerId) return idx.person.get(u.officerId)?.name ?? '偏将';
  return '你亲领';
}

/**
 * 打起来之后。
 *
 * 界面退到最薄 —— 这一段的主角是那张图。
 * 只留三样：谁还剩多少、战报、快慢。
 */
function Watching(
  { engine, idx, theatre: t }: { engine: Engine; idx: ContentIndex; theatre: Theatre },
) {
  const [speed, setSpeed] = useState(2);
  const timer = useRef(0);
  /**
   * 逼这一屏重画。
   *
   * **上层的重渲染是靠事件驱动的**：引擎只在有事件时通知订阅者，
   * 而一场仗从击鼓到接战的那九十多拍一条日志都不出。
   * 于是那几秒钟里人数不动、战报不动 —— 玩家看到的是「啥反馈都没有」。
   *
   * 仗一直在打。只是这一屏在等一个永远不来的事件。
   * 所以观战的时候它按自己的钟走，不等谁。
   */
  const [, beat] = useState(0);

  /**
   * 敌将叫阵的时候，把拍子停下来。
   *
   * 这是一个要当场做的决定，而五倍速下九合斗完只要几秒 ——
   * 不停下来，玩家还没看清是谁在叫阵，事情就过去了。
   *
   * 停的是**界面这边的钟**，模拟层一动不动：
   * 拍子不走，那道「犹豫太久就当没理他」的保险自然也不会触发。
   * 而屏幕上明晃晃两个按钮，所以停在这里也卡不住。
   */
  const offered = t.duel?.state === 'offered';
  const wasSpeed = useRef(2);
  useEffect(() => {
    if (offered) {
      if (speed !== 0) wasSpeed.current = speed;
      setSpeed(0);
    }
  }, [offered, speed]);

  useEffect(() => {
    if (t.phase !== 'fighting' || speed === 0) return;
    const id = window.setInterval(() => {
      engine.dispatch({ t: 'theatre_step', ticks: speed });
      beat((b) => b + 1);
    }, 90);
    timer.current = id;
    return () => window.clearInterval(id);
  }, [engine, t.phase, speed]);

  const own = t.units.filter((u) => u.side === 'own');
  const foe = t.units.filter((u) => u.side === 'foe' && (!u.hidden || u.revealed));
  const ownMen = own.filter((u) => !u.routed).reduce((a, u) => a + u.men, 0);
  const foeMen = foe.filter((u) => !u.routed).reduce((a, u) => a + u.men, 0);

  const lines = t.log.slice(-9);
  /**
   * 战报一出来，观战的那几块就该收起来。
   *
   * 否则右下角那条实况日志会从战报底下探出半截，
   * 同一段话在屏幕上出现两遍 —— 一遍在战报里，一遍压在战报后头。
   */
  const done = t.phase === 'done';

  return (
    <>
      {done && <Report engine={engine} idx={idx} theatre={t} />}
      {!done && (
      <>
      <div className="th-top">
        <div className="th-scores">
          <span className="ts-own">我 {ownMen}</span>
          <span className="ts-vs">对</span>
          <span className="ts-foe">敌 {foeMen}</span>
          {t.foeSupply <= 0 && <span className="ts-burn">敌粮已焚</span>}
        </div>
        <div className="th-speeds">
          {[0, 1, 2, 5].map((s) => (
            <button
              key={s}
              className={'th-sp' + (speed === s ? ' on' : '')}
              onClick={() => { setSpeed(s); Audio.click(); }}
            >
              {s === 0 ? '❙❙' : s + '×'}
            </button>
          ))}
          {/*
            打不过就撤 —— 这个按钮以前没有。
            两军要是都不肯上，玩家在这一屏上一个能点的东西都没有，
            只能眼看着它对望到天黑。
          */}
          <button
            className="th-gong"
            disabled={t.pullingAt >= 0}
            title="全军脱离接触往营里退。正咬着的部队要付断后的代价"
            onClick={() => { Audio.click(); engine.dispatch({ t: 'theatre_withdraw' }); }}
          >
            {t.pullingAt >= 0 ? '退兵中' : '鸣 金'}
          </button>
        </div>
      </div>

      <div className="th-roster">
        {own.map((u) => (
          <div key={u.id} className={'thr' + (u.routed ? ' out' : '')}>
            <span className="thr-k">{KIND_NAME[u.kind]}</span>
            <span className="thr-m">{u.routed ? '溃' : u.men}</span>
            <span className="thr-bar">
              <i style={{ width: (u.men / Math.max(1, u.men0)) * 100 + '%' }} />
            </span>
            <span className={'thr-s s-' + u.stance}>
              {u.hidden && !u.revealed ? '伏' : STANCE_NAME[u.stance]}
            </span>
          </div>
        ))}
      </div>

      {t.duel?.state === 'offered' && (
        <Challenge engine={engine} duel={t.duel} resume={() => setSpeed(wasSpeed.current)} />
      )}

      <div className="th-log">
        {lines.map((l, i) => (
          <div
            key={i}
            className={'thl ' + l.tone + (TURNING.has(l.textId) ? ' big' : '')}
          >
            <span className="thl-t">{shichen(l.tick)}</span>
            {renderText(idx.db.text, l.textId, l.vars ?? {})}
          </div>
        ))}
      </div>

      </>
      )}
    </>
  );
}

/**
 * 阵前叫战。
 *
 * 两条路都要疼，所以两个按钮都不写成好事：
 * 出马可能就此折掉一员将，不理他是当着两军的面示弱。
 * 这里不摆胜率 —— 你只知道对面是谁、他看着有多凶，
 * 剩下的是你自己拿主意。
 */
function Challenge(
  { engine, duel, resume }:
  { engine: Engine; duel: Duel; resume: () => void },
) {
  // 勇力不给数字，给一句话 —— 摆出「87 对 62」就成了算术题
  const gap = duel.foeValor - duel.ownValor;
  const look = gap > 18 ? '此人凶悍，不好相与。'
    : gap > 6 ? '看着比你手底下这位要强些。'
      : gap < -18 ? '不过一员庸将。'
        : gap < -6 ? '瞧着不如你手底下这位。'
          : '两人看着在伯仲之间。';

  return (
    <div className="th-challenge">
      <div className="tc-head">阵 前 叫 战</div>
      <div className="tc-what">
        敌将<b>{duel.foeName}</b>纵马出阵，指名要与<b>{duel.ownName}</b>一决。
      </div>
      <div className="tc-look">{look}</div>
      <div className="tc-row">
        <button
          className="tc-go"
          onClick={() => {
            Audio.drum();
            engine.dispatch({ t: 'theatre_duel_accept' });
            resume();
          }}
        >
          出 马
        </button>
        <button
          className="tc-no"
          onClick={() => {
            Audio.click();
            engine.dispatch({ t: 'theatre_duel_refuse' });
            resume();
          }}
        >
          不 理 他
        </button>
      </div>
      <div className="tc-note">
        赢了三军振奋，输了三军夺气 —— 而且可能就此折掉这个人。
        不出去，两军都看着你避战。
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 战报
// ─────────────────────────────────────────────────────────────

/**
 * 收场那一屏。
 *
 * 上一版这里只有一个「胜」字和一个按钮 —— 打了两刻钟的仗，
 * 收场时连折了多少人、哪一路是怎么没的都不说。
 * 那前面所有的排兵布阵就都没有落点：
 * 你埋的那支伏兵到底值不值，无从知道。
 *
 * 所以战报要答三个问题：**每一路是怎么回来的、账怎么算、仗是在哪一刻定的。**
 */
function Report(
  { engine, idx, theatre: t }: { engine: Engine; idx: ContentIndex; theatre: Theatre },
) {
  const r = t.result;
  const mine = t.units.filter((u) => u.side === 'own');
  /**
   * 转折要**从头留到尾**。
   *
   * 原先是 slice(-8)：一场仗前半段「你亲领折了、李典也折了」全被截掉，
   * 战报从伏兵杀出那一刻才开始 —— 看起来像是一路顺风。
   * 而那两路是怎么拼掉的，恰恰是这一仗最贵的部分。
   */
  const turns = t.log.filter((l) => TURNING.has(l.textId)).slice(-14);

  const title = t.outcome === 'won' ? '胜' : t.outcome === 'lost' ? '败' : '各自收兵';
  const what = t.kind === 'siege' ? '攻' : '战于';

  return (
    <div className="th-report">
      <div className="thd-title">{title}</div>
      <div className="thd-where">{what} {t.foeName}</div>

      {/* 一、每一路是怎么回来的 */}
      <div className="thd-sec">各路</div>
      <div className="thd-units">
        {mine.map((u) => {
          const lost = Math.max(0, u.men0 - (u.routed ? 0 : u.men));
          return (
            <div key={u.id} className={'thu' + (u.routed ? ' out' : '')}>
              <span className="thu-n">{unitName(u, idx)}</span>
              <span className="thu-k">{KIND_NAME[u.kind]}</span>
              <span className={'thu-s s-' + u.stance}>{STANCE_NAME[u.stance]}</span>
              <span className="thu-m">
                {u.men0} <i>→</i> {u.routed ? '溃散' : u.men}
              </span>
              <span className={'thu-l' + (lost > u.men0 * 0.4 ? ' heavy' : '')}>
                折 {lost}
              </span>
              {u.strayed && <span className="thu-x" title="没按你的令走">违令</span>}
            </div>
          );
        })}
      </div>

      {/* 二、账 */}
      {r && (
        <div className="thd-tally">
          <div><b>{r.lost}</b><span>我军折损</span></div>
          <div><b>{r.foeLost}</b><span>敌军折损</span></div>
          <div><b>{r.spoils}</b><span>缴获（石）</span></div>
          <div><b>{r.merit}</b><span>战功</span></div>
        </div>
      )}

      {/* 三、仗是在哪一刻定的 */}
      {turns.length > 0 && (
        <>
          <div className="thd-sec">战况</div>
          <div className="thd-turns">
            {turns.map((l, i) => (
              <div key={i} className={'thdt ' + l.tone}>
                <span className="thl-t">{shichen(l.tick)}</span>
                {renderText(idx.db.text, l.textId, l.vars ?? {})}
              </div>
            ))}
          </div>
        </>
      )}

      <button
        className="th-go"
        onClick={() => { Audio.click(); engine.dispatch({ t: 'theatre_dismiss' }); }}
      >
        收 兵 回 营
      </button>
    </div>
  );
}
