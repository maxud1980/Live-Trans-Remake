import { useEffect, useRef, useState } from 'react'
import { formatTxt, type ExportMode, type SessionRecord } from '../lib/segments'
import { shortLabel } from '../lib/languages'
import { t, type StringKey } from '../lib/i18n'

export function langName(code: string): string {
  return code === 'auto' ? t('autoDetect') : shortLabel(code)
}

type ExportSource = Pick<SessionRecord, 'startedAt' | 'endedAt' | 'sourceLang' | 'targetLang' | 'segments'>

function fileName(s: ExportSource, mode: ExportMode): string {
  const d = new Date(s.startedAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`
  const suffix = mode === 'both' ? `${s.sourceLang}-${s.targetLang}` : mode === 'target' ? s.targetLang : s.sourceLang
  return `live-trans_${stamp}_${suffix}.txt`
}

const OPTIONS: { mode: ExportMode; label: StringKey }[] = [
  { mode: 'both', label: 'exportBoth' },
  { mode: 'target', label: 'exportTarget' },
  { mode: 'source', label: 'exportSource' }
]

/** Save-as-TXT and copy actions for a session (the live one or one from History). */
export function ExportMenu(props: {
  getSession: () => ExportSource | null
  disabled?: boolean
  onResult: (message: string) => void
  align?: 'left' | 'right'
  direction?: 'up' | 'down'
  compact?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  function text(mode: ExportMode): { s: ExportSource; body: string } | null {
    const s = props.getSession()
    if (!s || s.segments.length === 0) return null
    return { s, body: formatTxt(s, { source: langName(s.sourceLang), target: langName(s.targetLang) }, mode) }
  }

  async function save(mode: ExportMode): Promise<void> {
    setOpen(false)
    const out = text(mode)
    if (!out) return props.onResult(t('nothingToExport'))
    const res = await window.api.saveTextFile(fileName(out.s, mode), out.body)
    if (res.ok) props.onResult(t('exportedTo', { path: res.path ?? '' }))
    else if (!res.canceled) props.onResult(t('exportFailed', { message: res.error ?? t('unknownError') }))
  }

  async function copy(mode: ExportMode): Promise<void> {
    setOpen(false)
    const out = text(mode)
    if (!out) return props.onResult(t('nothingToCopy'))
    await window.api.copyText(out.body)
    props.onResult(t('copied'))
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={props.disabled}
        className={`flex items-center gap-2 rounded-lg border border-border bg-surface font-medium text-muted transition hover:border-border-strong hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 ${
          props.compact ? 'h-8 px-2.5 text-[12px]' : 'h-10 px-3 text-[13px]'
        }`}
      >
        <DownloadIcon /> {t('export')}
      </button>
      {open && (
        <div
          className={`absolute z-40 w-60 animate-pop-in overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl ${
            props.align === 'left' ? 'left-0' : 'right-0'
          } ${props.direction === 'down' ? (props.compact ? 'top-10' : 'top-12') : 'bottom-12'}`}
        >
          <p className="px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">{t('saveAsTxt')}</p>
          {OPTIONS.map((o) => (
            <button
              key={o.mode}
              onClick={() => void save(o.mode)}
              className="block w-full px-3 py-2 text-left text-[13px] text-foreground transition hover:bg-elevated"
            >
              {t(o.label)}
            </button>
          ))}
          <div className="my-1 border-t border-border" />
          <p className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">{t('copy')}</p>
          <button
            onClick={() => void copy('both')}
            className="block w-full px-3 py-2 text-left text-[13px] text-foreground transition hover:bg-elevated"
          >
            {t('exportBoth')}
          </button>
          <button
            onClick={() => void copy('target')}
            className="mb-1 block w-full px-3 py-2 text-left text-[13px] text-foreground transition hover:bg-elevated"
          >
            {t('exportTarget')}
          </button>
        </div>
      )}
    </div>
  )
}

function DownloadIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
    </svg>
  )
}
