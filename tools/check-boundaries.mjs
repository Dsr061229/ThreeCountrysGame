/**
 * 边界检查：模拟层必须保持纯净。
 *
 * 这条规则不是洁癖 —— 联机模式要求服务端能在 Node 里跑同一份模拟，
 * 而存档回放要求模拟结果只由「种子 + 命令流」决定。
 * 一旦 src/sim 里出现渲染代码、DOM、Math.random 或 Date.now，两者同时失效。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SIM_DIR = 'src/sim';

const FORBIDDEN = [
  { re: /\bMath\.random\b/, why: '模拟层禁用 Math.random，请使用 state.rng（见 src/sim/rng.ts）' },
  { re: /\bDate\.now\b|\bnew Date\b|\bperformance\.now\b/, why: '模拟层禁用真实时间，请使用 state.tick' },
  { re: /\bdocument\b|\bwindow\b|\blocalStorage\b/, why: '模拟层禁止触碰 DOM' },
  { re: /from\s+['"](three|react|react-dom)/, why: '模拟层禁止依赖渲染库' },
  { re: /from\s+['"][^'"]*\/(view|ui)\//, why: '模拟层禁止反向依赖表现层' },
  { re: /\bcrypto\.randomUUID\b/, why: '模拟层禁用随机 id，请使用 mintId（见 src/sim/state.ts）' },
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

let violations = 0;
for (const file of walk(SIM_DIR)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    // 跳过注释行，避免规则本身的说明被误报
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
    for (const rule of FORBIDDEN) {
      if (rule.re.test(line)) {
        console.error(`✗ ${relative('.', file)}:${i + 1}  ${rule.why}`);
        console.error(`    ${trimmed}`);
        violations++;
      }
    }
  });
}

if (violations > 0) {
  console.error(`\n模拟层边界被破坏：${violations} 处。`);
  process.exit(1);
}
console.log('✓ 模拟层边界完好：无渲染依赖、无真实时间、无不受控随机。');
