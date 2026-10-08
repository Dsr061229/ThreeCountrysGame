/**
 * 声音 —— 全部用 Web Audio 现场合成，不依赖任何音频文件。
 *
 * 沉浸感有一半在耳朵里。没有音频资源的情况下，能做到的是：
 * 一层持续的风声底噪（滤波白噪声），加上几个有分量的短音
 * （钟、鼓、闷响）。它们不华丽，但能让「有事发生」被身体感知到，
 * 而不是只在屏幕角落弹出一行字。
 *
 * 浏览器要求用户先有一次交互才允许出声，所以入口是 enable()。
 */

class Ambience {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = false;
  private muted = false;

  /** 必须在用户点击之后调用 */
  enable(): void {
    if (this.enabled) return;
    try {
      const Ctor = window.AudioContext ?? (window as unknown as {
        webkitAudioContext?: typeof AudioContext;
      }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;

      const master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      this.master = master;

      this.startWind();
      this.enabled = true;
    } catch {
      // 出不了声就算了，不该因此影响游戏
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.1);
    }
  }

  isMuted(): boolean { return this.muted; }

  /** 风：白噪声过一个低通，再叠一层缓慢起伏的增益 */
  private startWind(): void {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // 布朗噪声比白噪声更接近真实的风
      const white = Math.random() * 2 - 1;
      last = (last + white * 0.02) / 1.02;
      data[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    lp.Q.value = 0.6;

    const gain = ctx.createGain();
    gain.gain.value = 0.11;

    src.connect(lp).connect(gain).connect(this.master!);
    src.start();

    // 阵风：增益缓慢来回摆动
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.055;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.055;
    lfo.connect(lfoGain).connect(gain.gain);
    lfo.start();
  }

  private env(
    node: AudioNode, peak: number, attack: number, decay: number,
  ): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g).connect(this.master!);
  }

  private tone(freq: number, type: OscillatorType, peak: number, attack: number, decay: number): void {
    if (!this.ctx || !this.master || this.muted) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    this.env(osc, peak, attack, decay);
    osc.start();
    osc.stop(ctx.currentTime + attack + decay + 0.05);
  }

  /** 短促的木质响声，点击反馈 */
  click(): void {
    this.tone(880, 'triangle', 0.05, 0.002, 0.05);
    this.tone(1320, 'sine', 0.025, 0.002, 0.035);
  }

  /** 钟。工程完工 —— 这是发育反馈里最该被听见的一下 */
  chime(): void {
    if (!this.ctx || this.muted) return;
    // 编钟的音色靠几个不成整数比的分音叠出来
    const base = 523.25;
    for (const [mul, amp, dec] of [[1, 0.16, 2.2], [2.76, 0.07, 1.6], [5.4, 0.03, 1.0]] as const) {
      this.tone(base * mul, 'sine', amp, 0.005, dec);
    }
  }

  /** 鼓。使者到、升迁、拓城 */
  drum(): void {
    if (!this.ctx || !this.master || this.muted) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.28);
    this.env(osc, 0.34, 0.004, 0.42);
    osc.start();
    osc.stop(t + 0.5);
    // 鼓皮的噪声成分
    const len = Math.floor(ctx.sampleRate * 0.14);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    src.connect(bp).connect(g).connect(this.master);
    src.start();
  }

  /** 闷响。天灾人祸 */
  thud(): void {
    if (!this.ctx || !this.master || this.muted) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(90, t);
    osc.frequency.exponentialRampToValueAtTime(32, t + 0.6);
    this.env(osc, 0.3, 0.01, 0.9);
    osc.start();
    osc.stop(t + 1.1);
  }
}

export const Audio = new Ambience();
