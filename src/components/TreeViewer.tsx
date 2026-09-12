import { useVirtualizer } from '@tanstack/react-virtual'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import type { FlatNodeView } from '../types/schema'
import { IconEmpty } from './icons'
import TreeRow, { ROW_HEIGHT } from './TreeRow'

/**
 * Rows fetched either side of the viewport so scrolling stays a little ahead of
 * the worker. Kept small deliberately: a large margin multiplies the rows
 * materialized per scroll tick, which cost more than the placeholder flicker it
 * was meant to hide (the virtualizer's own overscan already covers the edges).
 */
const FETCH_MARGIN = 16
/** Hard ceiling on retained rows — a few screens' worth, not the whole document. */
const MAX_CACHED_ROWS = 600

interface TreeViewerProps {
  visibleCount: number
  getVisibleNodes: (start: number, end: number) => Promise<FlatNodeView[]>
  onToggle: (nodeId: number) => void
  selectedNodeId: number | null
  onSelect: (node: FlatNodeView) => void
  hoveredPath: string | null
  onHoverChange: (path: string | null) => void
  onCopyPath: (node: FlatNodeView) => void
  onCopySubtree: (node: FlatNodeView) => void
  onCopyValue: (node: FlatNodeView) => void
  query: string
  jumpToIndex: { index: number; token: number } | null
}

/**
 * Renders only the rows the viewport can actually show (~50 DOM nodes,
 * regardless of tree size) and asks the worker for exactly that slice on
 * every range change — the full flat index never leaves the worker.
 */
export default function TreeViewer({
  visibleCount,
  getVisibleNodes,
  onToggle,
  selectedNodeId,
  onSelect,
  hoveredPath,
  onHoverChange,
  onCopyPath,
  onCopySubtree,
  onCopyValue,
  query,
  jumpToIndex,
}: TreeViewerProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  // Rows live in a mutable ref, not in state. The previous version copied the
  // whole Map on every fetch (`new Map(prev)`) and never evicted, so scrolling
  // a large document was O(rows seen) work per frame against a Map that grew
  // without bound — the dominant source of the viewer's memory growth. A
  // version counter drives re-render instead of a new Map identity.
  const cacheRef = useRef(new Map<number, FlatNodeView>())
  const [, bumpVersion] = useState(0)
  const fetchTokenRef = useRef(0)
  const generationRef = useRef(0)

  const virtualizer = useVirtualizer({
    count: visibleCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const rangeStart = virtualItems.length > 0 ? virtualItems[0].index : 0
  const rangeEnd = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index + 1 : 0

  // The set of node ids at any given visible-index shifts whenever a toggle
  // or search changes what's expanded/filtered, so previously cached rows
  // can no longer be trusted once the total changes.
  useEffect(() => {
    cacheRef.current.clear()
    generationRef.current++
    bumpVersion((v) => v + 1)
  }, [visibleCount])

  useEffect(() => {
    if (rangeEnd <= rangeStart) return
    const cache = cacheRef.current
    const from = Math.max(0, rangeStart - FETCH_MARGIN)
    const to = Math.min(visibleCount, rangeEnd + FETCH_MARGIN)

    // Ask only for the span that is actually missing. Materializing a row is
    // not free on the worker side (it builds the node's path and guide rails)
    // and every row also has to be structured-cloned across the boundary, so
    // refetching rows already held turns each scroll tick into avoidable work.
    // Nudging the scrollbar usually leaves nothing to fetch at all.
    let missFrom = -1
    let missTo = -1
    for (let i = from; i < to; i++) {
      if (cache.has(i)) continue
      if (missFrom < 0) missFrom = i
      missTo = i + 1
    }
    if (missFrom < 0) return

    const token = ++fetchTokenRef.current
    const generation = generationRef.current
    getVisibleNodes(missFrom, missTo).then((nodes) => {
      if (token !== fetchTokenRef.current || generation !== generationRef.current) return
      const live = cacheRef.current
      for (let i = 0; i < nodes.length; i++) live.set(missFrom + i, nodes[i])
      // Keep the cache bounded no matter how far the document is scrolled;
      // rows outside the retained window are cheap to fetch again.
      if (live.size > MAX_CACHED_ROWS) {
        const keepFrom = from - MAX_CACHED_ROWS
        const keepTo = to + MAX_CACHED_ROWS
        for (const index of live.keys()) {
          if (index < keepFrom || index > keepTo) live.delete(index)
        }
      }
      bumpVersion((v) => v + 1)
    })
  }, [rangeStart, rangeEnd, getVisibleNodes, visibleCount])

  useEffect(() => {
    if (jumpToIndex && jumpToIndex.index >= 0) {
      virtualizer.scrollToIndex(jumpToIndex.index, { align: 'center' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToIndex])

  if (visibleCount === 0) {
    return (
      <div style={{ flex: '1 1 auto', overflow: 'auto', background: 'var(--app-surface)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, height: '60vh', color: 'var(--app-muted)' }}>
          <IconEmpty size={34} />
          <div style={{ fontFamily: 'var(--app-mono)', fontSize: 12, letterSpacing: '0.06em' }}>
            {query ? `NO NODES MATCH “${query}”` : 'NOTHING TO INSPECT YET'}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div id="sb-tree" ref={parentRef} style={{ flex: '1 1 auto', overflow: 'auto', padding: '8px 0 40px', minWidth: 0 }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualItems.map((vi) => {
          const node = cacheRef.current.get(vi.index)
          if (!node) {
            const style: CSSProperties = {
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${vi.start}px)`,
            }
            return (
              <div
                key={vi.key}
                style={{ ...style, height: ROW_HEIGHT, background: 'var(--app-guide)', opacity: 0.4 }}
                className="animate-pulse"
              />
            )
          }
          return (
            <TreeRow
              key={vi.key}
              node={node}
              top={vi.start}
              isSelected={node.id === selectedNodeId}
              isHovered={!!hoveredPath && node.path.startsWith(hoveredPath) && node.path !== hoveredPath}
              onToggle={onToggle}
              onSelect={onSelect}
              onHoverChange={onHoverChange}
              onCopyPath={onCopyPath}
              onCopySubtree={onCopySubtree}
              onCopyValue={onCopyValue}
            />
          )
        })}
      </div>
    </div>
  )
}
