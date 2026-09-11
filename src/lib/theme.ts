export type Theme = 'light' | 'dark'

const DARK_TOKENS: Record<string, string> = {
  '--app-bg': '#16191c',
  '--app-surface': '#1b1f23',
  '--app-ink': '#e7e9ec',
  '--app-line': '#2d333a',
  '--app-muted': '#8b939c',
  '--app-guide': '#2a3037',
  '--app-hover': '#222932',
  '--color-bg': '#16191c',
  '--color-surface': '#1b1f23',
  '--color-text': '#e7e9ec',
  '--color-divider': '#2d333a',
  '--color-accent': '#94bce3',
  '--color-accent-100': '#243442',
  '--color-accent-200': '#2f4a60',
  '--color-accent-700': '#b5d9fd',
  '--color-accent-800': '#d6ebff',
  '--sx-key': '#cfe0f2',
  '--sx-str': '#8cc9ac',
  '--sx-num': '#dda66f',
  '--sx-bool': '#b0a3e0',
  '--sx-null': '#8b939c',
  '--sx-tag': '#a8c6e6',
  '--sx-attr': '#94bce3',
  '--sx-attrval': '#8cc9ac',
  '--sx-punct': '#6b737c',
}

const LIGHT_TOKENS: Record<string, string> = {
  '--app-bg': '#f2f2f3',
  '--app-surface': '#fbfbfc',
  '--app-ink': '#1d1f20',
  '--app-line': '#d4d4d7',
  '--app-muted': '#7a7a7d',
  '--app-guide': '#dedee2',
  '--app-hover': '#eef2f7',
  '--color-bg': '#f2f2f3',
  '--color-surface': '#e9e9ea',
  '--color-text': '#1d1f20',
  '--color-divider': '#d4d4d7',
  '--color-accent': '#5980a6',
  '--color-accent-100': '#eef6ff',
  '--color-accent-200': '#d6ebff',
  '--color-accent-700': '#416180',
  '--color-accent-800': '#2c455d',
  '--sx-key': '#1d2d3d',
  '--sx-str': '#2f6552',
  '--sx-num': '#8a552b',
  '--sx-bool': '#5b4a86',
  '--sx-null': '#7a7a7d',
  '--sx-tag': '#2c455d',
  '--sx-attr': '#597ea3',
  '--sx-attrval': '#2f6552',
  '--sx-punct': '#98989b',
}

export function applyTheme(theme: Theme) {
  const tokens = theme === 'dark' ? DARK_TOKENS : LIGHT_TOKENS
  for (const [key, value] of Object.entries(tokens)) {
    document.documentElement.style.setProperty(key, value)
  }
}
