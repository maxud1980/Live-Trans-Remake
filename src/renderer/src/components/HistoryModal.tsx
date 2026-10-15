import { useEffect, useMemo, useState } from 'react'
import type { HistoryRecord, HistorySummary } from '../env'
import { formatDateTime } from '../lib/segments'
import { ExportMenu, langName } from './ExportMenu'
import { Transcript, type TranscriptLine } from './Transcript'
import { t } from '../lib/i18n'

/** Past sessions: browse, re-read, export or delete. */
export function HistoryModal(props: {
  onClose: () => void
  activeSessionId: string | null
  onMessage: (message: string) => void
}): React.JSX.Element {
  const [items, setItems] = useState<HistorySummary[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [record, setRecord] = useState<HistoryRecord | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    void window.api.listHistory().then((list) => {
      setItems(list)
      if (list.length) setSelectedId(list[0].id)
    })
  }, [])

  useEffect(() => {
    setConfirmDelete(false)
    setRecord(null)
    if (!selectedId) return
    let cancelled = false
    void window.api.getHistory(selectedId).then((r) => {
      if (!cancelled) setRecord(r)
    })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  const lines: TranscriptLine[] = useMemo(
    () => (record?.segments ?? []).map((s, i) => ({ id: i + 1, source: s.source, target: s.target })),
    [record]
  )

  async function remove(): Promise<void> {
    if (!selectedId) return
    if (!confirmDelete) return setConfirmDelete(true)
    await window.api.deleteHistory(selectedId)
    const rest = (items ?? []).filter((i) => i.id !== selectedId)
    setItems(rest)
    setSelectedId(rest[0]?.id ?? null)
    setNotice(t('sessionDeleted'))
  }

  function report(message: string): void {
    setNotice(message)
    props.onMessage(message)
  }

  const recording = !!selectedId && selectedId === props.activeSessionId

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/55 p-6 backdrop-blur-sm"
      onClick={props.onClose}
    >
      <div
        className="no-drag flex h-[86vh] w-full max-w-5xl animate-pop-in flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">{t('history')}</h2>
            <p className="text-[11px] text-muted">{t('historySubtitle')}</p>
          </div>
          <button
            onClick={props.onClose}
            className="grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-foreground"
            title={t('close')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Session list */}
          <aside className="w-72 shrink-0 overflow-y-auto border-r border-border">
            {items === null ? (
              <p className="p-4 text-[12px] text-faint">{t('loading')}</p>
            ) : items.length === 0 ? (
              <p className="p-4 text-[12px] text-faint">{t('noSessions')}</p>
            ) : (
              items.map((it) => (
                <button
                  key={it.id}
                  onClick={() => setSelectedId(it.id)}
                  className={`block w-full border-b border-border/60 px-4 py-3 text-left transition ${
                    it.id === selectedId ? 'bg-elevated' : 'hover:bg-surface-2'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-medium text-foreground">{formatDateTime(it.startedAt)}</span>
                    <span className="text-[10px] text-faint">
                      {it.id === props.activeSessionId ? t('recording') : t('nLines', { n: it.segmentCount })}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted">
                    {langName(it.sourceLang)} → {langName(it.targetLang)}
                  </div>
                  {it.preview && <div className="mt-1 line-clamp-2 text-[11px] text-faint">{it.preview}</div>}
                </button>
              ))
            )}
          </aside>

          {/* Selected session */}
          <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
            {record ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium">
                      {formatDateTime(record.startedAt)} · {langName(record.sourceLang)} → {langName(record.targetLang)}
                    </p>
                    <p className="truncate text-[11px] text-faint">
                      {record.audioSource} · {t('nLines', { n: record.segments.length })}
                      {recording ? ` · ${t('stillRecording')}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <ExportMenu getSession={() => record} onResult={report} direction="down" />
                    <button
                      onClick={() => void remove()}
                      disabled={recording}
                      className={`h-10 rounded-lg border px-3 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                        confirmDelete
                          ? 'border-red-400/40 bg-red-400/10 text-red-300'
                          : 'border-border bg-surface text-muted hover:border-border-strong hover:text-red-300'
                      }`}
                    >
                      {confirmDelete ? t('confirmDelete') : t('delete')}
                    </button>
                  </div>
                </div>
                <Transcript
                  lines={lines}
                  sourceTitle={langName(record.sourceLang)}
                  targetTitle={t('translationColumn', { lang: langName(record.targetLang) })}
                  live={false}
                  emptyText={t('sessionEmpty')}
                />
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-[13px] text-faint">
                {items && items.length ? t('loading') : ''}
              </div>
            )}
            {notice && <p className="text-[11px] text-faint">{notice}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
