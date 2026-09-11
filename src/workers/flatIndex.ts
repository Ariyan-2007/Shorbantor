import type { FlatNodeView, NodeType, ParseMode } from '../types/schema'
import { CONTAINER_TYPES } from '../types/schema'
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
  private firstChildIdArr = new GrowableArray(Int32Array, 1024)
  private lastChildIdArr = new GrowableArray(Int32Array, 1024)
  private nextSiblingIdArr = new GrowableArray(Int32Array, 1024)
  private siblingIndexArr = new GrowableArray(Uint32Array, 1024)
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
    this.firstChildIdArr.push(NONE)
    this.lastChildIdArr.push(NONE)
    this.nextSiblingIdArr.push(NONE)
    this.siblingIndexArr.push(this.linkIntoParent(params.parentId, id))

    this.writeString(this.keyOffsetArr, this.keyLengthArr, params.key)
    this.writeString(this.valueOffsetArr, this.valueLengthArr, params.value)
    this.writeString(this.attrOffsetArr, this.attrLengthArr, params.attributes)

    if (CONTAINER_TYPES.has(params.type)) {
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

  private linkIntoParent(parentId: number, childId: number): number {
    if (parentId === NONE) {
      const idx = this.topLevelCount++
      if (this.topLevelFirstId === NONE) this.topLevelFirstId = childId
      else this.nextSiblingIdArr.set(this.topLevelLastId, childId)
      this.topLevelLastId = childId
      return idx
    }
    const idx = this.childCountArr.get(parentId)
    this.childCountArr.set(parentId, idx + 1)
    if (this.firstChildIdArr.get(parentId) === NONE) {
      this.firstChildIdArr.set(parentId, childId)
    } else {
      this.nextSiblingIdArr.set(this.lastChildIdArr.get(parentId), childId)
    }
    this.lastChildIdArr.set(parentId, childId)
    return idx
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

  toggleExpand(nodeId: number) {
    if (nodeId < 0 || nodeId >= this.nodeCount) return
    if (this.childCountArr.get(nodeId) === 0) return
    this.setExpanded(nodeId, !this.isExpanded(nodeId))
  }

  expandToDepth(depth: number) {
    for (let id = 0; id < this.nodeCount; id++) {
      if (this.childCountArr.get(id) === 0) continue
      this.setExpanded(id, this.depthArr.get(id) < depth)
    }
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

    const pushSiblingsReversed = (firstId: number) => {
      const siblings: number[] = []
      let id = firstId
      while (id !== NONE) {
        siblings.push(id)
        id = this.nextSiblingIdArr.get(id)
      }
      for (let i = siblings.length - 1; i >= 0; i--) stack.push(siblings[i])
    }

    pushSiblingsReversed(this.topLevelFirstId)

    while (stack.length > 0) {
      const id = stack.pop() as number
      out.push(id)
      if (this.childCountArr.get(id) > 0 && this.isExpanded(id)) {
        pushSiblingsReversed(this.firstChildIdArr.get(id))
      }
    }

    const result = new Uint32Array(out.length)
    for (let i = 0; i < out.length; i++) result[i] = out.get(i)
    this.visibleOrder = result
  }

  getVisibleCount(): number {
    return this.visibleOrder.length
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

  getVisibleSlice(start: number, end: number): FlatNodeView[] {
    const clampedStart = Math.max(0, start)
    const clampedEnd = Math.min(end, this.visibleOrder.length)
    const out: FlatNodeView[] = []
    for (let i = clampedStart; i < clampedEnd; i++) {
      out.push(this.getNodeView(this.visibleOrder[i]))
    }
    return out
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

  getNodeView(id: number): FlatNodeView {
    return {
      id,
      parentId: this.parentIdArr.get(id),
      depth: this.depthArr.get(id),
      key: this.readKey(id),
      value: this.readString(this.valueOffsetArr, this.valueLengthArr, id),
      attributes: this.readString(this.attrOffsetArr, this.attrLengthArr, id),
      type: NODE_TYPE_NAMES[this.nodeTypeArr.get(id)],
      childCount: this.childCountArr.get(id),
      isExpanded: this.isExpanded(id),
      path: this.mode === 'xml' ? this.computeXmlPath(id) : this.computeJsonPath(id),
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
}
