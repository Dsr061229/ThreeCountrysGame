/**
 * 人物 —— 程序生成，零外部美术资源。
 *
 * 这里出两样东西：
 *
 *   `Portrait` 半身像，装在框里。用在班列、案头这些一次要看好几个人的地方。
 *   `Figure`   立像，站着的一个人，会行礼会转身。**用在堂上那一个人身上。**
 *
 * 两样共用同一颗头（`Head`），所以同一个人在小图和大图上是同一张脸。
 *
 * ── 为什么不摆数值条 ────────────────────────────────
 *
 * 设计上第一条硬规矩：**不做数值面板**。
 * 「统率 86 / 武勇 82」告诉你的，远不如一张脸 + 一句「法令严整，守则不拔」。
 *
 * ── 为什么要有立像 ──────────────────────────────────
 *
 * 半身像装在框里，那是一幅画；**画不会给你行礼**。
 * 而心气这条线全部的情绪出口，就是他听完你的答复之后那 0.6 秒 ——
 * 深揖、抱拳、躬身、颔首，或者一言不发转身就走。
 * 那一下必须由一个**站着的人**来做，不能由一个头像来做。
 *
 * ── 怎么画 ──────────────────────────────────────────
 *
 * 全部从 id 的散列里长出来，**同一个人永远是同一张脸**。
 * 变的六样都不是乱抽的，是从他这个人身上读出来的：
 *   · 武勇高的方脸浓眉，智略高的清癯长目
 *   · 擅冲阵宿卫的戴兜鍪披甲，文事的戴进贤冠或幅巾
 *   · 老成持重的须发见白
 *   · 袍色随出身那一家的旗色，褪一半 —— 一屋子人不能个个鲜亮
 *
 * 笔法上守三条：
 *   一、**不画眼白。** 一点白立刻变成漫画的大眼；这里是一笔上睑加一点瞳仁。
 *   二、**色要闷。** 绢本设色，不是贴纸。
 *   三、**脸上要有骨相。** 颧与颐各压一点暗，脸才立得起来。
 */
import { memo } from 'react';
import type { PersonDef } from '../sim/content.ts';
import type { Reaction } from '../sim/lord_types.ts';

// ─────────────────────────────────────────────────────────────
// 从一个人身上读出他长什么样
// ─────────────────────────────────────────────────────────────

