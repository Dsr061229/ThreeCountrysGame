/**
 * 模拟引擎 —— 模拟层唯一对外的入口。
 *
 * 表现层只能做三件事：
 *   1. dispatch(命令)
 *   2. getState() 读快照（只读）
 *   3. subscribe(事件回调)
 *
 * 除此之外不得触碰内部状态。守住这条边界，联机才可能只改驱动方式而不重写游戏。
 */
import type { ContentDB, ContentIndex } from './content.ts';
import { indexContent } from './content.ts';
import { applyCommand } from './handlers.ts';
import { hashState, STATE_VERSION, type WorldState } from './state.ts';
import { createWorld } from './world.ts';
import type { Command, CommandEnvelope, SimEvent } from './commands.ts';

export type SimListener = (events: readonly SimEvent[], state: Readonly<WorldState>) => void;

/** 存档格式：种子 + 内容版本 + 命令流。回放即读档 */
export interface SaveFile {
  version: number;
  seed: string;
  log: CommandEnvelope[];
}

/** 存档来自另一套规则，读不得 */
export class StaleSaveError extends Error {
  readonly saved: number;
  readonly current: number;
  constructor(saved: number, current: number) {
    super(`存档版本 ${saved}，当前规则 ${current}`);
    this.name = 'StaleSaveError';
    this.saved = saved;
    this.current = current;
  }
}

export class Engine {
  private state: WorldState;
  private readonly idx: ContentIndex;
  private readonly log: CommandEnvelope[] = [];
  private readonly listeners = new Set<SimListener>();
  private seq = 0;

  constructor(seed: string, content: ContentDB) {
    this.idx = indexContent(content);
    this.state = createWorld(seed, this.idx);
  }

  /** 只读快照。表现层修改它不会影响模拟，但也没有意义——请走 dispatch */
  getState(): Readonly<WorldState> {
    return this.state;
  }

  getContent(): ContentIndex {
    return this.idx;
  }

  subscribe(fn: SimListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 执行一条命令。
   * 被拒绝的命令**不入日志** —— 日志必须只包含真正改变过世界的命令，
   * 否则回放时会因随机数消耗对不上而分叉。
   */
  dispatch(cmd: Command, by = 'local'): readonly SimEvent[] {
    const result = applyCommand(this.state, cmd, this.idx);
    if (result.ok) {
      this.log.push({ seq: this.seq++, cmd, by });
    }
    /**
     * 办成了就要说一声 —— 哪怕没有任何事件。
     *
     * 原先的条件是「有事件才通知」，而好几条命令是**默默改变世界**的：
     * 收兵、把一支还没出发的兵收回来、看完战报散场……
     * 它们都返回一个空的 ok()。于是界面收不到消息，不重画，
     * 玩家点下去屏幕上什么都不动 —— 看着就是按钮坏了。
     *
     * 更要命的是战场：一场仗前九十多拍走路，一条日志都不出，
     * 那几秒钟人数不动、尸首不出，就是那句「开战后啥反馈都没有」。
     *
     * 被拒绝的命令本来就带着 rejected 事件，所以这里两头都不漏。
     */
    if (result.ok || result.events.length > 0) {
      for (const fn of this.listeners) fn(result.events, this.state);
    }
    return result.events;
  }

  /** 静默执行，不通知监听者。回放时用 */
  private dispatchSilent(cmd: Command, by: string): void {
    const result = applyCommand(this.state, cmd, this.idx);
    if (result.ok) this.log.push({ seq: this.seq++, cmd, by });
  }

  save(): SaveFile {
    return { version: this.state.version, seed: this.state.seed, log: this.log.map((e) => ({ ...e })) };
  }

  /** 状态指纹。用于确定性测试与联机一致性校验 */
  fingerprint(): string {
    return hashState(this.state);
  }

  /**
   * 从存档重建。同样的种子 + 同样的命令流，必须得到同样的世界。
   *
   * 版本不合就**拒绝**，绝不将就着读。
   * 规则一改，同一份命令流重放出来的就是另一个世界 ——
   * 读出个错的比读不出来糟得多：玩家看不出哪里不对，
   * 只会觉得「我明明守住了那座城」。
   */
  static load(save: SaveFile, content: ContentDB): Engine {
    if (save.version !== STATE_VERSION) {
      throw new StaleSaveError(save.version, STATE_VERSION);
    }
    const e = new Engine(save.seed, content);
    for (const env of save.log) e.dispatchSilent(env.cmd, env.by);
    return e;
  }
}
