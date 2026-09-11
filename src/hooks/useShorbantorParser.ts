import { useCallback, useEffect, useRef, useState } from 'react'
import type { FlatNodeView, ParseMode, ParseStats, WorkerRequest, WorkerResponse } from '../types/schema'

export type ParserStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface UseShorbantorParserResult {
  status: ParserStatus
  progress: number
  error: string | null
  stats: ParseStats | null
  visibleCount: number
  loadFile: (file: File, mode: ParseMode) => void
  toggleExpand: (nodeId: number) => void
  expandToDepth: (depth: number) => void
  getVisibleNodes: (start: number, end: number) => Promise<FlatNodeView[]>
}

/**
 * Owns the parser worker's lifecycle and is the only thing on the main
 * thread that ever talks to it. Every method here is a thin postMessage
 * wrapper — no parsing, indexing, or tree walking happens in this hook.
 */
export function useShorbantorParser(): UseShorbantorParserResult {
  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)
  const pendingRequests = useRef(new Map<number, (nodes: FlatNodeView[]) => void>())

  const [status, setStatus] = useState<ParserStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<ParseStats | null>(null)
  const [visibleCount, setVisibleCount] = useState(0)

  useEffect(() => {
    const worker = new Worker(new URL('../workers/parser.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data
      switch (msg.type) {
        case 'PROGRESS':
          setProgress(msg.total > 0 ? Math.min(100, (msg.loaded / msg.total) * 100) : 0)
          return
        case 'PARSE_COMPLETE':
          setStats(msg.stats)
          setVisibleCount(msg.stats.visibleCount)
          setProgress(100)
          setStatus('ready')
          return
        case 'VISIBLE_RANGE': {
          const resolve = pendingRequests.current.get(msg.requestId)
          if (resolve) {
            pendingRequests.current.delete(msg.requestId)
            resolve(msg.nodes)
          }
          setVisibleCount(msg.visibleCount)
          return
        }
        case 'VISIBLE_COUNT_CHANGED':
          setVisibleCount(msg.visibleCount)
          return
        case 'ERROR':
          setError(msg.message)
          setStatus('error')
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

  const loadFile = useCallback((file: File, mode: ParseMode) => {
    setStatus('loading')
    setProgress(0)
    setError(null)
    setStats(null)
    setVisibleCount(0)
    pendingRequests.current.clear()
    const req: WorkerRequest = { type: 'LOAD_FILE', file, mode }
    workerRef.current?.postMessage(req)
  }, [])

  const toggleExpand = useCallback((nodeId: number) => {
    const req: WorkerRequest = { type: 'TOGGLE_EXPAND', nodeId }
    workerRef.current?.postMessage(req)
  }, [])

  const expandToDepth = useCallback((depth: number) => {
    const req: WorkerRequest = { type: 'EXPAND_TO_DEPTH', depth }
    workerRef.current?.postMessage(req)
  }, [])

  const getVisibleNodes = useCallback((start: number, end: number): Promise<FlatNodeView[]> => {
    return new Promise((resolve) => {
      const requestId = ++requestIdRef.current
      pendingRequests.current.set(requestId, resolve)
      const req: WorkerRequest = { type: 'GET_VISIBLE_RANGE', requestId, startIndex: start, endIndex: end }
      workerRef.current?.postMessage(req)
    })
  }, [])

  return { status, progress, error, stats, visibleCount, loadFile, toggleExpand, expandToDepth, getVisibleNodes }
}
