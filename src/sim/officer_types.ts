/**
 * 部将。
 *
 * 这条线上最要紧的一件事：**你下的是命令，执行的是人**。
 *
 * 如果部将只是给每一路加个百分比，那「派谁去」就退化成了「谁的数值高」，
 * 点将台也就成了一张表。所以这里的部将有性子，性子会让他不照你说的做：
 * 性急的等不到时候就动手，骄矜的嫌小道难走改上大道，
 * 谨慎的一路逡巡误了时辰。
 *
 * 街亭之败不是因为马谡数值低 —— 是因为诸葛亮让他当道下寨，他上了山。
 * 这个系统要能长出那种事来，它才配叫三国。
 */

/** 性子。决定他会怎么走样 */
export type Temper = 'cautious' | 'decisive' | 'rash' | 'proud';

export const TEMPER_NAME: Record<Temper, string> = {
  cautious: '谨慎',
  decisive: '果决',
  rash: '性急',
  proud: '骄矜',
};

export const TEMPER_DESC: Record<Temper, string> = {
  cautious: '不肯行险。守得住，也常常来得晚。',
  decisive: '说到做到。交代什么就是什么。',
  rash: '按不住。伏兵交给他，多半等不到时候。',
  proud: '眼里没有难走的路，也没有别人的安排。',
};

export interface Officer {
  id: string;
  name: string;
  courtesy: string;
  /** 统率 0~100。越高越能照计划走，带的兵也越齐整 */
  command: number;
  /** 武勇 0~100。接战时那一路的战力 */
  valor: number;
  /** 智略 0~100。设伏、断粮道这类要动脑子的事看它 */
  wit: number;
  temper: Temper;
  /** 忠诚 0~100。将来叛逃时用得上 */
  loyalty: number;
  /** 一句话的来历，点将时看得见 */
  note: string;
}

/**
 * 这一路会不会走样，以及怎么走样。
 *
 * 判定只看两样：**这件事难不难**，和**这个人扛不扛得住**。
 * 统率高的人照做的可能大；性子决定他一旦不照做，会往哪个方向偏。
 */
export function deviationRisk(officer: Officer | null, mission: string): number {
  // 你自己领的那一路不会走样 —— 你就在那儿
  if (!officer) return 0;

  // 憋着不动的事最难。伏兵要等，佯动要装，都得按得住性子
  const hard = mission === 'ambush' ? 34 : mission === 'feint' ? 26
    : mission === 'flank' ? 22 : mission === 'raid' ? 18 : 8;

  const steady = Math.floor(officer.command / 3);
  // 果决的人是**减项**而不是零。
  // 「说到做到」若只是「和谨慎的人一样偶尔迟到」，那这个性子就没有意义 ——
  // 玩家选人时看不出分别，点将也就成了摆设
  const temperExtra = officer.temper === 'rash' ? 22
    : officer.temper === 'proud' ? 16
      : officer.temper === 'cautious' ? 8 : -12;

  return Math.max(0, Math.min(880, (hard + temperExtra) * 10 - steady * 8));
}

/** 一旦走样，这个性子的人会怎么偏 */
export function deviationOf(temper: Temper, mission: string): string {
  if (temper === 'rash') return mission === 'assault' ? 'chased' : 'early';
  if (temper === 'proud') return 'wrong_road';
  if (temper === 'cautious') return 'late';
  return 'late';
}
