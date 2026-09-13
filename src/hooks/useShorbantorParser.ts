import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AncestorCrumb,
  FlatNodeView,
  InspectorRow,
  ParseMode,
  ParseStats,
  WorkerRequest,
  WorkerResponse,
} from '../types/schema'

export type ParserStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface UseShorbantorParserResult {
  status: ParserStatus
  progress: number
  loadingNodeCount: number
  error: string | null
  /** Last failure of an individual worker operation; the document stays loaded and usable. */
  opError: string | null
  clearOpError: () => void
  stats: ParseStats | null
  visibleCount: number
  loadFile: (file: File, mode: ParseMode) => void
  toggleExpand: (nodeId: number) => void
  setExpanded: (nodeId: number, expanded: boolean) => void
  expandToDepth: (depth: number) => void
  getVisibleNodes: (start: number, end: number) => Promise<FlatNodeView[]>
  search: (query: string) => Promise<{ matchCount: number; visibleCount: number }>
  getMatchPosition: (matchIndex: number) => Promise<number>
  getNodePosition: (nodeId: number) => Promise<number>
  getInspectorRows: (nodeId: number | null) => Promise<{ rows: InspectorRow[]; title: string }>
  getAncestorChain: (nodeId: number | null) => Promise<AncestorCrumb[]>
  getSubtreeText: (nodeId: number) => Promise<string>
  getValueText: (nodeId: number) => Promise<string>
  getNodePath: (nodeId: number) => Promise<string>
}

/**
 * Owns the parser worker's lifecycle and is the only thing on the main
 * thread that ever talks to it. Every method here is a thin postMessage
 * wrapper — no parsing, indexing, searching, or tree walking happens here.
 */
