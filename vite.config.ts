import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { shotPlugin } from './tools/shot-plugin.ts';

export default defineConfig({
  /**
   * 资源用**相对路径**引。
   *
   * GitHub Pages 的项目站点挂在 `https://<用户>.github.io/<仓库名>/` 下，
   * 而 Vite 默认按 `/` 写死绝对路径 —— 那样部署出去是一片白屏，
   * 控制台里全是 404。
   *
   * 写成 `./` 之后，同一份 dist 在 Pages、在本地双击打开、
   * 在任何子目录下都跑得起来。这一条成立的前提是**本来就没有路由**：
   * 整个游戏只有一个页面。
   */
  base: './',
  plugins: [react(), shotPlugin()],
  resolve: {
    alias: {
      '@sim': fileURLToPath(new URL('./src/sim', import.meta.url)),
      '@view': fileURLToPath(new URL('./src/view', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
      '@content': fileURLToPath(new URL('./content', import.meta.url)),
    },
  },
  server: { host: '0.0.0.0', port: 5273 },
});
