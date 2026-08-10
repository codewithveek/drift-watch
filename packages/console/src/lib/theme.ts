/**
 * Theme handling. Light is the default; dark is opt-in and persisted.
 *
 * The initial class is applied by an inline script in index.html rather than
 * here — doing it from a module would paint the light theme first and then
 * repaint, which a dark-mode user sees as a white flash.
 */
export type Theme = 'light' | 'dark';

const THEME_KEY = 'driftwatch.theme';

export function getTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function setTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage unavailable (private mode); the class still applies for this session.
  }
}
