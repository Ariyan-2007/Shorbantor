import { FileJson2 } from 'lucide-react'
import { useCallback, useState } from 'react'
import ControlsHeader from './components/ControlsHeader'
import TreeViewer from './components/TreeViewer'
import { useShorbantorParser } from './hooks/useShorbantorParser'
import { generateSampleJsonFile, generateSampleXmlFile } from './lib/sampleData'
import type { ParseMode } from './types/schema'

export default function App() {
  const [mode, setMode] = useState<ParseMode>('json')
  const [fileName, setFileName] = useState<string | null>(null)
  const { status, progress, error, stats, visibleCount, loadFile, toggleExpand, expandToDepth, getVisibleNodes } =
    useShorbantorParser()

  const handleFileSelected = useCallback(
    (file: File) => {
      const inferredMode: ParseMode = file.name.toLowerCase().endsWith('.xml') ? 'xml' : mode
      setMode(inferredMode)
      setFileName(file.name)
      loadFile(file, inferredMode)
    },
    [mode, loadFile],
  )

  const handleLoadSample = useCallback(() => {
    const file = mode === 'json' ? generateSampleJsonFile() : generateSampleXmlFile()
    setFileName(file.name)
    loadFile(file, mode)
  }, [mode, loadFile])

  return (
    <div className="flex h-full min-h-0 flex-col bg-shb-bg">
      <ControlsHeader
        mode={mode}
        onModeChange={setMode}
        status={status}
        progress={progress}
        stats={stats}
        error={error}
        fileName={fileName}
        onFileSelected={handleFileSelected}
        onLoadSample={handleLoadSample}
        onExpandToDepth={expandToDepth}
      />

      <main className="flex min-h-0 flex-1 flex-col">
        {status === 'ready' ? (
          <TreeViewer visibleCount={visibleCount} getVisibleNodes={getVisibleNodes} onToggle={toggleExpand} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-shb-text-faint">
            <FileJson2 size={32} strokeWidth={1.5} />
            <p className="text-sm">
              {status === 'loading'
                ? 'Streaming and indexing your file…'
                : status === 'error'
                  ? 'Something went wrong parsing that file.'
                  : 'Drop a JSON or XML file above, or load a sample to get started.'}
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
