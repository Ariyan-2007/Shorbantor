import { type ChangeEvent, type DragEvent, type UIEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { minifyText, prettyPrint } from '../lib/format'
import { highlightRaw } from '../lib/highlight'
import type { ParseMode } from '../types/schema'
import { IconCollapse, IconCopy, IconExpand } from './icons'

/**
 * Above this, the syntax-highlight backdrop is dropped and the textarea renders
 * plain text. highlightRaw() emits one React element per token, so a 1.5 MB
 * payload became ~250k DOM nodes — tens of MB of DOM, seconds of reconciliation
 * on every keystroke, and in practice a hung or crashed tab. Editing, parsing
 * and the tree view are unaffected; only the colored backdrop turns off.
 */
const HIGHLIGHT_MAX_BYTES = 128 * 1024

/**
 * Above this, the pane stops running its own JSON.parse/DOMParser pass and
 * reports whatever the worker's streaming parse found instead. The pane's parse
 * exists purely to put a line/column on an error — it is redundant with the
 * worker for everything else, and at multi-MB sizes it is a full second parse
 * (plus, for XML, a whole throwaway DOM) on the UI thread.
 */
const VALIDATE_MAX_BYTES = 2 * 1024 * 1024

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
  onCopy: (text: string, label: string) => void
  /** Parse failure reported by the worker, used when the text is too large to re-validate here. */
  parseError: string | null
}

/** FNV-1a over the text, so the "already loaded this" check costs 4 bytes instead of a full copy. */
function hashText(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Exact UTF-8 byte count. Blob is the fastest exact option a browser offers
 * (a hand-rolled charCodeAt loop measured slower), so the fix for the original
 * cost is not a different algorithm but calling it far less: this now runs off
 * the deferred value and memoized, rather than on every single render.
 */
function utf8Length(s: string): number {
  return new Blob([s]).size
}

/**
 * Picks the format from the first meaningful character instead of parsing the
 * document twice to find out. '<' can only start XML; '{' and '[' can only
 * start JSON. Anything else (a bare string or number) keeps the current mode,
 * which is what a full-parse probe concluded anyway.
 */
function sniffMode(text: string, fallback: ParseMode): ParseMode {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 32 || c === 9 || c === 10 || c === 13) continue
    if (c === 60) return 'xml'
    if (c === 123 || c === 91) return 'json'
    return fallback
  }
  return fallback
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

function tryParse(text: string, m: ParseMode): ErrorInfo | null {
  try {
    if (m === 'json') {
      JSON.parse(text)
    } else {
      const doc = new DOMParser().parseFromString(text, 'application/xml')
      const pe = doc.querySelector('parsererror')
      if (pe) throw new Error(pe.textContent?.replace(/\s+/g, ' ').trim().slice(0, 180) ?? 'Malformed XML')
    }
    return null
  } catch (e) {
    return errInfo(e, text)
  }
}

