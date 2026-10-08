/**
 * 野战的界面。
 *
 * 与守城战最大的不同：这里的界面是**薄的**。
 * 战场本身才是要看的东西 —— 面板压在边上，中间永远留给那片地。
 *
 * 布阵靠**拖**：把队伍拖到阵前两行，脚下是坡是沼一眼能看见。
 * 阵型是一排按钮，每一种都写明有得有失。
 */
import { useEffect } from 'react';
import { Engine } from '../sim/engine.ts';
import { renderText, type ContentIndex } from '../sim/content.ts';
import {
  FIELD_COLS, FORMATIONS, TERRAIN_BONUS, TERRAIN_NAME, UNIT_NAME,
  type FieldBattle, type Formation, type Terrain, type UnitKind,
} from '../sim/field_types.ts';
import { Audio } from '../audio/ambience.ts';

interface Props {
  engine: Engine;
  idx: ContentIndex;
  field: FieldBattle;
  /** 当前选中的队伍，用来在侧栏高亮 */
  picked: string | null;
}

/**
 * 军议那份计划落到实处是什么样。
 *
 * 这一块非有不可：出征那一层的全部功夫 —— 谁走了哪条道、
 * 伏兵咬没咬住、谁误了时辰 —— 若不在这里讲出来，
 * 玩家看到的就只是「我三百五十人对着七百人」，
 * 而不知道那是因为曹仁在小道上白等了一天。
 */
function PlanReport(
  { engine, idx }: { engine: Engine; idx: ContentIndex },
) {
  const c = engine.getState().campaign;
  if (!c || c.log.length === 0) return null;
  return (
    <div className="plan-report">
      <div className="pr-title">军议之后</div>
      {c.log.map((l, i) => (
        <div key={i} className={'pr-line ' + l.tone}>
          {renderText(idx.db.text, l.textId, l.vars)}
        </div>
      ))}
    </div>
  );
}

const FORM_ORDER: Formation[] = ['yulin', 'fengshi', 'heyi', 'fangyuan', 'yanyue'];

/**
 * 这支兵站在这块地上，是占便宜还是吃亏。
 *
 * 地形有分别是一回事，玩家**看得出**分别是另一回事 ——
 * 光写「缓坡」两个字，谁知道弓弩站上去值不值。所以直接把账写出来。
 */
function terrainEdge(kind: UnitKind, t: Terrain): { text: string; tone: string } {
  const v = TERRAIN_BONUS[t][kind] ?? 1000;
  if (v >= 1200) return { text: '大占便宜', tone: 'good' };
  if (v >= 1050) return { text: '占便宜', tone: 'good' };
  if (v <= 700) return { text: '施展不开', tone: 'bad' };
  if (v <= 950) return { text: '吃亏', tone: 'bad' };
  return { text: '平平', tone: '' };
}

export function FieldScreen({ engine, idx, field, picked }: Props) {
  const f = field;
  const foe = idx.faction.get(f.foeFactionId);

  // 交战阶段：空格接着打
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== ' ') return;
      const cur = engine.getState().field;
      if (!cur || cur.phase !== 'fighting' || cur.pending) return;
      e.preventDefault();
      engine.dispatch({ t: 'field_round' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);

  const own = f.units.filter((u) => u.side === 'own');
  const foes = f.units.filter((u) => u.side === 'foe');
  const sum = (us: typeof own): number => us.filter((u) => !u.routed).reduce((a, u) => a + u.men, 0);

  if (f.phase === 'done') {
    return <Aftermath engine={engine} idx={idx} field={f} />;
  }

  return (
    <>
      {/* 顶栏：两军实力，压在最上面一条 */}
      <div className="fd-top">
        <ForceTag name="我军" men={sum(own)} units={own} mine />
        <div className="fd-round">
          {f.phase === 'deploy'
            ? '布阵'
            : '第 ' + f.round + ' 轮 · 共 ' + f.maxRounds + ' 轮'}
          {f.ambush && <div className="fd-ambush">伏兵得手</div>}
          {f.reinforcements.map((r) => (
            <div key={r.round} className="fd-coming">
              第 {r.round} 轮 · {r.men} 人{r.from === 'rear' ? '自敌后' : '自侧翼'}至
            </div>
          ))}
        </div>
        <ForceTag name={foe?.name ?? '敌军'} men={sum(foes)} units={foes} />
      </div>

      {f.cause === 'campaign' && f.phase === 'deploy' && (
        <PlanReport engine={engine} idx={idx} />
      )}

      {f.phase === 'deploy' ? (
        <Deploy engine={engine} field={f} picked={picked} />
      ) : (
        <Fighting engine={engine} idx={idx} field={f} />
      )}
    </>
  );
}

