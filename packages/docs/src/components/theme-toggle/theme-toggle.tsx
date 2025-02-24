import { $, component$, useContext, useStyles$ } from '@builder.io/qwik';
import { SunAndMoon } from './sun-and-moon';
import { themeStorageKey } from '../router-head/theme-script';
import themeToggle from './theme-toggle.css';
import { GlobalStore } from '../../context';

export type ThemePreference = 'dark' | 'light';

export const colorSchemeChangeListener = (onColorSchemeChange: (isDark: boolean) => void) => {
  const listener = ({ matches: isDark }: MediaQueryListEvent) => {
    onColorSchemeChange(isDark);
  };
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', (event) => listener(event));

  return () =>
    window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', listener);
};

export const setPreference = (theme: ThemePreference) => {
  localStorage.setItem(themeStorageKey, theme);
  reflectPreference(theme);
};

export const reflectPreference = (theme: ThemePreference) => {
  document.firstElementChild?.setAttribute('data-theme', theme);
};

export const getColorPreference = (): ThemePreference => {
  if (localStorage.getItem(themeStorageKey)) {
    return localStorage.getItem(themeStorageKey) as ThemePreference;
  } else {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
};

export const ThemeToggle = component$(() => {
  useStyles$(themeToggle);
  const state = useContext(GlobalStore);

  const onClick$ = $(() => {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    setPreference(state.theme);
  });

  return (
    <div class={'theme-toggle-container'}>
      <button
        type="button"
        class={'theme-toggle'}
        id="theme-toggle"
        title="Toggles light & dark"
        aria-label={state.theme}
        aria-live="polite"
        onClick$={onClick$}
      >
        <SunAndMoon />
      </button>
    </div>
  );
});
