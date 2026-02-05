/**
 * File type categories for viewer selection
 */
export type FileCategory = 'markdown' | 'code' | 'image' | 'unknown';

/**
 * Map file extensions to Prism language identifiers for syntax highlighting
 */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // JavaScript/TypeScript
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',

  // Web
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',

  // Data formats
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  svg: 'xml',

  // Scripting
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  py: 'python',
  rb: 'ruby',

  // Systems
  rs: 'rust',
  go: 'go',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',

  // Other
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'docker',
  makefile: 'makefile',
};

/**
 * Extensions that should be rendered as markdown
 */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

/**
 * Extensions that should be rendered as images
 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

/**
 * Get the file extension from a path (lowercase)
 */
export function getFileExtension(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() || '';
}

/**
 * Determine the category of a file for viewer selection
 */
export function getFileCategory(filePath: string): FileCategory {
  const ext = getFileExtension(filePath);

  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return 'markdown';
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return 'image';
  }

  if (EXTENSION_TO_LANGUAGE[ext]) {
    return 'code';
  }

  return 'unknown';
}

/**
 * Check if a file can be previewed
 */
export function isPreviewable(filePath: string): boolean {
  return getFileCategory(filePath) !== 'unknown';
}

/**
 * Get the Prism language identifier for syntax highlighting
 */
export function getLanguageFromPath(filePath: string): string {
  const ext = getFileExtension(filePath);
  return EXTENSION_TO_LANGUAGE[ext] || 'text';
}

/**
 * Get a human-readable language name for display
 */
export function getLanguageDisplayName(filePath: string): string {
  const language = getLanguageFromPath(filePath);
  return language.charAt(0).toUpperCase() + language.slice(1);
}
