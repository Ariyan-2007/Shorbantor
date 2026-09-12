import type { AncestorCrumb, ColorToken, FlatNodeView, InspectorRow, NodeType, ParseMode } from '../types/schema'
import type { ContainerType, IndexBuilder, LeafType } from './tokenizers/builderTypes'

const NONE = -1
const NULL_OFFSET = 0xffffffff
/** Root and its immediate children start expanded; deeper nodes start collapsed. */
const DEFAULT_EXPANDED_DEPTH = 2

/**
 * Numeric node-type codes. Hot paths compare these directly instead of going
 * through NODE_TYPE_NAMES[code] — a string materialization plus string compare
 * per check, which showed up everywhere in the traversal and search loops.
 */
const T_OBJECT = 0
const T_ARRAY = 1
const T_XML_TAG = 2
const T_STRING = 3
const T_NUMBER = 4
const T_BOOLEAN = 5
const T_NULL = 6

export const NODE_TYPE_NAMES: NodeType[] = [
  'object',
  'array',
  'xml_tag',
  'string',
  'number',
  'boolean',
  'null',
]

export const NODE_TYPE_CODES: Record<NodeType, number> = {
  object: T_OBJECT,
  array: T_ARRAY,
  xml_tag: T_XML_TAG,
  string: T_STRING,
  number: T_NUMBER,
  boolean: T_BOOLEAN,
  null: T_NULL,
}

type TypedArray = Int32Array | Uint32Array | Uint16Array | Uint8Array
type TypedArrayCtor<T> = { new (length: number): T }

/** A vector-like wrapper around a TypedArray that doubles capacity on growth. */
class GrowableArray<T extends TypedArray> {
  private buf: T
  private ctor: TypedArrayCtor<T>
  length = 0

  constructor(ctor: TypedArrayCtor<T>, initialCapacity: number) {
    this.ctor = ctor
    this.buf = new ctor(Math.max(1, initialCapacity))
  }

  private ensureCapacity(n: number) {
    if (n <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < n) cap *= 2
    const next = new this.ctor(cap)
    next.set(this.buf)
    this.buf = next
  }

  push(value: number): number {
    this.ensureCapacity(this.length + 1)
    this.buf[this.length] = value
    return this.length++
  }

  get(index: number): number {
    return this.buf[index]
  }

  set(index: number, value: number): void {
    this.buf[index] = value
  }
}

/** ASCII upper -> lower, used for case-insensitive matching directly on pool bytes. */
function fold(b: number): number {
  return b >= 65 && b <= 90 ? b + 32 : b
}

/** Append-only UTF-8 byte pool backing every key/value/attribute string in the index. */
class StringPool {
  private bytes: Uint8Array
  private length = 0
  private readonly encoder = new TextEncoder()
  private readonly decoder = new TextDecoder('utf-8')

  constructor(initialCapacity = 1 << 16) {
    this.bytes = new Uint8Array(initialCapacity)
  }

  private ensureCapacity(n: number) {
    if (n <= this.bytes.length) return
    let cap = this.bytes.length * 2
    while (cap < n) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.bytes)
    this.bytes = next
  }

  append(str: string): { offset: number; length: number } {
    // encodeInto writes straight into the pool when there is room, skipping the
    // intermediate Uint8Array that encode() allocates for every string.
    this.ensureCapacity(this.length + str.length * 3)
    const { written } = this.encoder.encodeInto(str, this.bytes.subarray(this.length))
    const offset = this.length
    this.length += written
    return { offset, length: written }
  }

  read(offset: number, length: number): string {
    if (length === 0) return ''
    return this.decoder.decode(this.bytes.subarray(offset, offset + length))
  }

  /**
   * Case-insensitive substring test run directly against the pooled UTF-8
   * bytes — no decode, no toLowerCase(), no allocation. Folding is ASCII-only,
   * which is exact for ASCII needles: every byte of a multi-byte UTF-8
   * sequence is >= 0x80, so an ASCII needle can never match inside one.
   * Callers fall back to the decoding path for non-ASCII queries.
   */
  includesFolded(offset: number, length: number, needle: Uint8Array): boolean {
    const m = needle.length
    if (m === 0) return true
    if (m > length) return false
    const bytes = this.bytes
    const first = needle[0]
    const end = offset + length - m
    for (let i = offset; i <= end; i++) {
      if (fold(bytes[i]) !== first) continue
      let k = 1
      while (k < m && fold(bytes[i + k]) === needle[k]) k++
      if (k === m) return true
    }
    return false
  }
}

/**
 * Trims a scratch buffer to its used length. subarray() keeps the whole
 * oversized backing store alive, which is fine when most of it was used but
 * wasteful for a narrow search result — so copy out once the slack is large.
 */
function trimTo(buf: Uint32Array, used: number): Uint32Array {
  if (used === buf.length) return buf
  return used * 2 >= buf.length ? buf.subarray(0, used) : buf.slice(0, used)
}

function markText(text: string, query: string | null): [string, string, string] {
  if (!query) return [text, '', '']
  const idx = text.toLowerCase().indexOf(query)
  if (idx < 0) return [text, '', '']
  return [text.slice(0, idx), text.slice(idx, idx + query.length), text.slice(idx + query.length)]
}

