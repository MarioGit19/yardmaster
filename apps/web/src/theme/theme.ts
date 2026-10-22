import { useEffect } from 'react';
import { createPreference, useMediaQuery, usePreference } from '../prefs.js';

export const THEME_SETTINGS = ['dark', 'light', 'system'] as const;
export type ThemeSetting = (typeof THEME_SETTINGS)[number];
export type Theme = 'dark' | 'light';

/** The next setting in the HUD toggle's cycle. */
export const NEXT_THEME: Record<ThemeSetting, ThemeSetting> = {
  dark: 'light',
  light: 'system',
  system: 'dark',
};

export const PREFERS_LIGHT = '(prefers-color-scheme: light)';

export const themePreference = createPreference<ThemeSetting>(
  'cboard.theme',
  THEME_SETTINGS,
  'dark',
);

export function resolveTheme(setting: ThemeSetting, prefersLight: boolean): Theme {
  if (setting === 'system') return prefersLight ? 'light' : 'dark';
  return setting;
}

/** Dark is the default, so only light sets the attribute. */
export function applyTheme(root: HTMLElement, theme: Theme): void {
  if (theme === 'light') root.dataset.theme = 'light';
  else delete root.dataset.theme;
}

/** Applies the stored theme before React mounts, so the first paint is already correct. */
export function applyInitialTheme(root: HTMLElement = document.documentElement): void {
  const prefersLight = globalThis.matchMedia?.(PREFERS_LIGHT).matches ?? false;
  applyTheme(root, resolveTheme(themePreference.get(), prefersLight));
}

export function useTheme(): {
  setting: ThemeSetting;
  theme: Theme;
  setTheme(s: ThemeSetting): void;
} {
  const setting = usePreference(themePreference);
  const prefersLight = useMediaQuery(PREFERS_LIGHT);
  const theme = resolveTheme(setting, prefersLight);
  useEffect(() => applyTheme(document.documentElement, theme), [theme]);
  return { setting, theme, setTheme: themePreference.set };
}