export default function RawInputPane({ mode, value, onChange, onLoadText, onCopy, parseError }: RawInputPaneProps) {
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

  // Typing updates `value` at once so the textarea always stays responsive;
  // the expensive derived work below runs against the deferred copy at lower
  // priority and React can abandon it mid-flight when the next keystroke lands.
  const deferredValue = useDeferredValue(value)

  const bytes = useMemo(() => utf8Length(deferredValue), [deferredValue])
  const sizeLabel = bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`

  const validity = useMemo(() => {
    if (!deferredValue.trim()) return { err: null as ErrorInfo | null, empty: true, effectiveMode: mode, checked: true }
    const effectiveMode = sniffMode(deferredValue, mode)
    if (bytes > VALIDATE_MAX_BYTES) {
      // Too large to re-parse here; the worker already told us whether it parsed.
      const err = parseError ? { msg: parseError, line: 0, col: 0, snippet: '' } : null
      return { err, empty: false, effectiveMode, checked: false }
    }
    return { err: tryParse(deferredValue, effectiveMode), empty: false, effectiveMode, checked: true }
  }, [deferredValue, mode, parseError, bytes])

  const lastLoadedRef = useRef<string | null>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  /**
   * The textarea is deliberately uncontrolled. A controlled one re-assigns
   * .value on every render, and assigning a multi-megabyte string forces the
   * browser to re-lay-out the entire document's text. Letting the DOM own the
   * text means typing costs only an incremental edit.
   *
   * Comparing against what the element currently holds is the whole guard:
   * while typing, the DOM already has exactly `value`, so nothing is written;
   * any update from elsewhere (prettify, minify, fetch, drop, clear) differs
   * and is written through. An earlier version also tracked the last typed
   * string and skipped writes matching it, which silently dropped legitimate
   * updates that happened to reproduce previously typed text — minifying
   * already-minified input, or re-dropping a file after Clear.
   */
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    if (el.value !== value) el.value = value
  }, [value])

  // Syntax highlighting is only rendered in the expanded view — it sits as a
  // backdrop behind a transparent-text textarea so typing/selection stay native.
  const highlightTooBig = bytes > HIGHLIGHT_MAX_BYTES
  const segments = useMemo(
    () => (expanded && !highlightTooBig ? highlightRaw(deferredValue, validity.effectiveMode) : null),
    [expanded, highlightTooBig, deferredValue, validity.effectiveMode],
  )

  const syncHighlightScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    if (!highlightRef.current) return
    highlightRef.current.scrollTop = e.currentTarget.scrollTop
    highlightRef.current.scrollLeft = e.currentTarget.scrollLeft
  }

  // Identify what was last loaded by a hash rather than by the text itself —
  // the old key held a second full copy of the document alive for the lifetime
  // of the pane, doubling the resident cost of every paste.
  const load = (text: string, loadMode: ParseMode) => {
    const key = `${loadMode}:${text.length}:${hashText(text)}`
    if (lastLoadedRef.current === key) return
    lastLoadedRef.current = key
    onLoadText(text, loadMode)
  }

  const commit = (text: string) => {
    onChange(text)
    if (text.trim()) load(text, sniffMode(text, mode))
  }

  // Auto-display as the user types — no need to blur or press Prettify.
  // An empty box clears the tree immediately (and resets the dedupe key so a
  // subsequent paste — even one identical to what was cleared — always reloads).
  useEffect(() => {
    if (!value.trim()) {
      if (lastLoadedRef.current !== null) load('', mode)
      return
    }
    const t = window.setTimeout(() => load(value, validity.effectiveMode), 350)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, validity.effectiveMode, mode])

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
    if (value.trim()) load(value, validity.effectiveMode)
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
        {expanded && (
          <button
            className="btn btn-secondary btn-icon"
            title={`Copy ${mode.toUpperCase()}`}
            aria-label={`Copy raw ${mode.toUpperCase()}`}
            onClick={() => onCopy(value, 'Raw input')}
            disabled={!value.trim()}
            style={{ width: 26, height: 26 }}
          >
            <IconCopy size={13} />
          </button>
        )}
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
        <div style={{ position: 'relative', flex: '1 1 auto', minHeight: 0 }}>
          {segments && (
            <div
              ref={highlightRef}
              aria-hidden="true"
              style={{
                position: 'absolute',
                inset: 0,
                margin: 0,
                overflow: 'auto',
                pointerEvents: 'none',
                padding: 12,
                fontFamily: 'var(--app-mono)',
                fontSize: 14.5,
                lineHeight: 1.8,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                tabSize: 2,
              }}
            >
              {segments.map((seg, i) => (seg.color ? <span key={i} style={{ color: seg.color }}>{seg.text}</span> : seg.text))}
            </div>
          )}
          <textarea
            className="sb-ta"
            ref={taRef}
            defaultValue={value}
            onChange={handleChange}
            onBlur={handleBlurCommit}
            onScroll={segments ? syncHighlightScroll : undefined}
            spellCheck={false}
            placeholder="Paste JSON or XML — or drop a file here"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              resize: 'none',
              border: 0,
              outline: 'none',
              background: 'transparent',
              padding: 12,
              fontFamily: 'var(--app-mono)',
              fontSize: expanded ? 14.5 : 12.5,
              lineHeight: expanded ? 1.8 : 1.65,
              color: segments ? 'transparent' : 'var(--app-ink)',
              caretColor: 'var(--app-ink)',
              tabSize: 2,
            }}
          />
        </div>
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
            {validity.err
              ? `INVALID ${mode.toUpperCase()}`
              : validity.empty
                ? 'AWAITING INPUT'
                : validity.effectiveMode !== mode
                  ? `DETECTED ${validity.effectiveMode.toUpperCase()}`
                  : validity.checked
                    ? `VALID ${mode.toUpperCase()}`
                    : `PARSED ${validity.effectiveMode.toUpperCase()}`}
          </span>
        </div>
        {highlightTooBig && expanded && (
          <div style={{ padding: '0 10px 8px', fontFamily: 'var(--app-mono)', fontSize: 10.5, color: 'var(--app-muted)' }}>
            SYNTAX COLORING OFF ABOVE {HIGHLIGHT_MAX_BYTES / 1024} KB — EDITING AND THE TREE ARE UNAFFECTED
          </div>
        )}
      </div>

      {(validity.err || fetchError) && (
        <div style={{ margin: '0 12px 12px', padding: '10px 12px', border: '1px solid #b4693f', borderLeft: '3px solid #b4693f', background: '#fdf3ec' }}>
          <div style={{ fontFamily: 'var(--app-mono)', fontSize: 11, letterSpacing: '0.08em', color: '#8a4520' }}>
            {validity.err
              ? validity.checked
                ? `PARSE ERROR · LINE ${validity.err.line}, COL ${validity.err.col}`
                : 'PARSE ERROR'
              : 'FETCH ERROR'}
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
