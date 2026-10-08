/**
 * 一条命令发布到 GitHub Pages。
 *
 *   npm run deploy
 *
 * 做的事：打包 → 把 `dist/` 整个搬到 `gh-pages` 分支 → 推上去。
 *
 * ── 为什么不用 Actions ──────────────────────────────
 *
 * 用也行，而且更好（推一下就自动跑测试再部署，见 README）。
 * 但往仓库里放 `.github/workflows/` 要 token 带 `workflow` 权限，
 * 而 `gh` 默认登录是不带的 —— 第一次部署就卡在那儿，很扫兴。
 * 这个脚本谁都跑得了，什么权限都不用额外给。
 *
 * ── 为什么要 .nojekyll ──────────────────────────────
 *
 * Pages 默认拿 Jekyll 过一遍，而 Jekyll **会吃掉下划线开头的目录**。
 * Vite 现在不生成那种名字，但哪天换个插件就会踩到，
 * 而且那种 404 极难查 —— 放一个空文件就免疫了。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = fileURLToPath(new URL('../.gh-pages', import.meta.url));
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

console.log('— 打包 —');
run('npm', ['run', 'build']);

console.log('— 准备 gh-pages 工作区 —');
// 上一次留下的残骸先清掉，免得 worktree add 直接报错
if (existsSync(work)) {
  try { run('git', ['worktree', 'remove', '--force', work]); } catch { /* 不是 worktree 就算了 */ }
  rmSync(work, { recursive: true, force: true });
}
try {
  run('git', ['fetch', 'origin', 'gh-pages']);
  run('git', ['worktree', 'add', '-B', 'gh-pages', work, 'origin/gh-pages']);
} catch {
  // 远端还没有这个分支 —— 第一次部署
  run('git', ['worktree', 'add', '--orphan', '-b', 'gh-pages', work]);
}

// 旧文件全删，只留 .git —— 不然上一次的 hash 文件名会越堆越多
for (const name of readdirSync(work)) {
  if (name === '.git') continue;
  rmSync(`${work}/${name}`, { recursive: true, force: true });
}
mkdirSync(work, { recursive: true });
cpSync(`${root}dist`, work, { recursive: true });
writeFileSync(`${work}/.nojekyll`, '');

console.log('— 推上去 —');
run('git', ['add', '-A'], work);
try {
  run('git', ['commit', '-m', `部署 ${new Date().toISOString().slice(0, 10)}`], work);
} catch {
  console.log('（和线上一模一样，没什么可提交的）');
}
run('git', ['push', 'origin', 'gh-pages'], work);
run('git', ['worktree', 'remove', '--force', work]);

console.log('\n好了 → https://dsr061229.github.io/ThreeCountrysGame/');
console.log('（Pages 那边还要过一会儿才刷新，大约一两分钟）');
