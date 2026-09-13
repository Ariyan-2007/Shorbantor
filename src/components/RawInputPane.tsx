import { type ChangeEvent, type DragEvent, type KeyboardEvent, type UIEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { minifyText, prettyPrint } from '../lib/format'
import { highlightRaw } from '../lib/highlight'
import type { ParseMode } from '../types/schema'
import { IconChevronDown, IconChevronUp, IconCollapse, IconCopy, IconExpand, IconSearch } from './icons'

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
  /** Whether the "Show input" sidebar is toggled on. The pane stays mounted regardless — see the note above sectionStyle. */
  paneOpen: boolean
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

export default function RawInputPane({ paneOpen, mode, value, onChange, onLoadText, onCopy, parseError }: RawInputPaneProps) {
  const [url, setUrl] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [formatError, setFormatError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  // Search within the maximized raw view only — independent of the tree
  // filter, since a huge pasted document is exactly where jumping around the
  // raw text by hand becomes painful.
  const [rawQuery, setRawQuery] = useState('')
  const [rawMatchIdx, setRawMatchIdx] = useState(0)
  const searchHighlightRef = useRef<HTMLDivElement>(null)

  // "Hide input" collapses the sidebar; if the maximize view happened to be
  // open, take it down too rather than leaving a fullscreen overlay orphaned
  // behind a header button that no longer looks like it controls anything.
  useEffect(() => {
    if (!paneOpen) setExpanded(false)
  }, [paneOpen])

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // First Escape clears an active search; only the next one closes the view.
      if (rawQuery) {
        setRawQuery('')
        return
      }
      setExpanded(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [expanded, rawQuery])

  // Typing updates `value` at once so the textarea always stays responsive;
  // the expensive derived work below runs against the deferred copy at lower
  // priority and React can abandon it mid-flight when the next keystroke lands.
  const deferredValue = useDeferredValue(value)

  const bytes = useMemo(() => utf8Length(deferredValue), [deferredValue])
  const sizeLabel = bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`

  // Plain indexOf loop rather than a regex — the query is arbitrary user text,
  // not a pattern, so it must never be interpreted as one.
  const rawMatches = useMemo(() => {
    if (!rawQuery) return [] as { start: number; end: number }[]
    const q = rawQuery.toLowerCase()
    const lower = deferredValue.toLowerCase()
    const out: { start: number; end: number }[] = []
    let i = 0
    while (i <= lower.length - q.length) {
      const idx = lower.indexOf(q, i)
      if (idx < 0) break
      out.push({ start: idx, end: idx + q.length })
      i = idx + q.length
    }
    return out
  }, [deferredValue, rawQuery])

  const activeRawMatch = rawMatches.length > 0 ? ((rawMatchIdx % rawMatches.length) + rawMatches.length) % rawMatches.length : -1
  const rawMatchLabel = rawQuery ? (rawMatches.length ? `${activeRawMatch + 1}/${rawMatches.length}` : 'NO MATCHES') : ''

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

  /**
   * A second backdrop layered between the syntax colors and the (transparent)
   * textarea: non-match text is fully transparent so the colors underneath
   * show through untouched, and only matched spans paint an opaque highlight
   * over them — the same "found text" look as a code editor's find widget.
   * It shares the token backdrop's exact font/padding/wrap so both stay
   * pixel-aligned to the same text.
   */
  const rawSearchSegments = useMemo(() => {
    if (!expanded || !rawQuery || highlightTooBig || rawMatches.length === 0) return null
    const segs: { text: string; kind: 'plain' | 'match' | 'current' }[] = []
    let cursor = 0
    rawMatches.forEach((m, i) => {
      if (m.start > cursor) segs.push({ text: deferredValue.slice(cursor, m.start), kind: 'plain' })
      segs.push({ text: deferredValue.slice(m.start, m.end), kind: i === activeRawMatch ? 'current' : 'match' })
      cursor = m.end
    })
    if (cursor < deferredValue.length) segs.push({ text: deferredValue.slice(cursor), kind: 'plain' })
    return segs
  }, [expanded, rawQuery, highlightTooBig, rawMatches, activeRawMatch, deferredValue])

  const syncHighlightScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    const top = e.currentTarget.scrollTop
    const left = e.currentTarget.scrollLeft
    if (highlightRef.current) {
      highlightRef.current.scrollTop = top
      highlightRef.current.scrollLeft = left
    }
    if (searchHighlightRef.current) {
      searchHighlightRef.current.scrollTop = top
      searchHighlightRef.current.scrollLeft = left
    }
  }

  useEffect(() => {
    setRawMatchIdx(0)
  }, [rawQuery])

  // Marks the active match on the real textarea's selection (so it's already
  // there if the user tabs over — copy, further edits, everything works on
  // real text) and scrolls it into view, without moving keyboard focus off
  // the search field. Deliberately mirrors a browser's own find bar: typing
  // and Enter/next/prev all keep focus in the search input, never the
  // document, while the overlay below paints the highlight in sync.
  useEffect(() => {
    if (activeRawMatch < 0) return
    const m = rawMatches[activeRawMatch]
    const ta = taRef.current
    if (!ta || !m) return
    ta.setSelectionRange(m.start, m.end)
    const lineHeight = expanded ? 14.5 * 1.8 : 12.5 * 1.65
    const line = deferredValue.slice(0, m.start).split('\n').length - 1
    ta.scrollTop = Math.max(0, line * lineHeight - ta.clientHeight / 2)
    ta.dispatchEvent(new Event('scroll'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRawMatch, rawMatches])

  const gotoNextRawMatch = () => setRawMatchIdx((i) => i + 1)
  const gotoPrevRawMatch = () => setRawMatchIdx((i) => i - 1)

  const handleRawSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (e.shiftKey) gotoPrevRawMatch()
    else gotoNextRawMatch()
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
        // Hidden via display rather than by unmounting the pane (App.tsx keeps
        // it mounted across "Hide input" toggles) — an unmount would drop
        // lastLoadedRef and every other bit of local state, which previously
        // made toggling the pane back on look like a fresh paste and re-parse
        // the whole document from scratch.
        display: paneOpen ? 'flex' : 'none',
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

      {expanded && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px 8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flex: '1 1 auto', background: 'var(--app-surface)', border: '1px solid var(--app-line)', borderRadius: 'var(--radius-md)', padding: '0 8px' }}>
            <IconSearch size={14} />
            <input
              id="sb-raw-search"
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              onKeyDown={handleRawSearchKey}
              placeholder="Search this raw text   ⌘F"
              style={{ flex: '1 1 auto', border: 0, background: 'transparent', outline: 'none', fontFamily: 'var(--app-mono)', fontSize: 12, color: 'var(--app-ink)', padding: '6px 0' }}
            />
            <span style={{ fontFamily: 'var(--app-mono)', fontSize: 10.5, color: 'var(--app-muted)', whiteSpace: 'nowrap' }}>{rawMatchLabel}</span>
            {rawQuery && (
              <button
                onClick={() => setRawQuery('')}
                title="Clear search"
                aria-label="Clear search"
                style={{ border: 0, background: 'transparent', color: 'var(--app-muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '2px 2px' }}
              >
                ×
              </button>
            )}
          </div>
          <button className="btn btn-secondary btn-icon" title="Previous match" onClick={gotoPrevRawMatch} style={{ width: 26, height: 26 }}>
            <IconChevronUp size={13} />
          </button>
          <button className="btn btn-secondary btn-icon" title="Next match" onClick={gotoNextRawMatch} style={{ width: 26, height: 26 }}>
            <IconChevronDown size={13} />
          </button>
        </div>
      )}

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
          {rawSearchSegments && (
            <div
              ref={searchHighlightRef}
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
                color: 'transparent',
              }}
            >
              {rawSearchSegments.map((seg, i) =>
                seg.kind === 'plain' ? (
                  seg.text
                ) : (
                  <span
                    key={i}
                    style={{
                      background: seg.kind === 'current' ? 'var(--color-accent-400)' : 'color-mix(in srgb, var(--color-accent-400) 40%, transparent)',
                      color: 'var(--app-ink)',
                      borderRadius: 2,
                    }}
                  >
                    {seg.text}
                  </span>
                ),
              )}
            </div>
          )}
          <textarea
            className="sb-ta"
            ref={taRef}
            defaultValue={value}
            onChange={handleChange}
            onBlur={handleBlurCommit}
            onScroll={segments || rawSearchSegments ? syncHighlightScroll : undefined}
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
