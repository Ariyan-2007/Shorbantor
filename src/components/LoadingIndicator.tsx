interface LoadingIndicatorProps {
  progress: number
  nodeCount: number
}

export default function LoadingIndicator({ progress, nodeCount }: LoadingIndicatorProps) {
  return (
    <div style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: 'var(--app-surface)' }}>
      <div
        className="animate-spin"
        style={{ width: 30, height: 30, borderRadius: '50%', border: '3px solid var(--app-guide)', borderTopColor: 'var(--color-accent)' }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <div style={{ fontFamily: 'var(--app-mono)', fontSize: 12, letterSpacing: '0.06em', color: 'var(--app-muted)' }}>
          PARSING LARGE DOCUMENT… {progress.toFixed(0)}%
        </div>
        <div style={{ width: 240, height: 4, background: 'var(--app-guide)', borderRadius: 2, overflow: 'hidden' }}>
          <div
            style={{
              width: `${Math.max(2, progress)}%`,
              height: '100%',
              background: 'var(--color-accent)',
              transition: 'width 120ms linear',
            }}
          />
        </div>
        {nodeCount > 0 && (
          <div style={{ fontFamily: 'var(--app-mono)', fontSize: 10.5, letterSpacing: '0.06em', color: 'var(--app-muted)' }}>
            {nodeCount.toLocaleString()} NODES INDEXED SO FAR
          </div>
        )}
      </div>
    </div>
  )
}
