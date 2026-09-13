import type { ParseMode, WorkerRequest, WorkerResponse } from '../types/schema'
import { FlatNodeIndex } from './flatIndex'
import { JsonStreamTokenizer } from './tokenizers/jsonTokenizer'
import { XmlStreamTokenizer } from './tokenizers/xmlTokenizer'

const CHUNK_SIZE = 64 * 1024
const PROGRESS_INTERVAL_MS = 80

let index = new FlatNodeIndex('json')
/** Bumped on every LOAD_FILE so a stale in-flight parse can notice it was superseded and bail out. */
let loadToken = 0

function post(msg: WorkerResponse) {
  self.postMessage(msg)
}

async function* readFileChunks(file: File): AsyncGenerator<Uint8Array> {
  const reader = file.stream().getReader()
  let pending = new Uint8Array(0)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.length === 0) continue
      if (pending.length === 0) {
        pending = value
      } else {
        const merged = new Uint8Array(pending.length + value.length)
        merged.set(pending, 0)
        merged.set(value, pending.length)
        pending = merged
      }
      while (pending.length >= CHUNK_SIZE) {
        yield pending.subarray(0, CHUNK_SIZE)
        pending = pending.subarray(CHUNK_SIZE)
      }
    }
    if (pending.length > 0) yield pending
  } finally {
    reader.releaseLock()
  }
}

async function loadFile(file: File, mode: ParseMode, myToken: number) {
  index = new FlatNodeIndex(mode)
  const decoder = new TextDecoder('utf-8')
  const tokenizer = mode === 'json' ? new JsonStreamTokenizer(index) : new XmlStreamTokenizer(index)

  const startTime = performance.now()
  let loaded = 0
  let lastProgressPost = 0

  try {
    for await (const chunkBytes of readFileChunks(file)) {
      if (myToken !== loadToken) return

      const text = decoder.decode(chunkBytes, { stream: true })
      tokenizer.feed(text)
      loaded += chunkBytes.length

      const now = performance.now()
      if (now - lastProgressPost > PROGRESS_INTERVAL_MS) {
        lastProgressPost = now
        post({ type: 'PROGRESS', loaded, total: file.size, nodeCount: index.nodeCount })
      }
    }

    const tail = decoder.decode()
    if (tail) tokenizer.feed(tail)
    tokenizer.end()

    if (myToken !== loadToken) return

    index.rebuildVisibleOrder()
    post({
      type: 'PARSE_COMPLETE',
      stats: {
        totalNodes: index.nodeCount,
        visibleCount: index.getVisibleCount(),
        rootId: index.getRootId(),
        bytesTotal: file.size,
        elapsedMs: performance.now() - startTime,
        maxDepth: index.computeMaxDepth(),
      },
    })
  } catch (err) {
    if (myToken !== loadToken) return
    post({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Any single request can fail on a pathological document — the clearest case
 * being a subtree whose serialized form exceeds the engine's maximum string
 * length. Left unhandled that becomes an uncaught worker error: the worker
 * dies, every in-flight request's promise never settles, and the UI hangs with
 * no explanation. Failing one request instead keeps the session alive.
 */
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  try {
    handleRequest(event.data)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const requestId = 'requestId' in event.data ? event.data.requestId : undefined
    if (requestId === undefined) post({ type: 'ERROR', message })
    else post({ type: 'REQUEST_FAILED', requestId, message })
  }
}

function handleRequest(msg: WorkerRequest) {
  switch (msg.type) {
    case 'LOAD_FILE': {
      loadToken += 1
      void loadFile(msg.file, msg.mode, loadToken)
      return
    }
    case 'GET_VISIBLE_RANGE': {
      const { startIndex, endIndex, requestId } = msg
      post({
        type: 'VISIBLE_RANGE',
        requestId,
        startIndex,
        nodes: index.getVisibleSlice(startIndex, endIndex),
        visibleCount: index.getVisibleCount(),
      })
      return
    }
    case 'TOGGLE_EXPAND': {
      index.toggleExpand(msg.nodeId)
      index.rebuildVisibleOrder()
      post({ type: 'VISIBLE_COUNT_CHANGED', visibleCount: index.getVisibleCount() })
      return
    }
    case 'SET_EXPANDED': {
      index.setNodeExpanded(msg.nodeId, msg.expanded)
      index.rebuildVisibleOrder()
      post({ type: 'VISIBLE_COUNT_CHANGED', visibleCount: index.getVisibleCount() })
      return
    }
    case 'EXPAND_TO_DEPTH': {
      index.expandToDepth(msg.depth)
      index.rebuildVisibleOrder()
      post({ type: 'VISIBLE_COUNT_CHANGED', visibleCount: index.getVisibleCount() })
      return
    }
    case 'SET_SEARCH': {
      const { matchCount, visibleCount } = index.setSearchQuery(msg.query)
      post({ type: 'SEARCH_RESULT', requestId: msg.requestId, matchCount, visibleCount })
      return
    }
    case 'GET_MATCH_POSITION': {
      post({ type: 'MATCH_POSITION', requestId: msg.requestId, position: index.getMatchPosition(msg.matchIndex) })
      return
    }
    case 'GET_NODE_POSITION': {
      post({ type: 'NODE_POSITION', requestId: msg.requestId, position: index.getNodePosition(msg.nodeId) })
      return
    }
    case 'GET_INSPECTOR_ROWS': {
      const { rows, title } = index.getInspectorRows(msg.nodeId)
      post({ type: 'INSPECTOR_ROWS', requestId: msg.requestId, rows, title })
      return
    }
    case 'GET_ANCESTOR_CHAIN': {
      post({ type: 'ANCESTOR_CHAIN', requestId: msg.requestId, crumbs: index.getAncestorChain(msg.nodeId) })
      return
    }
    case 'GET_SUBTREE_TEXT': {
      post({ type: 'SUBTREE_TEXT', requestId: msg.requestId, text: index.getSubtreeText(msg.nodeId) })
      return
    }
    case 'GET_VALUE_TEXT': {
      post({ type: 'VALUE_TEXT', requestId: msg.requestId, text: index.getValueText(msg.nodeId) })
      return
    }
    case 'GET_NODE_PATH': {
      post({ type: 'NODE_PATH', requestId: msg.requestId, path: index.getNodePath(msg.nodeId) })
      return
    }
  }
}
