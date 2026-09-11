export interface ToastState {
  msg: string
  kind: 'ok' | 'err'
}

export default function Toast({ toast }: { toast: ToastState | null }) {
  if (!toast) return null
  const line = toast.kind === 'err' ? '#b4693f' : 'var(--color-accent)'
  return (
    <div
      className="blueprint elev-md"
      style={{
        position: 'fixed',
        right: 18,
        bottom: 18,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        background: 'var(--app-surface)',
        border: `1px solid ${line}`,
        maxWidth: 360,
      }}
    >
      <i className="corner tl" />
      <i className="corner tr" />
      <i className="corner bl" />
      <i className="corner br" />
      <span style={{ width: 6, height: 6, background: line, flex: '0 0 auto' }} />
      <span style={{ fontFamily: 'var(--app-mono)', fontSize: 12, color: 'var(--app-ink)', lineHeight: 1.45 }}>{toast.msg}</span>
    </div>
  )
}
