export type ParseMode = 'json' | 'xml'

/**
 * Leaf types carry enough information for TreeRow to apply distinct syntax
 * colors; 'object' | 'array' | 'xml_tag' are the only expandable container
 * types. Everything else is a leaf.
 */
export type NodeType =
  | 'object'
  | 'array'
  | 'xml_tag'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'

export const CONTAINER_TYPES: ReadonlySet<NodeType> = new Set(['object', 'array', 'xml_tag'])

/** A single flattened tree node as materialized for the UI thread. */
export interface FlatNodeView {
  id: number
  parentId: number
  depth: number
  key: string | null
  value: string | null
  /** Serialized attribute string for xml_tag nodes, e.g. `id="42" class="foo"`. */
  attributes: string | null
  type: NodeType
  childCount: number
  isExpanded: boolean
  path: string
}

export interface ParseStats {
  totalNodes: number
  visibleCount: number
  rootIds: number[]
  bytesTotal: number
  elapsedMs: number
}

// ---- Main thread -> Worker -------------------------------------------------

export type WorkerRequest =
  | { type: 'LOAD_FILE'; file: File; mode: ParseMode }
  | { type: 'GET_VISIBLE_RANGE'; requestId: number; startIndex: number; endIndex: number }
  | { type: 'TOGGLE_EXPAND'; nodeId: number }
  | { type: 'EXPAND_TO_DEPTH'; depth: number }

// ---- Worker -> Main thread --------------------------------------------------

export type WorkerResponse =
  | { type: 'PROGRESS'; loaded: number; total: number; nodeCount: number }
  | { type: 'PARSE_COMPLETE'; stats: ParseStats }
  | {
      type: 'VISIBLE_RANGE'
      requestId: number
      startIndex: number
      nodes: FlatNodeView[]
      visibleCount: number
    }
  | { type: 'VISIBLE_COUNT_CHANGED'; visibleCount: number }
  | { type: 'ERROR'; message: string }
