import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { type CSSProperties, type MouseEvent, type ReactNode, useState } from 'react'
import type { FlatNodeView } from '../types/schema'

const ROW_HEIGHT = 24
const INDENT_PX = 16
const ATTR_RE = /([\w:-]+)(=)("[^"]*"|'[^']*')/g

interface TreeRowProps {
  node: FlatNodeView
  style: CSSProperties
  onToggle: (nodeId: number) => void
}

function renderAttributes(attrs: string) {
  const parts: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  ATTR_RE.lastIndex = 0
  while ((match = ATTR_RE.exec(attrs))) {
    if (match.index > lastIndex) parts.push(attrs.slice(lastIndex, match.index))
    parts.push(
      <span key={match.index}>
        {' '}
        <span className="text-shb-attr">{match[1]}</span>
        <span className="text-shb-bracket">=</span>
        <span className="text-shb-string">{match[3]}</span>
      </span>,
    )
    lastIndex = ATTR_RE.lastIndex
  }
  if (lastIndex < attrs.length) parts.push(attrs.slice(lastIndex))
  return parts
}

function ValuePreview({ node }: { node: FlatNodeView }) {
  switch (node.type) {
    case 'object':
      return (
        <>
          <span className="text-shb-bracket">{'{'}</span>
          <span className="text-shb-text-faint">{node.childCount}</span>
          <span className="text-shb-bracket">{'}'}</span>
        </>
      )
    case 'array':
      return (
        <>
          <span className="text-shb-bracket">{'['}</span>
          <span className="text-shb-text-faint">{node.childCount}</span>
          <span className="text-shb-bracket">{']'}</span>
        </>
      )
    case 'string':
      return <span className="text-shb-string">"{node.value}"</span>
    case 'number':
      return <span className="text-shb-number">{node.value}</span>
    case 'boolean':
      return <span className="text-shb-boolean">{node.value}</span>
    case 'null':
      return <span className="text-shb-null italic">null</span>
    default:
      return null
  }
}

export default function TreeRow({ node, style, onToggle }: TreeRowProps) {
  const [copied, setCopied] = useState(false)
  const isContainer = node.type === 'object' || node.type === 'array' || node.type === 'xml_tag'
  const isExpandable = isContainer && node.childCount > 0

  const handleCopyPath = async (e: MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(node.path)
      setCopied(true)
      setTimeout(() => setCopied(false), 900)
    } catch {
      // Clipboard access denied — nothing sensible to fall back to here.
    }
  }

  return (
    <div
      style={{ ...style, height: ROW_HEIGHT }}
      className="group flex items-center whitespace-nowrap font-mono text-[13px] leading-none hover:bg-shb-accent-bg/60"
    >
      <div
        className="flex shrink-0 items-center"
        style={{ paddingLeft: 8 + node.depth * INDENT_PX, width: 20 }}
      >
        {isExpandable ? (
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            className="flex h-4 w-4 items-center justify-center rounded text-shb-text-muted hover:bg-shb-border"
            aria-label={node.isExpanded ? 'Collapse' : 'Expand'}
          >
            {node.isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : (
          <span className="h-4 w-4" />
        )}
      </div>

      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {node.type === 'xml_tag' ? (
          <>
            <span className="text-shb-bracket">{'<'}</span>
            <span className="text-shb-tag">{node.key}</span>
            {node.attributes && renderAttributes(node.attributes)}
            <span className="text-shb-bracket">{node.childCount > 0 ? '>' : ' />'}</span>
            {node.childCount > 0 && (
              <span className="text-shb-text-faint">{node.childCount} node{node.childCount === 1 ? '' : 's'}</span>
            )}
          </>
        ) : (
          <>
            {node.key !== null && (
              <>
                <span className="text-shb-key">{node.key}</span>
                <span className="text-shb-bracket">:</span>
              </>
            )}
            <ValuePreview node={node} />
          </>
        )}
      </div>

      <button
        type="button"
        onClick={handleCopyPath}
        className="ml-auto mr-2 hidden shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-shb-text-faint hover:bg-shb-border hover:text-shb-text group-hover:flex"
        title={`Copy path: ${node.path}`}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  )
}

export { ROW_HEIGHT }
