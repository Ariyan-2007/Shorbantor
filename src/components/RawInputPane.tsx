import { type ChangeEvent, type DragEvent, useMemo, useState } from 'react'
import type { ParseMode } from '../types/schema'

interface ErrorInfo {
  msg: string
  line: number
  col: number
  snippet: string
}

interface RawInputPaneProps {
  mode: ParseMode
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

export default function RawInputPane({ mode, onLoadText }: RawInputPaneProps) {
  const [raw, setRaw] = useState('')
  const [url, setUrl] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const validity = useMemo(() => {
    if (!raw.trim()) return { err: null as ErrorInfo | null, empty: true }
    try {
      if (mode === 'json') JSON.parse(raw)
      else {
        const doc = new DOMParser().parseFromString(raw, 'application/xml')
        const pe = doc.querySelector('parsererror')
        if (pe) throw new Error(pe.textContent?.replace(/\s+/g, ' ').trim().slice(0, 180) ?? 'Malformed XML')
      }
      return { err: null as ErrorInfo | null, empty: false }
    } catch (e) {
      return { err: errInfo(e, raw), empty: false }
    }
  }, [raw, mode])

  const bytes = new Blob([raw]).size
  const sizeLabel = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`

  const commit = (text: string) => {
    setRaw(text)
    if (text.trim()) onLoadText(text, mode)
  }

  const prettify = () => {
    try {
      if (mode === 'json') setRaw(JSON.stringify(JSON.parse(raw), null, 2))
      else {
        let out = ''
        let d = 0
        raw
          .replace(/>\s*</g, '><')
          .replace(/</g, '\n<')
          .split('\n')
          .filter(Boolean)
          .forEach((t) => {
            if (/^<\//.test(t)) d--
            out += '  '.repeat(Math.max(0, d)) + t + '\n'
            if (/^<[^!?/][^>]*[^/]>/.test(t) && !/<\/.+>$/.test(t)) d++
          })
        setRaw(out.trim())
      }
    } catch {
      // Formatting is opportunistic — leave raw untouched on invalid input.
    }
  }

  const minify = () => {
    try {
      if (mode === 'json') setRaw(JSON.stringify(JSON.parse(raw)))
      else setRaw(raw.replace(/>\s+</g, '><').trim())
    } catch {
      // Minifying is opportunistic — leave raw untouched on invalid input.
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

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => setRaw(e.target.value)
  const handleBlurCommit = () => {
    if (raw.trim()) onLoadText(raw, mode)
  }

  return (
    <section style={{ flex: '0 0 380px', display: 'flex', flexDirection: 'column', minWidth: 0, borderRight: '1px solid var(--app-line)', background: 'var(--app-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 8px' }}>
        <h6 style={{ margin: 0, fontSize: 11, letterSpacing: '0.1em' }}>Raw input</h6>
        <span style={{ fontFamily: 'var(--app-mono)', fontSize: 10.5, color: 'var(--app-muted)', marginLeft: 'auto' }}>{sizeLabel}</span>
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
          value={raw}
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
            fontSize: 12.5,
            lineHeight: 1.65,
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
    </section>
  )
}
