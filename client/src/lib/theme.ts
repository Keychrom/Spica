/**
 * テーマ（ライト / ダーク / 端末に合わせる）。
 * 見た目はトークンの差し替えだけ（data-theme を切り替える）。
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'spica_theme';
const ACCENT_KEY = 'spica_accent';

/** 選べるアクセント（元の UI と同じ 6 色） */
export type AccentChoice = 'indigo' | 'cyan' | 'emerald' | 'purple' | 'rose' | 'amber';

export const ACCENTS: { value: AccentChoice; label: string; color: string }[] = [
  { value: 'indigo', label: '紫', color: '#6d5ae6' },
  { value: 'cyan', label: '水色', color: '#0e93ad' },
  { value: 'emerald', label: '緑', color: '#0f9d6f' },
  { value: 'purple', label: '赤紫', color: '#8d3ee0' },
  { value: 'rose', label: '赤', color: '#d63a5c' },
  { value: 'amber', label: '橙', color: '#b9760a' },
];

export function getAccent(): AccentChoice {
  try {
    const saved = localStorage.getItem(ACCENT_KEY) || '';
    if (ACCENTS.some((item) => item.value === saved)) return saved as AccentChoice;
  } catch {
    /* noop */
  }
  return 'indigo';
}

/** アクセントを当てる（トークンを差し替えるだけ） */
export function applyAccent(choice: string | undefined): void {
  const value = ACCENTS.some((item) => item.value === choice) ? (choice as AccentChoice) : 'indigo';
  if (value === 'indigo') delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = value;
  try {
    localStorage.setItem(ACCENT_KEY, value);
  } catch {
    /* 保存できない環境ではそのまま */
  }
}
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function getThemeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    /* noop */
  }
  return 'system';
}

export function applyTheme(choice: ThemeChoice): void {
  const dark = choice === 'dark' || (choice === 'system' && media().matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0F111B' : '#F4F5FA');
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* noop */
  }
  applyTheme(choice);
}

/** 端末の設定が変わったときに追従する（system のときだけ） */
export function watchSystemTheme(): () => void {
  const onChange = () => {
    if (getThemeChoice() === 'system') applyTheme('system');
  };
  media().addEventListener('change', onChange);
  return () => media().removeEventListener('change', onChange);
}
