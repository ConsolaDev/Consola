import type { ITheme } from '@xterm/xterm';

/**
 * xterm colour themes.
 *
 * Background, foreground and cursor are read from the app's design tokens so
 * the pane blends into the surrounding chrome. The sixteen ANSI colours are
 * fixed palettes: Claude Code's TUI paints with them directly, so they need to
 * stay legible and mutually distinct rather than track the app's accent.
 */

const DARK_ANSI = {
    black: '#2f2f2f',
    red: '#eb5757',
    green: '#4dab75',
    yellow: '#dfab4d',
    blue: '#4398e8',
    magenta: '#b57edc',
    cyan: '#56b6c2',
    white: '#d8d8d8',
    brightBlack: '#5c5c5c',
    brightRed: '#ff7b7b',
    brightGreen: '#6fce97',
    brightYellow: '#f5c76e',
    brightBlue: '#6fb3f2',
    brightMagenta: '#cd9ef0',
    brightCyan: '#7bd4df',
    brightWhite: '#ffffff',
};

const LIGHT_ANSI = {
    black: '#37352f',
    red: '#c0392b',
    green: '#2f7d4f',
    yellow: '#9c6f19',
    blue: '#1f6feb',
    magenta: '#8b4bb5',
    cyan: '#2b7a86',
    white: '#6b6b6b',
    brightBlack: '#8a8a8a',
    brightRed: '#e05243',
    brightGreen: '#3f9c68',
    brightYellow: '#b8892b',
    brightBlue: '#3d8bf5',
    brightMagenta: '#a463cc',
    brightCyan: '#3d97a3',
    brightWhite: '#1a1a1a',
};

function readToken(name: string, fallback: string): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

/**
 * Build a theme from the currently applied CSS custom properties.
 *
 * Call this after `data-theme` changes so the terminal follows the app.
 */
export function buildXtermTheme(isDark: boolean): ITheme {
    const ansi = isDark ? DARK_ANSI : LIGHT_ANSI;

    return {
        ...ansi,
        background: readToken('--color-bg-primary', isDark ? '#191919' : '#ffffff'),
        foreground: readToken('--color-text-primary', isDark ? '#f2f2f2' : '#37352f'),
        cursor: readToken('--color-accent', '#2383e2'),
        cursorAccent: readToken('--color-bg-primary', isDark ? '#191919' : '#ffffff'),
        selectionBackground: readToken('--color-bg-selected', 'rgba(35, 131, 226, 0.3)'),
    };
}

/** The bundled family, as named by its @font-face rule. */
export const TERMINAL_FONT_FAMILY = 'JetBrains Mono Variable';

export interface TerminalFont {
    fontFamily: string;
    fontSize: number;
    fontWeight: 400 | 500;
    fontWeightBold: 700;
}

/**
 * Resolve the terminal's font from the app's tokens and the user's size setting.
 *
 * The regular weight is 500 rather than 400 on purpose. xterm's WebGL renderer
 * rasterises glyphs through Canvas2D, which gets Skia's grayscale antialiasing
 * without the stem darkening CoreText applies -- so light-on-dark text comes out
 * thinner here than the same font does in a native terminal. Half a weight step
 * puts the stems back without making the type look bold.
 */
export function readTerminalFont(fontSize: number): TerminalFont {
    return {
        fontFamily: readToken('--font-mono', `'${TERMINAL_FONT_FAMILY}', Menlo, monospace`),
        fontSize,
        fontWeight: 500,
        fontWeightBold: 700,
    };
}
