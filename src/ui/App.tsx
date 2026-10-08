/**
 * 界面。
 *
 * 只做三件事：读引擎快照渲染、把点击发成命令、把事件转成提示。
 * 任何「能不能做」的判断都不在这里 —— 一律交给模拟层拒绝，界面负责把理由说出来。
 *
 * 布局遵守一条硬规则：**任何时刻屏幕上不超过五个可操作项**。
 * 顶栏 + 一张指标条 + 点开之后的一张卡片，就是全部。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Engine } from '../sim/engine.ts';
import {
  renderText, totalInvested, upgradeCost,
  type BuildingDef, type ContentIndex,
} from '../sim/content.ts';
import { availableBuildings, computeOutput, countOf, isPlotOpen } from '../sim/city.ts';
import { currentCity } from '../sim/state.ts';
import {
  formatDate, quarterLabel, SEASON_NAME, seasonOf, shichenOf,
} from '../sim/time.ts';
import {
  AFFLICTION_NAME, DEMOLISH_REFUND, RANKS, WALL_COST, YAMEN_PLOT, type City,
} from '../sim/types.ts';
import { WALL_MAX, type EndingKind } from '../sim/world_types.ts';
import { defenceOf, garrisonOf } from '../sim/worldtick.ts';
import { CityView, type BesiegerInfo } from '../view/city.ts';
import { WorldMap } from '../view/worldmap.ts';
import { Audio } from '../audio/ambience.ts';
import { BattleScreen } from './Battle.tsx';
import { FieldScreen } from './Field.tsx';
import { FieldView } from '../view/field.ts';
import { TheatreView } from '../view/theatre.ts';
import { TheatreScreen } from './Theatre.tsx';
import { LordScreen } from './Lord.tsx';
import { CourtEnding, CourtScreen } from './Court.tsx';
import './court.css';
import { whyNotMarch } from '../sim/handlers_theatre.ts';
import { wardenOf } from '../sim/people.ts';
import { atWar } from '../sim/diplomacy.ts';
import { CampView } from '../view/camp.ts';
import type { SaveMeta } from '../save.ts';
import {
  CampMeters, CampPanel, GrainAlarm, Marching, OrderBanner, WarCouncil,
} from './Camp.tsx';
import { MILITARY_RANKS, STARTING_CAMP } from '../sim/general_types.ts';
import type { PlayerRole } from '../sim/state.ts';

/** 一日折合多少现实秒（1× 速度） */
const SECONDS_PER_DAY = 4;
const SPEEDS = [0, 1, 3, 10] as const;

type Mode = 'city' | 'world';

interface Props {
  engine: Engine;
  idx: ContentIndex;
  host: HTMLElement;
  /** 上一局走到哪儿了。没存档就是 null */
  saved: SaveMeta | null;
  /** 接着上一局打 */
  onResume: () => void;
  /** 不要上一局了 */
  onFresh: () => void;
}

interface Toast {
  id: number;
  text: string;
  tone: 'plain' | 'good' | 'bad';
}

let toastId = 0;