function primDisplay(type: NodeType, raw: string | null): { text: string; token: ColorToken } {
  switch (type) {
    case 'string':
      return { text: `"${raw ?? ''}"`, token: 'str' }
    case 'number':
      return { text: raw ?? '', token: 'num' }
    case 'boolean':
      return { text: raw ?? '', token: 'bool' }
    case 'null':
      return { text: 'null', token: 'null' }
    default:
      return { text: raw ?? '', token: 'muted' }
  }
}

const ATTR_PAIR_RE = /([\w:-]+)=("[^"]*"|'[^']*')/g

function parseAttrPairs(attrs: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = []
  ATTR_PAIR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_PAIR_RE.exec(attrs))) out.push({ name: m[1], value: m[2] })
  return out
}

/**
 * Structure-of-arrays flat tree index. Every node is a row split across
 * TypedArrays (numeric fields) plus offset/length pairs into a shared UTF-8
 * string pool (text fields) — no per-node JS object exists until a caller
 * asks for a materialized view of a specific id via getNodeView().
 */
export class FlatNodeIndex implements IndexBuilder {
  private parentIdArr = new GrowableArray(Int32Array, 1024)
  private depthArr = new GrowableArray(Uint16Array, 1024)
  private nodeTypeArr = new GrowableArray(Uint8Array, 1024)
  private childCountArr = new GrowableArray(Uint32Array, 1024)
  /** Element-child count for xml_tag nodes only (text/CDATA children don't count) — drives isContainer/badge for XML. */
  private elementChildCountArr = new GrowableArray(Uint32Array, 1024)
  private firstChildIdArr = new GrowableArray(Int32Array, 1024)
  private lastChildIdArr = new GrowableArray(Int32Array, 1024)
  private nextSiblingIdArr = new GrowableArray(Int32Array, 1024)
  private siblingIndexArr = new GrowableArray(Uint32Array, 1024)
  /** Position among element-only siblings (xml_tag children skip text/CDATA siblings when counting) — needed since raw siblingIndex includes absorbed text nodes. */
  private elementSiblingIndexArr = new GrowableArray(Uint32Array, 1024)
  private keyOffsetArr = new GrowableArray(Uint32Array, 1024)
  private keyLengthArr = new GrowableArray(Uint32Array, 1024)
  private valueOffsetArr = new GrowableArray(Uint32Array, 1024)
  private valueLengthArr = new GrowableArray(Uint32Array, 1024)
  private attrOffsetArr = new GrowableArray(Uint32Array, 1024)
  private attrLengthArr = new GrowableArray(Uint32Array, 1024)
  private expandedBits = new Uint8Array(128)
  private strings = new StringPool()

  private containerStack: number[] = []
  private topLevelFirstId = NONE
  private topLevelLastId = NONE
  private topLevelCount = 0
  private maxDepthSeen = 0

  private visibleOrder: Uint32Array = new Uint32Array(0)

  private activeQuery: string | null = null
  private searchVisibleOrder: Uint32Array = new Uint32Array(0)
  private searchMatchIds: Int32Array = new Int32Array(0)
  private searchMatchCount = 0
  /** 1 where the node itself matches the active query — computed once per query and reused by the walk, by getNodeView, and by match navigation. */
  private selfHit: Uint8Array = new Uint8Array(0)
  /** visible-row index of each match id, so getMatchPosition is O(1) instead of a scan of the whole filtered order. */
  private matchPositionById = new Map<number, number>()

  nodeCount = 0
  private mode: ParseMode

  constructor(mode: ParseMode) {
    this.mode = mode
  }

  // ---- IndexBuilder ---------------------------------------------------------

  openContainer(type: ContainerType, key: string | null, attributes: string | null = null): number {
    const parentId = this.currentParentId()
    const depth = parentId === NONE ? 0 : this.depthArr.get(parentId) + 1
    const id = this.addNodeInternal({ parentId, depth, type, key, value: null, attributes })
    this.containerStack.push(id)
    return id
  }

  closeContainer(): void {
    this.containerStack.pop()
  }

  addLeaf(type: LeafType, key: string | null, value: string | null): number {
    const parentId = this.currentParentId()
    const depth = parentId === NONE ? 0 : this.depthArr.get(parentId) + 1
    return this.addNodeInternal({ parentId, depth, type, key, value, attributes: null })
  }

  private currentParentId(): number {
    return this.containerStack.length > 0 ? this.containerStack[this.containerStack.length - 1] : NONE
  }

  private addNodeInternal(params: {
    parentId: number
    depth: number
    type: NodeType
    key: string | null
    value: string | null
    attributes: string | null
  }): number {
    const id = this.nodeCount++

    this.parentIdArr.push(params.parentId)
    this.depthArr.push(params.depth)
    this.nodeTypeArr.push(NODE_TYPE_CODES[params.type])
    this.childCountArr.push(0)
    this.elementChildCountArr.push(0)
    this.firstChildIdArr.push(NONE)
    this.lastChildIdArr.push(NONE)
    this.nextSiblingIdArr.push(NONE)
    this.siblingIndexArr.push(this.linkIntoParent(params.parentId, id, params.type))

    // Depth stat counts only nodes that get their own row: text/CDATA leaves
    // absorbed into an xml_tag's row never deepened the reported tree.
    const absorbed =
      params.parentId !== NONE &&
      this.nodeTypeArr.get(params.parentId) === T_XML_TAG &&
      params.type !== 'xml_tag'
    if (!absorbed && params.depth > this.maxDepthSeen) this.maxDepthSeen = params.depth

    this.writeString(this.keyOffsetArr, this.keyLengthArr, params.key)
    this.writeString(this.valueOffsetArr, this.valueLengthArr, params.value)
    this.writeString(this.attrOffsetArr, this.attrLengthArr, params.attributes)

    if (params.type === 'object' || params.type === 'array' || params.type === 'xml_tag') {
      this.ensureExpandedCapacity(id)
      this.setExpanded(id, params.depth < DEFAULT_EXPANDED_DEPTH)
    }

    return id
  }

