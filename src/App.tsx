import { useCallback, useEffect, useRef, useState } from 'react'
import AppHeader from './components/AppHeader'
import LoadingIndicator from './components/LoadingIndicator'
import NodeInspector from './components/NodeInspector'
import RawInputPane from './components/RawInputPane'
import StatusFooter from './components/StatusFooter'
import Toast, { type ToastState } from './components/Toast'
import TreeViewer from './components/TreeViewer'
import { useShorbantorParser } from './hooks/useShorbantorParser'
import { prettyPrint } from './lib/format'
import { applyTheme, type Theme } from './lib/theme'
import type { AncestorCrumb, FlatNodeView, InspectorRow, ParseMode } from './types/schema'

export default function App() {
  const [mode, setMode] = useState<ParseMode>('json')
  const [currentFile, setCurrentFile] = useState<File | null>(null)
  const [rawText, setRawText] = useState('')
  const [theme, setTheme] = useState<Theme>('light')
  const [paneOpen, setPaneOpen] = useState(true)
  const [narrow, setNarrow] = useState(false)

  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [matchIdx, setMatchIdx] = useState(0)
  const [jumpToIndex, setJumpToIndex] = useState<{ index: number; token: number } | null>(null)

  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [hoveredPath, setHoveredPath] = useState<string | null>(null)

  const [crumbs, setCrumbs] = useState<AncestorCrumb[]>([{ id: -1, label: 'root' }])
  const [inspectorRows, setInspectorRows] = useState<InspectorRow[]>([])
  const [inspectorTitle, setInspectorTitle] = useState('—')
  const [inspectorEmptyLabel, setInspectorEmptyLabel] = useState('Nothing parsed yet.')

  const [toast, setToast] = useState<ToastState | null>(null)
  const toastTimerRef = useRef<number | undefined>(undefined)

  const {
    status,
    progress,
    loadingNodeCount,
    error,
    stats,
    visibleCount,
    loadFile,
    toggleExpand,
    setExpanded,
    expandToDepth,
    getVisibleNodes,
    search,
    getMatchPosition,
    getNodePosition,
    getInspectorRows,
    getAncestorChain,
    getSubtreeText,
    getValueText,
    getNodePath,
  } = useShorbantorParser()

  const showToast = useCallback((msg: string, kind: ToastState['kind'] = 'ok') => {
    window.clearTimeout(toastTimerRef.current)
    setToast({ msg, kind })
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2200)
  }, [])

  const copy = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text)
        showToast(`${label} copied`)
      } catch {
        showToast('Clipboard unavailable', 'err')
      }
    },
    [showToast],
  )

  // ---- loading -------------------------------------------------------------

  const beginLoad = useCallback(
    (file: File, loadMode: ParseMode) => {
      setCurrentFile(file)
      setSelectedNodeId(null)
      setSelectedPath(null)
      setQuery('')
      setMatchIdx(0)
      loadFile(file, loadMode)
    },
    [loadFile],
  )

  const handleLoadText = useCallback(
    (text: string, textMode: ParseMode) => {
      const file = new File([text], `pasted.${textMode}`, { type: textMode === 'json' ? 'application/json' : 'application/xml' })
      setMode(textMode)
      beginLoad(file, textMode)
    },
    [beginLoad],
  )

  const handleModeChange = useCallback(
    (newMode: ParseMode) => {
      if (newMode === mode) return
      setMode(newMode)
      if (currentFile) {
        beginLoad(new File([currentFile], currentFile.name, { type: newMode === 'json' ? 'application/json' : 'application/xml' }), newMode)
      }
    },
    [mode, currentFile, beginLoad],
  )

  useEffect(() => {
    applyTheme('light')
  }, [])

  // Small delay avoids a loader flash on quick, small-file loads — it only
  // ever shows once a parse has genuinely been running for a moment.
  const [showLoader, setShowLoader] = useState(false)
  useEffect(() => {
    if (status !== 'loading') {
      setShowLoader(false)
      return
    }
    const t = window.setTimeout(() => setShowLoader(true), 200)
    return () => window.clearTimeout(t)
  }, [status])

  // ---- header actions (operate on the whole loaded document) ---------------

  const handleCopyRaw = useCallback(async () => {
    if (!currentFile) return
    copy(await currentFile.text(), 'Raw document')
  }, [currentFile, copy])

  const handleDownload = useCallback(() => {
    if (!currentFile) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(currentFile)
    a.download = currentFile.name || `shorbantor.${mode}`
    a.click()
    showToast('Download started')
  }, [currentFile, mode, showToast])

  const handlePrettify = useCallback(async () => {
    if (!currentFile) return
    try {
      const text = await currentFile.text()
      const out = prettyPrint(text, mode)
      const file = new File([out], currentFile.name, { type: currentFile.type })
      beginLoad(file, mode)
      showToast('Formatted')
    } catch {
      showToast('Cannot format — fix the parse error first', 'err')
    }
  }, [currentFile, mode, beginLoad, showToast])

  const handleClear = useCallback(() => {
    const file = new File([''], `empty.${mode}`, { type: mode === 'json' ? 'application/json' : 'application/xml' })
    beginLoad(file, mode)
    setCurrentFile(null)
    setRawText('')
    showToast('Cleared')
  }, [mode, beginLoad, showToast])

  const handleToggleTheme = useCallback(() => {
    const next: Theme = theme === 'light' ? 'dark' : 'light'
    applyTheme(next)
    setTheme(next)
  }, [theme])

  // ---- selection / breadcrumb / inspector -----------------------------------

  const handleSelect = useCallback(
    (node: FlatNodeView) => {
      setSelectedNodeId(node.id)
      setSelectedPath(node.path)
      if (node.isContainer) toggleExpand(node.id)
    },
    [toggleExpand],
  )

  const inspectorTargetId = selectedNodeId ?? stats?.rootId ?? null

  useEffect(() => {
    if (status !== 'ready') return
    let cancelled = false
    getAncestorChain(selectedNodeId).then((c) => !cancelled && setCrumbs(c))
    getInspectorRows(selectedNodeId).then(({ rows, title }) => {
      if (cancelled) return
      setInspectorRows(rows)
      setInspectorTitle(title)
      if (rows.length === 0) {
        const targetId = selectedNodeId ?? stats?.rootId ?? null
        if (targetId === null) setInspectorEmptyLabel('Nothing parsed yet.')
        else getValueText(targetId).then((v) => !cancelled && setInspectorEmptyLabel(`Leaf node — no children.\nValue: ${v}`))
      }
    })
    return () => {
      cancelled = true
    }
  }, [selectedNodeId, status, stats, getAncestorChain, getInspectorRows, getValueText])

  const handleInspectorRowClick = useCallback(
    async (childId: number) => {
      if (inspectorTargetId !== null) setExpanded(inspectorTargetId, true)
      setExpanded(childId, true)
      setSelectedNodeId(childId)
      setSelectedPath(await getNodePath(childId))
    },
    [inspectorTargetId, setExpanded, getNodePath],
  )

  const handleCopySelectedPath = useCallback(() => copy(selectedPath ?? '$', 'Path'), [selectedPath, copy])

  const handleCopyInspectorSubtree = useCallback(() => {
    if (inspectorTargetId === null) return
    getSubtreeText(inspectorTargetId).then((text) => copy(text, 'Sub-tree'))
  }, [inspectorTargetId, getSubtreeText, copy])

  const handleRowCopyPath = useCallback((node: FlatNodeView) => copy(node.path, 'Path'), [copy])
  const handleRowCopySubtree = useCallback((node: FlatNodeView) => getSubtreeText(node.id).then((text) => copy(text, 'Sub-tree')), [getSubtreeText, copy])
  const handleRowCopyValue = useCallback((node: FlatNodeView) => getValueText(node.id).then((text) => copy(text, 'Value')), [getValueText, copy])

  // ---- search ----------------------------------------------------------------

  useEffect(() => {
    if (status !== 'ready') return
    let cancelled = false
    const t = window.setTimeout(() => {
      search(query).then(({ matchCount: c }) => {
        if (!cancelled) {
          setMatchCount(c)
          setMatchIdx(0)
        }
      })
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [query, status, search])

  const jump = useCallback(
    async (dir: 1 | -1) => {
      if (matchCount === 0) return
      const next = (matchIdx + dir + matchCount) % matchCount
      setMatchIdx(next)
      const position = await getMatchPosition(next)
      if (position >= 0) setJumpToIndex({ index: position, token: Date.now() })
    },
    [matchIdx, matchCount, getMatchPosition],
  )

  const matchLabel = query.trim() ? (matchCount ? `${Math.min(matchIdx + 1, matchCount)}/${matchCount}` : 'NO MATCHES') : ''

  const handleSelectCrumb = useCallback(
    async (nodeId: number) => {
      setSelectedNodeId(nodeId)
      setSelectedPath(await getNodePath(nodeId))
      const position = await getNodePosition(nodeId)
      if (position >= 0) setJumpToIndex({ index: position, token: Date.now() })
    },
    [getNodePath, getNodePosition],
  )

  // ---- keyboard shortcuts + responsive ---------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        // The raw-input maximize view has its own search field; while it's open
        // that's what ⌘F should reach, not the tree filter behind it.
        const rawSearch = document.getElementById('sb-raw-search') as HTMLInputElement | null
        ;(rawSearch ?? document.getElementById('sb-search'))?.focus()
        return
      }
      if (typing) return
      // Only bare key presses trigger these — otherwise Cmd/Ctrl+C (copy) or
      // Cmd/Ctrl+E collapsed or expanded the whole tree out from under a copy.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.toLowerCase() === 'e') expandToDepth(Number.POSITIVE_INFINITY)
      else if (e.key.toLowerCase() === 'c') expandToDepth(0)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [expandToDepth])

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1100)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // ---- footer labels -----------------------------------------------------

  const modeLabel = `${mode.toUpperCase()} MODE`
  const nodeLabel = stats ? `${stats.totalNodes.toLocaleString()} NODES · ${visibleCount.toLocaleString()} ROWS VISIBLE` : '0 NODES · 0 ROWS VISIBLE'
  const depthLabel = `MAX DEPTH ${stats?.maxDepth ?? 0}`
  const parseLabel = `PARSED IN ${stats?.elapsedMs.toFixed(1) ?? '0.0'} MS`

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--app-bg)', color: 'var(--app-ink)', fontFamily: 'var(--font-body)', overflow: 'hidden' }}>
      <AppHeader
        mode={mode}
        onModeChange={handleModeChange}
        onPrettify={handlePrettify}
        onCopyRaw={handleCopyRaw}
        onDownload={handleDownload}
        onClear={handleClear}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        paneOpen={paneOpen}
        onTogglePane={() => setPaneOpen((v) => !v)}
        onExpandAll={() => expandToDepth(Number.POSITIVE_INFINITY)}
        onCollapseAll={() => expandToDepth(0)}
        query={query}
        onQueryChange={setQuery}
        matchLabel={matchLabel}
        onPrevMatch={() => jump(-1)}
        onNextMatch={() => jump(1)}
        crumbs={crumbs}
        onCopyCrumbPath={handleCopySelectedPath}
        onSelectCrumb={handleSelectCrumb}
      />

      <main style={{ flex: '1 1 auto', display: 'flex', minHeight: 0 }}>
        <RawInputPane
          paneOpen={paneOpen}
          mode={mode}
          value={rawText}
          onChange={setRawText}
          onLoadText={handleLoadText}
          onCopy={copy}
          parseError={status === 'error' ? error : null}
        />

        <section style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--app-surface)' }}>
          <div style={{ flex: '1 1 auto', display: 'flex', minHeight: 0 }}>
            {status === 'loading' && showLoader ? (
              <LoadingIndicator progress={progress} nodeCount={loadingNodeCount} />
            ) : status === 'error' ? (
              <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--app-muted)', fontFamily: 'var(--app-mono)', fontSize: 12 }}>
                {error}
              </div>
            ) : (
              <TreeViewer
                visibleCount={visibleCount}
                getVisibleNodes={getVisibleNodes}
                onToggle={toggleExpand}
                selectedNodeId={selectedNodeId}
                onSelect={handleSelect}
                hoveredPath={hoveredPath}
                onHoverChange={setHoveredPath}
                onCopyPath={handleRowCopyPath}
                onCopySubtree={handleRowCopySubtree}
                onCopyValue={handleRowCopyValue}
                jumpToIndex={jumpToIndex}
              />
            )}

            {!narrow && (
              <NodeInspector
                title={inspectorTitle}
                rows={inspectorRows}
                emptyLabel={inspectorEmptyLabel}
                onRowClick={handleInspectorRowClick}
                onCopyPath={handleCopySelectedPath}
                onCopySubtree={handleCopyInspectorSubtree}
              />
            )}
          </div>

          <StatusFooter modeLabel={modeLabel} nodeLabel={nodeLabel} depthLabel={depthLabel} parseLabel={parseLabel} showHint={!narrow} />
        </section>
      </main>

      <Toast toast={toast} />
    </div>
  )
}
