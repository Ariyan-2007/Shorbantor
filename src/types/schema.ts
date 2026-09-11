export type ParseMode = 'json' | 'xml'

export type NodeType =
  | 'object'
  | 'array'
  | 'xml_tag'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'

export const CONTAINER_TYPES: ReadonlySet<NodeType> = new Set(['object', 'array', 'xml_tag'])

/** Which CSS custom property (--sx-*, --app-muted, or the accent) a token names. */
export type ColorToken = 'key' | 'idx' | 'tag' | 'null' | 'str' | 'num' | 'bool' | 'muted' | 'accent'

/** A single flattened tree node as materialized for the UI thread, pre-formatted to match the design exactly. */
export interface FlatNodeView {
  id: number
  parentId: number
  depth: number
  type: NodeType
  isContainer: boolean
  isExpanded: boolean
  /** Element-only count for xml_tag (text children don't count); raw child count otherwise. Drives the badge. */
  childCount: number
  keyPre: string
  keyMid: string
  keyPost: string
  keyColorToken: ColorToken
  valuePre: string
  valueMid: string
  valuePost: string
  valueColorToken: ColorToken
  markerColorToken: ColorToken
  attributes: string | null
  showColon: boolean
  badge: string
  path: string
  /** One entry per ancestor (root-first): true draws a solid vertical guide at that column, false leaves it blank. */
  rails: boolean[]
  /** Whether this row's own elbow connector extends down to a following sibling (true) or stops at the joint (false, last child). */
  elbowExtendsDown: boolean
  /** True when this node itself (not just an ancestor of a match) matches the active search query. */
  isSearchMatch: boolean
}

export interface InspectorRow {
  key: string
  value: string
  isAttribute: boolean
  markerColorToken: ColorToken
  valueColorToken: ColorToken
  childId: number | null
}

export interface AncestorCrumb {
  id: number
  label: string
}

export interface ParseStats {
  totalNodes: number
  visibleCount: number
  rootId: number | null
  bytesTotal: number
  elapsedMs: number
  maxDepth: number
}

// ---- Main thread -> Worker -------------------------------------------------

export type WorkerRequest =
  | { type: 'LOAD_FILE'; file: File; mode: ParseMode }
  | { type: 'GET_VISIBLE_RANGE'; requestId: number; startIndex: number; endIndex: number }
  | { type: 'TOGGLE_EXPAND'; nodeId: number }
  | { type: 'SET_EXPANDED'; nodeId: number; expanded: boolean }
  | { type: 'EXPAND_TO_DEPTH'; depth: number }
  | { type: 'SET_SEARCH'; requestId: number; query: string }
  | { type: 'GET_MATCH_POSITION'; requestId: number; matchIndex: number }
  | { type: 'GET_INSPECTOR_ROWS'; requestId: number; nodeId: number | null }
  | { type: 'GET_ANCESTOR_CHAIN'; requestId: number; nodeId: number | null }
  | { type: 'GET_SUBTREE_TEXT'; requestId: number; nodeId: number }
  | { type: 'GET_VALUE_TEXT'; requestId: number; nodeId: number }
  | { type: 'GET_NODE_PATH'; requestId: number; nodeId: number }

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
  | { type: 'SEARCH_RESULT'; requestId: number; matchCount: number; visibleCount: number }
  | { type: 'MATCH_POSITION'; requestId: number; position: number }
  | { type: 'INSPECTOR_ROWS'; requestId: number; rows: InspectorRow[]; title: string }
  | { type: 'ANCESTOR_CHAIN'; requestId: number; crumbs: AncestorCrumb[] }
  | { type: 'SUBTREE_TEXT'; requestId: number; text: string }
  | { type: 'VALUE_TEXT'; requestId: number; text: string }
  | { type: 'NODE_PATH'; requestId: number; path: string }
  | { type: 'ERROR'; message: string }
