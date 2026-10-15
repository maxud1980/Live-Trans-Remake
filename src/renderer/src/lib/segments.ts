// Groups the two independent transcript streams (source speech and its translation) into
// paired lines, so the UI and exports can show which translation belongs to which original.
//
// The model sends small text deltas for each stream with no shared ids or timestamps, and
// the translation trails the source by a second or two. Boundaries are therefore inferred:
//   - a pause: no delta on either stream for PAUSE_MS closes the current line;
//   - turnComplete or a reconnect closes it explicitly;
//   - very long continuous speech is split once both streams end a sentence, i.e. the
//     translation has caught up, so the split cannot separate a translation from its source.
// Translation that arrives shortly after its line was closed (a long lag) is attached to that
// line instead of starting a translation-only line. The window is short on purpose: a line
// that legitimately has no translation (speech already in the target language) must not
// swallow the translation of the next speaker.

export type Segment = {
  id: number
  source: string
  target: string
  open: boolean
}

export const PAUSE_MS = 1500
export const LONG_SEGMENT_MS = 25_000
export const LATE_TRANSLATION_WINDOW_MS = 1500
// A translation delta this soon after the previous one continues the same line, so one
// translated sentence is never split across two rows.
export const TARGET_CONTINUATION_MS = 800
// A newer line that has been speaking at least this long owns incoming translation; only a
// line that has barely started can lose a late translation to the line before it.
export const OPEN_LINE_GRACE_MS = 800
const LATE_TRANSLATION_LOOKBACK = 2
const SENTENCE_END = /[.!?…。！？]["»”)\]]*\s*$/

export class Segmenter {
  private segs: Segment[] = []
  private nextId = 1
  private lastActivity = 0
  private openedAt = 0
  private closedAt = new Map<number, number>()
  private lastTarget: { id: number; at: number } | null = null

  get segments(): Segment[] {
    return this.segs
  }

  /** Restore a previous list (e.g. after the app reloads a session). */
  reset(initial: Segment[] = []): void {
    this.segs = initial.map((s) => ({ ...s, open: false }))
    this.nextId = initial.reduce((m, s) => Math.max(m, s.id), 0) + 1
    this.lastActivity = 0
    this.openedAt = 0
    this.closedAt.clear()
    this.lastTarget = null
  }

  addSource(text: string, now: number): void {
    if (!text) return
    this.maybeCloseForPause(now)
    let seg = this.current()
    if (!seg) seg = this.open(now)
    this.patchLast({ source: seg.source + text })
    this.lastActivity = now
  }

  addTarget(text: string, now: number): void {
    if (!text) return
    this.maybeCloseForPause(now)

    // Continuation of the translation that is streaming right now.
    if (this.lastTarget && now - this.lastTarget.at < TARGET_CONTINUATION_MS) {
      const idx = this.indexOf(this.lastTarget.id)
      if (idx !== -1) return this.appendTarget(idx, text, now)
    }

    const open = this.current()
    // Late translation for a just-closed line whose translation never arrived — unless a
    // newer line has already been speaking for a while, in which case it is that line's.
    const openIsFresh = !open || (!open.target && now - this.openedAt < OPEN_LINE_GRACE_MS)
    if (openIsFresh) {
      const late = this.findMissingTranslation(open, now)
      if (late !== -1) return this.appendTarget(late, text, now)
    }
    if (!open) this.open(now)
    this.appendTarget(this.segs.length - 1, text, now)
  }

  private appendTarget(index: number, text: string, now: number): void {
    this.patchAt(index, { target: this.segs[index].target + text })
    this.lastTarget = { id: this.segs[index].id, at: now }
    this.lastActivity = now
  }

  private indexOf(id: number): number {
    for (let i = this.segs.length - 1; i >= 0 && i >= this.segs.length - 4; i--) {
      if (this.segs[i].id === id) return i
    }
    return -1
  }

  /** Call periodically; returns true when the list changed. */
  tick(now: number): boolean {
    const seg = this.current()
    if (!seg) return false
    if (now - this.lastActivity >= PAUSE_MS) return this.close(this.lastActivity + PAUSE_MS)
    if (
      now - this.openedAt >= LONG_SEGMENT_MS &&
      SENTENCE_END.test(seg.source) &&
      SENTENCE_END.test(seg.target)
    ) {
      return this.close(now)
    }
    return false
  }

  /**
   * Close the open line, if any. `now` is the logical close time: for a pause it is when the
   * pause began counting as one, not when the periodic tick noticed it. Returns true when the
   * list changed.
   */
  close(now = Date.now()): boolean {
    const seg = this.current()
    if (!seg) return false
    this.closedAt.set(seg.id, now)
    const trimmed = { source: seg.source.trim(), target: seg.target.trim() }
    if (!trimmed.source && !trimmed.target) {
      this.segs = this.segs.slice(0, -1)
      return true
    }
    this.patchLast({ ...trimmed, open: false })
    return true
  }

  private current(): Segment | null {
    const last = this.segs[this.segs.length - 1]
    return last && last.open ? last : null
  }

  private maybeCloseForPause(now: number): void {
    if (this.current() && now - this.lastActivity >= PAUSE_MS) this.close(this.lastActivity + PAUSE_MS)
  }

  private open(now: number): Segment {
    const seg: Segment = { id: this.nextId++, source: '', target: '', open: true }
    this.segs = [...this.segs, seg]
    this.openedAt = now
    return seg
  }

  // Index of the oldest recently-closed line that has source text but no translation yet.
  private findMissingTranslation(open: Segment | null, now: number): number {
    const end = this.segs.length - (open ? 1 : 0)
    const start = Math.max(0, end - LATE_TRANSLATION_LOOKBACK)
    for (let i = start; i < end; i++) {
      const s = this.segs[i]
      const closed = this.closedAt.get(s.id)
      if (s.source && !s.target && closed !== undefined && now - closed <= LATE_TRANSLATION_WINDOW_MS) return i
    }
    return -1
  }

  // Segments are replaced, never mutated, so memoized React rows only re-render when theirs changed.
  private patchLast(patch: Partial<Segment>): void {
    this.patchAt(this.segs.length - 1, patch)
  }

  private patchAt(index: number, patch: Partial<Segment>): void {
    const next = this.segs.slice()
    next[index] = { ...next[index], ...patch }
    this.segs = next
  }
}

/* ------------------------------ Sessions & export ------------------------------ */

export type SessionRecord = {
  id: string
  startedAt: number
  endedAt: number
  sourceLang: string
  targetLang: string
  audioSource: string
  segments: { source: string; target: string }[]
}

export type SessionSummary = Omit<SessionRecord, 'segments'> & {
  segmentCount: number
  preview: string
}

export type ExportMode = 'both' | 'target' | 'source'

export function newSessionId(startedAt: number): string {
  const d = new Date(startedAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-` +
    Math.random().toString(36).slice(2, 6)
  )
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Plain-text export. Deliberately has no timecodes: in live use the audio often comes from
 * different parts of a video, so wall-clock times would not match the media.
 */
export function formatTxt(
  session: Pick<SessionRecord, 'startedAt' | 'endedAt' | 'segments'>,
  labels: { source: string; target: string },
  mode: ExportMode
): string {
  const lines: string[] = []
  const end = new Date(session.endedAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  lines.push(`live-trans · ${formatDateTime(session.startedAt)}–${pad(end.getHours())}:${pad(end.getMinutes())}`)
  if (mode === 'both') lines.push(`${labels.source} → ${labels.target}`)
  else lines.push(mode === 'target' ? labels.target : labels.source)
  lines.push('')

  const segs = session.segments.filter((s) =>
    mode === 'both' ? s.source || s.target : mode === 'target' ? s.target : s.source
  )
  if (mode === 'both') {
    for (const s of segs) {
      lines.push(s.source || '—')
      lines.push(`→ ${s.target || '—'}`)
      lines.push('')
    }
  } else {
    for (const s of segs) lines.push(mode === 'target' ? s.target : s.source)
  }
  return lines.join('\n').trimEnd() + '\n'
}
