import { memo, useLayoutEffect, useRef } from 'react'
import { t } from '../lib/i18n'

export type TranscriptLine = { id: number; source: string; target: string; open?: boolean }

// Rendering every line of a two-hour session on each delta would get slow; older lines stay
// in memory, history and exports, only the visible tail is capped.
const MAX_RENDERED = 400

/**
 * Paired transcript: each row is one spoken line with its translation beside it, so it is
 * always clear which translation belongs to which original.
 */
export function Transcript(props: {
  lines: TranscriptLine[]
  sourceTitle: string
  targetTitle: string
  live: boolean
  emptyText: string
  // Optional controls shown at the right end of the header (e.g. Export).
  actions?: React.ReactNode
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Follow new lines only while the reader is at the bottom; scrolling up to re-read pauses it.
  const stickRef = useRef(true)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [props.lines])

  const hidden = Math.max(0, props.lines.length - MAX_RENDERED)
  const visible = hidden ? props.lines.slice(hidden) : props.lines

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface/40">
      <div className="grid min-h-11 grid-cols-2 items-center gap-6 border-b border-border py-1.5 pl-4 pr-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{props.sourceTitle}</span>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">{props.targetTitle}</span>
          <div className="flex items-center gap-3">
            {props.live && (
              <span className="flex items-center gap-1.5 text-[10px] text-faint">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                {t('live')}
              </span>
            )}
            {props.actions}
          </div>
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
        className="flex-1 overflow-y-auto px-4"
      >
        {props.lines.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="max-w-[20rem] text-center text-[13px] text-faint">{props.emptyText}</p>
          </div>
        ) : (
          <>
            {hidden > 0 && (
              <p className="py-2 text-center text-[11px] text-faint">
                {t('earlierLines', { n: hidden })}
              </p>
            )}
            {visible.map((line) => (
              <Row key={line.id} line={line} />
            ))}
          </>
        )}
      </div>
    </section>
  )
}

// Memoized per line: a new delta only re-renders the one row whose text changed.
const Row = memo(function Row({ line }: { line: TranscriptLine }): React.JSX.Element {
  return (
    <div
      className={`grid grid-cols-2 gap-6 border-b border-border/50 py-2.5 text-[15px] leading-relaxed last:border-b-0 ${
        line.open ? 'text-foreground' : 'text-foreground/85'
      }`}
    >
      <p className="whitespace-pre-wrap text-foreground/70">{line.source || <span className="text-faint">—</span>}</p>
      <p className="whitespace-pre-wrap">
        {line.target || (line.open ? <span className="text-faint">…</span> : <span className="text-faint">—</span>)}
      </p>
    </div>
  )
})
