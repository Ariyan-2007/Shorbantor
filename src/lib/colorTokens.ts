import type { ColorToken } from '../types/schema'

export const TOKEN_COLOR: Record<ColorToken, string> = {
  key: 'var(--sx-key)',
  idx: 'var(--sx-idx)',
  tag: 'var(--sx-tag)',
  null: 'var(--sx-null)',
  str: 'var(--sx-str)',
  num: 'var(--sx-num)',
  bool: 'var(--sx-bool)',
  muted: 'var(--app-muted)',
  accent: 'var(--color-accent-700)',
}