  private writeString(offsetArr: GrowableArray<Uint32Array>, lengthArr: GrowableArray<Uint32Array>, str: string | null) {
    if (str === null) {
      offsetArr.push(NULL_OFFSET)
      lengthArr.push(0)
      return
    }
    const { offset, length } = this.strings.append(str)
    offsetArr.push(offset)
    lengthArr.push(length)
  }

  private linkIntoParent(parentId: number, childId: number, childType: NodeType): number {
    if (parentId === NONE) {
      const idx = this.topLevelCount++
      if (this.topLevelFirstId === NONE) this.topLevelFirstId = childId
      else this.nextSiblingIdArr.set(this.topLevelLastId, childId)
      this.topLevelLastId = childId
      this.elementSiblingIndexArr.push(idx)
      return idx
    }
    const idx = this.childCountArr.get(parentId)
    this.childCountArr.set(parentId, idx + 1)
    let elemIdx = 0
    if (childType === 'xml_tag') {
      elemIdx = this.elementChildCountArr.get(parentId)
      this.elementChildCountArr.set(parentId, elemIdx + 1)
    }
    this.elementSiblingIndexArr.push(elemIdx)
    if (this.firstChildIdArr.get(parentId) === NONE) {
      this.firstChildIdArr.set(parentId, childId)
    } else {
      this.nextSiblingIdArr.set(this.lastChildIdArr.get(parentId), childId)
    }
    this.lastChildIdArr.set(parentId, childId)
    return idx
  }

  private isLastChild(id: number): boolean {
    const parentId = this.parentIdArr.get(id)
    if (parentId === NONE) return this.siblingIndexArr.get(id) === this.topLevelCount - 1
    if (this.nodeTypeArr.get(id) === T_XML_TAG) {
      return this.elementSiblingIndexArr.get(id) === this.elementChildCountArr.get(parentId) - 1
    }
    return this.siblingIndexArr.get(id) === this.childCountArr.get(parentId) - 1
  }

  /** Root-first: one entry per ancestor, true if that ancestor has a following sibling (so its guide line must continue). */
  private getRails(id: number): boolean[] {
    const depth = this.depthArr.get(id)
    if (depth === 0) return []
    // Filled back-to-front: unshift() on a plain array is O(n) per call, which
    // made this O(depth^2) for every materialized row.
    const rails = new Array<boolean>(depth)
    let cur = this.parentIdArr.get(id)
    let i = depth - 1
    while (cur !== NONE && i >= 0) {
      rails[i--] = !this.isLastChild(cur)
      cur = this.parentIdArr.get(cur)
    }
    return i >= 0 ? rails.slice(i + 1) : rails
  }

  // ---- Expansion bitset -------------------------------------------------

