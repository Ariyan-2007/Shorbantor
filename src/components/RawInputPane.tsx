import { type ChangeEvent, type DragEvent, useEffect, useMemo, useState } from 'react'
import { minifyText, prettyPrint } from '../lib/format'
import type { ParseMode } from '../types/schema'
import { IconCollapse, IconExpand } from './icons'

interface ErrorInfo {
  msg: string
  line: number
  col: number
  snippet: string
}

interface RawInputPaneProps {
  mode: ParseMode
  value: string
  onChange: (text: string) => void
  onLoadText: (text: string, mode: ParseMode) => void
}

function errInfo(e: unknown, raw: string): ErrorInfo {
  const msg = e instanceof Error ? e.message : String(e)
  let pos = -1
  const m = /position (\d+)/i.exec(msg)
  if (m) pos = +m[1]
  let line = 1
  let col = 1
  let snippet = ''
  if (pos >= 0) {
    const before = raw.slice(0, pos)
    line = before.split('\n').length
    col = pos - before.lastIndexOf('\n')
    const lines = raw.split('\n')
    const txt = lines[line - 1] || ''
    snippet = `L${line}  ${txt.slice(0, 60)}\n${' '.repeat(String(line).length + 3 + Math.max(0, col - 1))}^`
  } else {
    const lm = /line (\d+)/i.exec(msg)
    if (lm) {
      line = +lm[1]
      snippet = `L${line}  ${(raw.split('\n')[line - 1] || '').slice(0, 60)}`
    }
  }
  return { msg: msg.replace(/\s+/g, ' '), line, col, snippet }
}

