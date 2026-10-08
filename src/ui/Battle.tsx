/**
 * 守城战的界面。
 *
 * 一场强攻是全屏的 —— 城下正在厮杀，别的事都不重要了。
 *
 * 三个阶段各只做一件事：
 *   部署 → 把人分到三处，每处做什么写在脸上
 *   交战 → 一轮一轮打，中间停下来问你两三次
 *   战报 → 谁死了多少，哪一步是关键
 *
 * 「好上手」在这里落成四个预设按钮：一次点击就能摆完阵，
 * 想细调的再去动滑杆。不该有人因为不会分兵而打不了这一仗。
 */
import { useEffect, useState } from 'react';
import { Engine } from '../sim/engine.ts';
import { renderText, type ContentIndex } from '../sim/content.ts';
import type { Battle } from '../sim/battle_types.ts';
import { Audio } from '../audio/ambience.ts';

interface Props {
  engine: Engine;
  idx: ContentIndex;
  battle: Battle;
}

type Preset = 'even' | 'wall' | 'gate' | 'reserve';

const PRESETS: Record<Preset, { name: string; hint: string; split: (m: number) => [number, number] }> = {
  even: {
    name: '三处均分',
    hint: '不偏不倚。哪一头都不至于垮，也哪一头都不占便宜。',
    split: (m) => [Math.floor(m / 3), Math.floor(m / 3)],
  },
  wall: {
    name: '重兵上城头',
    hint: '居高临下地射。打的是他的士气 —— 逼他退兵，而不是熬到最后。',
    split: (m) => [Math.floor(m * 0.62), Math.floor(m * 0.18)],
  },
  gate: {
    name: '死守城门',
    hint: '撞木撞不开门，城墙就塌不了。代价是城头人少，蚁附会难挡。',
    split: (m) => [Math.floor(m * 0.25), Math.floor(m * 0.55)],
  },
  reserve: {
    name: '厚置预备',
    hint: '哪里破了往哪里堵。伤亡最小，但打不痛对方。',
    split: (m) => [Math.floor(m * 0.34), Math.floor(m * 0.16)],
  },
};

export function BattleScreen({ engine, idx, battle }: Props) {
  const b = battle;
  const faction = idx.faction.get(b.attackerId);
  const city = idx.node.get(b.cityId);

  if (b.phase === 'deploy') {
    return <Deploy engine={engine} battle={b} attacker={faction?.name ?? ''} city={city?.name ?? ''} />;
  }
  if (b.phase === 'done') {
    return <Aftermath engine={engine} idx={idx} battle={b} attacker={faction?.name ?? ''} />;
  }
  return <Fighting engine={engine} idx={idx} battle={b} attacker={faction?.name ?? ''} city={city?.name ?? ''} />;
}

// ─────────────────────────────────────────────────────────────

