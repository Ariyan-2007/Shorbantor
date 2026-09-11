interface StatusFooterProps {
  modeLabel: string
  nodeLabel: string
  depthLabel: string
  parseLabel: string
  showHint: boolean
}

export default function StatusFooter({ modeLabel, nodeLabel, depthLabel, parseLabel, showHint }: StatusFooterProps) {
  return (
    <footer
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '6px 14px',
        borderTop: '1px solid var(--app-line)',
        background: 'var(--app-bg)',
        flex: '0 0 auto',
        fontFamily: 'var(--app-mono)',
        fontSize: 10.5,
        letterSpacing: '0.06em',
        color: 'var(--app-muted)',
        overflowX: 'auto',
        whiteSpace: 'nowrap',
      }}
    >
      <span>{modeLabel}</span>
      <span>{nodeLabel}</span>
      <span>{depthLabel}</span>
      <span>{parseLabel}</span>
      {showHint && <span style={{ marginLeft: 'auto' }}>CLICK A ROW TO OPEN IT · ⌘F FILTER · ⏎ NEXT MATCH · E EXPAND ALL · C COLLAPSE ALL</span>}
    </footer>
  )
}
