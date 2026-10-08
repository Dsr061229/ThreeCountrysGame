/**
 * 时间系统 —— 以「日」为最小刻度。
 *
 * 为可玩性做的简化：一年 12 月，每月 30 日，共 360 日。
 * 真实的汉历有大小月和闰月，但那会让所有周期判定（季度指标、农时、俸禄）
 * 变成一堆特例，收益却只有历史考据分。这里取整齐的 360 日。
 */

/** 纪元：初平元年（公元 190 年）正月初一 = day 0 */
export const EPOCH_YEAR = 190;
export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR; // 360
export const MONTHS_PER_QUARTER = 3;

export interface GameDate {
  /** 公元年 */ year: number;
  /** 1–12 */ month: number;
  /** 1–30 */ day: number;
}

const MONTH_NAME = [
  '正月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '冬月', '腊月',
] as const;

export function dayToDate(day: number): GameDate {
  const y = Math.floor(day / DAYS_PER_YEAR);
  const rem = day - y * DAYS_PER_YEAR;
  return {
    year: EPOCH_YEAR + y,
    month: Math.floor(rem / DAYS_PER_MONTH) + 1,
    day: (rem % DAYS_PER_MONTH) + 1,
  };
}

export function dateToDay(d: GameDate): number {
  return (d.year - EPOCH_YEAR) * DAYS_PER_YEAR + (d.month - 1) * DAYS_PER_MONTH + (d.day - 1);
}

// ─────────────────────────────────────────────────────────────
// 年号
// ─────────────────────────────────────────────────────────────

const ERAS: ReadonlyArray<{ from: number; name: string }> = [
  { from: 184, name: '中平' },
  { from: 190, name: '初平' },
  { from: 194, name: '兴平' },
  { from: 196, name: '建安' },
  { from: 220, name: '延康' },
];

const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'] as const;

function cnNumber(n: number): string {
  if (n <= 0) return '';
  if (n === 1) return '元';
  if (n <= 10) return CN[n] ?? String(n);
  if (n < 20) return '十' + (CN[n - 10] ?? '');
  return (CN[Math.floor(n / 10)] ?? '') + '十' + (n % 10 ? CN[n % 10] ?? '' : '');
}

/** 日期序数：初一、十五、廿三…… */
function cnDay(n: number): string {
  if (n <= 10) return '初' + (CN[n] ?? String(n));
  if (n < 20) return '十' + (CN[n - 10] ?? '');
  if (n === 20) return '二十';
  if (n < 30) return '廿' + (CN[n - 20] ?? '');
  return '三十';
}

export function eraOf(year: number): { name: string; nth: number } {
  let chosen = ERAS[0]!;
  let base = chosen.from;
  for (const e of ERAS) {
    if (e.from <= year) { chosen = e; base = e.from; } else break;
  }
  return { name: chosen.name, nth: year - base + 1 };
}

/** "初平元年 三月 初五" */
export function formatDate(day: number): string {
  const d = dayToDate(day);
  const era = eraOf(d.year);
  return `${era.name}${cnNumber(era.nth)}年 ${MONTH_NAME[d.month - 1]} ${cnDay(d.day)}`;
}

/** "初平元年·三月" —— 顶栏用 */
export function formatMonth(day: number): string {
  const d = dayToDate(day);
  const era = eraOf(d.year);
  return `${era.name}${cnNumber(era.nth)}年 ${MONTH_NAME[d.month - 1]}`;
}

export function monthName(month: number): string {
  return MONTH_NAME[month - 1] ?? '';
}

// ─────────────────────────────────────────────────────────────
// 季度 —— 主公下指标的周期
// ─────────────────────────────────────────────────────────────

/** 从 0 开始的季度序号 */
export function quarterOf(day: number): number {
  const d = dayToDate(day);
  return (d.year - EPOCH_YEAR) * 4 + Math.floor((d.month - 1) / MONTHS_PER_QUARTER);
}

/** 该季度的第一天 */
export function quarterStartDay(quarter: number): number {
  const y = Math.floor(quarter / 4);
  const q = quarter % 4;
  return y * DAYS_PER_YEAR + q * MONTHS_PER_QUARTER * DAYS_PER_MONTH;
}

export function quarterEndDay(quarter: number): number {
  return quarterStartDay(quarter + 1) - 1;
}

export const QUARTER_NAME = ['春', '夏', '秋', '冬'] as const;

export function quarterLabel(quarter: number): string {
  const y = EPOCH_YEAR + Math.floor(quarter / 4);
  const era = eraOf(y);
  return `${era.name}${cnNumber(era.nth)}年 ${QUARTER_NAME[quarter % 4]}`;
}

// ─────────────────────────────────────────────────────────────
// 四时与一日之内的时辰
// ─────────────────────────────────────────────────────────────

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

const SEASON_BY_MONTH: readonly Season[] = [
  'winter', 'spring', 'spring', 'spring', 'summer', 'summer',
  'summer', 'autumn', 'autumn', 'autumn', 'winter', 'winter',
];

export function seasonOf(day: number): Season {
  return SEASON_BY_MONTH[dayToDate(day).month - 1] ?? 'spring';
}

export const SEASON_NAME: Record<Season, string> = {
  spring: '春', summer: '夏', autumn: '秋', winter: '冬',
};

/**
 * 一日之内的进度 0~1，由表现层用来推算太阳角度。
 * 逻辑层不使用它 —— 农事与产出以整日结算，避免浮点进入判定。
 */
export function dayFraction(dayFloat: number): number {
  return dayFloat - Math.floor(dayFloat);
}

/** 十二时辰，用于顶栏与环境音切换 */
const SHICHEN = [
  '子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥',
] as const;

export function shichenOf(fraction: number): string {
  // 子时从前一日 23:00 起算，这里按 0.958 起算做偏移
  const hour = (fraction * 24 + 1) % 24;
  return SHICHEN[Math.floor(hour / 2) % 12] + '时';
}
