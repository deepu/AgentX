/**
 * Centralized branding assets for MemWise
 * Used by OAuth callback pages
 */

export const MEMWISE_LOGO = [
  '████  ████ ████████ ████  ████ ██      ██ ██ ████████ ████████',
  '██████████ ██       ██████████ ██      ██ ██ ██       ██      ',
  '██  ██  ██ ██████   ██  ██  ██ ██  ██  ██ ██ ████████ ██████  ',
  '██      ██ ██       ██      ██ ██████████ ██       ██ ██      ',
  '██      ██ ████████ ██      ██ ████  ████ ██ ████████ ████████',
] as const;

/** Logo as a single string for HTML templates */
export const MEMWISE_LOGO_HTML = MEMWISE_LOGO.map((line) => line.trimEnd()).join('\n');

/** Session viewer base URL */
export const VIEWER_URL = 'https://thecraftagents.com';
