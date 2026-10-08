/**
 * 战场的地。
 *
 * 这张图**不是随机生成的** —— 它是从天下图上那一段真实的地里长出来的。
 *
 * 你从雍丘外的营出发去打陈留，中间是中原的平野，那战场就是一片开阔地，
 * 没处伏兵；你从汉中打长安，中间横着秦岭，那战场就是一条山谷，
 * 两侧全是坡，中间一条道 —— 而那条道就是伏兵该等的地方。
 *
 * 于是「地形」这件事在三个尺度上是同一件事：
 *   天下图上你看得见那片山；
 *   出兵时它让你多走十天；
 *   打起来的时候，你的伏兵就藏在那片山的林子里。
 */
import { chancePermille, nextInt, nextRange } from './rng.ts';
import type { RngState } from './rng.ts';
import type { RouteSurvey } from './terrain.ts';
import { type Cell, type Ground } from './theatre_types.ts';

export const COLS = 40;
export const ROWS = 26;

const idxOf = (c: number, r: number): number => r * COLS + c;

/**
 * 造一张战场。
 *
 * `survey` 是天下图上两地之间的实地勘察 —— 山占几成、林占几成、泽占几成。
 * 这张战场按那个比例来铺，所以它是**那一段地**的样子。
 */
export function makeTheatreMap(rng: RngState, survey: RouteSurvey): Cell[] {
  const cells: Cell[] = [];
  for (let i = 0; i < COLS * ROWS; i++) {
    cells.push({ ground: 'plain', height: 0 });
  }

  const put = (c: number, r: number, ground: Ground, height = 0): void => {
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return;
    const cell = cells[idxOf(c, r)]!;
    cell.ground = ground;
    cell.height = height;
  };

  /** 撒一团。地形是连片的，不是噪点 */
  const blob = (
    cx: number, cy: number, radius: number, ground: Ground, peak = 0,
  ): void => {
    const rr = Math.ceil(radius);
    for (let dc = -rr; dc <= rr; dc++) {
      for (let dr = -rr; dr <= rr; dr++) {
        const d = Math.hypot(dc, dr);
        if (d > radius) continue;
        // 边缘要毛一点，不然像贴上去的圆饼
        if (d > radius - 1.2 && chancePermille(rng, 420)) continue;
        const h = peak > 0 ? Math.max(1, Math.round(peak * (1 - d / radius) + 0.4)) : 0;
        put(cx + dc, cy + dr, ground, h);
      }
    }
  };

  // ── 山 ────────────────────────────────────────────────
  //
  // 山不是散布的 —— 它是一道**脊**。而一道脊会把战场切成两半，
  // 中间留一条谷道。这正是伏兵能成立的地形：
  // 敌军必须从那条道过，而两侧的坡上藏得住人。
  const mountains = Math.round((survey.mountain / 1000) * 3.2);
  for (let i = 0; i < mountains; i++) {
    // 脊大致横着或竖着走，随机偏一点
    const vertical = chancePermille(rng, 500);
    const along = vertical ? ROWS : COLS;
    const at = vertical
      ? nextRange(rng, 5, COLS - 5)
      : nextRange(rng, 5, ROWS - 5);
    let drift = 0;
    for (let k = 0; k < along; k++) {
      drift += nextRange(rng, -1, 1) * 0.5;
      drift = Math.max(-5, Math.min(5, drift));
      const w = 1.6 + nextRange(rng, 0, 1.6);
      const cx = vertical ? at + drift : k;
      const cy = vertical ? k : at + drift;
      blob(Math.round(cx), Math.round(cy), w, 'hill', 2 + nextInt(rng, 2));
    }
  }

  // ── 林 ────────────────────────────────────────────────
  const woods = 2 + Math.round((survey.forest / 1000) * 6);
  for (let i = 0; i < woods; i++) {
    blob(
      nextInt(rng, COLS), nextInt(rng, ROWS),
      2.4 + nextRange(rng, 0, 3.4), 'forest',
    );
  }

  // ── 泽 ────────────────────────────────────────────────
  const marshes = Math.round((survey.marsh / 1000) * 4);
  for (let i = 0; i < marshes; i++) {
    blob(nextInt(rng, COLS), nextInt(rng, ROWS), 2.2 + nextRange(rng, 0, 3), 'marsh');
  }

  // ── 水 ────────────────────────────────────────────────
  //
  // 大半的战场上有一条水。它是天然的界，也是「半渡而击」的舞台。
  if (chancePermille(rng, 620)) {
    const vertical = chancePermille(rng, 400);
    const at = vertical
      ? nextRange(rng, 8, COLS - 8)
      : nextRange(rng, 6, ROWS - 6);
    let drift = 0;
    const along = vertical ? ROWS : COLS;
    for (let k = 0; k < along; k++) {
      drift += nextRange(rng, -1, 1) * 0.6;
      drift = Math.max(-4, Math.min(4, drift));
      const w = 0.9 + nextRange(rng, 0, 0.9);
      const cx = vertical ? at + drift : k;
      const cy = vertical ? k : at + drift;
      blob(Math.round(cx), Math.round(cy), w, 'water');
    }
    // 总得有个渡口，否则这仗打不起来
    const fords = 1 + nextInt(rng, 2);
    for (let f = 0; f < fords; f++) {
      const k = nextRange(rng, 4, along - 4);
      for (let d = -3; d <= 3; d++) {
        const cx = vertical ? at : k;
        const cy = vertical ? k : at;
        for (let w = -3; w <= 3; w++) {
          const c = vertical ? cx + w : cx + d;
          const r = vertical ? cy + d : cy + w;
          if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
          const cell = cells[idxOf(c, r)]!;
          if (cell.ground === 'water') { cell.ground = 'marsh'; cell.height = 0; }
        }
      }
    }
  }

  return cells;
}