function Deploy(
  { engine, battle, attacker, city }:
  { engine: Engine; battle: Battle; attacker: string; city: string },
) {
  const men = battle.defMen;
  const [preset, setPreset] = useState<Preset>('even');
  const [wall, setWall] = useState(() => PRESETS.even.split(men)[0]);
  const [gate, setGate] = useState(() => PRESETS.even.split(men)[1]);
  const reserve = Math.max(0, men - wall - gate);

  const apply = (p: Preset): void => {
    Audio.click();
    setPreset(p);
    const [w, g] = PRESETS[p].split(men);
    setWall(w);
    setGate(g);
  };

  // 拖动滑杆时保证三处加起来永远等于总兵力
  const setWallSafe = (v: number): void => {
    const w = Math.max(0, Math.min(men, v));
    setWall(w);
    if (w + gate > men) setGate(men - w);
  };
  const setGateSafe = (v: number): void => {
    const g = Math.max(0, Math.min(men - wall, v));
    setGate(g);
  };

  return (
    <div className="battle">
      <div className="bt-inner">
        <div className="bt-era">{city} · 城下</div>
        <h1 className="bt-title">{attacker} 强攻</h1>
        <p className="bt-lead">
          城下 <b>{battle.atkMen}</b> 人，城中 <b>{men}</b> 人。城墙完好 {battle.wallIntegrity}。
        </p>

        <div className="bt-presets">
          {(Object.keys(PRESETS) as Preset[]).map((p) => (
            <button
              key={p}
              className={'bt-preset' + (preset === p ? ' on' : '')}
              onClick={() => apply(p)}
            >
              {PRESETS[p].name}
            </button>
          ))}
        </div>
        <div className="bt-preset-hint">{PRESETS[preset].hint}</div>

        <div className="bt-deploy">
          <Post
            label="城头" men={wall} total={men}
            desc="射住城下，压制蚁附。人越多，对方死得越快、越早泄气。"
            onChange={setWallSafe}
          />
          <Post
            label="城门" men={gate} total={men}
            desc="挡住撞木。城门无人，城墙一轮就能被撞掉一大块。"
            onChange={setGateSafe}
          />
          <Post
            label="预备" men={reserve} total={men} readOnly
            desc="哪里破了往哪里堵。它决定你的人死得慢不慢。"
          />
        </div>

        <button
          className="bt-go"
          onClick={() => {
            Audio.drum();
            engine.dispatch({ t: 'deploy', wall, gate, reserve });
          }}
        >
          就 位
        </button>
      </div>
    </div>
  );
}

