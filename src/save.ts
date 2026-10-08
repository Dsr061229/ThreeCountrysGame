/**
 * 存档。
 *
 * 存的不是世界，是**这一局是怎么走到这儿的** ——
 * 一个种子加一串命令。读档就是照着重放一遍。
 *
 * 这么做的代价是读档要跑一遍模拟（实测三百天约十毫秒，
 * 十五年的一局也就两百毫秒，感觉不出来）；
 * 换来的好处是存档极小、天然可回放、将来联机时客户端与服务端跑的是同一份东西。
 *
 * 写盘是**攒着写**的。命令流一长，每落一天就整份 JSON 序列化一次，
 * 十倍速下一秒要写十次、每次两百多 KB —— 画面会一顿一顿的。
 * 所以这里最多两秒写一次，另外在页面要关掉的那一刻补写一次，
 * 保证「刚盖完一栋楼就手滑关了窗口」不会白干。
 */
import { Engine, StaleSaveError, type SaveFile } from './sim/engine.ts';
import type { ContentDB } from './sim/content.ts';

const KEY = 'sanguo.save.v1';
/** 两次写盘至少隔这么久 */
const WRITE_EVERY_MS = 2000;

export interface SaveMeta {
  /** 存档里的纪年日，用来在标题页显示「上一局走到了哪儿」 */
  day: number;
  playerName: string;
  cityId: string;
}

interface Stored {
  save: SaveFile;
  meta: SaveMeta;
}

function read(): Stored | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // 隐私模式下 localStorage 会直接抛。没存档就是没存档，不该让游戏起不来
    return null;
  }
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Stored;
    if (!s?.save?.log || typeof s.save.seed !== 'string') return null;
    return s;
  } catch {
    return null;
  }
}

/** 上一局走到哪儿了。没有存档就是 null */
export function peek(): SaveMeta | null {
  return read()?.meta ?? null;
}

export function clear(): void {
  try {
    localStorage.removeItem(KEY);
  } catch { /* 存不了也就删不了，无所谓 */ }
}

/**
 * 读上一局。
 *
 * 读不了的存档一律当作没有，并把它清掉 ——
 * 留着一个永远读不出来的存档，只会让标题页上那个按钮一直骗人。
 */
export function restore(content: ContentDB): Engine | null {
  const s = read();
  if (!s) return null;
  try {
    return Engine.load(s.save, content);
  } catch (err) {
    if (err instanceof StaleSaveError) {
      console.info('[存档] 来自旧规则（v%d，当前 v%d），已丢弃', err.saved, err.current);
    } else {
      console.warn('[存档] 读不出来，已丢弃', err);
    }
    clear();
    return null;
  }
}

/**
 * 盯着这局引擎，自动存。
 *
 * 返回一个「不盯了」的函数。
 */
export function autosave(engine: Engine): () => void {
  let timer: number | null = null;
  let dirty = false;

  const write = (): void => {
    dirty = false;
    const st = engine.getState();
    // 还没上任就没什么可存的
    if (!st.official?.cityId) return;
    // 已经出局的局面不留。结局页上的「再来」是刷新页面，
    // 存档若还在，刷新就又回到结局页 —— 玩家会被永远关在里面
    if (st.ending) { clear(); return; }
    const stored: Stored = {
      save: engine.save(),
      meta: { day: st.day, playerName: st.official.name, cityId: st.official.cityId },
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(stored));
    } catch (err) {
      // 满了或者被禁了。存不上是遗憾，但不该把游戏搞崩
      console.warn('[存档] 写不进去', err);
    }
  };

  const schedule = (): void => {
    dirty = true;
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      if (dirty) write();
    }, WRITE_EVERY_MS);
  };

  // 关窗口那一刻补写一次，别让最后两秒的操作白做
  const flush = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (dirty) write();
  };
  const onHide = (): void => { if (document.visibilityState === 'hidden') flush(); };

  const unsubscribe = engine.subscribe(schedule);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', onHide);

  return () => {
    unsubscribe();
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', onHide);
    flush();
  };
}
