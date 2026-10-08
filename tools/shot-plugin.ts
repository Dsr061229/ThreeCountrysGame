/**
 * 开发期的「把画面存下来」。
 *
 * 为什么要有这个：调视效的时候必须**看得见**。
 * 若只能靠 readPixels 采样几个点，就只能确认「有东西、不是黑的」，
 * 确认不了「好不好看」—— 那等于闭着眼睛调色。
 *
 * 做法：dev server 上开一个 POST 口子，页面把画布压成 PNG 发过来，
 * 落到 `.shots/latest.png`。之后直接看那个文件。
 *
 * **只在 dev 生效**，打包出去的东西里没有这段。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

export function shotPlugin(dir = '.shots'): Plugin {
  return {
    name: 'sanguo-shot',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('post only');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const name = (req.url ?? '/latest').replace(/[^\w./-]/g, '') || '/latest';
            const base64 = body.replace(/^data:image\/\w+;base64,/, '');
            const file = resolve(process.cwd(), dir, name.replace(/^\//, '') + '.png');
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, Buffer.from(base64, 'base64'));
            res.statusCode = 200;
            res.end(file);
          } catch (err) {
            res.statusCode = 500;
            res.end(String(err));
          }
        });
      });
    },
  };
}
