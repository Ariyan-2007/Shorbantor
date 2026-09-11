import { TOKEN_COLOR } from '../lib/colorTokens'
import type { InspectorRow } from '../types/schema'

interface NodeInspectorProps {
  title: string
  rows: InspectorRow[]
  emptyLabel: string
  onRowClick: (childId: number) => void
  onCopyPath: () => void
  onCopySubtree: () => void
}

export default function NodeInspector({ title, rows, emptyLabel, onRowClick, onCopyPath, onCopySubtree }: NodeInspectorProps) {
  return (
    <aside style={{ flex: '0 0 300px', display: 'flex', flexDirection: 'column', minHeight: 0, borderLeft: '1px solid var(--app-line)', background: 'var(--app-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--app-line)' }}>
        <h6 style={{ margin: 0, fontSize: 11 }}>Node inspector</h6>
        <span
          style={{
            fontFamily: 'var(--app-mono)',
            fontSize: 10.5,
            color: 'var(--app-muted)',
            marginLeft: 'auto',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 150,
          }}
        >
          {title}
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 0,
          padding: '0 12px',
          height: 24,
          alignItems: 'center',
          borderBottom: '1px solid var(--app-line)',
          fontFamily: 'var(--app-mono)',
          fontSize: 10,
          letterSpacing: '0.12em',
          color: 'var(--app-muted)',
        }}
      >
        <span>NAME</span>
        <span>VALUE</span>
      </div>

      <div style={{ flex: '1 1 auto', overflow: 'auto' }}>
        {rows.map((row, i) => (
          <div
            key={i}
            className="sb-row"
            onClick={() => row.childId !== null && onRowClick(row.childId)}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              alignItems: 'center',
              gap: 0,
              padding: '0 12px',
              minHeight: 26,
              borderBottom: '1px solid var(--app-guide)',
              cursor: row.childId !== null ? 'pointer' : 'default',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
              <span style={{ flex: '0 0 auto', width: 7, height: 7, background: TOKEN_COLOR[row.markerColorToken] }} />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--app-mono)', fontSize: 12, color: 'var(--sx-key)' }}>
                {row.key}
              </span>
            </span>
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: 'var(--app-mono)',
                fontSize: 12,
                color: TOKEN_COLOR[row.valueColorToken],
              }}
            >
              {row.value}
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <div style={{ padding: '14px 12px', fontFamily: 'var(--app-mono)', fontSize: 11, lineHeight: 1.6, color: 'var(--app-muted)' }}>{emptyLabel}</div>
        )}
      </div>

      <div style={{ padding: '8px 12px', borderTop: '1px solid var(--app-line)', display: 'flex', gap: 6 }}>
        <button className="btn btn-secondary" onClick={onCopyPath} style={{ fontSize: 11.5, flex: '1 1 auto' }}>
          Copy path
        </button>
        <button className="btn btn-primary" onClick={onCopySubtree} style={{ fontSize: 11.5, flex: '1 1 auto' }}>
          Copy sub-tree
        </button>
      </div>
    </aside>
  )
}