export function useShorbantorParser(): UseShorbantorParserResult {
  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)
  const pendingRequests = useRef(new Map<number, (msg: WorkerResponse) => void>())

  const [status, setStatus] = useState<ParserStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [loadingNodeCount, setLoadingNodeCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<ParseStats | null>(null)
  const [visibleCount, setVisibleCount] = useState(0)
  const [opError, setOpError] = useState<string | null>(null)

  const clearOpError = useCallback(() => setOpError(null), [])

  useEffect(() => {
    const worker = new Worker(new URL('../workers/parser.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data
      if ('requestId' in msg) {
        const resolve = pendingRequests.current.get(msg.requestId)
        if (resolve) {
          pendingRequests.current.delete(msg.requestId)
          resolve(msg)
        }
      }
      switch (msg.type) {
        case 'PROGRESS':
          setProgress(msg.total > 0 ? Math.min(100, (msg.loaded / msg.total) * 100) : 0)
          setLoadingNodeCount(msg.nodeCount)
          return
        case 'PARSE_COMPLETE':
          setStats(msg.stats)
          setVisibleCount(msg.stats.visibleCount)
          setProgress(100)
          setStatus('ready')
          return
        case 'VISIBLE_RANGE':
        case 'SEARCH_RESULT':
          setVisibleCount(msg.visibleCount)
          return
        case 'VISIBLE_COUNT_CHANGED':
          setVisibleCount(msg.visibleCount)
          return
        case 'ERROR':
          setError(msg.message)
          setStatus('error')
          return
        default:
          return
      }
    }

    worker.onerror = (event) => {
      setError(event.message)
      setStatus('error')
    }

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  const send = useCallback((req: WorkerRequest) => {
    workerRef.current?.postMessage(req)
  }, [])

  /**
   * Resolves with the worker's reply, or with `fallback` if that single request
   * failed. Requests are never left pending: an unsettled promise here shows up
   * as a permanently blank pane or a stuck breadcrumb rather than an error.
   */
  const request = useCallback(
    <T extends WorkerResponse, R>(build: (requestId: number) => WorkerRequest, extract: (msg: T) => R, fallback: R): Promise<R> => {
      return new Promise((resolve) => {
        const requestId = ++requestIdRef.current
        pendingRequests.current.set(requestId, (msg) => {
          if (msg.type === 'REQUEST_FAILED') {
            setOpError(msg.message)
            resolve(fallback)
            return
          }
          resolve(extract(msg as T))
        })
        send(build(requestId))
      })
    },
    [send],
  )

  const loadFile = useCallback(
    (file: File, mode: ParseMode) => {
      setStatus('loading')
      setProgress(0)
      setLoadingNodeCount(0)
      setError(null)
      setOpError(null)
      setStats(null)
      setVisibleCount(0)
      pendingRequests.current.clear()
      send({ type: 'LOAD_FILE', file, mode })
    },
    [send],
  )

  const toggleExpand = useCallback((nodeId: number) => send({ type: 'TOGGLE_EXPAND', nodeId }), [send])
  const setExpanded = useCallback((nodeId: number, expanded: boolean) => send({ type: 'SET_EXPANDED', nodeId, expanded }), [send])
  const expandToDepth = useCallback((depth: number) => send({ type: 'EXPAND_TO_DEPTH', depth }), [send])

  const getVisibleNodes = useCallback(
    (start: number, end: number) =>
      request<Extract<WorkerResponse, { type: 'VISIBLE_RANGE' }>, FlatNodeView[]>(
        (requestId) => ({ type: 'GET_VISIBLE_RANGE', requestId, startIndex: start, endIndex: end }),
        (msg) => msg.nodes,
        [],
      ),
    [request],
  )

  const search = useCallback(
    (query: string) =>
      request<Extract<WorkerResponse, { type: 'SEARCH_RESULT' }>, { matchCount: number; visibleCount: number }>(
        (requestId) => ({ type: 'SET_SEARCH', requestId, query }),
        (msg) => ({ matchCount: msg.matchCount, visibleCount: msg.visibleCount }),
        { matchCount: 0, visibleCount: 0 },
      ),
    [request],
  )

  const getMatchPosition = useCallback(
    (matchIndex: number) =>
      request<Extract<WorkerResponse, { type: 'MATCH_POSITION' }>, number>(
        (requestId) => ({ type: 'GET_MATCH_POSITION', requestId, matchIndex }),
        (msg) => msg.position,
        -1,
      ),
    [request],
  )

  const getNodePosition = useCallback(
    (nodeId: number) =>
      request<Extract<WorkerResponse, { type: 'NODE_POSITION' }>, number>(
        (requestId) => ({ type: 'GET_NODE_POSITION', requestId, nodeId }),
        (msg) => msg.position,
        -1,
      ),
    [request],
  )

  const getInspectorRows = useCallback(
    (nodeId: number | null) =>
      request<Extract<WorkerResponse, { type: 'INSPECTOR_ROWS' }>, { rows: InspectorRow[]; title: string }>(
        (requestId) => ({ type: 'GET_INSPECTOR_ROWS', requestId, nodeId }),
        (msg) => ({ rows: msg.rows, title: msg.title }),
        { rows: [], title: '—' },
      ),
    [request],
  )

  const getAncestorChain = useCallback(
    (nodeId: number | null) =>
      request<Extract<WorkerResponse, { type: 'ANCESTOR_CHAIN' }>, AncestorCrumb[]>(
        (requestId) => ({ type: 'GET_ANCESTOR_CHAIN', requestId, nodeId }),
        (msg) => msg.crumbs,
        [],
      ),
    [request],
  )

  const getSubtreeText = useCallback(
    (nodeId: number) =>
      request<Extract<WorkerResponse, { type: 'SUBTREE_TEXT' }>, string>(
        (requestId) => ({ type: 'GET_SUBTREE_TEXT', requestId, nodeId }),
        (msg) => msg.text,
        '',
      ),
    [request],
  )

  const getValueText = useCallback(
    (nodeId: number) =>
      request<Extract<WorkerResponse, { type: 'VALUE_TEXT' }>, string>(
        (requestId) => ({ type: 'GET_VALUE_TEXT', requestId, nodeId }),
        (msg) => msg.text,
        '',
      ),
    [request],
  )

  const getNodePath = useCallback(
    (nodeId: number) =>
      request<Extract<WorkerResponse, { type: 'NODE_PATH' }>, string>(
        (requestId) => ({ type: 'GET_NODE_PATH', requestId, nodeId }),
        (msg) => msg.path,
        '',
      ),
    [request],
  )

  return {
    status,
    progress,
    loadingNodeCount,
    error,
    opError,
    clearOpError,
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
  }
}
