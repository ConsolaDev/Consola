/**
 * Shared syntax highlighting theme for code across the app
 * Based on oneDark with transparent backgrounds to allow CSS variables to show through
 */
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

/**
 * Custom theme based on oneDark with transparent backgrounds
 * This allows our CSS variable --color-bg-secondary to show through
 */
export const codeTheme = {
  ...oneDark,
  'pre[class*="language-"]': {
    ...(oneDark['pre[class*="language-"]'] as object),
    background: 'transparent',
  },
  'code[class*="language-"]': {
    ...(oneDark['code[class*="language-"]'] as object),
    background: 'transparent',
  },
};

/**
 * Default custom styles for SyntaxHighlighter component
 */
export const codeCustomStyle = {
  margin: 0,
  borderRadius: 0,
  fontSize: '13px',
};