export function App({ engine, idx, host, saved, onResume, onFresh }: Props) {
  const [rev, setRev] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [pickedCity, setPickedCity] = useState<string | null>(null);
  const [pickedUnit, setPickedUnit] = useState<string | null>(null);
  /** 玩家在战场图上点的那一格 */
  const [pickedCell, setPickedCell] = useState<{ col: number; row: number } | null>(null);
  const [mode, setMode] = useState<Mode>('city');
  const [razeMode, setRazeMode] = useState(false);
  const campRef = useRef<CampView | null>(null);
  const [speedIdx, setSpeedIdx] = useState(1);
  /** 主公看的是朝堂还是天下图。默认朝堂 —— 图不再是主屏 */
  const [lordView, setLordView] = useState<'court' | 'realm'>('court');

  const cityRef = useRef<CityView | null>(null);
  const mapRef = useRef<WorldMap | null>(null);
  const fieldRef = useRef<FieldView | null>(null);
  const theatreRef = useRef<TheatreView | null>(null);
  const fracRef = useRef(0.35);
  const speedRef = useRef(1);
  const razeRef = useRef(false);
  razeRef.current = razeMode;
  speedRef.current = SPEEDS[speedIdx] ?? 1;

  const st = engine.getState();
  const started = st.started;

  const push = useCallback((text: string, tone: Toast['tone'] = 'plain') => {
    const t = { id: toastId++, text, tone };
    setToasts((prev) => [...prev.slice(-5), t]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), 8000);
  }, []);

  // ── 事件订阅 ──
  useEffect(() => engine.subscribe((events) => {
    const fname = (id: string): string => idx.faction.get(id)?.name ?? id;
    const cname = (id: string): string => idx.node.get(id)?.name ?? id;
    const here = (id: string): boolean => id === engine.getState().official.cityId;

    for (const ev of events) {
      switch (ev.t) {
        case 'built': {
          const d = idx.building.get(ev.buildingId);
          push((d?.name ?? '') + '修成了（' + ev.level + '级）', 'good');
          Audio.chime();
          break;
        }
        case 'demolish_started': {
          const d = idx.building.get(ev.buildingId);
          push('开始拆除' + (d?.name ?? '') + '，需 ' + ev.days + ' 日。', 'plain');
          break;
        }
        case 'demolished': {
          const d = idx.building.get(ev.buildingId);
          push(
            (d?.name ?? '') + '拆了。收回折钱 ' + ev.refundCoin + ' 缗、粮 ' + ev.refundGrain + ' 石。',
            'plain',
          );
          Audio.thud();
          break;
        }
        case 'unlocked': {
          const d = idx.building.get(ev.buildingId);
          push('可以营造：' + (d?.name ?? ''), 'good');
          break;
        }
        case 'wall_started':
          push('城墙开始修葺，需 ' + ev.days + ' 日。', 'plain');
          break;
        case 'wall_done':
          push('城墙修好了（' + ev.level + ' 级）。站上去能看出很远。', 'good');
          Audio.chime();
          break;
        case 'quota_issued':
          push(
            ev.coin > 0
              ? '使者来了：本季须交粮 ' + ev.grain + ' 石、钱 ' + ev.coin + ' 缗'
              : '使者来了：本季须交粮 ' + ev.grain + ' 石',
            'plain',
          );
          Audio.drum();
          break;
        case 'quota_settled':
          push(ev.met ? '这一季的差事交上去了。' : '这一季没交上。主公的回文很短。', ev.met ? 'good' : 'bad');
          break;
        case 'promoted':
          push('调令下来了。自今日起，你是' + RANKS[ev.rank] + '。', 'good');
          Audio.drum();
          break;
        case 'granary_full':
          push('粮仓满了。新收的粮堆在檐下，眼看着要烂。', 'bad');
          break;
        case 'treasury_full':
          push('府库满了。', 'bad');
          break;
        case 'famine':
          push('米缸空了。城里开始有人往外走。', 'bad');
          break;
        case 'affliction':
          push(renderText(idx.db.text, 'aff.' + ev.kind, {
            grain: ev.grainLost, pop: ev.popLost, coin: 0, count: 0,
          }), 'bad');
          Audio.thud();
          break;
        case 'affliction_ended': {
          const s = renderText(idx.db.text, 'aff.ended.' + ev.kind);
          if (s && !s.startsWith('⟪')) push(s, 'good');
          break;
        }
        case 'refugees_arrived':
          push(renderText(idx.db.text, 'aff.refugees', { count: ev.count }), 'plain');
          break;
        case 'pop_changed':
          if (ev.reason === 'flight') push('又有人在夜里走了。守门的没拦——拦不住。', 'bad');
          break;
        case 'expanded':
          push('外郭拓开了。地方大了，能做的事也多了。', 'good');
          Audio.drum();
          break;

        // ── 天下 ──
        case 'army_launched':
          if (here(ev.toId)) {
            push(fname(ev.factionId) + '发兵 ' + ev.troops + ' 人，正朝这里来。', 'bad');
            Audio.drum();
          } else {
            push(
              fname(ev.factionId) + '自' + cname(ev.fromId) + '发兵 ' + ev.troops
                + ' 攻' + cname(ev.toId) + '。',
              'plain',
            );
          }
          break;
        case 'siege_started':
          if (here(ev.cityId)) {
            push(fname(ev.factionId) + '的兵到了城下，' + ev.troops + ' 人。', 'bad');
            Audio.thud();
          } else {
            push(fname(ev.factionId) + '围了' + cname(ev.cityId) + '。', 'plain');
          }
          break;
        case 'siege_lifted':
          push(
            here(ev.cityId) ? '城下的兵退了。' : fname(ev.factionId) + '自' + cname(ev.cityId) + '城下退兵。',
            here(ev.cityId) ? 'good' : 'plain',
          );
          break;
        case 'city_fell':
          push(cname(ev.cityId) + '陷落：' + fname(ev.from) + ' → ' + fname(ev.to), 'bad');
          Audio.thud();
          break;
        case 'assault_begun':
          push(fname(ev.factionId) + '擂鼓了。云梯抬到了城下——他们要强攻。', 'bad');
          Audio.drum();
          break;
        case 'sortie_begun':
          push(renderText(idx.db.text, 'fd.begin'), 'plain');
          Audio.drum();
          break;
        case 'sortie_ended':
          push(
            ev.outcome === 'won' ? '打退了。城下的营盘拔了。'
              : ev.outcome === 'lost' ? '败了。回城的人不到出去时的一半。'
                : '各自收兵。他仍在城下。',
            ev.outcome === 'won' ? 'good' : ev.outcome === 'lost' ? 'bad' : 'plain',
          );
          break;
        case 'sacked':
          push(
            '流寇抢走了粮 ' + ev.grain + ' 石、钱 ' + ev.coin + ' 缗，天亮前散了。城还是你的。',
            'bad',
          );
          Audio.thud();
          break;
        case 'assault_ended':
          push(
            ev.outcome === 'held'
              ? '这一场守住了。城下留了不少人。'
              : '没守住。',
            ev.outcome === 'held' ? 'good' : 'bad',
          );
          break;
        case 'lord_relief':
          push('主公遣兵 ' + ev.troops + ' 来援。他还信得过你。', 'good');
          Audio.drum();
          break;
        case 'army_dispersed':
          push(fname(ev.factionId) + '往' + cname(ev.toId) + '的军队断粮溃散了。', 'plain');
          break;
        case 'theatre_event': {
          /**
           * 战场上出了事 —— 把镜头推过去。
           *
           * **不是每件事都推。**每一次接触都推一下，画面会抽搐。
           * 只推那几个真正的关口：伏兵起、某一路崩了、大营起火、城墙塌了。
           * 那几下正是玩家花心思布的局兑现的时刻，错过了这局就白布了。
           */
          const BIG = new Set([
            'th.ambush_ours', 'th.ambush_theirs',
            'th.routed_ours', 'th.routed_theirs',
            'th.supply_burned', 'th.wall_broken', 'th.strayed', 'th.wiped',
  'th.hard_ours', 'th.hard_theirs',
  'th.spotted_ours', 'th.spotted_theirs',
          ]);
          if (ev.at && BIG.has(ev.textId)) {
            theatreRef.current?.pushTo(ev.at[0], ev.at[1], ev.tone === 'bad' ? 'bad' : 'good');
          }
          break;
        }
        case 'order_issued':
          push('主公有令。', 'plain');
          break;
        case 'order_settled':
          push(
            ev.outcome === 'done' ? '差事办成了。'
              : ev.outcome === 'defied' ? '你抗了这道令。主公会记着。'
                : '这道令没能办成。',
            ev.outcome === 'done' ? 'good' : 'bad',
          );
          break;
        case 'officer_joined':
          push(
            ev.officerId
              ? (idx.person.get(ev.officerId)?.name ?? '有人') + '来投。'
              : '礼送出去了，人没请来。',
            ev.officerId ? 'good' : 'bad',
          );
          break;
        case 'rejected':
          push(renderText(idx.db.text, 'rej.' + ev.reasonId), 'bad');
          break;
        default:
          break;
      }
    }
    setRev((r) => r + 1);
  }), [engine, idx, push]);

  // ── 两个场景一起挂上，切换时只暂停不销毁 ──
  //
  // 武将没有那座跑完整地块模型的城，所以城内图对他不成立 ——
  // 他的主视图是天下图，只挂那一个
  const isGeneral = st.role === 'general';
  const isLord = st.role === 'lord';
  useEffect(() => {
    if (!started || mapRef.current) return;

    /**
     * 主公没有「自己那一处」。
     *
     * 文官挂城内图，武将挂营内图 —— 那都是他亲手经营的地方。
     * 主公中间只有天下图：他手上没有任何一处是自己做的。
     *
     * 少了这一句，主公会被当成文官去建一座并不存在的城的场景，
     * 开局当场白屏（`Cannot read properties of undefined`）。
     */
    if (isLord) {
      void 0;
    } else if (isGeneral) {
      const campView = new CampView(host);
      const c0 = Object.values(engine.getState().camps)[0];
      if (c0) campView.sync(c0, '#c8a45c', 0.32);
      campView.start();
      campRef.current = campView;
      if (import.meta.env.DEV) {
        (window as unknown as { __camp?: CampView }).__camp = campView;
      }
    } else {
      const cityView = new CityView(host, {
      onPickPlot: (i) => {
        Audio.click();
        // 拆除模式下，左键点谁就拆谁
        if (razeRef.current) {
          engine.dispatch({ t: 'demolish', plot: i });
          return;
        }
        setSelected(i);
      },
        onHoverPlot: () => { /* 悬停高亮由场景自理 */ },
      });
      cityView.sync(currentCity(engine.getState()), seasonOf(engine.getState().day), null);
      cityView.start();
      cityRef.current = cityView;
    }

    const map = new WorldMap(host, idx, {
      onPickCity: (id) => { setPickedCity(id); Audio.click(); },
    });
    map.sync(engine.getState(), idx);
    map.focus(engine.getState().official.cityId, idx);
    // 武将开局站在自己的营里，和文官开局站在城里一样
    map.setPaused(true);
    map.start();
    mapRef.current = map;

    if (import.meta.env.DEV) {
      const w = window as unknown as {
        __openPlot?: (i: number | null) => void;
        __city?: CityView | null; __map?: WorldMap;
        __engine?: Engine; __sortie?: (foe?: number) => void;
      };
      /**
       * 把当前画面存到 .shots/ 下。
       *
       * 调视效必须看得见 —— 只靠采样几个像素点，
       * 能确认「有东西」，确认不了「好不好看」。
       */
      (w as unknown as { __shot?: (name?: string) => Promise<string> }).__shot =
        async (name = 'latest') => {
          // 页面里会同时挂着好几张画布（城内、天下、战场），
          // 要的是**当前显示的那一张** —— 取第一张会截到底下压着的场景
          const all = [...document.querySelectorAll('canvas')]
            .filter((x) => x.style.display !== 'none' && x.width > 100);
          const src = all[all.length - 1];
          if (!src) return 'no canvas';
          const c = document.createElement('canvas');
          c.width = 1280;
          c.height = Math.round((1280 * src.height) / src.width);
          c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
          const res = await fetch('/__shot/' + name, {
            method: 'POST', body: c.toDataURL('image/png'),
          });
          return res.text();
        };
      w.__openPlot = (i) => setSelected(i);
      w.__city = cityRef.current;
      w.__map = map;
      w.__engine = engine;
      // 一脚踩进野战。调战场的视效时不必先在城里发育二十分钟
      w.__sortie = (foe = 210) => {
        const st2 = engine.getState() as unknown as {
          cities: Record<string, {
            households: number; morale: number;
            plots: { buildingId: string | null; level: number; work: unknown }[];
          }>;
          sieges: Record<string, unknown>;
          official: { cityId: string };
        };
        const id = st2.official.cityId;
        const c = st2.cities[id]!;
        c.households = 800;
        c.morale = 62;
        c.plots[7] = { buildingId: 'barracks', level: 2, work: null };
        st2.sieges[id] = {
          cityId: id, factionId: 'taiping', troops: foe, supply: 9000, days: 2,
        };
        engine.dispatch({ t: 'sortie' });
      };
      // 一脚踩进出征。调点将台与战场时不必先在营里练三年兵
      (w as unknown as { __march?: (plan?: string) => string }).__march = (plan = 'trap') => {
        const s2 = engine.getState() as unknown as {
          camps: Record<string, {
            troops: number; training: number; gear: number; grain: number; nodeId: string;
          }>;
          nodes: Record<string, { factionId: string }>;
          official: { lordId: string };
        };
        const camp = Object.values(s2.camps)[0];
        if (!camp) return '这一局不是武将';
        camp.troops = 700; camp.training = 62; camp.gear = 2; camp.grain = 4000;
        const foe = Object.entries(s2.nodes)
          .find(([, n]) => n.factionId !== s2.official.lordId);
        if (!foe) return '天下无敌';
        engine.dispatch({ t: 'campaign_open', targetNodeId: foe[0] });
        const c = engine.getState().campaign;
        if (!c) return '开不了军议';
        const road = (k: string): string =>
          (c.routes.find((r) => r.kind === k) ?? c.routes[0]!).id;
        const cols = plan === 'plain'
          ? [{ men: 700, routeId: road('main'), mission: 'assault' as const, officerId: null }]
          : [
            { men: 140, routeId: road('main'), mission: 'feint' as const, officerId: 'lidian' },
            { men: 350, routeId: road('byway'), mission: 'ambush' as const, officerId: 'caoren' },
            { men: 210, routeId: road('main'), mission: 'assault' as const, officerId: 'yuejin' },
          ];
        engine.dispatch({ t: 'campaign_plan', columns: cols });
        engine.dispatch({ t: 'campaign_go' });
        for (let d = 0; d < 40; d++) {
          const s3 = engine.getState();
          if (s3.field || !s3.campaign) break;
          engine.dispatch({ t: 'day' });
        }
        return engine.getState().field ? '接战' : '没打起来';
      };
      /**
       * 一脚踩进战场。
       *
       * 调战场的视效、镜头、战报都要真打一仗才看得见 ——
       * 而正常走一遍要在营里练三年兵、等一道军令、再行军半个月。
       */
      (w as unknown as { __war?: (n?: number) => string }).__war = (n = 800) => {
        const s2 = engine.getState() as unknown as {
          camps: Record<string, {
            troops: number; training: number; gear: number; grain: number;
            works: Record<string, number>;
          }>;
          nodes: Record<string, { factionId: string; troops: number }>;
          official: { lordId: string };
          retinue: string[];
          flags: Record<string, number>;
        };
        const camp = Object.values(s2.camps)[0];
        if (!camp) return '这一局不是武将';
        camp.troops = n; camp.training = 70; camp.gear = 3; camp.grain = 5000;
        s2.retinue = ['yuejin', 'lidian', 'caoren'];
        delete s2.flags['campaignRest'];
        const foe = Object.entries(s2.nodes)
          .find(([, x]) => x.factionId !== s2.official.lordId);
        if (!foe) return '天下无敌';
        engine.dispatch({ t: 'theatre_open', targetNodeId: foe[0] });
        return engine.getState().theatre ? '到了城下' : '出不了兵';
      };
    }
    return () => {
      cityRef.current?.dispose(); cityRef.current = null;
      campRef.current?.dispose(); campRef.current = null;
      map.dispose(); mapRef.current = null;
    };
  }, [started, isGeneral, isLord, engine, idx, host]);

  // ── 武将的战场 ──
  //
  // 与野战同一个路子：按需挂载，打完就拆。
  // 但它是另一套场景（地图 + 位置 + 时间），所以另建一个 View
  const inTheatre = st.theatre !== null;
  useEffect(() => {
    if (!inTheatre) {
      theatreRef.current?.dispose();
      theatreRef.current = null;
      return;
    }
    if (theatreRef.current) return;
    const view = new TheatreView(host, {
      onPickCell: (col, row) => {
        // 只有在派将阶段点地才有意义
        if (engine.getState().theatre?.phase !== 'orders') return;
        Audio.click();
        setPickedCell({ col, row });
        view.showMark(col, row, 'good');
      },
      onHoverCell: () => { /* 悬停的提示交给场景自己 */ },
    });
    const t0 = engine.getState().theatre;
    if (t0) view.sync(t0);
    view.start();
    theatreRef.current = view;
    if (import.meta.env.DEV) {
      (window as unknown as { __theatre?: TheatreView }).__theatre = view;
    }
  }, [inTheatre, engine, host]);

  useEffect(() => {
    // 这里以前写的是 st.theatre!。那个叹号是在骗自己：
    // 收兵之后 theatre 就是 null，而这个 effect 照样会跑一次
    const th = st.theatre;
    if (!th) return;
    theatreRef.current?.sync(th);
  }, [rev, st]);

  // 战场按需挂载：只有真打野战时才建它，打完就拆 ——
  // 一张一直挂着的战场没有意义，还要白占一个 WebGL 上下文
  const inField = st.field !== null;
  useEffect(() => {
    if (!inField) {
      fieldRef.current?.dispose();
      fieldRef.current = null;
      return;
    }
    if (fieldRef.current) return;
    const view = new FieldView(host, {
      onPlace: (id, col, row) => {
        const f = engine.getState().field;
        if (!f || f.phase !== 'deploy') return;
        Audio.click();
        engine.dispatch({
          t: 'field_deploy',
          formation: f.formation,
          places: f.units
            .filter((u) => u.side === 'own')
            .map((u) => (u.id === id ? { id, col, row } : { id: u.id, col: u.col, row: u.row })),
        });
      },
      onPickUnit: (id) => setPickedUnit(id),
    });
    view.start();
    fieldRef.current = view;
    if (import.meta.env.DEV) {
      (window as unknown as { __field?: FieldView }).__field = view;
    }
  }, [inField, engine, host]);

  useEffect(() => {
    const f = st.field;
    if (!f || !fieldRef.current) return;
    fieldRef.current.setField(f);
    fieldRef.current.sync(
      f,
      idx.faction.get(st.official.lordId)?.color ?? '#c8a45c',
      idx.faction.get(f.foeFactionId)?.color ?? '#8a3b32',
    );
    if (f.pending?.focus) fieldRef.current.focusCell(f.pending.focus.col, f.pending.focus.row);
  }, [rev, st, idx]);

  useEffect(() => {
    // 打野战时，城内图与天下图都让开
    // 「城中」这一档，文官看的是城，武将看的是营
    // 打起来的时候别的场景一律停手 —— 两个 WebGL 场景同时跑会互相抢帧
    const busy = inField || inTheatre;
    cityRef.current?.setPaused(busy || mode !== 'city');
    campRef.current?.setPaused(busy || mode !== 'city');
    /**
     * 天下图什么时候该停手。
     *
     * 主公这一档原先写的是「永不暂停」，理由是「别把他唯一的画面停掉」——
     * 但从 M5a 起他的主画面是**朝堂**，天下图缩在一个标签页后面。
     * 于是那个 Three.js 场景在一块不透明的朝堂背后**全速跑了整局**，
     * 每一帧都在渲染没人看的东西。
     *
     * 后果全落在手感上：点「退朝」要等，点按钮像隔了一层。
     * 模拟层一次退朝只要三毫秒，慢的从来不是它。
     */
    mapRef.current?.setPaused(
      busy || (isLord ? lordView !== 'realm' : mode !== 'world'),
    );
    if (mode !== 'city') setRazeMode(false);
  }, [mode, inField, inTheatre, isLord, lordView]);

  useEffect(() => {
    cityRef.current?.setRazeMode(razeMode);
    if (razeMode) setSelected(null);
  }, [razeMode]);

  useEffect(() => {
    if (!started) return;
    mapRef.current?.sync(st, idx);
    // 主公只有天下图。他没有城内图，也没有营内图
    if (isLord) return;
    if (isGeneral) {
      const c0 = Object.values(st.camps)[0];
      const color = idx.faction.get(st.official.lordId)?.color ?? '#c8a45c';
      if (c0) campRef.current?.sync(c0, color, 0.32);
      return;
    }
    // 被围时把围兵的样貌交给场景：城外要真的立起营盘
    const sg = st.sieges[st.official.cityId];
    const f = sg ? idx.faction.get(sg.factionId) : undefined;
    const besieger: BesiegerInfo | null = sg && f
      ? { factionId: sg.factionId, banner: f.banner, color: f.color, troops: sg.troops }
      : null;
    cityRef.current?.sync(currentCity(st), seasonOf(st.day), besieger);
  }, [rev, started, isGeneral, isLord, st, idx]);

  // ── 时钟：一日 4 秒，可暂停可加速 ──
  useEffect(() => {
    if (!started) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const now0 = engine.getState();
      // 打仗时时间停住。硬发 day 只会被拒绝，还会刷一屏提示
      if (now0.ending || now0.battle) return;
      /**
       * **主公不看日历。**
       *
       * 他没有日常 —— 上一版给他挂了一排［1×］［3×］［10×］，
       * 而他的一天里什么也不发生，于是玩家在做的事是
       * 「开十倍速，看日历，等一件事」。
       * 现在他的时间由「散朝」推，一件事接一件事（见 cmdAdjourn）。
       */
      if (now0.role === 'lord') return;
      const sp = speedRef.current;
      if (sp <= 0) return;
      fracRef.current += (dt * sp) / SECONDS_PER_DAY;
      while (fracRef.current >= 1) {
        fracRef.current -= 1;
        engine.dispatch({ t: 'day' });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [started, engine]);

  // 切换视图的快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') { setRazeMode(false); return; }
      if (e.key.toLowerCase() === 'x') {
        e.preventDefault();
        setRazeMode((v) => !v);
        Audio.click();
        return;
      }
      if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setMode((v) => (v === 'city' ? 'world' : 'city'));
        Audio.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!started) {
    return (
      <Opening
        idx={idx}
        saved={saved}
        onResume={() => { Audio.enable(); onResume(); }}
        onStart={(name, role, lordId) => {
          Audio.enable();
          onFresh();
          engine.dispatch({
            t: 'begin', playerName: name, role,
            cityId: idx.db.cities[0]!.id,
            // 当主公时你**就是**那面旗号，所以这一项由开局那张表决定
            lordId: role === 'lord' ? lordId : idx.db.lords[0]!.id,
          });
        }}
      />
    );
  }

  if (st.ending) {
    /**
     * 主公的结局不是胜负屏，是**史书上的一段**加一张生平时间轴。
     * 「失败不是游戏结束，是那一段写得不好看」—— 这一条比任何
     * Victory / Defeat 都更让人想再来一局。
     */
    if (st.role === 'lord' && st.court) {
      return <CourtEnding engine={engine} idx={idx} onAgain={onFresh} />;
    }
    return <EndScreen idx={idx} kind={st.ending.kind} day={st.ending.day} state={st} />;
  }

  // 城下正在厮杀，别的事都不重要了
  if (st.battle) {
    return <BattleScreen engine={engine} idx={idx} battle={st.battle} />;
  }

  // 战场：界面退到最薄，中间那片地全留给战场本身
  if (st.theatre) {
    return (
      <TheatreScreen
        engine={engine}
        idx={idx}
        theatre={st.theatre}
        picked={pickedCell}
        onClearPick={() => {
          setPickedCell(null);
          theatreRef.current?.clearMark();
        }}
      />
    );
  }

  // 野战：界面很薄，中间那片地留给战场本身
  if (st.field) {
    return <FieldScreen engine={engine} idx={idx} field={st.field} picked={pickedUnit} />;
  }

  /**
   * 主公的主屏是**朝堂**，不是天下图。
   *
   * 上一版把整张图摆在他面前，于是他做的事变成「点开十二座城、
   * 每座点四个按钮」—— 十二份缩水的城池官长活。
   * 图还在，只是退回它该在的位置：一个看局势的地方，不是操作面板。
   */
  if (st.role === 'lord') {
    if (lordView === 'realm') {
      return (
        <>
          <LordScreen
            engine={engine}
            idx={idx}
            pickedCity={pickedCity}
            setPickedCity={setPickedCity}
          />
          <button
            className="ct-back"
            onClick={() => { Audio.click(); setPickedCity(null); setLordView('court'); }}
          >
            回　朝
          </button>
        </>
      );
    }
    return <CourtScreen engine={engine} idx={idx} onRealm={() => setLordView('realm')} />;
  }

  // 武将不看城，看地图 —— 从这里岔开
  if (st.role === 'general') {
    return (
      <GeneralScreen
        engine={engine}
        idx={idx}
        speedIdx={speedIdx}
        setSpeedIdx={setSpeedIdx}
        pickedCity={pickedCity}
        setPickedCity={setPickedCity}
        mode={mode}
        setMode={setMode}
      />
    );
  }

  const city = currentCity(st);
  const out = computeOutput(city, idx);
  const quota = st.quota;
  const lord = idx.lord.get(st.official.lordId);

  const needGrain = quota ? Math.max(0, quota.demandGrain - quota.paidGrain) : 0;
  const needCoin = quota ? Math.max(0, quota.demandCoin - quota.paidCoin) : 0;
  const daysLeft = quota ? Math.max(0, quota.dueDay - st.day) : 0;

  const siege = st.sieges[st.official.cityId];
  const incoming = Object.values(st.armies).filter((a) => a.toId === st.official.cityId);

  return (
    <>
      {/* 顶栏 */}
      <div className="hud-top">
        <div className="clock">
          <div className="date">{formatDate(st.day)}</div>
          <div className="sub">
            {shichenOf(cityRef.current?.getSkyTime() ?? 0.32)} · {SEASON_NAME[seasonOf(st.day)]}
            {city.afflictions.length > 0 && (
              <span className="aff">
                {city.afflictions.map((a) => AFFLICTION_NAME[a.kind]).join('、')}
              </span>
            )}
          </div>
        </div>

        <Meter label="粮" value={city.grain} cap={out.capGrain} rate={out.grainNet} unit="石" />
        <Meter label="钱" value={city.coin} cap={out.capCoin} rate={out.coinPerDay} unit="缗" />
        <Meter label="户" value={city.households} cap={out.capHouse} />
        <Morale value={city.morale} labour={out.labourRatio} />
        <Defence city={city} idx={idx} />

        <div className="spacer" />

        <button
          className={'modebtn' + (mode === 'world' ? ' on' : '')}
          title="M 键切换"
          onClick={() => { setMode(mode === 'city' ? 'world' : 'city'); Audio.click(); }}
        >
          {mode === 'city' ? '看天下' : '回城中'}
        </button>

        <div className="speeds">
          {SPEEDS.map((s, i) => (
            <button
              key={s}
              className={'sp' + (speedIdx === i ? ' on' : '')}
              title={s === 0 ? '暂停' : s + ' 倍速'}
              onClick={() => { setSpeedIdx(i); Audio.click(); }}
            >
              {s === 0 ? '❙❙' : s + '×'}
            </button>
          ))}
        </div>
      </div>

      {/* 兵临城下 */}
      {siege && (
        <div className="siege-alert">
          <div className="sa-title">
            {idx.faction.get(siege.factionId)?.name} 围城 · 第 {siege.days} 日
          </div>
          <div className="sa-row">
            <span>城下 <b>{Math.max(0, siege.troops)}</b> 人</span>
            <span>城中 <b>{st.nodes[st.official.cityId]?.troops ?? 0}</b> 人</span>
          </div>
          <div className="sa-tip">守得住与否，看兵营、城墙与民心。主公若还信得过你，会派兵来。</div>
          <button
            className="sa-sortie"
            title="带七成守军出城野战。赢了当场解围，输了城更难守"
            onClick={() => { Audio.drum(); engine.dispatch({ t: 'sortie' }); }}
          >
            出城迎击
          </button>
        </div>
      )}
      {!siege && incoming.length > 0 && (
        <div className="siege-alert warn">
          <div className="sa-title">有兵朝这里来</div>
          {incoming.map((a) => (
            <div key={a.id} className="sa-row">
              <span>{idx.faction.get(a.factionId)?.name} <b>{a.troops}</b> 人</span>
              <span>约 {Math.max(1, Math.ceil((1000 - a.progress) / 170))} 日后抵达</span>
            </div>
          ))}
        </div>
      )}

      {/* 季度指标 */}
      {quota && mode === 'city' && (
        <div className={'quota' + (daysLeft <= 15 && (needGrain > 0 || needCoin > 0) ? ' urgent' : '')}>
          <div className="q-head">
            <span className="q-lord">{lord?.name}</span> 令 · {quarterLabel(quota.quarter)}
            <span className="q-days">{daysLeft > 0 ? '余 ' + daysLeft + ' 日' : '今日截止'}</span>
          </div>
          <QuotaBar label="粮" paid={quota.paidGrain} demand={quota.demandGrain} unit="石" />
          {quota.demandCoin > 0 && (
            <QuotaBar label="钱" paid={quota.paidCoin} demand={quota.demandCoin} unit="缗" />
          )}
          <div className="q-actions">
            <button
              disabled={needGrain === 0 && needCoin === 0}
              onClick={() => {
                Audio.click();
                engine.dispatch({
                  t: 'pay',
                  grain: Math.min(needGrain, city.grain),
                  coin: Math.min(needCoin, city.coin),
                });
              }}
            >
              尽数送去
            </button>
            <button
              className="ghost"
              disabled={city.grain < 100 && city.coin < 100}
              title="留下三十日口粮，其余上缴。分批交比一次掏空更稳妥"
              onClick={() => {
                Audio.click();
                const spare = Math.max(0, city.grain - out.grainUpkeep * 30);
                engine.dispatch({
                  t: 'pay',
                  grain: Math.min(needGrain, spare),
                  coin: Math.min(needCoin, Math.max(0, city.coin - 150)),
                });
              }}
            >
              送去余粮
            </button>
          </div>
          <div className="q-tip">指标是整季累计的，可以分几次交。一次掏空会伤民心。</div>
        </div>
      )}

      {mode === 'city' && selected !== null && (
        <PlotCard engine={engine} idx={idx} index={selected} onClose={() => setSelected(null)} />
      )}
      {mode === 'world' && pickedCity && (
        <CityBrief engine={engine} idx={idx} id={pickedCity} onClose={() => setPickedCity(null)} />
      )}

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={'toast ' + t.tone}>{t.text}</div>)}
      </div>

      {/* 官阶与城务 */}
      <div className="rank">
        <span>{city.commandery} · {city.name}</span>
        <b>{RANKS[st.official.rank]}</b>
        <span className="dim">功绩 {st.official.merit} · 信任 {st.official.trust}</span>
        {mode === 'city' && (
          <>
            {out.dev >= 12 && city.ring === 0 && (
              <button
                className="expand"
                title="需钱 420、粮 300"
                onClick={() => { Audio.click(); engine.dispatch({ t: 'expand' }); }}
              >
                拓外郭
              </button>
            )}
            <button
              className={'expand raze-toggle' + (razeMode ? ' on' : '')}
              title="进入拆除模式后，左键点哪栋就拆哪栋。X 键切换，Esc 退出"
              onClick={() => { Audio.click(); setRazeMode(!razeMode); }}
            >
              {razeMode ? '拆除中…点击建筑' : '拆除'}
            </button>
            {city.wall < WALL_MAX && (
              <button
                className="expand"
                disabled={city.wallWork > 0}
                title={
                  city.wallWork > 0
                    ? '正在修葺，还需 ' + city.wallWork + ' 日'
                    : '需钱 ' + WALL_COST[city.wall]!.coin + '、粮 ' + WALL_COST[city.wall]!.grain
                      + '，工期 ' + WALL_COST[city.wall]!.days + ' 日'
                }
                onClick={() => { Audio.click(); engine.dispatch({ t: 'fortify' }); }}
              >
                {city.wallWork > 0
                  ? '修城中 ' + city.wallWork + ' 日'
                  : '修城墙至 ' + (city.wall + 1) + ' 级'}
              </button>
            )}
          </>
        )}
      </div>

      {razeMode && (
        <div className="raze-banner">
          拆除模式 · 左键点建筑即拆　
          <span className="dim">只收回三成投入，官署拆不得。按 Esc 退出</span>
        </div>
      )}

      {st.day < 12 && !razeMode && (
        <div className="controls-hint">
          拖动画面移动 · 滚轮缩放 · <b>W A S D</b> 平移 · <b>M</b> 看天下
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────

function Meter(
  { label, value, cap, rate, unit }:
  { label: string; value: number; cap: number; rate?: number; unit?: string },
) {
  const pct = Math.max(0, Math.min(100, Math.round((value / Math.max(1, cap)) * 100)));
  const full = pct >= 98;
  return (
    <div className={'meter' + (full ? ' full' : '')} title={value + ' / ' + cap + ' ' + (unit ?? '')}>
      <div className="m-label">{label}</div>
      <div className="m-value">{value}<span className="m-cap">/{cap}</span></div>
      <div className="m-bar"><i style={{ width: pct + '%' }} /></div>
      {rate !== undefined && (
        <div className={'m-rate' + (rate < 0 ? ' neg' : '')}>
          {rate >= 0 ? '+' : ''}{rate}／日
        </div>
      )}
    </div>
  );
}

function Morale({ value, labour }: { value: number; labour: number }) {
  const mood = value >= 70 ? '安' : value >= 50 ? '平' : value >= 32 ? '怨' : '乱';
  return (
    <div
      className={'meter morale m-' + mood}
      title={'民心 ' + value + '／100；劳力满足 ' + Math.floor(labour / 10) + '%'}
    >
      <div className="m-label">民心</div>
      <div className="m-value">{value}<span className="m-cap"> {mood}</span></div>
      <div className="m-bar"><i style={{ width: value + '%' }} /></div>
      {labour < 900 && <div className="m-rate neg">人手不足 {Math.floor(labour / 10)}%</div>}
    </div>
  );
}

/** 守备。在这之前兵营和城墙是纯负担建筑，这一栏是它们存在的理由 */
function Defence({ city, idx }: { city: City; idx: ContentIndex }) {
  const men = garrisonOf(city, idx);
  const power = defenceOf(city, idx);
  return (
    <div className="meter" title={'守军 ' + men + ' 人；城墙 ' + city.wall + ' 级。守备强度已计入民心'}>
      <div className="m-label">守备</div>
      <div className="m-value">{men}<span className="m-cap"> 人</span></div>
      <div className="m-bar"><i style={{ width: Math.min(100, power / 6) + '%' }} /></div>
      <div className="m-rate">城墙 {city.wall} 级</div>
    </div>
  );
}

function QuotaBar(
  { label, paid, demand, unit }: { label: string; paid: number; demand: number; unit: string },
) {
  const pct = Math.min(100, Math.round((paid / Math.max(1, demand)) * 100));
  return (
    <div className="qbar">
      <span className="qb-label">{label}</span>
      <div className="qb-track">
        <i className={pct >= 100 ? 'done' : ''} style={{ width: pct + '%' }} />
      </div>
      <span className="qb-num">{paid}<span className="dim">/{demand} {unit}</span></span>
    </div>
  );
}

/**
 * 还差多少才够。
 *
 * 一个按钮因为条件不满足而不可点时，必须说出缺什么 ——
 * 否则玩家只能自己拿造价和家底两两相减，那是把界面的活推给了人脑。
 */
function shortfallOf(
  city: { coin: number; grain: number }, cost: { coin: number; grain: number },
): string | null {
  const lackCoin = Math.max(0, cost.coin - city.coin);
  const lackGrain = Math.max(0, cost.grain - city.grain);
  if (lackCoin === 0 && lackGrain === 0) return null;
  const bits: string[] = [];
  if (lackCoin > 0) bits.push(lackCoin + ' 缗');
  if (lackGrain > 0) bits.push(lackGrain + ' 石');
  return '尚缺 ' + bits.join('、');
}

// ─────────────────────────────────────────────────────────────

function PlotCard(
  { engine, idx, index, onClose }:
  { engine: Engine; idx: ContentIndex; index: number; onClose: () => void },
) {
  const [confirmRaze, setConfirmRaze] = useState(false);
  const st = engine.getState();
  const city = currentCity(st);
  const plot = city.plots[index]!;
  const open = isPlotOpen(city, index);

  const build = (id: string): void => {
    Audio.click();
    engine.dispatch({ t: 'build', plot: index, buildingId: id });
  };

  if (!open) {
    return (
      <Card title="外郭荒地" onClose={onClose}>
        <p className="c-desc">城墙外的荒地。要拓外郭，才用得上。</p>
      </Card>
    );
  }

  if (plot.work) {
    const def = idx.building.get(plot.work.buildingId);
    const done = plot.work.totalDays - plot.work.daysLeft;
    const pct = Math.round((done / Math.max(1, plot.work.totalDays)) * 100);
    const razing = plot.work.demolish === true;
    return (
      <Card
        title={(def?.name ?? '') + (razing ? ' 拆除中' : ' 营造中')}
        onClose={onClose}
        footer={
          <button
            className="ghost"
            onClick={() => { Audio.click(); engine.dispatch({ t: 'cancel_work', plot: index }); }}
          >
            {razing ? '停手（房子留着）' : '罢工（退还一半）'}
          </button>
        }
      >
        <div className="work">
          <div className="w-bar">
            <i className={razing ? 'razing' : ''} style={{ width: pct + '%' }} />
          </div>
          <div className="w-txt">
            还需 {plot.work.daysLeft} 日{razing ? '' : ' · 修至 ' + plot.work.toLevel + ' 级'}
          </div>
        </div>
      </Card>
    );
  }

  if (plot.buildingId && plot.level > 0) {
    const def = idx.building.get(plot.buildingId)!;
    const maxed = plot.level >= def.maxLevel;
    const cost = maxed ? null : upgradeCost(def, plot.level + 1);
    const afford = cost ? city.coin >= cost.coin && city.grain >= cost.grain : false;
    const isYamen = index === YAMEN_PLOT;
    const spent = totalInvested(def, plot.level);
    const backCoin = Math.floor((spent.coin * DEMOLISH_REFUND) / 1000);
    const backGrain = Math.floor((spent.grain * DEMOLISH_REFUND) / 1000);
    const razeDays = Math.max(2, Math.ceil(upgradeCost(def, plot.level).days / 2));

    return (
      <Card
        title={def.name + ' · ' + plot.level + ' 级'}
        onClose={onClose}
        footer={
          <>
            {maxed ? <div className="c-note">已经修到头了。</div> : (
              <>
                <button className="primary" disabled={!afford} onClick={() => build(def.id)}>
                  修至 {plot.level + 1} 级
                  <em>
                    {cost!.coin} 缗{cost!.grain > 0 ? ' · ' + cost!.grain + ' 石' : ''}
                    {' · '}{cost!.days} 日
                  </em>
                </button>
                {!afford && <div className="shortfall">{shortfallOf(city, cost!)}</div>}
              </>
            )}
            {!isYamen && (confirmRaze ? (
              <div className="raze-confirm">
                <div className="rz-txt">
                  拆掉它？需 {razeDays} 日，只收回折钱 {backCoin} 缗
                  {backGrain > 0 ? '、粮 ' + backGrain + ' 石' : ''}。
                </div>
                <div className="rz-btns">
                  <button
                    className="danger"
                    onClick={() => {
                      Audio.click();
                      engine.dispatch({ t: 'demolish', plot: index });
                      setConfirmRaze(false);
                    }}
                  >
                    拆
                  </button>
                  <button className="ghost" onClick={() => setConfirmRaze(false)}>算了</button>
                </div>
              </div>
            ) : (
              <button
                className="ghost small raze"
                onClick={() => { Audio.click(); setConfirmRaze(true); }}
              >
                拆除，腾出这块地
              </button>
            ))}
          </>
        }
      >
        <p className="c-desc">{def.desc}</p>
        <Effects def={def} level={plot.level} />
        {isYamen && <p className="c-note">官署是你办公的地方，拆不得。</p>}
      </Card>
    );
  }

  const avail = availableBuildings(city, idx);
  return (
    <Card title="空地" onClose={onClose}>
      {avail.length === 0 && <p className="c-desc">眼下还没有能在这里营造的东西。</p>}
      <div className="c-list">
        {avail.map((def) => {
          const cost = upgradeCost(def, 1);
          const afford = city.coin >= cost.coin && city.grain >= cost.grain;
          const n = countOf(city, def.id);
          return (
            <button
              key={def.id}
              className={'c-item' + (afford ? '' : ' poor')}
              disabled={!afford}
              onClick={() => build(def.id)}
            >
              <div className="ci-head">
                <span className="ci-name">{def.name}</span>
                {def.maxCount !== undefined && <span className="ci-count">{n}/{def.maxCount}</span>}
                <span className="ci-cost">
                  {cost.coin} 缗{cost.grain > 0 ? ' · ' + cost.grain + ' 石' : ''}
                  {' · '}{cost.days} 日
                </span>
              </div>
              <div className="ci-desc">{def.desc}</div>
              <Effects def={def} level={0} inline />
              {!afford && <div className="shortfall">{shortfallOf(city, cost)}</div>}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

/** 天下图上点开一座城。你是个县令，看得到的只有大略 */
/**
 * 武将的主界面。
 *
 * 中间那片地是天下图 —— 带兵的人本来就是看地图的。
 * 左边一条压着营里的事，右边点开一座城就是「打不打他」。
 *
 * 这里刻意**不**做一张营内图。武将一天里真正在想的事只有两件：
 * 兵够不够，往哪儿打。一张画着帐篷的场景对这两件事都没有帮助。
 */
function GeneralScreen(
  { engine, idx, speedIdx, setSpeedIdx, pickedCity, setPickedCity, mode, setMode }:
  {
    engine: Engine; idx: ContentIndex;
    speedIdx: number; setSpeedIdx: (i: number) => void;
    pickedCity: string | null; setPickedCity: (id: string | null) => void;
    mode: Mode; setMode: (m: Mode) => void;
  },
) {
  const st = engine.getState();
  const camp = st.camps[STARTING_CAMP];
  if (!camp) return null;

  const c = st.campaign;

  // 军议开着的时候，别的都不重要了
  if (c && c.phase === 'planning') {
    return <WarCouncil engine={engine} idx={idx} campaign={c} camp={camp} />;
  }

  return (
    <>
      <div className="hud-top">
        <div className="clock">
          <div className="date">{formatDate(st.day)}</div>
          <div className="sub">
            {SEASON_NAME[seasonOf(st.day)]} · {MILITARY_RANKS[st.official.rank]}
            <span className="aff">功 {st.official.merit} · 信任 {st.official.trust}</span>
          </div>
        </div>

        <CampMeters camp={camp} idx={idx} />

        <div className="spacer" />

        <button
          className={'modebtn' + (mode === 'world' ? ' on' : '')}
          title="M 键切换"
          onClick={() => { setMode(mode === 'city' ? 'world' : 'city'); Audio.click(); }}
        >
          {mode === 'city' ? '看天下' : '回营中'}
        </button>

        <div className="speeds">
          {SPEEDS.map((sp, i) => (
            <button
              key={sp}
              className={'sp' + (speedIdx === i ? ' on' : '')}
              title={sp === 0 ? '暂停' : sp + ' 倍速'}
              onClick={() => { setSpeedIdx(i); Audio.click(); }}
            >
              {sp === 0 ? '❙❙' : sp + '×'}
            </button>
          ))}
        </div>
      </div>

      <GrainAlarm camp={camp} />
      <OrderBanner engine={engine} idx={idx} />

      {c && c.phase === 'marching'
        ? <Marching idx={idx} campaign={c} />
        : <CampPanel engine={engine} idx={idx} camp={camp} campId={STARTING_CAMP} />}

      {pickedCity && (
        <TargetBrief
          engine={engine}
          idx={idx}
          id={pickedCity}
          onClose={() => setPickedCity(null)}
        />
      )}
    </>
  );
}

/**
 * 点开一座城：打，还是不打。
 *
 * **自家的城被围了是要去救的。**
 *
 * 这一段原先写着「『增援』要等主公的军令那一套做出来，现在还没有」——
 * 可军令早就做出来了，主公开口就是「驰援雍丘」，
 * 而命令层也一直支持（自家的城被围时出兵是合法的）。
 * 缺的只是这里的一颗按钮：玩家点开自家被围的城，看到的是
 * 一句「自家的城。」和一片空白，于是「按了没反应，援不了」。
 */
function TargetBrief(
  { engine, idx, id, onClose }:
  {
    engine: Engine; idx: ContentIndex; id: string;
    onClose: () => void;
  },
) {
  const st = engine.getState();
  const node = st.nodes[id];
  const def = idx.node.get(id);
  if (!node || !def) return null;
  const f = idx.faction.get(node.factionId);
  const mine = node.factionId === st.official.lordId;
  const camp = st.camps[STARTING_CAMP];
  const here = camp?.nodeId === id;
  const siege = st.sieges[id];
  /**
   * 出不出得了兵，问模拟层 —— 别在这儿另写一套。
   *
   * 上一版这里只看了「没在行军、没在屯田」，而命令层还查了
   * 兵力、休整期、是不是自家的城。两边一分岔，按钮就开始撒谎。
   */
  const no = whyNotMarch(st, id);
  const relief = mine && !!siege;
  const warden = wardenOf(st, idx, id);
  const hostile = !mine && atWar(st, st.official.lordId, node.factionId);

  return (
    <Card title={def.name + ' · ' + def.commandery} onClose={onClose}>
      <div className="cb-owner">
        <span className="cb-flag" style={{ background: f?.color ?? '#888' }}>{f?.banner}</span>
        <span className="cb-name">{f?.name}</span>
        {here && <span className="cb-mine">你的营在此</span>}
        {/*
          主公跟这一家的交情。天下的恩怨是会变的（见 diplomacy.ts）——
          不写出来，玩家就只看得见地图上的颜色，看不见颜色底下的势
        */}
        {!mine && (
          <span className={'cb-att' + (hostile ? ' war' : '')}>
            {hostile ? '与主公交恶' : '眼下无仇'}
          </span>
        )}
      </div>
      <p className="c-desc">{def.desc}</p>
      {/*
        谁在守这座城。
        照设计方案 2.3：**不摆五维数值条**，给评语与擅长 ——
        「万人敌，可当一面」比「武力 92」告诉你的多，
        而且「忌」那一条会让你真的改主意。
      */}
      {warden && (
        <div className="cb-warden">
          <div className="cw-head">
            <span className="cw-name">{warden.name}</span>
            {warden.courtesy && <span className="cw-zi">{warden.courtesy}</span>}
            <span className="cw-role">守将</span>
          </div>
          <div className="cw-praise">「{warden.praise}」</div>
          <div className="cw-tags">
            {warden.good.map((g) => <span key={g} className="cw-good">{g}</span>)}
            <span className="cw-flaw">忌：{warden.flaw}</span>
          </div>
        </div>
      )}
      <div className="cb-stats">
        <div><span className="dim">守军</span> {node.troops}</div>
        <div><span className="dim">存粮</span> {node.grain}</div>
        <div><span className="dim">民心</span> {node.morale}</div>
      </div>
      {mine && !relief ? (
        <div className="c-note">自家的城。眼下无事。</div>
      ) : (
        <>
          {relief && (
            <div className="cb-siege">
              城下有<b>{siege!.troops}</b>人围着，已围 {siege!.days} 日。
              <span className="dim">　你打的是城下这支兵，不是城。</span>
            </div>
          )}
          <div className="c-note">
            全营开拔。到了地头，你在战场图上分兵派将。
          </div>
          <button
            className={'c-go' + (relief ? ' relief' : '')}
            disabled={no !== null}
            title={no ? renderText(idx.db.text, 'rej.' + no) : ''}
            onClick={() => {
              Audio.drum();
              engine.dispatch({ t: 'theatre_open', targetNodeId: id });
              onClose();
            }}
          >
            {no
              ? renderText(idx.db.text, 'rej.' + no)
              : relief ? '驰 援' : '出 兵'}
          </button>
        </>
      )}
    </Card>
  );
}

function CityBrief(
  { engine, idx, id, onClose }:
  { engine: Engine; idx: ContentIndex; id: string; onClose: () => void },
) {
  const st = engine.getState();
  const node = st.nodes[id];
  const def = idx.node.get(id);
  if (!node || !def) return null;
  const f = idx.faction.get(node.factionId);
  const siege = st.sieges[id];
  const mine = id === st.official.cityId;

  return (
    <Card title={def.name + ' · ' + def.commandery} onClose={onClose}>
      <div className="cb-owner">
        <span className="cb-flag" style={{ background: f?.color ?? '#888' }}>{f?.banner}</span>
        <span className="cb-name">{f?.name}</span>
        {mine && <span className="cb-mine">你在此任上</span>}
        {def.seat && <span className="ci-count">治所</span>}
      </div>
      <p className="c-desc">{def.desc}</p>
      <div className="cb-stats">
        <div><span className="dim">守军</span> {node.troops}</div>
        <div><span className="dim">存粮</span> {node.grain}</div>
        <div><span className="dim">民心</span> {node.morale}</div>
        <div><span className="dim">规模</span> {node.dev}</div>
      </div>
      {node.unrest > 20 && <div className="c-note">新附之地，人心未附。（离心 {node.unrest}）</div>}
      {siege && (
        <div className="cb-siege">
          {idx.faction.get(siege.factionId)?.name} 正在围城，第 {siege.days} 日，城下 {siege.troops} 人。
        </div>
      )}
      <div className="cb-links">
        <span className="dim">通往 </span>
        {def.links.map((l) => idx.node.get(l)?.name ?? l).join(' · ')}
      </div>
    </Card>
  );
}

function Effects({ def, level, inline }: { def: BuildingDef; level: number; inline?: boolean }) {
  const n = Math.max(1, level);
  const bits: string[] = [];
  if (def.grain) bits.push('产粮 ' + def.grain * n + '／日');
  if (def.coin) bits.push('产钱 ' + def.coin * n + '／日');
  if (def.capGrain) bits.push('仓容 +' + def.capGrain * n);
  if (def.capCoin) bits.push('府库 +' + def.capCoin * n);
  if (def.capHouse) bits.push('可容 +' + def.capHouse * n + ' 户');
  if (def.garrison) bits.push('守军 +' + def.garrison * n + ' 人');
  if (def.boost) bits.push('田产 +' + (def.boost.permille * n) / 10 + '%');
  if (def.morale) bits.push('民心 ' + (def.morale > 0 ? '+' : '') + def.morale * n);
  if (def.labour) bits.push('占人手 ' + def.labour * n + ' 户');
  if (bits.length === 0) return null;
  return <div className={'effects' + (inline ? ' inline' : '')}>{bits.join(' · ')}</div>;
}

/**
 * 卡片。
 *
 * 操作区是**独立的页脚**，不跟正文一起滚动 ——
 * 按钮被内容顶到视口外面去，是这类面板最常见也最致命的毛病。
 */
function Card(
  { title, onClose, children, footer }:
  { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode },
) {
  return (
    <div className="card">
      <div className="c-head">
        {title}
        <button className="c-close" onClick={onClose}>×</button>
      </div>
      <div className="c-body">{children}</div>
      {footer && <div className="c-foot">{footer}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

function EndScreen(
  { idx, kind, day, state }:
  {
    idx: ContentIndex; kind: EndingKind; day: number;
    state: ReturnType<Engine['getState']>;
  },
) {
  const met = state.quotaHistory.filter((q) => q.outcome === 'met').length;
  const years = Math.floor(day / 360) + 1;
  return (
    <div className="opening">
      <div className="op-inner">
        <div className="op-era">{formatDate(day)}</div>
        <h1 className="op-title">
          {kind === 'captured' ? '城 破' : kind === 'scattered' ? '兵 散' : '免 官'}
        </h1>
        <p className="op-text">{renderText(idx.db.text, 'end.' + kind)}</p>
        <div className="op-cards">
          <div className="op-card">
            <div className="op-k">在任</div>
            <div className="op-v">{years} 年</div>
            <div className="op-d">
              交上去 {met} 季，交不上 {state.quotaHistory.length - met} 季。
            </div>
          </div>
          <div className="op-card">
            <div className="op-k">终于</div>
            <div className="op-v">{RANKS[state.official.rank]}</div>
            <div className="op-d">
              功绩 {state.official.merit}，主公的信任停在 {state.official.trust}。
            </div>
          </div>
        </div>
        <div className="op-row">
          <button className="op-go" onClick={() => location.reload()}>再 来</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 开局能挑的诸侯。
 *
 * 设计方案里写着「**这张表本身就是难度选择**，不需要另做难度设定」——
 * 起始几座城、四邻是谁、粮兵的配比，合起来就是难度。
 * 星号只是把它说出来。
 */
const LORD_CHOICES: { id: string; hard: number; note: string }[] = [
  { id: 'caocao', hard: 2, note: '陈留起兵。兵多而粮少，四战之地。' },
  { id: 'yuanshao', hard: 1, note: '家世好，起步最稳。' },
  { id: 'liubiao', hard: 1, note: '荆州富庶，只是将才匮乏。' },
  { id: 'taoqian', hard: 2, note: '徐州殷实，四邻却都不好惹。' },
  { id: 'gongsunzan', hard: 3, note: '北平一隅。骑兵犀利，缺粮。' },
  { id: 'kongrong', hard: 4, note: '北海名望极高，兵极弱。' },
  { id: 'liuyan', hard: 2, note: '益州天险。安全，但也出不去。' },
  { id: 'mateng', hard: 3, note: '西凉边地，粮少路远。' },
];

function Opening(
  { idx, saved, onStart, onResume }:
  {
    idx: ContentIndex; saved: SaveMeta | null;
    onStart: (name: string, role: PlayerRole, lordId: string) => void;
    onResume: () => void;
  },
) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<PlayerRole>('official');
  const [lordId, setLordId] = useState('caocao');
  const city = idx.db.cities[0]!;
  const lord = idx.db.lords[0]!;
  return (
    <div className="opening">
      <div className="op-inner">
        <div className="op-era">初平元年 · 陈留郡</div>
        <h1 className="op-title">雍丘</h1>
        <p className="op-text">{renderText(idx.db.text, 'intro')}</p>
        {/* 站在哪个位置上。同一个乱世，两只手 */}
        <div className="op-roles">
          <button
            className={'op-role' + (role === 'official' ? ' on' : '')}
            onClick={() => { Audio.click(); setRole('official'); }}
          >
            <span className="or-k">文</span>
            <span className="or-n">县令</span>
            <span className="or-d">
              守一座城。种田、修墙、按季交差。<br />
              城破就完了，交不上差也一样。
            </span>
          </button>
          <button
            className={'op-role' + (role === 'general' ? ' on' : '')}
            onClick={() => { Audio.click(); setRole('general'); }}
          >
            <span className="or-k">武</span>
            <span className="or-n">裨将</span>
            <span className="or-d">
              带一营兵。练兵、屯田、分兵派将去打。<br />
              粮要向主公要，要不到就得自己想办法。
            </span>
          </button>
          <button
            className={'op-role' + (role === 'lord' ? ' on' : '')}
            onClick={() => { Audio.click(); setRole('lord'); }}
          >
            <span className="or-k">主</span>
            <span className="or-n">诸侯</span>
            <span className="or-d">
              你不亲手做任何一件事 —— 你派人去做。<br />
              任命、征调、兴修、遣使。地盘丢光才算完。
            </span>
          </button>
        </div>

        {/* 当主公要先挑一家。这张表本身就是难度选择 */}
        {role === 'lord' && (
          <div className="op-lords">
            {LORD_CHOICES.map((f) => {
              const def = idx.faction.get(f.id);
              return (
                <button
                  key={f.id}
                  className={'op-lord' + (lordId === f.id ? ' on' : '')}
                  onClick={() => { Audio.click(); setLordId(f.id); }}
                >
                  <span
                    className="ol-flag"
                    style={{ background: def?.color ?? '#888' }}
                  >
                    {def?.banner}
                  </span>
                  <span className="ol-n">{def?.name ?? f.id}</span>
                  <span className="ol-hard">{'★'.repeat(f.hard)}</span>
                  <span className="ol-d">{f.note}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className={'op-cards' + (role === 'lord' ? ' hide' : '')}>
          <div className="op-card">
            <div className="op-k">你的主公</div>
            <div className="op-v">{lord.name} <span className="dim">{lord.courtesy}</span></div>
            <div className="op-d">{lord.desc}</div>
          </div>
          <div className="op-card">
            <div className="op-k">你的城</div>
            <div className="op-v">{city.name} <span className="dim">{city.commandery}</span></div>
            <div className="op-d">{city.desc}</div>
          </div>
        </div>
        {saved && (
          <div className="op-resume">
            <div className="op-resume-t">
              上一局：{saved.playerName} 在 {idx.city.get(saved.cityId)?.name ?? saved.cityId}
              ，{formatDate(saved.day)}
            </div>
            <button className="op-go on" onClick={onResume}>接 着 打</button>
            <div className="op-resume-d">另起一局，上一局就没了。</div>
          </div>
        )}
        <div className="op-row">
          <input
            placeholder="取个名字"
            value={name}
            maxLength={8}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onStart(name.trim() || '无名', role, lordId);
            }}
          />
          <button
            className="op-go"
            onClick={() => onStart(name.trim() || '无名', role, lordId)}
          >
            {saved ? '另 起 一 局' : '上 任'}
          </button>
        </div>
      </div>
    </div>
  );
}