function ForceTag(
  { name, men, units, mine }:
  { name: string; men: number; units: FieldBattle['units']; mine?: boolean },
) {
  const live = units.filter((u) => !u.routed);
  return (
    <div className={'fd-force' + (mine ? ' mine' : '')}>
      <div className="fdf-name">{name}</div>
      <div className="fdf-men">{men}<span className="dim"> 人</span></div>
      <div className="fdf-units">
        {live.map((u) => (
          <span key={u.id} className={'fdf-u k-' + u.kind}>
            {UNIT_NAME[u.kind]}{u.men}
          </span>
        ))}
        {units.length > live.length && (
          <span className="fdf-routed">溃 {units.length - live.length}</span>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

function Deploy(
  { engine, field, picked }: { engine: Engine; field: FieldBattle; picked: string | null },
) {
  const f = field;
  const def = FORMATIONS[f.formation];
  const own = f.units.filter((u) => u.side === 'own');

  const setForm = (id: Formation): void => {
    Audio.click();
    // 只换阵型，不动位置，**也不开打** ——
    // 选阵型顺手把布阵阶段结束掉，是上一版最要命的那个 bug
    engine.dispatch({
      t: 'field_deploy',
      places: own.map((u) => ({ id: u.id, col: u.col, row: u.row })),
      formation: id,
    });
  };

  return (
    <>
      <div className="fd-side">
        <div className="fds-title">阵中各队</div>
        {own.map((u) => {
          const t = f.cells[u.row * FIELD_COLS + u.col]?.terrain ?? 'plain';
          const edge = terrainEdge(u.kind, t);
          return (
            <div key={u.id} className={'fds-unit' + (picked === u.id ? ' on' : '')}>
              <span className={'fdf-u k-' + u.kind}>{UNIT_NAME[u.kind]}</span>
              <span className="fds-men">{u.men} 人</span>
              <span className="fds-terr">{TERRAIN_NAME[t]}</span>
              <span className={'fds-edge ' + edge.tone}>{edge.text}</span>
            </div>
          );
        })}
        <div className="fds-hint">
          把队伍<b>拖到</b>阵前两行。<br />
          弓弩上坡射得远，骑兵进了林子和沼地就施展不开。
        </div>
        <div className="fds-scout">
          斥候：{f.scouting >= 70 ? '看清了敌阵的阵势' : f.scouting >= 45 ? '只看出个大概' : '没能靠近，敌阵不明'}
        </div>
      </div>

      <div className="fd-bottom">
        <div className="fdb-forms">
          {FORM_ORDER.map((id) => (
            <button
              key={id}
              className={'fdb-form' + (f.formation === id ? ' on' : '')}
              onClick={() => setForm(id)}
            >
              {FORMATIONS[id].name}
            </button>
          ))}
        </div>
        <div className="fdb-desc">{def.desc}</div>
        <button
          className="fdb-go"
          onClick={() => {
            Audio.drum();
            engine.dispatch({ t: 'field_begin' });
            engine.dispatch({ t: 'field_round' });
          }}
        >
          击 鼓 进 兵
        </button>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────

function Fighting(
  { engine, idx, field }: { engine: Engine; idx: ContentIndex; field: FieldBattle },
) {
  const f = field;
  const d = f.pending;

  return (
    <>
      <div className="fd-log">
        {f.log.slice(-5).map((l, i) => (
          <div key={i} className={'fdl ' + l.tone}>
            <span className="fdl-r">{l.round}</span>
            {renderText(idx.db.text, l.textId, l.vars)}
          </div>
        ))}
      </div>

      {d ? (
        <div className="fd-decision">
          <div className="fdd-text">{renderText(idx.db.text, d.textId, d.vars)}</div>
          <div className="fdd-opts">
            {d.options.map((o, i) => (
              <button
                key={o.textId}
                className={'fdd-opt' + (o.effect.gamble ? ' gamble' : '')}
                onClick={() => { Audio.click(); engine.dispatch({ t: 'field_decide', option: i }); }}
              >
                <span className="fdd-name">{renderText(idx.db.text, o.textId)}</span>
                <span className="fdd-hint">{renderText(idx.db.text, o.hintId)}</span>
                {o.effect.gamble && <span className="fdd-odds">胜算 {o.effect.gamble.chance}%</span>}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="fd-bottom">
          <div className="fdb-desc">
            阵型：<b>{FORMATIONS[f.formation].name}</b> · {FORMATIONS[f.formation].desc}
          </div>
          <button
            className="fdb-go"
            onClick={() => { Audio.thud(); engine.dispatch({ t: 'field_round' }); }}
          >
            再 战 一 轮 <em>空格</em>
          </button>
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────

function Aftermath(
  { engine, idx, field }: { engine: Engine; idx: ContentIndex; field: FieldBattle },
) {
  const f = field;
  const title = f.outcome === 'won' ? '胜' : f.outcome === 'lost' ? '败' : '各 自 收 兵';
  const ownLeft = f.units.filter((u) => u.side === 'own' && !u.routed).reduce((a, u) => a + u.men, 0);
  const foeLeft = f.units.filter((u) => u.side === 'foe' && !u.routed).reduce((a, u) => a + u.men, 0);

  return (
    <div className="battle">
      <div className="bt-inner">
        <div className="bt-era">野战 · 第 {f.round} 轮</div>
        <h1 className="bt-title">{title}</h1>
        <p className="bt-lead">
          {renderText(idx.db.text, 'fd.' + (f.outcome ?? 'withdrew'))}
        </p>
        <div className="bt-tally">
          <div><div className="bt-k">回城的</div><div className="bt-v">{ownLeft} 人</div></div>
          <div><div className="bt-k">敌军还剩</div><div className="bt-v">{foeLeft} 人</div></div>
          <div><div className="bt-k">打了</div><div className="bt-v">{f.round} 轮</div></div>
        </div>
        <div className="bt-review">
          {f.log.map((l, i) => (
            <div key={i} className={'btl ' + l.tone}>
              <span className="btl-r">{l.round}</span>
              {renderText(idx.db.text, l.textId, l.vars)}
            </div>
          ))}
        </div>
        <button
          className="bt-go"
          onClick={() => { Audio.click(); engine.dispatch({ t: 'field_dismiss' }); }}
        >
          {f.outcome === 'won' ? '回 城' : '收 拢 残 部'}
        </button>
      </div>
    </div>
  );
}
