/**
 * 入口：装配内容库、起一局、挂上界面。
 * 这里是唯一把「模拟层」「表现层」「内容」三者接在一起的地方，
 * 也是唯一碰存档的地方 —— 换局要换掉整个引擎，只有这一层做得了。
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Engine } from './sim/engine.ts';
import { indexContent } from './sim/content.ts';
import { content } from '../content/index.ts';
import { App } from './ui/App.tsx';
import { autosave, clear, peek, restore } from './save.ts';
import './ui/styles.css';
import './ui/general.css';
import './ui/theatre.css';

const worldHost = document.getElementById('world')!;
const uiHost = document.getElementById('ui')!;

// 种子决定这一局的天灾人祸。将来联机房间也由它开始
const seed = new URLSearchParams(location.search).get('seed') ?? 'yongqiu-190';

const idx = indexContent(content);

function Root() {
  const [engine, setEngine] = useState(() => new Engine(seed, content));
  // 只在起页面时看一眼有没有上一局。看过就不再变 ——
  // 存下去的那一刻它就该从标题页上消失了，而不是变成「继续到刚才」
  const [saved] = useState(() => peek());

  useEffect(() => autosave(engine), [engine]);

  if (import.meta.env.DEV) {
    (window as unknown as { __engine?: Engine }).__engine = engine;
  }

  return (
    <App
      engine={engine}
      idx={idx}
      host={worldHost}
      saved={saved}
      onResume={() => {
        const back = restore(content);
        if (back) setEngine(back);
      }}
      onFresh={clear}
    />
  );
}

// 热更新会把这个模块整个重跑一遍。
// 每次都 createRoot 会在同一个容器上开第二个根 —— React 会报错，
// 而且旧的那个根还挂着，界面会出现两份。所以根只开一次，之后复用
declare global {
  interface Window { __uiRoot?: ReturnType<typeof createRoot> }
}
const root = window.__uiRoot ?? createRoot(uiHost);
window.__uiRoot = root;
root.render(<Root />);
