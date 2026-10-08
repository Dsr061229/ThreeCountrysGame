import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { Engine } from '../src/sim/engine.ts';
import { indexContent, type ContentDB } from '../src/sim/content.ts';
const read = (n: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${n}.json`, import.meta.url)), 'utf8'));
const content = {
  buildings: read('buildings'), cities: read('cities'), lords: read('lords'),
  map: read('map'), factions: read('factions'), battle: read('battle'),
  field: read('field'), facilities: read('facilities'),
  terrain: read('terrain'), people: read('people'), text: read('text'),
} as ContentDB;
const idx = indexContent(content);
for (const f of ['caocao', 'liubiao', 'taoqian']) {
  const e = new Engine('a', content);
  const r = e.dispatch({ t: 'begin', playerName: '推演', cityId: 'yongqiu', lordId: f, role: 'lord' });
  const st = e.getState();
  const held = Object.values(st.nodes).filter((n) => n.factionId === f);
  const front = held.filter((n) => (idx.node.get(n.id)?.links ?? []).some((to) => {
    const t = st.nodes[to]; return t && t.factionId !== f;
  }));
  const m = e.dispatch({ t: 'lord_muster', cityId: front[0]?.id ?? held[0]!.id });
  console.log('   ', held.map((n) => n.id + ' 兵' + n.troops + ' 粮' + n.grain + ' dev' + n.dev).join(' | '));
  console.log(f, 'begin=', r.map((x) => x.t).join(','),
    'role=', st.role, 'seat=', st.official.cityId, 'lordId=', st.official.lordId,
    'held=', held.length, 'front=', front.length,
    'troops=', held.map((n) => n.troops).join('/'),
    'muster=', m.map((x) => x.t).join(','));
}