function Post(
  { label, men, total, desc, onChange, readOnly }:
  {
    label: string; men: number; total: number; desc: string;
    onChange?: (v: number) => void; readOnly?: boolean;
  },
) {
  const pct = total > 0 ? Math.round((men / total) * 100) : 0;
  return (
    <div className={'bt-post' + (readOnly ? ' ro' : '')}>
      <div className="bp-head">
        <span className="bp-label">{label}</span>
        <span className="bp-men">{men} <span className="dim">人 · {pct}%</span></span>
      </div>
      {onChange ? (
        <input
          type="range" min={0} max={total} value={men}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      ) : (
        <div className="bp-bar"><i style={{ width: pct + '%' }} /></div>
      )}
      <div className="bp-desc">{desc}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

function Fighting(
  { engine, idx, battle, attacker, city }:
  { engine: Engine; idx: ContentIndex; battle: Battle; attacker: string; city: string },
) {
  const b = battle;
  const d = b.pending;

  // 没有待决断时，按空格接着打
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== ' ' || d) return;
      e.preventDefault();
      engine.dispatch({ t: 'battle_round' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, d]);

  return (
    <div className="battle">
      <div className="bt-field">
        <div className="bt-round">
          {b.round === 0 ? '两军对圆' : '第 ' + b.round + ' 轮 · 共 ' + b.maxRounds + ' 轮'}
        </div>

        <div className="bt-sides">
          <Side
            name={city} sub="守"
            men={b.defMen} morale={b.defMorale} mine
            detail={`城头 ${b.deploy.wall} · 城门 ${b.deploy.gate} · 预备 ${b.deploy.reserve}`}
          />
          <div className="bt-wall">
            <div className="bw-label">城墙</div>
            <div className="bw-bar">
              <i
                className={b.wallIntegrity < 35 ? 'crit' : b.wallIntegrity < 60 ? 'warn' : ''}
                style={{ height: b.wallIntegrity + '%' }}
              />
            </div>
            <div className="bw-num">{b.wallIntegrity}</div>
          </div>
          <Side name={attacker} sub="攻" men={b.atkMen} morale={b.atkMorale} />
        </div>

        {d ? (
          <div className="bt-decision">
            <div className="bd-text">{renderText(idx.db.text, d.textId, d.vars)}</div>
            <div className="bd-options">
              {d.options.map((o, i) => (
                <button
                  key={o.textId}
                  className={'bd-opt' + (o.effect.gamble ? ' gamble' : '')}
                  onClick={() => { Audio.click(); engine.dispatch({ t: 'decide', option: i }); }}
                >
                  <span className="bd-name">{renderText(idx.db.text, o.textId)}</span>
                  <span className="bd-hint">{renderText(idx.db.text, o.hintId)}</span>
                  {o.effect.gamble && (
                    <span className="bd-odds">胜算 {o.effect.gamble.chance}%</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button
            className="bt-go"
            onClick={() => { Audio.thud(); engine.dispatch({ t: 'battle_round' }); }}
          >
            再 打 一 轮 <em>空格</em>
          </button>
        )}

        <BattleLog idx={idx} battle={b} />
      </div>
    </div>
  );
}

function Side(
  { name, sub, men, morale, detail, mine }:
  { name: string; sub: string; men: number; morale: number; detail?: string; mine?: boolean },
) {
  const mood = morale >= 65 ? '锐' : morale >= 45 ? '稳' : morale >= 28 ? '疲' : '溃';
  return (
    <div className={'bt-side' + (mine ? ' mine' : '')}>
      <div className="bs-sub">{sub}</div>
      <div className="bs-name">{name}</div>
      <div className="bs-men">{men}<span className="dim"> 人</span></div>
      <div className="bs-morale">
        <div className="bs-mbar">
          <i className={morale < 28 ? 'crit' : morale < 45 ? 'warn' : ''} style={{ width: morale + '%' }} />
        </div>
        <span className="bs-mood">士气 {mood}</span>
      </div>
      {detail && <div className="bs-detail">{detail}</div>}
    </div>
  );
}

function BattleLog({ idx, battle }: { idx: ContentIndex; battle: Battle }) {
  const lines = battle.log.slice(-6);
  if (lines.length === 0) return null;
  return (
    <div className="bt-log">
      {lines.map((l, i) => (
        <div key={i} className={'btl ' + l.tone}>
          <span className="btl-r">{l.round}</span>
          {renderText(idx.db.text, l.textId, l.vars)}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

function Aftermath(
  { engine, idx, battle, attacker }:
  { engine: Engine; idx: ContentIndex; battle: Battle; attacker: string },
) {
  const held = battle.outcome === 'held';
  // 流寇破城是被洗劫，不是丢城 —— 结局的措辞必须分开，否则玩家会以为自己输光了
  const bandits = battle.attackerId === 'bandit';
  const title = held ? '守 住 了' : bandits ? '城 被 洗 劫' : '城 破';
  const lead = held ? 'bt.held' : bandits ? 'bt.sacked' : 'bt.fallen';
  return (
    <div className="battle">
      <div className="bt-inner">
        <div className="bt-era">{attacker} 强攻 · 第 {battle.round} 轮</div>
        <h1 className="bt-title">{title}</h1>
        <p className="bt-lead">{renderText(idx.db.text, lead)}</p>

        <div className="bt-tally">
          <div>
            <div className="bt-k">城中还剩</div>
            <div className="bt-v">{battle.defMen} 人</div>
          </div>
          <div>
            <div className="bt-k">城下还剩</div>
            <div className="bt-v">{battle.atkMen} 人</div>
          </div>
          <div>
            <div className="bt-k">城墙</div>
            <div className="bt-v">{battle.wallIntegrity}</div>
          </div>
        </div>

        <div className="bt-review">
          {battle.log.map((l, i) => (
            <div key={i} className={'btl ' + l.tone}>
              <span className="btl-r">{l.round}</span>
              {renderText(idx.db.text, l.textId, l.vars)}
            </div>
          ))}
        </div>

        <button
          className="bt-go"
          onClick={() => { Audio.click(); engine.dispatch({ t: 'battle_dismiss' }); }}
        >
          {held ? '收 兵' : bandits ? '清 点' : '……'}
        </button>
      </div>
    </div>
  );
}
