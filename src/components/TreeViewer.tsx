import { useVirtualizer } from '@tanstack/react-virtual'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import type { FlatNodeView } from '../types/schema'
import TreeRow, { ROW_HEIGHT } from './TreeRow'

interface TreeViewerProps {
  visibleCount: number
  getVisibleNodes: (start: number, end: number) => Promise<FlatNodeView[]>
  onToggle: (nodeId: number) => void
}

/**
 * Renders only the rows the viewport can actually show (~50 DOM nodes,
 * regardless of tree size) and asks the worker for exactly that slice on
 * every range change — the full flat index never leaves the worker.
 */
export default function TreeViewer({ visibleCount, getVisibleNodes, onToggle }: TreeViewerProps) {
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
  // changes what's expanded, so previously cached rows can no longer be
  // trusted once the total changes.
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

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto bg-shb-surface">
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
                style={{ ...style, height: ROW_HEIGHT }}
                className="animate-pulse bg-shb-border/40"
              />
            )
          }
          return <TreeRow key={vi.key} node={node} style={style} onToggle={onToggle} />
        })}
      </div>
    </div>
  )
}
