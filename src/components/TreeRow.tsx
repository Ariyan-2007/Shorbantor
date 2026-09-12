import { type CSSProperties, type MouseEvent, memo, useMemo } from 'react'
import { TOKEN_COLOR } from '../lib/colorTokens'
import type { FlatNodeView } from '../types/schema'
import { IconChevron } from './icons'

export const ROW_HEIGHT = 25
const FONT_SIZE = 12.5

const ATTR_PAIR_RE = /([\w:-]+)=("[^"]*"|'[^']*')/g

function parseAttrPairs(attrs: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = []
  ATTR_PAIR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_PAIR_RE.exec(attrs))) out.push({ name: m[1], value: m[2] })
  return out
}

interface TreeRowProps {
  node: FlatNodeView
  /** Vertical offset in px. Passed as a number rather than a style object so memo() can compare it. */
  top: number
  isSelected: boolean
  isHovered: boolean
  onToggle: (nodeId: number) => void
  onSelect: (node: FlatNodeView) => void
  onHoverChange: (path: string | null) => void
  onCopyPath: (node: FlatNodeView) => void
  onCopySubtree: (node: FlatNodeView) => void
  onCopyValue: (node: FlatNodeView) => void
}

/**
 * memo()'d because the viewer re-renders on every cache fill and every scroll
 * tick: without it each of those repainted all ~50 mounted rows, including
 * re-running the attribute regex for each one.
 */