export default function RawInputPane({ mode, value, onChange, onLoadText }: RawInputPaneProps) {
  const [url, setUrl] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [formatError, setFormatError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [expanded])

  const validity = useMemo(() => {
    if (!value.trim()) return { err: null as ErrorInfo | null, empty: true }
    try {
      if (mode === 'json') JSON.parse(value)
      else {
        const doc = new DOMParser().parseFromString(value, 'application/xml')
        const pe = doc.querySelector('parsererror')
        if (pe) throw new Error(pe.textContent?.replace(/\s+/g, ' ').trim().slice(0, 180) ?? 'Malformed XML')
      }
      return { err: null as ErrorInfo | null, empty: false }
    } catch (e) {
      return { err: errInfo(e, value), empty: false }
    }
  }, [value, mode])

  const bytes = new Blob([value]).size
  const sizeLabel = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`

  const commit = (text: string) => {
    onChange(text)
    if (text.trim()) onLoadText(text, mode)
  }

  const prettify = () => {
    try {
      setFormatError(null)
      onChange(prettyPrint(value, mode))
    } catch {
      setFormatError(`Cannot prettify — fix the ${mode.toUpperCase()} error first`)
    }
  }

  const minify = () => {
    try {
      setFormatError(null)
      onChange(minifyText(value, mode))
    } catch {
      setFormatError(`Cannot minify — fix the ${mode.toUpperCase()} error first`)
    }
  }

  const fetchUrl = async () => {
    const u = url.trim()
    if (!u) return
    setFetchError(null)
    try {
      const res = await fetch(u)
      const text = await res.text()
      commit(text)
    } catch {
      setFetchError('Fetch blocked or failed — paste the payload instead')
    }
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    file.text().then(commit)
  }

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setFormatError(null)
    onChange(e.target.value)
  }
  const handleBlurCommit = () => {
    if (value.trim()) onLoadText(value, mode)
  }

  const sectionStyle = expanded
    ? {
        position: 'fixed' as const,
        top: '4vh',
        left: '6vw',
        right: '6vw',
        bottom: '4vh',
        zIndex: 41,
        display: 'flex',
        flexDirection: 'column' as const,
        minWidth: 0,
        background: 'var(--app-bg)',
        border: '1px solid var(--app-line)',
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
      }
    : {
        flex: '0 0 380px',
        display: 'flex',
        flexDirection: 'column' as const,
        minWidth: 0,
        borderRight: '1px solid var(--app-line)',
        background: 'var(--app-bg)',
      }

  return (
    <>
      {expanded && (
        <div onClick={() => setExpanded(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(15, 13, 10, 0.45)', zIndex: 40 }} />
      )}
      <section style={sectionStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 8px' }}>
        <h6 style={{ margin: 0, fontSize: 11, letterSpacing: '0.1em' }}>Raw input</h6>
        <span style={{ fontFamily: 'var(--app-mono)', fontSize: 10.5, color: 'var(--app-muted)', marginLeft: 'auto' }}>{sizeLabel}</span>
        <button
          className="btn btn-secondary btn-icon"
          title={expanded ? 'Restore size' : 'Expand view'}
          aria-label={expanded ? 'Restore raw input size' : 'Expand raw input view'}
          onClick={() => setExpanded((v) => !v)}
          style={{ width: 26, height: 26 }}
        >
          {expanded ? <IconCollapse size={13} /> : <IconExpand size={13} />}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px 8px' }}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void fetchUrl()
          }}
          placeholder="https://… fetch from URL"
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            background: 'var(--app-surface)',
            border: '1px solid var(--app-line)',
            borderRadius: 'var(--radius-md)',
            padding: '6px 8px',
            fontFamily: 'var(--app-mono)',
            fontSize: 11.5,
            color: 'var(--app-ink)',
            outline: 'none',
          }}
        />
        <button className="btn btn-primary" onClick={() => void fetchUrl()} style={{ fontSize: 12, padding: '6px 12px' }}>
          Fetch
        </button>
      </div>

      <div
        className="blueprint sb-ta"
        onDragOver={(e) => {
          e.preventDefault()
          if (!dragOver) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        style={{
          position: 'relative',
          flex: '1 1 auto',
          margin: '0 12px 12px',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          background: dragOver ? 'var(--color-accent-100)' : 'var(--app-surface)',
        }}
      >
        <i className="corner tl" />
        <i className="corner tr" />
        <i className="corner bl" />
        <i className="corner br" />
        <textarea
          className="sb-ta"
          value={value}
          onChange={handleChange}
          onBlur={handleBlurCommit}
          spellCheck={false}
          placeholder="Paste JSON or XML — or drop a file here"
          style={{
            flex: '1 1 auto',
            resize: 'none',
            border: 0,
            outline: 'none',
            background: 'transparent',
            padding: 12,
            fontFamily: 'var(--app-mono)',
            fontSize: expanded ? 14.5 : 12.5,
            lineHeight: expanded ? 1.8 : 1.65,
            color: 'var(--app-ink)',
            tabSize: 2,
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderTop: '1px solid var(--app-line)' }}>
          <button className="btn btn-secondary" onClick={prettify} style={{ fontSize: 12 }}>
            Prettify
          </button>
          <button className="btn btn-secondary" onClick={minify} style={{ fontSize: 12 }}>
            Minify
          </button>
          <span
            style={{
              fontFamily: 'var(--app-mono)',
              fontSize: 10.5,
              color: validity.err ? '#8a4520' : 'var(--color-accent-700)',
              marginLeft: 'auto',
              textAlign: 'right',
            }}
          >
            {validity.err ? `INVALID ${mode.toUpperCase()}` : validity.empty ? 'AWAITING INPUT' : `VALID ${mode.toUpperCase()}`}
          </span>
        </div>
      </div>

      {(validity.err || fetchError) && (
        <div style={{ margin: '0 12px 12px', padding: '10px 12px', border: '1px solid #b4693f', borderLeft: '3px solid #b4693f', background: '#fdf3ec' }}>
          <div style={{ fontFamily: 'var(--app-mono)', fontSize: 11, letterSpacing: '0.08em', color: '#8a4520' }}>
            {validity.err ? `PARSE ERROR · LINE ${validity.err.line}, COL ${validity.err.col}` : 'FETCH ERROR'}
          </div>
          <div style={{ fontFamily: 'var(--app-mono)', fontSize: 12, lineHeight: 1.5, color: '#6d3a1c', marginTop: 4 }}>
            {validity.err ? validity.err.msg : fetchError}
          </div>
          {validity.err?.snippet && (
            <div style={{ fontFamily: 'var(--app-mono)', fontSize: 12, marginTop: 8, padding: '6px 8px', background: '#fff', border: '1px solid #e9d3c3', color: 'var(--app-ink)', overflowX: 'auto', whiteSpace: 'pre' }}>
              {validity.err.snippet}
            </div>
          )}
        </div>
      )}

      {!validity.err && formatError && (
        <div style={{ margin: '0 12px 12px', padding: '8px 12px', border: '1px solid #b4693f', borderLeft: '3px solid #b4693f', background: '#fdf3ec' }}>
          <div style={{ fontFamily: 'var(--app-mono)', fontSize: 12, color: '#6d3a1c' }}>{formatError}</div>
        </div>
      )}
      </section>
    </>
  )
}