  private ensureExpandedCapacity(nodeId: number) {
    const byteIndex = nodeId >> 3
    if (byteIndex < this.expandedBits.length) return
    let cap = this.expandedBits.length * 2
    while (cap <= byteIndex) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.expandedBits)
    this.expandedBits = next
  }

  private setExpanded(nodeId: number, expanded: boolean) {
    const byteIndex = nodeId >> 3
    const bit = nodeId & 7
    if (expanded) this.expandedBits[byteIndex] |= 1 << bit
    else this.expandedBits[byteIndex] &= ~(1 << bit)
  }

  isExpanded(nodeId: number): boolean {
    const byteIndex = nodeId >> 3
    if (byteIndex >= this.expandedBits.length) return false
    return (this.expandedBits[byteIndex] & (1 << (nodeId & 7))) !== 0
  }

  /** xml_tag counts only its element children (text/CDATA never make a tag "expandable"); object/array count all children. */
  isContainerNode(id: number): boolean {
    if (this.nodeTypeArr.get(id) === T_XML_TAG) return this.elementChildCountArr.get(id) > 0
    return this.childCountArr.get(id) > 0
  }

  private effectiveChildCount(id: number): number {
    return this.nodeTypeArr.get(id) === T_XML_TAG ? this.elementChildCountArr.get(id) : this.childCountArr.get(id)
  }

  toggleExpand(nodeId: number) {
    if (nodeId < 0 || nodeId >= this.nodeCount) return
    if (!this.isContainerNode(nodeId)) return
    this.setExpanded(nodeId, !this.isExpanded(nodeId))
  }

  setNodeExpanded(nodeId: number, expanded: boolean) {
    if (nodeId < 0 || nodeId >= this.nodeCount) return
    if (!this.isContainerNode(nodeId)) return
    this.setExpanded(nodeId, expanded)
  }

  expandToDepth(depth: number) {
    for (let id = 0; id < this.nodeCount; id++) {
      if (!this.isContainerNode(id)) continue
      this.setExpanded(id, this.depthArr.get(id) < depth)
    }
  }

  // ---- Structural walk helpers ------------------------------------------

  /**
   * First child of `id` that gets its own row. Text/CDATA leaves under an
   * xml_tag are absorbed into their parent's row instead of being listed.
   */
  private firstRowChild(id: number): number {
    let c = this.firstChildIdArr.get(id)
    if (this.nodeTypeArr.get(id) !== T_XML_TAG) return c
    while (c !== NONE && this.nodeTypeArr.get(c) !== T_XML_TAG) c = this.nextSiblingIdArr.get(c)
    return c
  }

  /** Next sibling of `id` that gets its own row, applying the same xml_tag filter. */
  private nextRowSibling(id: number): number {
    const parentId = this.parentIdArr.get(id)
    let c = this.nextSiblingIdArr.get(id)
    if (parentId === NONE || this.nodeTypeArr.get(parentId) !== T_XML_TAG) return c
    while (c !== NONE && this.nodeTypeArr.get(c) !== T_XML_TAG) c = this.nextSiblingIdArr.get(c)
    return c
  }

  /** Node ids that should appear as their own row under `id` when expanded. */
  private childrenToVisit(id: number): number[] {
    const out: number[] = []
    for (let c = this.firstRowChild(id); c !== NONE; c = this.nextRowSibling(c)) out.push(c)
    return out
  }

  /** The inline text shown on a leaf xml_tag's own row (its absorbed text/CDATA content) — null for container or empty tags. */
  private getInlineXmlText(id: number): string | null {
    if (this.elementChildCountArr.get(id) > 0) return null
    if (this.childCountArr.get(id) === 0) return null
    let out: string | null = null
    let c = this.firstChildIdArr.get(id)
    while (c !== NONE) {
      const v = this.readString(this.valueOffsetArr, this.valueLengthArr, c)
      if (v) out = out === null ? v : out + ' ' + v
      c = this.nextSiblingIdArr.get(c)
    }
    return out
  }

  // ---- Visible order (depth filtering) -----------------------------------

  /**
   * Recomputed from scratch on every toggle/expand-to-depth rather than
   * patched incrementally: an incrementally-shifted flat list needs an
   * order-statistics structure to stay O(log n), which is overkill here —
   * a full walk still runs entirely off the main thread and stays well under
   * a frame for tens of millions of nodes.
   *
   * The walk is a pointer-chasing descend/advance/climb loop rather than an
   * explicit stack of child arrays: it allocates nothing per node (the old
   * form built a fresh JS array of children for every container it entered)
   * and writes straight into one exactly-sized Uint32Array instead of filling
   * a GrowableArray and then copying it out.
   */
  rebuildVisibleOrder() {
    const out = new Uint32Array(this.nodeCount)
    let k = 0
    let id = this.topLevelFirstId

    while (id !== NONE) {
      out[k++] = id
      let next = NONE
      if (this.isContainerNode(id) && this.isExpanded(id)) next = this.firstRowChild(id)
      if (next === NONE) {
        for (let cur = id; cur !== NONE; cur = this.parentIdArr.get(cur)) {
          next = this.nextRowSibling(cur)
          if (next !== NONE) break
        }
      }
      id = next
    }

    this.visibleOrder = trimTo(out, k)
  }

  getVisibleCount(): number {
    return this.activeQuery ? this.searchVisibleOrder.length : this.visibleOrder.length
  }

  getTopLevelIds(): number[] {
    const ids: number[] = []
    let id = this.topLevelFirstId
    while (id !== NONE) {
      ids.push(id)
      id = this.nextSiblingIdArr.get(id)
    }
    return ids
  }

  getRootId(): number | null {
    return this.topLevelFirstId === NONE ? null : this.topLevelFirstId
  }

  /** Depth is recorded as each node is appended, so the deepest level is already known — no traversal needed. */
  computeMaxDepth(): number {
    return this.nodeCount === 0 ? 0 : this.maxDepthSeen + 1
  }

  getVisibleSlice(start: number, end: number): FlatNodeView[] {
    const order = this.activeQuery ? this.searchVisibleOrder : this.visibleOrder
    const clampedStart = Math.max(0, start)
    const clampedEnd = Math.min(end, order.length)
    const out: FlatNodeView[] = []
    for (let i = clampedStart; i < clampedEnd; i++) {
      out.push(this.getNodeView(order[i]))
    }
    return out
  }

  // ---- Search -------------------------------------------------------------

  /** Encoded, ASCII-folded needle for the byte-level path; null when the query has non-ASCII characters. */
  private queryBytes: Uint8Array | null = null

  private poolHit(offsetArr: GrowableArray<Uint32Array>, lengthArr: GrowableArray<Uint32Array>, id: number, q: string): boolean {
    const offset = offsetArr.get(id)
    if (offset === NULL_OFFSET) return false
    const len = lengthArr.get(id)
    if (len === 0) return false
    if (this.queryBytes) return this.strings.includesFolded(offset, len, this.queryBytes)
    return this.strings.read(offset, len).toLowerCase().includes(q)
  }

  private hitSelf(id: number, q: string): boolean {
    if (this.poolHit(this.keyOffsetArr, this.keyLengthArr, id, q)) return true

    const parentId = this.parentIdArr.get(id)
    if (parentId !== NONE && this.nodeTypeArr.get(parentId) === T_ARRAY) {
      if (String(this.siblingIndexArr.get(id)).includes(q)) return true
    }

    const type = this.nodeTypeArr.get(id)
    if (type === T_XML_TAG) {
      if (this.poolHit(this.attrOffsetArr, this.attrLengthArr, id, q)) return true
      // Absorbed text children render on this tag's own row, so they count as
      // this node's own content. Tested per child against the pool rather than
      // joining them into a throwaway string first.
      if (this.elementChildCountArr.get(id) > 0) return false
      for (let c = this.firstChildIdArr.get(id); c !== NONE; c = this.nextSiblingIdArr.get(c)) {
        if (this.poolHit(this.valueOffsetArr, this.valueLengthArr, c, q)) return true
      }
      return false
    }

    if (type !== T_OBJECT && type !== T_ARRAY) {
      if (this.poolHit(this.valueOffsetArr, this.valueLengthArr, id, q)) return true
    }
    return false
  }

  setSearchQuery(query: string): { matchCount: number; visibleCount: number } {
    const q = query.trim().toLowerCase()
    if (!q) {
      this.activeQuery = null
      this.queryBytes = null
      this.searchVisibleOrder = new Uint32Array(0)
      this.searchMatchIds = new Int32Array(0)
      this.searchMatchCount = 0
      this.selfHit = new Uint8Array(0)
      this.matchPositionById.clear()
      return { matchCount: 0, visibleCount: this.visibleOrder.length }
    }
    this.activeQuery = q
    // eslint-disable-next-line no-control-regex
    this.queryBytes = /^[\x00-\x7f]*$/.test(q) ? new TextEncoder().encode(q) : null

    // One pass to score every node, then a reverse pass to propagate hits up to
    // ancestors. Children always have a higher id than their parent, so a single
    // descending sweep is enough to lift every hit to the root.
    const selfHit = new Uint8Array(this.nodeCount)
    const anyHit = new Uint8Array(this.nodeCount)
    let matchTotal = 0
    for (let id = 0; id < this.nodeCount; id++) {
      if (this.hitSelf(id, q)) {
        selfHit[id] = 1
        anyHit[id] = 1
        matchTotal++
      }
    }
    for (let id = this.nodeCount - 1; id >= 0; id--) {
      if (anyHit[id]) {
        const p = this.parentIdArr.get(id)
        if (p !== NONE) anyHit[p] = 1
      }
    }
    this.selfHit = selfHit

    const out = new Uint32Array(this.nodeCount)
    const matches = new Int32Array(matchTotal)
    this.matchPositionById.clear()
    let k = 0
    let m = 0

    // Same allocation-free descend/advance/climb walk as rebuildVisibleOrder,
    // additionally skipping any subtree that contains no hit at all.
    const firstHitChild = (id: number): number => {
      let c = this.firstRowChild(id)
      while (c !== NONE && !anyHit[c]) c = this.nextRowSibling(c)
      return c
    }
    const nextHitSibling = (id: number): number => {
      let c = this.nextRowSibling(id)
      while (c !== NONE && !anyHit[c]) c = this.nextRowSibling(c)
      return c
    }

    let id = this.topLevelFirstId
    while (id !== NONE && !anyHit[id]) id = this.nextSiblingIdArr.get(id)

    while (id !== NONE) {
      if (selfHit[id]) {
        matches[m++] = id
        this.matchPositionById.set(id, k)
      }
      out[k++] = id

      let next = this.isContainerNode(id) ? firstHitChild(id) : NONE
      if (next === NONE) {
        for (let cur = id; cur !== NONE; cur = this.parentIdArr.get(cur)) {
          next = nextHitSibling(cur)
          if (next !== NONE) break
        }
      }
      id = next
    }

    this.searchVisibleOrder = trimTo(out, k)
    this.searchMatchIds = m === matches.length ? matches : matches.slice(0, m)
    this.searchMatchCount = m
    return { matchCount: m, visibleCount: k }
  }

  /** O(1): positions were recorded during the filtered walk rather than re-scanned per jump. */
  getMatchPosition(matchIndex: number): number {
    if (matchIndex < 0 || matchIndex >= this.searchMatchCount) return -1
    const pos = this.matchPositionById.get(this.searchMatchIds[matchIndex])
    return pos === undefined ? -1 : pos
  }

  // ---- Node materialization -----------------------------------------------

  private readString(offsetArr: GrowableArray<Uint32Array>, lengthArr: GrowableArray<Uint32Array>, id: number): string | null {
    const offset = offsetArr.get(id)
    if (offset === NULL_OFFSET) return null
    return this.strings.read(offset, lengthArr.get(id))
  }

  private readKey(id: number): string | null {
    return this.readString(this.keyOffsetArr, this.keyLengthArr, id)
  }

  private plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`
  }

  private badgeText(id: number, type: NodeType): string {
    if (type === 'object') return this.plural(this.childCountArr.get(id), 'key', 'keys')
    if (type === 'array') return this.plural(this.childCountArr.get(id), 'item', 'items')
    if (type === 'xml_tag') {
      const n = this.elementChildCountArr.get(id)
      if (n > 0) return this.plural(n, 'node', 'nodes')
      return this.getInlineXmlText(id) ? 'text' : 'empty'
    }
    return type === 'null' ? 'null' : type === 'string' ? 'str' : type === 'number' ? 'num' : 'bool'
  }

  /** Peek preview shown next to a *collapsed* JSON container — first 3 children, comma-joined. XML containers never peek (design only defines this for obj/arr). */
  private collapsedPeek(id: number, type: NodeType): string {
    const parts: string[] = []
    let c = this.firstChildIdArr.get(id)
    let count = 0
    while (c !== NONE && count < 3) {
      const ct = NODE_TYPE_NAMES[this.nodeTypeArr.get(c)]
      if (type === 'array') {
        if (ct === 'array') parts.push('[…]')
        else if (ct === 'object') parts.push('{…}')
        else parts.push(primDisplay(ct, this.readString(this.valueOffsetArr, this.valueLengthArr, c)).text)
      } else {
        parts.push(this.readKey(c) ?? '')
      }
      c = this.nextSiblingIdArr.get(c)
      count++
    }
    const hasMore = this.childCountArr.get(id) > 3
    return parts.join(', ') + (hasMore ? ', …' : '')
  }

  private formatKey(id: number): { text: string; token: ColorToken } {
    const parentId = this.parentIdArr.get(id)
    if (this.mode === 'xml') return { text: this.readKey(id) ?? 'node', token: 'tag' }
    if (parentId === NONE) return { text: 'root', token: 'key' }
    if (this.nodeTypeArr.get(parentId) === T_ARRAY) return { text: `[${this.siblingIndexArr.get(id)}]`, token: 'idx' }
    return { text: this.readKey(id) ?? '', token: 'key' }
  }

  getNodeView(id: number): FlatNodeView {
    const typeCode = this.nodeTypeArr.get(id)
    const type = NODE_TYPE_NAMES[typeCode]
    const isContainer = this.isContainerNode(id)
    const isExpanded = this.activeQuery ? isContainer : this.isExpanded(id)

    let valueText: string
    let valueColorToken: ColorToken
    if (typeCode === T_STRING || typeCode === T_NUMBER || typeCode === T_BOOLEAN || typeCode === T_NULL) {
      const d = primDisplay(type, this.readString(this.valueOffsetArr, this.valueLengthArr, id))
      valueText = d.text
      valueColorToken = d.token
    } else if (typeCode === T_XML_TAG) {
      valueText = this.getInlineXmlText(id) ?? ''
      valueColorToken = 'str'
    } else if (isExpanded) {
      valueText = ''
      valueColorToken = 'muted'
    } else {
      valueText = this.collapsedPeek(id, type)
      valueColorToken = 'muted'
    }

    const key = this.formatKey(id)
    const [keyPre, keyMid, keyPost] = markText(key.text, this.activeQuery)
    const [valuePre, valueMid, valuePost] = markText(valueText, this.activeQuery)

    const markerColorToken: ColorToken = typeCode === T_XML_TAG ? 'accent' : valueColorToken

    return {
      id,
      parentId: this.parentIdArr.get(id),
      depth: this.depthArr.get(id),
      type,
      isContainer,
      isExpanded,
      childCount: this.effectiveChildCount(id),
      keyPre,
      keyMid,
      keyPost,
      keyColorToken: key.token,
      valuePre,
      valueMid,
      valuePost,
      valueColorToken,
      markerColorToken,
      attributes: this.readString(this.attrOffsetArr, this.attrLengthArr, id),
      showColon: !isContainer && valueText !== '',
      badge: isContainer ? this.badgeText(id, type) : '',
      path: this.mode === 'xml' ? this.computeXmlPath(id) : this.computeJsonPath(id),
      rails: this.getRails(id),
      elbowExtendsDown: this.parentIdArr.get(id) !== NONE && !this.isLastChild(id),
      // Reuses the bitset built by setSearchQuery instead of re-running the
      // whole match test for every row that scrolls into view.
      isSearchMatch: this.activeQuery !== null && id < this.selfHit.length && this.selfHit[id] === 1,
    }
  }

  private computeJsonPath(id: number): string {
    const segments: string[] = []
    let cur = id
    while (cur !== NONE) {
      const parentId = this.parentIdArr.get(cur)
      if (parentId === NONE) break
      if (this.nodeTypeArr.get(parentId) === T_ARRAY) {
        segments.push(`[${this.siblingIndexArr.get(cur)}]`)
      } else {
        segments.push(`.${this.readKey(cur) ?? ''}`)
      }
      cur = parentId
    }
    segments.reverse()
    return '$' + segments.join('')
  }

  private computeXmlPath(id: number): string {
    const segments: string[] = []
    let cur = id
    const isTextLeaf = this.nodeTypeArr.get(id) !== T_XML_TAG
    while (cur !== NONE) {
      if (this.nodeTypeArr.get(cur) === T_XML_TAG) {
        segments.push(`${this.readKey(cur) ?? 'node'}[${this.siblingIndexArr.get(cur)}]`)
      }
      cur = this.parentIdArr.get(cur)
    }
    segments.reverse()
    return '/' + segments.join('/') + (isTextLeaf ? '/text()' : '')
  }

  // ---- Node inspector / breadcrumb / copy actions --------------------------

  getAncestorChain(nodeId: number | null): AncestorCrumb[] {
    if (nodeId === null || nodeId < 0 || nodeId >= this.nodeCount) {
      return [{ id: this.topLevelFirstId, label: 'root' }]
    }
    const chain: AncestorCrumb[] = []
    let cur = nodeId
    while (cur !== NONE) {
      const parentId = this.parentIdArr.get(cur)
      if (parentId === NONE) {
        chain.push({ id: cur, label: 'root' })
      } else if (this.mode === 'xml') {
        chain.push({ id: cur, label: this.readKey(cur) ?? 'node' })
      } else {
        chain.push({
          id: cur,
          label: this.nodeTypeArr.get(parentId) === T_ARRAY ? `[${this.siblingIndexArr.get(cur)}]` : (this.readKey(cur) ?? ''),
        })
      }
      cur = parentId
    }
    chain.reverse()
    return chain
  }

  private previewValue(id: number, type: NodeType): { text: string; token: ColorToken } {
    if (type === 'string' || type === 'number' || type === 'boolean' || type === 'null') {
      return primDisplay(type, this.readString(this.valueOffsetArr, this.valueLengthArr, id))
    }
    if (type === 'xml_tag') {
      const inline = this.getInlineXmlText(id)
      return inline ? { text: inline, token: 'str' } : { text: '…', token: 'muted' }
    }
    if (type === 'array') return { text: `[ ${this.childCountArr.get(id)} ]`, token: 'muted' }
    if (type === 'object') return { text: `{ ${this.childCountArr.get(id)} }`, token: 'muted' }
    return { text: '…', token: 'muted' }
  }

  getInspectorRows(nodeId: number | null): { rows: InspectorRow[]; title: string } {
    const targetId = nodeId ?? this.topLevelFirstId
    if (targetId === NONE) return { rows: [], title: '—' }

    const type = NODE_TYPE_NAMES[this.nodeTypeArr.get(targetId)]
    const rows: InspectorRow[] = []

    if (type === 'xml_tag') {
      const attrs = this.readString(this.attrOffsetArr, this.attrLengthArr, targetId)
      if (attrs) {
        for (const { name, value } of parseAttrPairs(attrs)) {
          rows.push({ key: `@${name}`, value, isAttribute: true, markerColorToken: 'tag', valueColorToken: 'str', childId: null })
        }
      }
    }

    for (const childId of this.childrenToVisit(targetId)) {
      const childType = NODE_TYPE_NAMES[this.nodeTypeArr.get(childId)]
      const name =
        this.mode === 'xml'
          ? (this.readKey(childId) ?? 'node')
          : type === 'array'
            ? `[${this.siblingIndexArr.get(childId)}]`
            : (this.readKey(childId) ?? '')
      const { text: value, token } = this.previewValue(childId, childType)
      const isChildContainer = childType === 'object' || childType === 'array' || childType === 'xml_tag'
      rows.push({
        key: name,
        value,
        isAttribute: false,
        markerColorToken: isChildContainer ? 'accent' : token,
        valueColorToken: token,
        childId,
      })
    }

    const selfName =
      targetId === this.topLevelFirstId ? 'root' : (this.mode === 'xml' ? (this.readKey(targetId) ?? 'node') : this.formatKey(targetId).text)
    const title = `${selfName} · ${this.badgeText(targetId, type)}`
    return { rows, title }
  }

  getNodePath(nodeId: number): string {
    return this.mode === 'xml' ? this.computeXmlPath(nodeId) : this.computeJsonPath(nodeId)
  }

  getValueText(nodeId: number): string {
    const type = this.nodeTypeArr.get(nodeId)
    if (type === T_XML_TAG) return this.getInlineXmlText(nodeId) ?? ''
    if (type === T_OBJECT || type === T_ARRAY) return this.getSubtreeText(nodeId)
    return this.readString(this.valueOffsetArr, this.valueLengthArr, nodeId) ?? ''
  }

  /**
   * Depth past which the native JSON.stringify path is unsafe. JSON.stringify
   * recurses internally, so even an iteratively-built plain value overflows the
   * stack on a deep enough document; engines differ on where, and Safari's
   * limit is the lowest, so this stays far below every observed threshold.
   */
  private static readonly SAFE_NATIVE_DEPTH = 1000

  getSubtreeText(nodeId: number): string {
    if (this.mode === 'xml') return this.serializeXml(nodeId)
    const subtreeDepth = this.maxDepthSeen - this.depthArr.get(nodeId)
    return subtreeDepth < FlatNodeIndex.SAFE_NATIVE_DEPTH
      ? JSON.stringify(this.toPlainValue(nodeId), null, 2)
      : this.serializeJson(nodeId)
  }

  private primitiveJson(id: number): string {
    const type = this.nodeTypeArr.get(id)
    const raw = this.readString(this.valueOffsetArr, this.valueLengthArr, id)
    if (type === T_NUMBER) return raw === null ? 'null' : JSON.stringify(Number(raw))
    if (type === T_BOOLEAN) return raw === 'true' ? 'true' : 'false'
    if (type === T_NULL) return 'null'
    return JSON.stringify(raw)
  }

  /**
   * Fully iterative JSON writer used only past SAFE_NATIVE_DEPTH. Slower than
   * native stringify, but it is the difference between a copy that works and a
   * worker that dies with a stack overflow. Output matches the native path.
   */
  private serializeJson(nodeId: number): string {
    const parts: string[] = []
    const pads: string[] = ['']
    const padFor = (n: number) => {
      while (pads.length <= n) pads.push(pads[pads.length - 1] + '  ')
      return pads[n]
    }

    const ids: number[] = [nodeId]
    const cursors: number[] = [-2]
    const indents: number[] = [0]

    while (ids.length > 0) {
      const top = ids.length - 1
      const id = ids[top]
      const type = this.nodeTypeArr.get(id)
      const indent = indents[top]

      if (type !== T_OBJECT && type !== T_ARRAY) {
        parts.push(this.primitiveJson(id))
        ids.pop()
        cursors.pop()
        indents.pop()
        continue
      }

      const isObject = type === T_OBJECT
      const descend = (child: number) => {
        parts.push(padFor(indent + 1))
        if (isObject) parts.push(JSON.stringify(this.readKey(child) ?? '') + ': ')
        cursors[top] = child
        ids.push(child)
        cursors.push(-2)
        indents.push(indent + 1)
      }

      if (cursors[top] === -2) {
        const first = this.firstChildIdArr.get(id)
        if (first === NONE) {
          parts.push(isObject ? '{}' : '[]')
          ids.pop()
          cursors.pop()
          indents.pop()
          continue
        }
        parts.push(isObject ? '{\n' : '[\n')
        descend(first)
        continue
      }

      const next = this.nextSiblingIdArr.get(cursors[top])
      if (next === NONE) {
        parts.push('\n' + padFor(indent) + (isObject ? '}' : ']'))
        ids.pop()
        cursors.pop()
        indents.pop()
        continue
      }
      parts.push(',\n')
      descend(next)
    }

    return parts.join('')
  }

  private leafValue(id: number): unknown {
    const raw = this.readString(this.valueOffsetArr, this.valueLengthArr, id)
    const type = this.nodeTypeArr.get(id)
    if (type === T_NUMBER) return raw === null ? null : Number(raw)
    if (type === T_BOOLEAN) return raw === 'true'
    if (type === T_NULL) return null
    return raw
  }

  /**
   * Rebuilds a plain JS mirror of a subtree for JSON.stringify. Kept iterative:
   * the recursive form recursed once per node, so copying a deeply nested
   * document overflowed the call stack and took the worker down with it. The
   * explicit stacks live on the heap, so depth is bounded by memory instead.
   */
  private toPlainValue(nodeId: number): unknown {
    const rootType = this.nodeTypeArr.get(nodeId)
    if (rootType !== T_OBJECT && rootType !== T_ARRAY) return this.leafValue(nodeId)

    const root: Record<string, unknown> | unknown[] = rootType === T_OBJECT ? {} : []
    // Parallel stacks (node id / built container / next unvisited child).
    const nodes: number[] = [nodeId]
    const vals: (Record<string, unknown> | unknown[])[] = [root]
    const cursors: number[] = [this.firstChildIdArr.get(nodeId)]

    while (nodes.length > 0) {
      const top = nodes.length - 1
      const childId = cursors[top]
      if (childId === NONE) {
        nodes.pop()
        vals.pop()
        cursors.pop()
        continue
      }
      cursors[top] = this.nextSiblingIdArr.get(childId)

      const parentVal = vals[top]
      const parentIsObject = this.nodeTypeArr.get(nodes[top]) === T_OBJECT
      const childType = this.nodeTypeArr.get(childId)
      const childIsContainer = childType === T_OBJECT || childType === T_ARRAY
      const childVal = childIsContainer ? (childType === T_OBJECT ? {} : []) : this.leafValue(childId)

      if (parentIsObject) (parentVal as Record<string, unknown>)[this.readKey(childId) ?? ''] = childVal
      else (parentVal as unknown[]).push(childVal)

      if (childIsContainer) {
        nodes.push(childId)
        vals.push(childVal as Record<string, unknown> | unknown[])
        cursors.push(this.firstChildIdArr.get(childId))
      }
    }
    return root
  }

  /** Iterative for the same reason as toPlainValue — deep XML must not overflow the stack. */
  private serializeXml(nodeId: number): string {
    const parts: string[] = []
    // Indent strings are reused rather than rebuilt with repeat() per node.
    const pads: string[] = ['']
    const padFor = (n: number) => {
      while (pads.length <= n) pads.push(pads[pads.length - 1] + '  ')
      return pads[n]
    }

    const ids: number[] = [nodeId]
    const cursors: number[] = [-2]
    const indents: number[] = [0]

    while (ids.length > 0) {
      const top = ids.length - 1
      const id = ids[top]
      const indent = indents[top]
      const pad = padFor(indent)

      if (this.nodeTypeArr.get(id) !== T_XML_TAG) {
        parts.push(pad + (this.readString(this.valueOffsetArr, this.valueLengthArr, id) ?? ''))
        ids.pop()
        cursors.pop()
        indents.pop()
        continue
      }

      const name = this.readKey(id) ?? 'node'

      if (cursors[top] === -2) {
        const attrs = this.readString(this.attrOffsetArr, this.attrLengthArr, id)
        const attrStr = attrs ? ` ${attrs}` : ''
        const firstChild = this.firstRowChild(id)
        if (firstChild === NONE) {
          const inline = this.getInlineXmlText(id)
          parts.push(inline === null ? `${pad}<${name}${attrStr} />` : `${pad}<${name}${attrStr}>${inline}</${name}>`)
          ids.pop()
          cursors.pop()
          indents.pop()
          continue
        }
        parts.push(`${pad}<${name}${attrStr}>\n`)
        cursors[top] = firstChild
        ids.push(firstChild)
        cursors.push(-2)
        indents.push(indent + 1)
        continue
      }

      const nextChild = this.nextRowSibling(cursors[top])
      if (nextChild === NONE) {
        parts.push(`\n${pad}</${name}>`)
        ids.pop()
        cursors.pop()
        indents.pop()
        continue
      }
      parts.push('\n')
      cursors[top] = nextChild
      ids.push(nextChild)
      cursors.push(-2)
      indents.push(indent + 1)
    }

    return parts.join('')
  }
}
