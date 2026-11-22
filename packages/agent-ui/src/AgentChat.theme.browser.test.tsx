import { beforeAll, expect, it } from 'vite-plus/test';
import {
  addToPage,
  answerOf,
  emulateColorScheme,
  forgetStoredThreads,
  host,
  mountChat,
} from './testing/render.tsx';

// What the chat shows comes from the host, not from t3's stored copy of an earlier file's chat.
beforeAll(forgetStoredThreads);

const CONSOLA_DARK_BACKGROUND = 'rgb(5, 5, 5)';
const CONSOLA_DARK_TEXT = 'rgb(240, 240, 240)';

it("takes Consola's colour tokens and dark theme from the page, popups included", async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  // As the desktop renderer sets them: tokens on `html[data-theme]`.
  const tokens = document.createElement('style');
  tokens.textContent = `[data-theme="dark"] { --color-bg-primary: ${CONSOLA_DARK_BACKGROUND}; --color-text-primary: ${CONSOLA_DARK_TEXT}; }`;
  addToPage(tokens);
  document.documentElement.setAttribute('data-theme', 'dark');
  try {
    await mountChat({ hostUrl, pass, sessionId });
    await expect.element(answerOf(assistantText)).toBeVisible();

    const theme = document.querySelector('.consola-agent-ui-theme');
    expect(theme?.classList.contains('dark')).toBe(true);
    const style = getComputedStyle(theme as Element);
    expect(style.backgroundColor).toBe(CONSOLA_DARK_BACKGROUND);
    // t3 draws text from `--foreground` through its contrast mix, so the variable is what maps.
    expect(style.getPropertyValue('--foreground').trim()).toBe(CONSOLA_DARK_TEXT);

    // A popup t3 opens lands at the end of <body>; it is marked as the chat's, in its theme.
    const portal = document.createElement('div');
    portal.setAttribute('data-base-ui-portal', '');
    addToPage(portal);
    await expect.poll(() => portal.className).toBe('consola-agent-ui-portal dark');
    expect(getComputedStyle(portal).getPropertyValue('--background').trim()).toBe(
      CONSOLA_DARK_BACKGROUND,
    );
  } finally {
    document.documentElement.removeAttribute('data-theme');
  }
});

/** The chat's theme element, and how its document reads: t3's `color-scheme` is light or dark. */
const chatTheme = async () => {
  const theme = document.querySelector('.consola-agent-ui-theme') as HTMLElement;
  const { getThemeSnapshot } = await import('~/hooks/useTheme');
  return {
    dark: theme.classList.contains('dark'),
    colorScheme: getComputedStyle(theme).colorScheme,
    // What t3's own code reads (code highlighting, diffs): its resolved appearance.
    t3Appearance: getThemeSnapshot().resolvedTheme,
  };
};

it("is light when Consola is, on a dark system and under a page's own .dark", async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  await emulateColorScheme('dark');
  const html = document.documentElement;
  html.setAttribute('data-theme', 'light');
  // A page's own `dark` class (Tailwind's) says nothing about the chat's theme.
  html.classList.add('dark');
  try {
    await mountChat({ hostUrl, pass, sessionId });
    await expect.element(answerOf(assistantText)).toBeVisible();
    expect(await chatTheme()).toEqual({ dark: false, colorScheme: 'light', t3Appearance: 'light' });
  } finally {
    html.removeAttribute('data-theme');
    html.classList.remove('dark');
  }
});

it('is dark when Consola is, on a light system, and follows Consola when it changes', async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  await emulateColorScheme('light');
  const html = document.documentElement;
  html.setAttribute('data-theme', 'dark');
  try {
    await mountChat({ hostUrl, pass, sessionId });
    await expect.element(answerOf(assistantText)).toBeVisible();
    expect(await chatTheme()).toEqual({ dark: true, colorScheme: 'dark', t3Appearance: 'dark' });

    html.setAttribute('data-theme', 'light');
    await expect
      .poll(chatTheme)
      .toEqual({ dark: false, colorScheme: 'light', t3Appearance: 'light' });
    expect(html.classList.contains('dark')).toBe(false);
  } finally {
    html.removeAttribute('data-theme');
  }
});