/**
 * 在图上开一条道，把两处连起来。
 *
 * 道走得快，但一望可见 —— 它是「主攻走大路，奇兵绕小道」这个取舍
 * 在战场尺度上的样子。开道时会把水面改成渡口，
 * 否则一条画在水上的路是走不通的。
 */
export function carveRoad(
  cells: Cell[], from: [number, number], to: [number, number],
): void {
  const steps = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const c = Math.round(from[0] + (to[0] - from[0]) * t);
    const r = Math.round(from[1] + (to[1] - from[1]) * t);
    for (let w = -1; w <= 1; w++) {
      const rr = r + w;
      if (c < 0 || c >= COLS || rr < 0 || rr >= ROWS) continue;
      const cell = cells[idxOf(c, rr)]!;
      // 道从坡上过就成了隘口，从水上过就成了渡头
      if (cell.ground === 'hill') continue;
      if (cell.ground === 'water') { cell.ground = 'marsh'; cell.height = 0; continue; }
      cell.ground = 'road';
      cell.height = 0;
    }
  }
}

/** 把营寨脚下那一块推平。没人在坡上支帐篷 */
export function flatten(cells: Cell[], at: [number, number], radius: number): void {
  const rr = Math.ceil(radius);
  for (let dc = -rr; dc <= rr; dc++) {
    for (let dr = -rr; dr <= rr; dr++) {
      if (Math.hypot(dc, dr) > radius) continue;
      const c = at[0] + dc;
      const r = at[1] + dr;
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
      const cell = cells[idxOf(c, r)]!;
      cell.ground = 'plain';
      cell.height = 0;
    }
  }
}

/** 取一格。越界当平地 */
export function cellAt(cells: Cell[], x: number, y: number): Cell {
  const c = Math.max(0, Math.min(COLS - 1, Math.round(x)));
  const r = Math.max(0, Math.min(ROWS - 1, Math.round(y)));
  return cells[idxOf(c, r)]!;
}
