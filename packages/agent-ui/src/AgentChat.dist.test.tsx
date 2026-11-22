// The built library, as a page imports it: `dist/agent-ui.js` and `dist/agent-ui.css`
// (`pnpm build` first; `pnpm test:dist`). The browser tests import the source; this is what
// shows the build keeps what they check: the chat styled, the page left as it was.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vite-plus/test';
import { addToPage, emulateColorScheme, pageDocument } from './testing/render.tsx';

// Variables, so neither TypeScript nor Vite resolves them before the build exists.
const BUILT_SCRIPT = '../dist/agent-ui.js';
const BUILT_STYLESHEET = '../dist/agent-ui.css?raw';

const CONSOLA_LIGHT_BACKGROUND = 'rgb(252, 251, 248)';

it('styles the chat and leaves the page as it was', async () => {
  // A light Consola page (its colour tokens on `html[data-theme]`), with a background of its
  // own, on a system in dark mode.
  await emulateColorScheme('dark');
  document.documentElement.setAttribute('data-theme', 'light');
  const pageStyle = document.createElement('style');
  pageStyle.textContent = `[data-theme="light"] { --color-bg-primary: ${CONSOLA_LIGHT_BACKGROUND}; }
    body { background-color: rgb(250, 248, 240); }`;
  addToPage(pageStyle);
  try {
    const before = pageDocument();

    const { default: css } = (await import(/* @vite-ignore */ BUILT_STYLESHEET)) as {
      default: string;
    };
    const stylesheet = document.createElement('style');
    stylesheet.textContent = css;
    document.head.append(stylesheet);
    const { AgentChat } = (await import(
      /* @vite-ignore */ BUILT_SCRIPT
    )) as typeof import('./index.ts');
    expect(pageDocument()).toEqual(before);

    const container = document.createElement('div');
    container.style.height = '720px';
    addToPage(container);
    const root = createRoot(container);
    await act(async () =>
      // A host nobody listens on: what is checked is the page, not the conversation.
      root.render(
        <AgentChat hostUrl="http://127.0.0.1:9" pass="a-pass" sessionId="built-library" />,
      ),
    );
    try {
      const theme = document.querySelector('.consola-agent-ui-theme') as HTMLElement;
      const style = getComputedStyle(theme);
      // t3's theme reached the chat, mapped to Consola's tokens, and light as Consola is.
      expect(style.backgroundColor).toBe(CONSOLA_LIGHT_BACKGROUND);
      expect(style.colorScheme).toBe('light');
      expect(
        getComputedStyle(container.querySelector('.consola-agent-ui') as Element).contain,
      ).toBe('layout');
      expect(pageDocument()).toEqual(before);
    } finally {
      await act(async () => root.unmount());
      stylesheet.remove();
    }
  } finally {
    document.documentElement.removeAttribute('data-theme');
  }
});
