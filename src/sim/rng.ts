/**
 * 确定性伪随机数发生器 —— xoshiro128**
 *
 * 全部使用 32 位整数运算，JS 的位运算保证跨平台结果一致。
 * 模拟层内**禁止**使用 Math.random，所有随机性必须经由此处，
 * 否则存档回放与联机状态同步都会失效。
 */

export interface RngState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** 用一个字符串或数字种子生成初始状态（splitmix32 铺开） */
export function seedRng(seed: string | number): RngState {
  let h = typeof seed === 'number' ? seed >>> 0 : 2166136261 >>> 0;
  if (typeof seed === 'string') {
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  const next = (): number => {
    h = (h + 0x9e3779b9) >>> 0;
    let z = h;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
  const st: RngState = { s0: next(), s1: next(), s2: next(), s3: next() };
  // 全零状态会退化，兜底
  if ((st.s0 | st.s1 | st.s2 | st.s3) === 0) st.s0 = 1;
  return st;
}

export function cloneRng(r: RngState): RngState {
  return { s0: r.s0, s1: r.s1, s2: r.s2, s3: r.s3 };
}

/** 推进一步，返回 32 位无符号整数 */
export function nextU32(r: RngState): number {
  const result = (Math.imul(rotl(Math.imul(r.s1, 5) >>> 0, 7), 9) >>> 0) >>> 0;
  const t = (r.s1 << 9) >>> 0;
  r.s2 = (r.s2 ^ r.s0) >>> 0;
  r.s3 = (r.s3 ^ r.s1) >>> 0;
  r.s1 = (r.s1 ^ r.s2) >>> 0;
  r.s0 = (r.s0 ^ r.s3) >>> 0;
  r.s2 = (r.s2 ^ t) >>> 0;
  r.s3 = rotl(r.s3, 11);
  return result;
}

/** [0, n) 的整数，无模偏（rejection sampling） */
export function nextInt(r: RngState, n: number): number {
  if (n <= 1) return 0;
  const limit = (0x100000000 - (0x100000000 % n)) >>> 0;
  let x = nextU32(r);
  // limit 为 0 表示 n 整除 2^32，无需拒绝
  if (limit !== 0) {
    let guard = 0;
    while (x >= limit && guard++ < 64) x = nextU32(r);
  }
  return x % n;
}

/** 闭区间 [lo, hi] */
export function nextRange(r: RngState, lo: number, hi: number): number {
  return lo + nextInt(r, hi - lo + 1);
}

/** 百分数判定：chance 为 0~100 的整数 */
export function chance(r: RngState, percent: number): boolean {
  return nextInt(r, 100) < percent;
}

/**
 * 千分数判定。
 *
 * 「每季两成」这类概率摊到每一天就成了千分之二 —— 百分数不够用。
 * 把按季度的判定摊成按日的判定，是让世界**有节奏但不规律**的关键：
 * 概率不变，但落在哪一天说不准。
 */
export function chancePermille(r: RngState, permille: number): boolean {
  return nextInt(r, 1000) < permille;
}

/** 按整数权重加权挑选，返回下标；权重全为 0 时返回 -1 */
export function weightedPick(r: RngState, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (total <= 0) return -1;
  let roll = nextInt(r, total);
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i] ?? 0;
    if (w <= 0) continue;
    roll -= w;
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

/** 原地洗牌（Fisher–Yates） */
export function shuffle<T>(r: RngState, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = nextInt(r, i + 1);
    const a = arr[i] as T;
    const b = arr[j] as T;
    arr[i] = b;
    arr[j] = a;
  }
  return arr;
}

/** 从数组中取一个元素，空数组返回 undefined */
export function pick<T>(r: RngState, arr: readonly T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[nextInt(r, arr.length)];
}
