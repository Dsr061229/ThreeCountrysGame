/**
 * 内容库装配。
 *
 * 全部内容都是 JSON，Vite 会热重载它们 —— 改一行数值立刻在浏览器里生效，
 * 不需要重启。这是往后调平衡时的生产力关键。
 */
import type { ContentDB } from '../src/sim/content.ts';
import buildings from './buildings.json';
import cities from './cities.json';
import lords from './lords.json';
import map from './map.json';
import factions from './factions.json';
import battle from './battle.json';
import field from './field.json';
import facilities from './facilities.json';
import terrain from './terrain.json';
import people from './people.json';
import situations from './situations.json';
import text from './text.json';

export const content = {
  buildings, cities, lords, map, factions, battle, field, facilities, terrain,
  people, situations, text,
} as unknown as ContentDB;