function hashOf(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/**
 * 取散列的第 n 段，落在 [0, m)。
 *
 * ── 这里踩过一个很贵的坑 ──────────────────────────────
 *
 * 原先写的是 `((h >>> a) ^ (h >>> b)) % m`。两处出错：
 *
 *   一、JS 的移位**按 32 取模**，`h >>> 32` 等于 `h >>> 0` ——
 *      n=3 时两个操作数退化成 `(h>>>9) ^ h`，白算一场。
 *   二、更要命的是 `^` 返回的是**有符号**三十二位整数。
 *      结果一旦落在负半边，`% m` 也是负的，`SKIN[-3]` 就是 `undefined`——
 *      于是那个人的 `fill` 属性整个不见了，SVG 默认填黑：
 *      **一屋子人里约莫一半是没有脸的黑影。**
 *
 * 加一个 `>>> 0` 把它掰回无符号，就这一下。
 */
function pickOf(h: number, n: number, m: number): number {
  const a = h >>> ((n * 3) % 31);
  const b = h >>> ((n * 7 + 11) % 31);
  return ((a ^ b) >>> 0) % m;
}

const SKIN = ['#dcbb94', '#d2ac83', '#c39a70', '#e0c4a0', '#b98d64'];
const INK = '#241a13';
const INK_SOFT = '#4a382c';
const HAIR = ['#241d16', '#2d2419', '#372c1f'];
const GREY = '#8f857a';

/** 把旗色褪一半当袍色。一屋子人不能个个鲜亮 */
function robeOf(color: string | undefined, dim: number): string {
  const c = (color ?? '#8a7a5e').replace('#', '');
  const n = parseInt(c.length === 3 ? c.split('').map((x) => x + x).join('') : c, 16);
  const r = Math.round(((n >> 16) & 255) * dim + 26 * (1 - dim));
  const g = Math.round(((n >> 8) & 255) * dim + 22 * (1 - dim));
  const b = Math.round((n & 255) * dim + 20 * (1 - dim));
  return `rgb(${r},${g},${b})`;
}

interface Traits {
  uid: string;
  martial: boolean; scholar: boolean; grey: boolean;
  beard: 'stubble' | 'short' | 'long' | 'full';
  cap: 'guan' | 'jin' | 'helm';
  skin: string; hair: string; robe: string;
  tilt: number; brow: number;
  ck: number; jw: number; cn: number;
  faceD: string;
}

const L = 60; // 头的中线

function traitsOf(who: PersonDef, color: string | undefined): Traits {
  const h = hashOf(who.id);
  const martial = who.valor >= 74
    || who.good.some((g) => ['冲阵', '宿卫', '先登', '统众', '野战'].includes(g));
  const scholar = who.wit >= 68
    || who.good.some((g) => ['谋断', '举荐', '治理'].includes(g));
  /**
   * 须发见白只给老成那一路：能统众、有智略，而勇力已经不在了。
   * 写成「统率高且有智略」的话，曹仁张辽这些三十出头的人会一律满头白发。
   */
  const grey = who.command >= 78 && who.wit >= 70 && who.valor < 72;

  const face = martial ? (pickOf(h, 1, 2) === 0 ? 'square' : 'broad') : scholar ? 'long' : 'oval';
  /**
   * 须。**这一笔最认人。** 留了「无须」这一档的话，
   * 小图上好几个人只剩一张空脸，彼此分不出来。汉末士人蓄须本是常态。
   */
  const young = who.valor < 70 && who.command < 62;
  const beard: Traits['beard'] = who.valor >= 86 ? 'full'
    : who.wit >= 70 || who.command >= 80 ? 'long'
      : young && pickOf(h, 2, 2) === 0 ? 'stubble' : 'short';

  const ck = face === 'square' ? 33 : face === 'broad' ? 34 : face === 'long' ? 28 : 30.5;
  const jw = face === 'square' ? 26 : face === 'broad' ? 24 : face === 'long' ? 16 : 20;
  const cn = face === 'long' ? 108 : face === 'square' ? 103 : 105;

  return {
    uid: 'p' + (h >>> 0).toString(36),
    martial, scholar, grey, beard,
    cap: martial ? 'helm' : scholar ? 'jin' : 'guan',
    skin: SKIN[pickOf(h, 3, SKIN.length)]!,
    hair: grey ? GREY : HAIR[pickOf(h, 4, HAIR.length)]!,
    robe: robeOf(color, martial ? 0.34 : 0.4),
    tilt: who.temper === 'rash' ? -5 : who.temper === 'cautious' ? 3 : 0,
    brow: martial ? 4.4 : 2.8,
    ck, jw, cn,
    faceD: `M${L} 30
      C ${L + ck} 30 ${L + ck + 2} 52 ${L + ck - 3} 72
      C ${L + ck - 7} 92 ${L + jw} ${cn} ${L} ${cn + 2}
      C ${L - jw} ${cn} ${L - ck + 7} 92 ${L - ck + 3} 72
      C ${L - ck - 2} 52 ${L - ck} 30 ${L} 30 Z`,
  };
}

// ─────────────────────────────────────────────────────────────
// 一颗头
// ─────────────────────────────────────────────────────────────

/**
 * 面、发、眉、目、鼻、须、冠。
 *
 * 画在 x∈[26,94]、y∈[2,132] 这一块里，两处共用 ——
 * 小图缩着看，大图放着看，是同一颗头。
 */
function Head({ t }: { t: Traits }) {
  const { ck, cn, skin, hair, faceD, uid, grey, tilt, brow, beard, cap } = t;
  return (
    <>
      {/* 颈 */}
      <path d={`M51 96 L51 112 Q${L} 119 69 112 L69 96 Z`} fill={skin} />
      <path d={`M51 96 L51 106 Q${L} 113 69 106 L69 96 Z`} fill="#000" opacity="0.3" />

      {/* 面 */}
      <path d={faceD} fill={skin} />
      <path d={`M${L - ck + 2} 62 q-7 2 -5 11 q2 8 7 7`} fill={skin} stroke={INK_SOFT}
        strokeWidth="1" />
      <path d={`M${L + ck - 2} 62 q7 2 5 11 q-2 8 -7 7`} fill={skin} stroke={INK_SOFT}
        strokeWidth="1" />

      {/* 骨相：颧与颐各压一点暗，脸才立得起来 */}
      <g clipPath={`url(#${uid}c)`}>
        <ellipse cx={L + ck - 6} cy="80" rx="11" ry="20" fill="#000" opacity="0.1" />
        <ellipse cx={L - ck + 6} cy="80" rx="9" ry="17" fill="#000" opacity="0.05" />
        <ellipse cx={L} cy={cn - 6} rx="16" ry="10" fill="#000" opacity="0.06" />
        {grey && (
          <>
            <path d={`M${L - 22} 60 q10 -2 18 0`} stroke="#000" strokeOpacity="0.14"
              strokeWidth="1" fill="none" />
            <path d={`M${L - 23} 86 q4 7 2 13`} stroke="#000" strokeOpacity="0.12"
              strokeWidth="1" fill="none" />
            <path d={`M${L + 23} 86 q-4 7 -2 13`} stroke="#000" strokeOpacity="0.12"
              strokeWidth="1" fill="none" />
          </>
        )}
      </g>

      {/* 发。鬓与额际 */}
      <path
        d={`M${L} 26 C ${L + ck} 26 ${L + ck + 3} 46 ${L + ck - 2} 60
            C ${L + ck - 5} 48 ${L + 15} 43 ${L} 43
            C ${L - 15} 43 ${L - ck + 5} 48 ${L - ck + 2} 60
            C ${L - ck - 3} 46 ${L - ck} 26 ${L} 26 Z`}
        fill={hair}
      />

      {/* 眉 */}
      <path d={`M${L - 25} ${64 + tilt} q11 -6 20 -1`} stroke={hair}
        strokeWidth={brow} fill="none" strokeLinecap="round" />
      <path d={`M${L + 5} ${63 - tilt} q9 -5 20 1`} stroke={hair}
        strokeWidth={brow} fill="none" strokeLinecap="round" />

      {/* 目。一笔上睑，一点瞳仁。不画眼白 */}
      <path d={`M${L - 23} 74 q10 -6 19 -1`} stroke={INK} strokeWidth="2.2" fill="none"
        strokeLinecap="round" />
      <path d={`M${L + 4} 73 q9 -5 19 1`} stroke={INK} strokeWidth="2.2" fill="none"
        strokeLinecap="round" />
      <ellipse cx={L - 14} cy="77" rx="2.6" ry="3.1" fill={INK} />
      <ellipse cx={L + 14} cy="77" rx="2.6" ry="3.1" fill={INK} />
      <path d={`M${L - 23} 79 q10 3 19 -1`} stroke={INK_SOFT} strokeWidth="0.8" fill="none"
        opacity="0.55" />
      <path d={`M${L + 4} 78 q9 4 19 1`} stroke={INK_SOFT} strokeWidth="0.8" fill="none"
        opacity="0.55" />

      {/* 鼻 */}
      <path d={`M${L + 1} 78 q-3 9 -4 13 q4 3 8 0`} fill="none" stroke={INK_SOFT}
        strokeWidth="1.2" strokeLinecap="round" />

      {/* 须 */}
      {beard === 'stubble' && (
        <>
          <path d={`M${L - 9} 92 q9 -3 18 0 q-3 5 -9 5 q-6 0 -9 -5 Z`} fill={hair}
            opacity="0.72" />
          <path d={`M${L - 8} 99 q8 4 16 0`} stroke={INK} strokeWidth="1.4" fill="none"
            strokeLinecap="round" />
        </>
      )}
      {beard === 'short' && (
        <>
          <path d={`M${L - 11} 91 q11 -4 22 0 q-4 6 -11 6 q-7 0 -11 -6 Z`} fill={hair} />
          <path d={`M${L - 10} 99 q10 6 20 0 q-2 10 -10 10 q-8 0 -10 -10 Z`} fill={hair}
            opacity="0.95" />
        </>
      )}
      {beard === 'long' && (
        <>
          <path d={`M${L - 12} 91 q12 -4 24 0 q-4 6 -12 6 q-8 0 -12 -6 Z`} fill={hair} />
          <path d={`M${L - 11} 99 q11 6 22 0 q-1 20 -11 30 q-10 -10 -11 -30 Z`} fill={hair} />
          <path d={`M${L - 20} 92 q-4 10 1 18`} stroke={hair} strokeWidth="2.4" fill="none"
            strokeLinecap="round" />
          <path d={`M${L + 20} 92 q4 10 -1 18`} stroke={hair} strokeWidth="2.4" fill="none"
            strokeLinecap="round" />
        </>
      )}
      {beard === 'full' && (
        <>
          {/**
            * 络腮。**收窄、提亮。**
            * 一团纯黑从颧骨盖到下巴，五十像素上整张脸就没了 ——
            * 一排戴兜鍪的武人看着像六个黑影。
            * 大胡子该有的是形状，不是面积。
            */}
          <path
            d={`M${L - ck + 13} 92 q-2 18 8 27 q11 8 20 0 q10 -9 8 -27
                q-6 11 -18 12 q-12 -1 -18 -12 Z`}
            fill={hair} opacity="0.92"
          />
          <path d={`M${L - 12} 96 q12 -4 24 0`} stroke={hair} strokeWidth="3"
            fill="none" strokeLinecap="round" />
        </>
      )}

      {/* 冠 */}
      {cap === 'guan' && (
        /* 进贤冠：文吏之服。后高前低，梁在顶上 */
        <>
          <path d="M38 34 L82 34 L78 10 Q60 2 42 10 Z" fill="#38291b" />
          <path d="M45 12 Q60 5 75 12 L73 21 Q60 15 47 21 Z" fill="#4a3826" />
          <path d="M52 5 L52 33 M60 3 L60 33 M68 5 L68 33" stroke="#0d0906"
            strokeWidth="1" opacity="0.55" />
          <rect x="34" y="31" width="52" height="6" rx="2.5" fill="#53412c" />
          <path d="M34 34 L23 45 M86 34 L97 45" stroke="#221a13" strokeWidth="2.4"
            strokeLinecap="round" />
        </>
      )}
      {cap === 'jin' && (
        /* 幅巾：儒者之饰。裹髻，垂带于后 */
        <>
          <path d="M34 36 q-1 -28 26 -28 q27 0 26 28 q-26 -10 -52 0 Z" fill="#443626" />
          <path d="M34 36 q26 -10 52 0 l1 7 q-27 -11 -54 0 Z" fill="#584631" />
          <path d="M60 8 q-7 4 -7 11 q7 -5 14 0 q0 -7 -7 -11 Z" fill="#332818" />
          <path d="M85 24 q13 6 10 23" stroke="#443626" strokeWidth="4" fill="none"
            strokeLinecap="round" />
        </>
      )}
      {cap === 'helm' && (
        /**
         * 兜鍪要**亮**。用近乎黑的铁色，一排武人看着像戴了黑头套 ——
         * 小图上暗色的冠和暗色的发糊成一块，脸只剩下半截。铁是有光的。
         */
        <>
          <path d="M29 44 q-5 17 0 30 l12 -3 q-4 -14 -1 -27 Z" fill="#5a5245" />
          <path d="M91 44 q5 17 0 30 l-12 -3 q4 -14 1 -27 Z" fill="#4c453a" />
          <path d="M32 40 q0 -32 28 -32 q28 0 28 32 q-28 -11 -56 0 Z" fill="#6d6454" />
          <path d="M32 40 q0 -32 28 -32 q10 0 17 6 q-19 6 -21 30 q-9 0 -16 4 Z"
            fill="#8b8069" opacity="0.75" />
          <path d="M32 40 q28 -11 56 0 l2 7 q-30 -11 -60 0 Z" fill="#3f382e" />
          <rect x="56.5" y="2" width="7" height="10" rx="2.5" fill="#a08243" />
          <path d="M60 3 q-6 -8 0 -10 q6 2 0 10" fill="#b04d3b" />
        </>
      )}
    </>
  );
}

/** 两处共用的一套渐变与蒙版 */
function Defs({ t, ground }: { t: Traits; ground: boolean }) {
  const { uid, robe, faceD } = t;
  return (
    <defs>
      {ground && (
        <radialGradient id={uid + 'g'} cx="50%" cy="32%" r="78%">
          <stop offset="0%" stopColor="#5e4d3b" />
          <stop offset="54%" stopColor="#33291f" />
          <stop offset="100%" stopColor="#140f0a" />
        </radialGradient>
      )}
      {/* 绢纹。极淡的横丝，凑近了才看得见 */}
      <pattern id={uid + 'w'} width="3" height="3" patternUnits="userSpaceOnUse">
        <path d="M0 1.5 H3" stroke="#000" strokeOpacity="0.1" strokeWidth="0.7" />
      </pattern>
      {/* 光从左上来 */}
      <linearGradient id={uid + 'f'} x1="10%" y1="2%" x2="94%" y2="98%">
        <stop offset="0%" stopColor="#fff2dc" stopOpacity="0.4" />
        <stop offset="50%" stopColor="#fff2dc" stopOpacity="0" />
        <stop offset="100%" stopColor="#2e1708" stopOpacity="0.3" />
      </linearGradient>
      <linearGradient id={uid + 'r'} x1="14%" y1="0%" x2="92%" y2="100%">
        <stop offset="0%" stopColor={robe} />
        <stop offset="58%" stopColor={robe} />
        <stop offset="100%" stopColor="#15110d" />
      </linearGradient>
      <clipPath id={uid + 'c'}><path d={faceD} /></clipPath>
    </defs>
  );
}

// ─────────────────────────────────────────────────────────────
// 半身像
// ─────────────────────────────────────────────────────────────

export interface PortraitProps {
  who: PersonDef;
  color?: string | undefined;
  size?: number;
  /** 心气的一句话。有就写在底下 */
  mood?: string;
  /** 暗着画 —— 用在「不再上报」的人身上 */
  dim?: boolean;
  /** 不写名字，只要脸 */
  bare?: boolean;
}

/**
 * 半身像。
 *
 * **包一层 memo。** 一次「退朝」会甩出上百条事件，
 * 整屏跟着重画 —— 而班列上十来张像、每张几十个 SVG 节点，
 * 全部重建一遍就是那句「按钮不灵敏」。同一个人、同样的参数，画一次就够。
 */
export const Portrait = memo(function Portrait(
  { who, color, size = 76, mood, dim, bare }: PortraitProps,
) {
  const t = traitsOf(who, color);
  const W = 120;
  const H = 150;

  return (
    <figure className={'pt' + (dim ? ' dim' : '')} style={{ width: size }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={size} height={(size * H) / W} role="img"
        aria-label={who.name}>
        <Defs t={t} ground />
        <rect x="0" y="0" width={W} height={H} fill={`url(#${t.uid}g)`} />

        {/* 肩与交领右衽 */}
        <path d={`M8 ${H} C13 124 33 113 45 109 L${L} 118 L75 109 C87 113 107 124 112 ${H} Z`}
          fill={`url(#${t.uid}r)`} />
        {t.martial && (
          <>
            <path d={`M22 ${H} C24 132 36 116 47 111 L44 ${H} Z`} fill="#544a3d" />
            <path d={`M98 ${H} C96 132 84 116 73 111 L76 ${H} Z`} fill="#544a3d" />
          </>
        )}
        <path d={`M45 109 L${L} 121 L75 109 L71 107 L${L} 116 L49 107 Z`}
          fill="#e7dbc2" opacity="0.86" />

        <Head t={t} />

        <rect x="0" y="0" width={W} height={H} fill={`url(#${t.uid}f)`}
          style={{ mixBlendMode: 'soft-light' }} />
        <rect x="0" y="0" width={W} height={H} fill={`url(#${t.uid}w)`} />
        <rect x="0" y="0" width={W} height={H} fill="none" stroke="#0b0806" strokeWidth="2.6" />
        <rect x="1.8" y="1.8" width={W - 3.6} height={H - 3.6} fill="none"
          stroke="#8a7248" strokeOpacity="0.3" strokeWidth="0.9" />
      </svg>
      {!bare && (
        <figcaption>
          <b>{who.name}</b>
          {who.courtesy && <em>{who.courtesy}</em>}
          {mood && <span className="pt-mood">{mood}</span>}
        </figcaption>
      )}
    </figure>
  );
});

// ─────────────────────────────────────────────────────────────
// 立像 —— 站在堂上的那个人
// ─────────────────────────────────────────────────────────────

export interface FigureProps {
  who: PersonDef;
  color?: string | undefined;
  height?: number;
  /**
   * 他此刻在做什么。
   *
   * null 是站着。给了反应就演那一下 ——
   * 上半身绕着腰折下去（深揖折得最狠），或者整个人转过身去。
   */
  pose?: Reaction | null;
  /** 站得远一点、暗一点。班列后排用 */
  faded?: boolean;
}

/**
 * 一个站着的人。
 *
 * 上半身单独成组，绕**腰**旋转 —— 这样行礼才是折腰，
 * 而不是整个人歪一下。转身那一下是水平翻面 + 挪出画。
 */
/** 立像。同样包一层 memo —— 它比半身像还大一倍 */
export const Figure = memo(function Figure(
  { who, color, height = 300, pose, faded }: FigureProps,
) {
  const t = traitsOf(who, color);
  const W = 160;
  const H = 430;
  const C = 80;          // 立像的中线
  const dx = C - L;      // 头画在 L=60 上，挪到中线来
  const HEAD_Y = 22;     // 头往下挪这么多，脖子正好接上交领
  const WAIST = 248;     // 折腰的支点

  return (
    <svg
      className={'fg pose-' + (pose ?? 'stand') + (faded ? ' faded' : '')}
      viewBox={`0 0 ${W} ${H}`} height={height} width={(height * W) / H}
      role="img" aria-label={who.name}
    >
      <Defs t={t} ground={false} />

      {/* 地上的一团影。人站在地上，不是浮着 */}
      <ellipse cx={C} cy={H - 8} rx="54" ry="9" fill="#000" opacity="0.45" />

      {/**
        * 下裳。**落地的一段不动** ——
        * 行礼折的是上半身，裙裾是不跟着甩的。
        */}
      <path
        d={`M${C - 30} 238 C ${C - 40} 300 ${C - 48} 370 ${C - 50} ${H - 12}
            Q${C} ${H - 1} ${C + 50} ${H - 12}
            C ${C + 48} 370 ${C + 40} 300 ${C + 30} 238 Z`}
        fill={`url(#${t.uid}r)`}
      />
      {/* 衣褶。三道就够，多了在暗处只会脏 */}
      <path d={`M${C - 16} 250 C ${C - 24} 320 ${C - 28} 370 ${C - 30} ${H - 18}`}
        stroke="#0d0a07" strokeOpacity="0.34" strokeWidth="1.8" fill="none" />
      <path d={`M${C + 1} 254 L${C + 3} ${H - 16}`}
        stroke="#0d0a07" strokeOpacity="0.24" strokeWidth="1.5" fill="none" />
      <path d={`M${C + 17} 250 C ${C + 25} 320 ${C + 30} 370 ${C + 32} ${H - 18}`}
        stroke="#0d0a07" strokeOpacity="0.34" strokeWidth="1.8" fill="none" />

      {/* ── 上半身。行礼时整组绕腰折下去 ── */}
      <g className="fg-upper" style={{ transformOrigin: `${C}px ${WAIST}px` }}>
        {/* 袍身 */}
        <path
          d={`M${C - 32} 252 C ${C - 36} 210 ${C - 34} 172 ${C - 24} 154
              L${C} 172 L${C + 24} 154
              C ${C + 34} 172 ${C + 36} 210 ${C + 32} 252 Z`}
          fill={`url(#${t.uid}r)`}
        />
        {/**
          * 广袖。**汉服这一身最好认的轮廓就是它。**
          * 袖口垂到腰下，人才有那个「拱手而立」的样子。
          */}
        <path
          d={`M${C - 26} 158 C ${C - 52} 168 ${C - 66} 202 ${C - 62} 244
              Q${C - 44} 254 ${C - 34} 236 C ${C - 38} 202 ${C - 34} 174 ${C - 24} 166 Z`}
          fill={`url(#${t.uid}r)`}
        />
        <path
          d={`M${C + 26} 158 C ${C + 52} 168 ${C + 66} 202 ${C + 62} 244
              Q${C + 44} 254 ${C + 34} 236 C ${C + 38} 202 ${C + 34} 174 ${C + 24} 166 Z`}
          fill={`url(#${t.uid}r)`}
        />
        <path d={`M${C - 58} 240 Q${C - 44} 250 ${C - 35} 235`} fill="none"
          stroke="#0d0a07" strokeOpacity="0.4" strokeWidth="1.5" />
        <path d={`M${C + 58} 240 Q${C + 44} 250 ${C + 35} 235`} fill="none"
          stroke="#0d0a07" strokeOpacity="0.4" strokeWidth="1.5" />

        {/* 甲。武人多一层肩吞 */}
        {t.martial && (
          <>
            <path d={`M${C - 32} 168 C ${C - 26} 156 ${C - 14} 152 ${C - 7} 155
                      L${C - 12} 180 Z`} fill="#5c5348" />
            <path d={`M${C + 32} 168 C ${C + 26} 156 ${C + 14} 152 ${C + 7} 155
                      L${C + 12} 180 Z`} fill="#5c5348" />
            <path d={`M${C - 32} 168 C ${C - 26} 156 ${C - 14} 152 ${C - 7} 155`}
              fill="none" stroke="#8d8069" strokeWidth="1.5" />
            <path d={`M${C + 32} 168 C ${C + 26} 156 ${C + 14} 152 ${C + 7} 155`}
              fill="none" stroke="#8d8069" strokeWidth="1.5" />
          </>
        )}

        {/* 交领右衽 */}
        <path d={`M${C - 24} 154 L${C} 180 L${C + 24} 154 L${C + 18} 150
                  L${C} 172 L${C - 18} 150 Z`} fill="#e7dbc2" opacity="0.9" />
        <path d={`M${C - 18} 150 L${C} 172 L${C + 18} 150`} fill="none"
          stroke="#0f0b08" strokeWidth="1.2" opacity="0.5" />

        {/* 大带与绶 */}
        <path d={`M${C - 33} 228 Q${C} 238 ${C + 33} 228 L${C + 33} 242
                  Q${C} 252 ${C - 33} 242 Z`} fill="#2c231a" />
        <path d={`M${C - 5} 240 L${C - 7} 288 L${C} 282 L${C + 7} 288 L${C + 5} 240 Z`}
          fill="#3a2e21" />

        {/**
          * 拱手。
          *
          * **这一双手是「他在跟你说话」这件事的全部证据。**
          * 少了它，一个立着的人和一张贴在墙上的画没有分别。
          */}
        <g className="fg-hands">
          <ellipse cx={C} cy="208" rx="18" ry="12" fill={t.skin} />
          <ellipse cx={C - 6} cy="205" rx="12" ry="10" fill={t.skin} />
          <path d={`M${C - 17} 208 q17 8 34 0`} fill="none" stroke={INK_SOFT}
            strokeWidth="1.2" opacity="0.7" />
          <path d={`M${C - 9} 199 q9 -3 17 1`} fill="none" stroke={INK_SOFT}
            strokeWidth="1.1" opacity="0.5" />
        </g>

        {/* 头 */}
        <g transform={`translate(${dx}, ${HEAD_Y})`}>
          <Head t={t} />
        </g>
      </g>
    </svg>
  );
});
