import { useVirtualizer } from '@tanstack/react-virtual'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import type { FlatNodeView } from '../types/schema'
import { IconEmpty } from './icons'
import TreeRow, { ROW_HEIGHT } from './TreeRow'

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
  const [cache, setCache] = useState<Map<number, FlatNodeView>>(new Map())
  const fetchTokenRef = useRef(0)

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
    setCache(new Map())
  }, [visibleCount])

  useEffect(() => {
    if (rangeEnd <= rangeStart) return
    const token = ++fetchTokenRef.current
    getVisibleNodes(rangeStart, rangeEnd).then((nodes) => {
      if (token !== fetchTokenRef.current) return
      setCache((prev) => {
        const next = new Map(prev)
        nodes.forEach((node, i) => next.set(rangeStart + i, node))
        return next
      })
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
          const style: CSSProperties = {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${vi.start}px)`,
          }
          const node = cache.get(vi.index)
          if (!node) {
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
              style={style}
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
