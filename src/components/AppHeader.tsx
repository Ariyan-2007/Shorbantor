import type { KeyboardEvent } from 'react'
import type { Theme } from '../lib/theme'
import type { AncestorCrumb, ParseMode } from '../types/schema'
import { IconChevronDown, IconChevronUp, IconSearch, IconTheme } from './icons'

interface AppHeaderProps {
  mode: ParseMode
  onModeChange: (mode: ParseMode) => void
  onPrettify: () => void
  onCopyRaw: () => void
  onDownload: () => void
  onClear: () => void
  theme: Theme
  onToggleTheme: () => void

  paneOpen: boolean
  onTogglePane: () => void
  onExpandAll: () => void
  onCollapseAll: () => void

  query: string
  onQueryChange: (query: string) => void
  matchLabel: string
  onPrevMatch: () => void
  onNextMatch: () => void

  crumbs: AncestorCrumb[]
  onCopyCrumbPath: () => void
  onSelectCrumb: (nodeId: number) => void
}

export default function AppHeader({
  mode,
  onModeChange,
  onPrettify,
  onCopyRaw,
  onDownload,
  onClear,
  theme,
  onToggleTheme,
  paneOpen,
  onTogglePane,
  onExpandAll,
  onCollapseAll,
  query,
  onQueryChange,
  matchLabel,
  onPrevMatch,
  onNextMatch,
  crumbs,
  onCopyCrumbPath,
  onSelectCrumb,
}: AppHeaderProps) {
  const on = 'var(--color-accent-700)'
  const onT = 'var(--color-bg)'
  const off = 'transparent'
  const offT = 'var(--app-ink)'

  const handleSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) onPrevMatch()
      else onNextMatch()
    }
    if (e.key === 'Escape') onQueryChange('')
  }

  return (
    <>
      <header style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px', borderBottom: '1px solid var(--app-line)', background: 'var(--app-surface)', flex: '0 0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 6 }}>
          <img src="/favicon.svg" alt="Shorbantor logo" width={22} height={21} style={{ flex: '0 0 auto', display: 'block' }} />
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 20, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Shorbantor</span>
            <span style={{ fontFamily: 'var(--app-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--app-muted)' }}>JSON / XML INSPECTOR</span>
          </div>
        </div>

        <div className="seg" style={{ flex: '0 0 auto' }}>
          <button
            className="seg-opt"
            aria-pressed={mode === 'json'}
            onClick={() => onModeChange('json')}
            style={{ fontFamily: 'var(--app-mono)', fontSize: 12, letterSpacing: '0.08em', padding: '6px 14px', background: mode === 'json' ? on : off, color: mode === 'json' ? onT : offT }}
          >
            JSON
          </button>
          <button
            className="seg-opt"
            aria-pressed={mode === 'xml'}
            onClick={() => onModeChange('xml')}
            style={{ fontFamily: 'var(--app-mono)', fontSize: 12, letterSpacing: '0.08em', padding: '6px 14px', background: mode === 'xml' ? on : off, color: mode === 'xml' ? onT : offT }}
          >
            XML
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <button className="btn btn-secondary" onClick={onPrettify} style={{ fontSize: 13 }}>
            Prettify
          </button>
          <button className="btn btn-secondary" onClick={onCopyRaw} style={{ fontSize: 13 }}>
            Copy raw
          </button>
          <button className="btn btn-secondary" onClick={onDownload} style={{ fontSize: 13 }}>
            Download
          </button>
          <button className="btn btn-secondary" onClick={onClear} style={{ fontSize: 13 }}>
            Clear
          </button>
          <button className="btn btn-secondary btn-icon" title="Toggle theme" onClick={onToggleTheme} aria-label="Toggle theme">
            <IconTheme size={17} style={{ color: theme === 'dark' ? 'var(--color-accent-300)' : undefined }} />
          </button>
        </div>
      </header>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--app-line)', background: 'var(--app-bg)', flex: '0 0 auto', flexWrap: 'wrap' }}>
        <button className="btn btn-secondary" onClick={onTogglePane} style={{ fontSize: 12, fontFamily: 'var(--app-mono)', letterSpacing: '0.04em' }}>
          {paneOpen ? '⟨ HIDE INPUT' : 'SHOW INPUT ⟩'}
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 1, border: '1px solid var(--app-line)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <button onClick={onExpandAll} style={{ fontFamily: 'var(--app-mono)', fontSize: 11, letterSpacing: '0.06em', padding: '6px 10px', background: 'transparent', border: 0, color: 'var(--app-ink)', cursor: 'pointer' }}>
            EXPAND ALL
          </button>
          <button
            onClick={onCollapseAll}
            style={{ fontFamily: 'var(--app-mono)', fontSize: 11, letterSpacing: '0.06em', padding: '6px 10px', background: 'transparent', border: 0, borderLeft: '1px solid var(--app-line)', color: 'var(--app-ink)', cursor: 'pointer' }}
          >
            COLLAPSE ALL
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 260px', minWidth: 220, maxWidth: 460 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flex: '1 1 auto', background: 'var(--app-surface)', border: '1px solid var(--app-line)', borderRadius: 'var(--radius-md)', padding: '0 8px' }}>
            <IconSearch size={15} />
            <input
              id="sb-search"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={handleSearchKey}
              placeholder="Search keys & values   ⌘F"
              style={{ flex: '1 1 auto', border: 0, background: 'transparent', outline: 'none', fontFamily: 'var(--app-mono)', fontSize: 12.5, color: 'var(--app-ink)', padding: '7px 0' }}
            />
            <span style={{ fontFamily: 'var(--app-mono)', fontSize: 11, color: 'var(--app-muted)', whiteSpace: 'nowrap' }}>{matchLabel}</span>
            {query && (
              <button
                onClick={() => onQueryChange('')}
                title="Clear search"
                aria-label="Clear search"
                style={{ flex: '0 0 auto', border: 0, background: 'transparent', color: 'var(--app-muted)', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '2px 2px' }}
              >
                ×
              </button>
            )}
          </div>
          <button className="btn btn-secondary btn-icon" title="Previous match" onClick={onPrevMatch} style={{ width: 30, height: 30 }}>
            <IconChevronUp size={15} />
          </button>
          <button className="btn btn-secondary btn-icon" title="Next match" onClick={onNextMatch} style={{ width: 30, height: 30 }}>
            <IconChevronDown size={15} />
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderBottom: '1px solid var(--app-line)', background: 'var(--app-surface)', flex: '0 0 auto', overflowX: 'auto' }}>
        <span style={{ fontFamily: 'var(--app-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--app-muted)', flex: '0 0 auto' }}>PATH</span>
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1
          return (
            <span key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>
              <span style={{ color: 'var(--sx-punct)', fontFamily: 'var(--app-mono)', fontSize: 11 }}>/</span>
              <button
                onClick={() => onSelectCrumb(c.id)}
                title={`Jump to ${c.label}`}
                style={{
                  border: 0,
                  background: 'transparent',
                  padding: 0,
                  cursor: 'pointer',
                  fontFamily: 'var(--app-mono)',
                  fontSize: 12,
                  color: isLast ? 'var(--color-accent-800)' : 'var(--app-muted)',
                  textDecoration: isLast ? 'none' : 'underline',
                  textUnderlineOffset: 2,
                }}
              >
                {c.label}
              </button>
            </span>
          )
        })}
        <button className="btn btn-ghost" onClick={onCopyCrumbPath} style={{ fontSize: 11, fontFamily: 'var(--app-mono)', letterSpacing: '0.06em', marginLeft: 8, flex: '0 0 auto' }}>
          COPY PATH
        </button>
      </div>
    </>
  )
}