function TreeRow({
  node,
  top,
  isSelected,
  isHovered,
  onToggle,
  onSelect,
  onHoverChange,
  onCopyPath,
  onCopySubtree,
  onCopyValue,
}: TreeRowProps) {
  const style: CSSProperties = useMemo(
    () => ({ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${top}px)` }),
    [top],
  )
  const attrPairs = useMemo(() => (node.attributes ? parseAttrPairs(node.attributes) : null), [node.attributes])

  const glyph =
    node.type === 'array' ? (node.isExpanded ? '[' : '[ ]') : node.type === 'object' ? (node.isExpanded ? '{' : '{ }') : node.isExpanded ? '<' : '< >'

  const bg = isSelected ? 'var(--color-accent-100)' : isHovered ? 'color-mix(in srgb, var(--color-accent-100) 55%, transparent)' : 'transparent'
  const mark = isSelected ? 'var(--color-accent)' : node.isSearchMatch ? 'var(--color-accent-400)' : 'transparent'

  const stop = (e: MouseEvent) => e.stopPropagation()

  return (
    <div
      className="sb-row"
      data-rid={node.path}
      style={{
        ...style,
        position: 'absolute',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: 'max-content',
        minWidth: '100%',
        minHeight: ROW_HEIGHT,
        padding: '0 12px 0 4px',
        background: bg,
        boxShadow: `inset 2px 0 0 ${mark}`,
        cursor: node.isContainer ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
      }}
      onClick={() => onSelect(node)}
      onMouseEnter={() => onHoverChange(node.isContainer ? node.path : null)}
    >
      {node.rails.map((solid, i) => (
        <span key={i} style={{ flex: '0 0 auto', width: 18, height: ROW_HEIGHT, borderLeft: `1px solid ${solid ? 'var(--app-guide)' : 'transparent'}` }} />
      ))}

      {node.depth > 0 && (
        <span style={{ flex: '0 0 auto', position: 'relative', width: 18, height: ROW_HEIGHT }}>
          <span
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: node.elbowExtendsDown ? '0' : '50%',
              borderLeft: '1px solid var(--app-guide)',
            }}
          />
          <span style={{ position: 'absolute', left: 0, top: '50%', width: 13, borderTop: '1px solid var(--app-guide)' }} />
        </span>
      )}

      {node.isContainer ? (
        <>
          <button
            onClick={(e) => {
              stop(e)
              onToggle(node.id)
            }}
            aria-label="Toggle node"
            style={{
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 15,
              height: 15,
              border: '1px solid var(--app-line)',
              background: 'var(--app-surface)',
              padding: 0,
              cursor: 'pointer',
              color: 'var(--app-muted)',
            }}
          >
            <IconChevron size={11} style={{ transform: `rotate(${node.isExpanded ? 90 : 0}deg)` }} />
          </button>
          <span style={{ flex: '0 0 auto', fontFamily: 'var(--app-mono)', fontSize: FONT_SIZE, color: 'var(--color-accent-700)', letterSpacing: '-0.06em' }}>
            {glyph}
          </span>
        </>
      ) : (
        <span style={{ flex: '0 0 auto', width: 8, height: 8, marginLeft: 4, background: TOKEN_COLOR[node.markerColorToken] }} />
      )}

      <span style={{ flex: '0 0 auto', fontFamily: 'var(--app-mono)', fontSize: FONT_SIZE, color: TOKEN_COLOR[node.keyColorToken], fontWeight: 500 }}>
        {node.keyPre}
        <span style={{ background: 'var(--color-accent-200)', color: 'var(--sx-key)', borderRadius: 2 }}>{node.keyMid}</span>
        {node.keyPost}
      </span>

      {attrPairs && (
        <span style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
          {attrPairs.map((a, i) => (
            <span key={i} style={{ fontFamily: 'var(--app-mono)', fontSize: FONT_SIZE }}>
              <span style={{ color: 'var(--sx-attr)' }}>{a.name}</span>
              <span style={{ color: 'var(--sx-punct)' }}>=</span>
              <span style={{ color: 'var(--sx-attrval)' }}>{a.value}</span>
            </span>
          ))}
        </span>
      )}

      {node.showColon && <span style={{ flex: '0 0 auto', color: 'var(--sx-punct)', fontFamily: 'var(--app-mono)', fontSize: FONT_SIZE }}>:</span>}

      <span
        style={{
          flex: '0 0 auto',
          maxWidth: '48ch',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontFamily: 'var(--app-mono)',
          fontSize: FONT_SIZE,
          color: TOKEN_COLOR[node.valueColorToken],
        }}
      >
        {node.valuePre}
        <span style={{ background: 'var(--color-accent-200)', color: 'var(--app-ink)', borderRadius: 2 }}>{node.valueMid}</span>
        {node.valuePost}
      </span>

      {node.isContainer && node.badge && (
        <span style={{ flex: '0 0 auto', fontFamily: 'var(--app-mono)', fontSize: 10, letterSpacing: '0.06em', color: 'var(--app-muted)' }}>
          {node.badge}
        </span>
      )}

      <span
        className="sb-act"
        style={{
          position: 'sticky',
          right: 0,
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          paddingLeft: 16,
          background: 'var(--app-hover)',
          boxShadow: '-14px 0 14px var(--app-hover)',
        }}
      >
        {node.isContainer ? (
          <>
            <ActButton label="PATH" title="Copy full path" onClick={(e) => (stop(e), onCopyPath(node))} />
            <ActButton label="SUBTREE" title="Copy this node and everything under it" onClick={(e) => (stop(e), onCopySubtree(node))} />
          </>
        ) : (
          <>
            <ActButton label="VALUE" title="Copy value" onClick={(e) => (stop(e), onCopyValue(node))} />
            <ActButton label="PATH" title="Copy full path" onClick={(e) => (stop(e), onCopyPath(node))} />
          </>
        )}
      </span>
    </div>
  )
}

export default memo(TreeRow)

function ActButton({ label, title, onClick }: { label: string; title: string; onClick: (e: MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        fontFamily: 'var(--app-mono)',
        fontSize: 10.5,
        letterSpacing: '0.06em',
        color: 'var(--color-accent-700)',
        background: 'var(--app-surface)',
        border: '1px solid var(--app-line)',
        borderRadius: 2,
        padding: '3px 8px',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}
