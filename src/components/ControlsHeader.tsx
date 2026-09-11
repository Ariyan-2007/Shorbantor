import {
  Braces,
  ChevronsDownUp,
  ChevronsUpDown,
  FileCode2,
  FileJson2,
  Layers,
  Loader2,
  Upload,
} from 'lucide-react'
import { type ChangeEvent, type DragEvent, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import type { ParseMode, ParseStats } from '../types/schema'
import type { ParserStatus } from '../hooks/useShorbantorParser'

interface ControlsHeaderProps {
  mode: ParseMode
  onModeChange: (mode: ParseMode) => void
  status: ParserStatus
  progress: number
  stats: ParseStats | null
  error: string | null
  fileName: string | null
  onFileSelected: (file: File) => void
  onLoadSample: () => void
  onExpandToDepth: (depth: number) => void
}

const DEPTH_SHORTCUTS = [
  { label: 'Collapse all', depth: 0 },
  { label: 'Depth 1', depth: 1 },
  { label: 'Depth 2', depth: 2 },
  { label: 'Depth 3', depth: 3 },
  { label: 'Expand all', depth: Number.POSITIVE_INFINITY },
]

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

export default function ControlsHeader({
  mode,
  onModeChange,
  status,
  progress,
  stats,
  error,
  fileName,
  onFileSelected,
  onLoadSample,
  onExpandToDepth,
}: ControlsHeaderProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const isLoading = status === 'loading'
  const isReady = status === 'ready'

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) onFileSelected(file)
  }

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onFileSelected(file)
    e.target.value = ''
  }

  return (
    <header className="flex shrink-0 flex-col border-b border-shb-border bg-shb-surface">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
        <div className="mr-1 flex items-center gap-2">
          <Braces size={18} className="text-shb-accent" />
          <span className="font-mono text-sm font-semibold tracking-tight text-shb-text">Shorbantor</span>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragOver(true)
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          className={cn(
            'flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed px-2.5 text-xs text-shb-text-muted transition-colors',
            isDragOver ? 'border-shb-accent bg-shb-accent-bg text-shb-accent' : 'border-shb-border-strong hover:bg-shb-bg',
          )}
        >
          <Upload size={13} />
          <span>{fileName ?? 'Drop a file or click to browse'}</span>
          <input ref={inputRef} type="file" accept=".json,.xml,application/json,text/xml,application/xml" className="hidden" onChange={handleInputChange} />
        </div>

        <div className="flex items-center gap-0.5 rounded-md border border-shb-border p-0.5">
          <button
            type="button"
            onClick={() => onModeChange('json')}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors',
              mode === 'json' ? 'bg-shb-accent-bg text-shb-accent' : 'text-shb-text-muted hover:bg-shb-bg',
            )}
          >
            <FileJson2 size={13} /> JSON
          </button>
          <button
            type="button"
            onClick={() => onModeChange('xml')}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors',
              mode === 'xml' ? 'bg-shb-accent-bg text-shb-accent' : 'text-shb-text-muted hover:bg-shb-bg',
            )}
          >
            <FileCode2 size={13} /> XML
          </button>
        </div>

        <button
          type="button"
          onClick={onLoadSample}
          className="flex h-8 items-center gap-1.5 rounded-md border border-shb-border px-2.5 text-xs font-medium text-shb-text-muted hover:bg-shb-bg"
        >
          <Layers size={13} />
          Load sample {mode.toUpperCase()}
        </button>

        <div className="mx-1 h-5 w-px bg-shb-border" />

        <div className={cn('flex items-center gap-1 rounded-md border border-shb-border p-0.5', !isReady && 'pointer-events-none opacity-40')}>
          {DEPTH_SHORTCUTS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => onExpandToDepth(s.depth)}
              title={s.label}
              className="flex h-7 items-center gap-1 rounded px-2 text-xs text-shb-text-muted hover:bg-shb-bg hover:text-shb-text"
            >
              {s.depth === 0 ? <ChevronsDownUp size={13} /> : s.depth === Number.POSITIVE_INFINITY ? <ChevronsUpDown size={13} /> : null}
              {s.depth === 0 || s.depth === Number.POSITIVE_INFINITY ? null : s.depth}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3 font-mono text-xs text-shb-text-muted">
          {isLoading && (
            <span className="flex items-center gap-1.5 text-shb-accent">
              <Loader2 size={13} className="animate-spin" />
              {progress.toFixed(0)}%
            </span>
          )}
          {isReady && stats && (
            <span>
              {stats.totalNodes.toLocaleString()} nodes · {formatBytes(stats.bytesTotal)} · {stats.elapsedMs.toFixed(0)}ms
            </span>
          )}
          {error && <span className="text-red-600">{error}</span>}
        </div>
      </div>

      {isLoading && (
        <div className="h-0.5 w-full bg-shb-border">
          <div className="h-full bg-shb-accent transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      )}
    </header>
  )
}
