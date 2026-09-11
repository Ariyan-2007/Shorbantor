import type { AncestorCrumb, ColorToken, FlatNodeView, InspectorRow, NodeType, ParseMode } from '../types/schema'
import type { ContainerType, IndexBuilder, LeafType } from './tokenizers/builderTypes'

const NONE = -1
const NULL_OFFSET = 0xffffffff
/** Root and its immediate children start expanded; deeper nodes start collapsed. */
const DEFAULT_EXPANDED_DEPTH = 2

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
  object: 0,
  array: 1,
  xml_tag: 2,
  string: 3,
  number: 4,
  boolean: 5,
  null: 6,
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
    const encoded = this.encoder.encode(str)
    this.ensureCapacity(this.length + encoded.length)
    this.bytes.set(encoded, this.length)
    const offset = this.length
    this.length += encoded.length
    return { offset, length: encoded.length }
  }

  read(offset: number, length: number): string {
    if (length === 0) return ''
    return this.decoder.decode(this.bytes.subarray(offset, offset + length))
  }
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

  private visibleOrder: Uint32Array = new Uint32Array(0)

  private activeQuery: string | null = null
  private searchVisibleOrder: Uint32Array = new Uint32Array(0)
  private searchMatchIds: number[] = []

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
    const type = NODE_TYPE_NAMES[this.nodeTypeArr.get(id)]
    if (parentId === NONE) return this.siblingIndexArr.get(id) === this.topLevelCount - 1
    if (type === 'xml_tag') return this.elementSiblingIndexArr.get(id) === this.elementChildCountArr.get(parentId) - 1
    return this.siblingIndexArr.get(id) === this.childCountArr.get(parentId) - 1
  }

  /** Root-first: one entry per ancestor, true if that ancestor has a following sibling (so its guide line must continue). */
  private getRails(id: number): boolean[] {
    const rails: boolean[] = []
    let cur = this.parentIdArr.get(id)
    while (cur !== NONE) {
      rails.unshift(!this.isLastChild(cur))
      cur = this.parentIdArr.get(cur)
    }
    return rails
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
    const type = NODE_TYPE_NAMES[this.nodeTypeArr.get(id)]
    if (type === 'xml_tag') return this.elementChildCountArr.get(id) > 0
    return this.childCountArr.get(id) > 0
  }

  private effectiveChildCount(id: number): number {
    const type = NODE_TYPE_NAMES[this.nodeTypeArr.get(id)]
    return type === 'xml_tag' ? this.elementChildCountArr.get(id) : this.childCountArr.get(id)
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

  /** Node ids that should appear as their own row under `id` when expanded — text/CDATA leaves under an xml_tag are absorbed into their parent's own row instead. */
  private childrenToVisit(id: number): number[] {
    const type = NODE_TYPE_NAMES[this.nodeTypeArr.get(id)]
    const out: number[] = []
    let c = this.firstChildIdArr.get(id)
    while (c !== NONE) {
      if (type !== 'xml_tag' || NODE_TYPE_NAMES[this.nodeTypeArr.get(c)] === 'xml_tag') out.push(c)
      c = this.nextSiblingIdArr.get(c)
    }
    return out
  }

  /** The inline text shown on a leaf xml_tag's own row (its absorbed text/CDATA content) — null for container or empty tags. */
  private getInlineXmlText(id: number): string | null {
    if (this.elementChildCountArr.get(id) > 0) return null
    if (this.childCountArr.get(id) === 0) return null
    const parts: string[] = []
    let c = this.firstChildIdArr.get(id)
    while (c !== NONE) {
      const v = this.readString(this.valueOffsetArr, this.valueLengthArr, c)
      if (v) parts.push(v)
      c = this.nextSiblingIdArr.get(c)
    }
    return parts.length > 0 ? parts.join(' ') : null
  }

  // ---- Visible order (depth filtering) -----------------------------------

  /**
   * Recomputed from scratch on every toggle/expand-to-depth rather than
   * patched incrementally: an incrementally-shifted flat list needs an
   * order-statistics structure to stay O(log n), which is overkill here —
   * a full DFS still runs entirely off the main thread and stays well under
   * a frame for tens of millions of nodes.
   */
  rebuildVisibleOrder() {
    const out = new GrowableArray(Uint32Array, Math.max(1024, this.nodeCount))
    const stack: number[] = []
    const pushReversed = (ids: number[]) => {
      for (let i = ids.length - 1; i >= 0; i--) stack.push(ids[i])
    }

    pushReversed(this.getTopLevelIds())

    while (stack.length > 0) {
      const id = stack.pop() as number
      out.push(id)
      if (this.isContainerNode(id) && this.isExpanded(id)) {
        pushReversed(this.childrenToVisit(id))
      }
    }

    const result = new Uint32Array(out.length)
    for (let i = 0; i < out.length; i++) result[i] = out.get(i)
    this.visibleOrder = result
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

  computeMaxDepth(): number {
    let max = 0
    const stack: [number, number][] = this.getTopLevelIds().map((id) => [id, 1] as [number, number])
    while (stack.length > 0) {
      const [id, depth] = stack.pop() as [number, number]
      if (depth > max) max = depth
      for (const c of this.childrenToVisit(id)) stack.push([c, depth + 1])
    }
    return max
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

  private hitSelf(id: number, q: string): boolean {
    const type = NODE_TYPE_NAMES[this.nodeTypeArr.get(id)]
    const key = this.readKey(id)
    if (key && key.toLowerCase().includes(q)) return true
    const parentId = this.parentIdArr.get(id)
    if (parentId !== NONE && NODE_TYPE_NAMES[this.nodeTypeArr.get(parentId)] === 'array') {
      if (String(this.siblingIndexArr.get(id)).includes(q)) return true
    }
    if (type === 'xml_tag') {
      const attrs = this.readString(this.attrOffsetArr, this.attrLengthArr, id)
      if (attrs && attrs.toLowerCase().includes(q)) return true
      const inline = this.getInlineXmlText(id)
      return !!inline && inline.toLowerCase().includes(q)
    }
    if (type !== 'object' && type !== 'array') {
      const value = this.readString(this.valueOffsetArr, this.valueLengthArr, id)
      if (value && value.toLowerCase().includes(q)) return true
    }
    return false
  }

  setSearchQuery(query: string): { matchCount: number; visibleCount: number } {
    const q = query.trim().toLowerCase()
    if (!q) {
      this.activeQuery = null
      this.searchVisibleOrder = new Uint32Array(0)
      this.searchMatchIds = []
      return { matchCount: 0, visibleCount: this.visibleOrder.length }
    }
    this.activeQuery = q

    const anyHit = new Uint8Array(this.nodeCount)
    for (let id = 0; id < this.nodeCount; id++) anyHit[id] = this.hitSelf(id, q) ? 1 : 0
    for (let id = this.nodeCount - 1; id >= 0; id--) {
      if (anyHit[id]) {
        const p = this.parentIdArr.get(id)
        if (p !== NONE) anyHit[p] = 1
      }
    }

    const out = new GrowableArray(Uint32Array, Math.max(1024, this.nodeCount))
    const matches: number[] = []
    const stack: number[] = []
    const pushReversed = (ids: number[]) => {
      for (let i = ids.length - 1; i >= 0; i--) if (anyHit[ids[i]]) stack.push(ids[i])
    }
    pushReversed(this.getTopLevelIds())

    while (stack.length > 0) {
      const id = stack.pop() as number
      out.push(id)
      if (this.hitSelf(id, q)) matches.push(id)
      if (this.isContainerNode(id)) pushReversed(this.childrenToVisit(id))
    }

    const result = new Uint32Array(out.length)
    for (let i = 0; i < out.length; i++) result[i] = out.get(i)
    this.searchVisibleOrder = result
    this.searchMatchIds = matches
    return { matchCount: matches.length, visibleCount: result.length }
  }

  getMatchPosition(matchIndex: number): number {
    if (matchIndex < 0 || matchIndex >= this.searchMatchIds.length) return -1
    const id = this.searchMatchIds[matchIndex]
    for (let i = 0; i < this.searchVisibleOrder.length; i++) {
      if (this.searchVisibleOrder[i] === id) return i
    }
    return -1
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
    const parentType = NODE_TYPE_NAMES[this.nodeTypeArr.get(parentId)]
    if (parentType === 'array') return { text: `[${this.siblingIndexArr.get(id)}]`, token: 'idx' }
    return { text: this.readKey(id) ?? '', token: 'key' }
  }

  getNodeView(id: number): FlatNodeView {
    const type = NODE_TYPE_NAMES[this.nodeTypeArr.get(id)]
    const isContainer = this.isContainerNode(id)
    const isExpanded = this.activeQuery ? isContainer : this.isExpanded(id)

    let valueText: string
    let valueColorToken: ColorToken
    if (type === 'string' || type === 'number' || type === 'boolean' || type === 'null') {
      const d = primDisplay(type, this.readString(this.valueOffsetArr, this.valueLengthArr, id))
      valueText = d.text
      valueColorToken = d.token
    } else if (type === 'xml_tag') {
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

    const markerColorToken: ColorToken = type === 'xml_tag' ? 'accent' : valueColorToken

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
      isSearchMatch: this.activeQuery !== null && this.hitSelf(id, this.activeQuery),
    }
  }

  private computeJsonPath(id: number): string {
    const segments: string[] = []
    let cur = id
    while (cur !== NONE) {
      const parentId = this.parentIdArr.get(cur)
      if (parentId === NONE) break
      const parentType = NODE_TYPE_NAMES[this.nodeTypeArr.get(parentId)]
      if (parentType === 'array') {
        segments.unshift(`[${this.siblingIndexArr.get(cur)}]`)
      } else {
        segments.unshift(`.${this.readKey(cur) ?? ''}`)
      }
      cur = parentId
    }
    return '$' + segments.join('')
  }

  private computeXmlPath(id: number): string {
    const segments: string[] = []
    let cur = id
    const isTextLeaf = NODE_TYPE_NAMES[this.nodeTypeArr.get(id)] !== 'xml_tag'
    while (cur !== NONE) {
      if (NODE_TYPE_NAMES[this.nodeTypeArr.get(cur)] === 'xml_tag') {
        segments.unshift(`${this.readKey(cur) ?? 'node'}[${this.siblingIndexArr.get(cur)}]`)
      }
      cur = this.parentIdArr.get(cur)
    }
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
        chain.unshift({ id: cur, label: 'root' })
      } else if (this.mode === 'xml') {
        chain.unshift({ id: cur, label: this.readKey(cur) ?? 'node' })
      } else {
        const parentType = NODE_TYPE_NAMES[this.nodeTypeArr.get(parentId)]
        chain.unshift({
          id: cur,
          label: parentType === 'array' ? `[${this.siblingIndexArr.get(cur)}]` : (this.readKey(cur) ?? ''),
        })
      }
      cur = parentId
    }
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
    const type = NODE_TYPE_NAMES[this.nodeTypeArr.get(nodeId)]
    if (type === 'xml_tag') return this.getInlineXmlText(nodeId) ?? ''
    if (type === 'object' || type === 'array') return this.getSubtreeText(nodeId)
    return this.readString(this.valueOffsetArr, this.valueLengthArr, nodeId) ?? ''
  }

  getSubtreeText(nodeId: number): string {
    return this.mode === 'xml' ? this.serializeXml(nodeId, 0) : JSON.stringify(this.toPlainValue(nodeId), null, 2)
  }

  private toPlainValue(nodeId: number): unknown {
    const type = NODE_TYPE_NAMES[this.nodeTypeArr.get(nodeId)]
    if (type === 'object') {
      const obj: Record<string, unknown> = {}
      let c = this.firstChildIdArr.get(nodeId)
      while (c !== NONE) {
        obj[this.readKey(c) ?? ''] = this.toPlainValue(c)
        c = this.nextSiblingIdArr.get(c)
      }
      return obj
    }
    if (type === 'array') {
      const arr: unknown[] = []
      let c = this.firstChildIdArr.get(nodeId)
      while (c !== NONE) {
        arr.push(this.toPlainValue(c))
        c = this.nextSiblingIdArr.get(c)
      }
      return arr
    }
    const raw = this.readString(this.valueOffsetArr, this.valueLengthArr, nodeId)
    if (type === 'number') return raw === null ? null : Number(raw)
    if (type === 'boolean') return raw === 'true'
    if (type === 'null') return null
    return raw
  }

  private serializeXml(nodeId: number, indent: number): string {
    const pad = '  '.repeat(indent)
    const type = NODE_TYPE_NAMES[this.nodeTypeArr.get(nodeId)]
    if (type !== 'xml_tag') {
      return pad + (this.readString(this.valueOffsetArr, this.valueLengthArr, nodeId) ?? '')
    }
    const name = this.readKey(nodeId) ?? 'node'
    const attrs = this.readString(this.attrOffsetArr, this.attrLengthArr, nodeId)
    const attrStr = attrs ? ` ${attrs}` : ''
    const elementChildren = this.childrenToVisit(nodeId)

    if (elementChildren.length === 0) {
      const inline = this.getInlineXmlText(nodeId)
      if (inline === null) return `${pad}<${name}${attrStr} />`
      return `${pad}<${name}${attrStr}>${inline}</${name}>`
    }

    const lines = [`${pad}<${name}${attrStr}>`]
    for (const c of elementChildren) lines.push(this.serializeXml(c, indent + 1))
    lines.push(`${pad}</${name}>`)
    return lines.join('\n')
  }
}
