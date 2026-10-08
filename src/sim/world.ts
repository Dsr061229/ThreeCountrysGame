/**
 * 世界初始化。
 *
 * createWorld 只铺开静态世界，玩家身份由 `begin` 命令确定 ——
 * 这样「选了哪座城、投了哪位主公」也进入命令流，回放时才能完整重建。
 */
import { seedRng } from './rng.ts';
import { STATE_VERSION, type WorldState } from './state.ts';
import type { ContentIndex } from './content.ts';
import { PLOT_COUNT, YAMEN_PLOT, type City, type Plot } from './types.ts';
import type { CityNode, FactionState } from './world_types.ts';
import { seedPosts } from './people.ts';

function emptyPlots(): Plot[] {
  const plots: Plot[] = [];
  for (let i = 0; i < PLOT_COUNT; i++) {
    plots.push({ buildingId: null, level: 0, work: null });
  }
  // 中心固定为官署：它是你办公的地方，也是城的视觉中心
  plots[YAMEN_PLOT] = { buildingId: 'yamen', level: 1, work: null };
  return plots;
}

/** 城的规模决定它开局有多少家底。治所自然比小县厚实 */
function briefFor(scale: number, governance: number, seat: boolean): Omit<CityNode, 'id' | 'factionId'> {
  const size = Math.max(1, scale);
  return {
    dev: size * 6 + Math.floor(governance / 12),
    grain: size * 420 + governance * 6,
    troops: size * 120 + (seat ? 260 : 0) + Math.floor(governance * 1.5),
    morale: Math.max(25, Math.min(80, 34 + Math.floor(governance / 2))),
    unrest: 0,
    takenDay: -1,
    lastSiegeDay: -1,
  };
}

export function createWorld(seed: string, idx: ContentIndex): WorldState {
  const state: WorldState = {
    version: STATE_VERSION,
    seed,
    day: 0,
    rng: seedRng(seed),
    nextId: 1,
    started: false,
    role: 'official',
    official: { name: '', rank: 0, merit: 0, trust: 50, cityId: '', lordId: '' },
    cities: {},
    nodes: {},
    factions: {},
    armies: {},
    sieges: {},
    battle: null,
    field: null,
    ending: null,
    consecutiveMisses: 0,
    camps: {},
    ration: null,
    retinue: [],
    hurt: {},
    posts: {},
    order: null,
    campaign: null,
    theatre: null,
    // 朝堂只有主公那一局才开张，见 openCourt
    court: null,
    couriers: {},
    quota: null,
    quotaHistory: [],
    seenUnlocks: [],
    flags: {},
  };

  for (const c of idx.db.cities) {
    const city: City = {
      id: c.id,
      name: c.name,
      commandery: c.commandery,
      plots: emptyPlots(),
      ring: 0,
      grain: c.grain,
      coin: c.coin,
      households: c.households,
      morale: c.morale,
      taxPressure: 0,
      afflictions: [],
      wall: 0,
      wallWork: 0,
    };
    state.cities[c.id] = city;
  }

  for (const f of idx.db.factions) {
    const fs: FactionState = { id: f.id, attitude: {}, cooldown: 0 };
    state.factions[f.id] = fs;
  }
  // 初始态度：同为讨董联军的彼此还算客气，黄巾则与所有人为敌
  for (const a of idx.db.factions) {
    for (const b of idx.db.factions) {
      if (a.id === b.id) continue;
      let att = 0;
      if (a.id === 'taiping' || b.id === 'taiping') att = -70;
      else if (a.id === 'caocao' && b.id === 'zhangmiao') att = 45;
      else if (a.id === 'zhangmiao' && b.id === 'caocao') att = 45;
      else if (a.id === 'yuanshu' || b.id === 'yuanshu') att = -20;
      state.factions[a.id]!.attitude[b.id] = att;
    }
  }

  for (const n of idx.db.map) {
    const f = idx.faction.get(n.faction);
    const brief = briefFor(n.scale, f?.governance ?? 40, n.seat === true);
    state.nodes[n.id] = { id: n.id, factionId: n.faction, ...brief };
  }

  // 募兵：把「有兵无地」的部曲摊到各城头上
  for (const f of idx.db.factions) {
    if (!f.levy) continue;
    const own = idx.db.map.filter((n) => n.faction === f.id);
    if (own.length === 0) continue;
    const each = Math.floor(f.levy / own.length);
    for (const n of own) state.nodes[n.id]!.troops += each;
  }

  // 天下每一座城派一个守将 —— 名字要是那一家的人。见 people.ts
  seedPosts(state, idx);

  return state;
}
