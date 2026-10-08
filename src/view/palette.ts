/**
 * 配色 —— 宋画写意。
 *
 * 整体是纸本设色：低饱和、明度层次窄、靠墨线撑结构。
 * 全篇只允许一处高饱和（朱砂），用来指示「与你有关的东西」。
 */
export const PALETTE = {
  /** 宣纸底 */
  paper: 0xe6dfd0,
  paperDeep: 0xd8cfbc,
  /** 墨 */
  ink: 0x2a2926,
  inkSoft: 0x5d574b,
  /** 青瓦 */
  tile: 0x4d5251,
  tileLit: 0x646b69,
  /** 夯土墙 */
  earth: 0xcabfa8,
  earthShade: 0xb0a58e,
  /** 木构 */
  wood: 0x7a5a3e,
  woodDark: 0x5c4230,
  /** 草木 */
  foliage: 0x6e7a5c,
  /** 朱砂 —— 全局唯一的强调色，只用于玩家与可交互目标 */
  cinnabar: 0xa8382a,
  /** 石 */
  stone: 0x9a958a,
} as const;

/** 四时调色：整体色温随季节偏移，用于表现层的环境光 */
export const SEASON_LIGHT = {
  spring: { sky: 0xdfe4d8, ground: 0xc9c2ae, intensity: 0.95 },
  summer: { sky: 0xe9e6d2, ground: 0xc4c0a6, intensity: 1.1 },
  autumn: { sky: 0xe8dcc0, ground: 0xc9b894, intensity: 0.9 },
  winter: { sky: 0xdadfe2, ground: 0xc6c6c0, intensity: 0.8 },
} as const;

export const css = (hex: number): string => '#' + hex.toString(16).padStart(6, '0');
