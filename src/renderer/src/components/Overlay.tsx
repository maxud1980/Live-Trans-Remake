import { useEffect, useRef, useState } from 'react'
import type { OverlayLine, OverlaySettings } from '../env'
import { setUiLanguage, t } from '../lib/i18n'

const DEFAULTS: OverlaySettings = { fontSize: 28, lines: 2, showOriginal: false, locked: false }

/**
 * The floating subtitles window. Unlocked: drag anywhere to move, corner grip to resize,
 * toolbar for text size / lines / original. Locked: clicks pass through to the app below;
 * hovering shows a small unlock button (the only clickable spot).
 */
export function Overlay(): React.JSX.Element {
  const [settings, setSettings] = useState<OverlaySettings>(DEFAULTS)
  const [lines, setLines] = useState<OverlayLine[]>([])
  const [hover, setHover] = useState(false)
  const [, setLangTick] = useState(0)

  useEffect(() => {
    document.documentElement.classList.add('overlay')
    void window.api.getSettings().then((s) => {
      setUiLanguage(s.uiLanguage)
      setLangTick((n) => n + 1)
    })
    void window.api.getOverlaySettings().then(setSettings)
    void window.api.getOverlayLines().then(setLines)
    const offLines = window.api.onOverlayLines(setLines)
    const offSettings = window.api.onOverlaySettings(setSettings)
    const offLang = window.api.onUiLanguage((lang) => {
      setUiLanguage(lang)
      setLangTick((n) => n + 1)
    })
    return () => {
      offLines()
      offSettings()
      offLang()
    }
  }, [])

  const update = (patch: Partial<OverlaySettings>): void => {
    setSettings((s) => ({ ...s, ...patch }))
    void window.api.setOverlaySettings(patch)
  }

  const shown = lines
    .filter((l) => l.target.trim() || (settings.showOriginal && l.source.trim()))
    .slice(-settings.lines)
  const locked = settings.locked
  const empty = shown.length === 0

  return (
    <div
      className="flex h-full w-full p-1.5"
      onMouseMove={() => !hover && setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        className={`relative flex h-full w-full flex-col justify-end overflow-hidden rounded-2xl px-5 py-3 transition-colors ${
          locked ? (empty ? 'bg-transparent' : 'bg-black/55') : 'overlay-drag bg-black/65 ring-1 ring-white/20'
        }`}
      >
        {empty && !locked && (
          <p className="pointer-events-none mb-auto mt-auto text-center text-[14px] text-white/70">{t('overlayPlaceholder')}</p>
        )}

        {shown.map((l, i) => (
          <div key={i} className="overlay-text text-center">
            {settings.showOriginal && l.source.trim() && (
              <p className="leading-snug text-white/70" style={{ fontSize: Math.round(settings.fontSize * 0.62) }}>
                {l.source.trim()}
              </p>
            )}
            {l.target.trim() && (
              <p className="font-semibold leading-snug text-white" style={{ fontSize: settings.fontSize }}>
                {l.target.trim()}
              </p>
            )}
          </div>
        ))}

        {/* Toolbar: always while unlocked, only the unlock button while locked. */}
        {!locked ? (
          <div className="overlay-no-drag absolute right-2 top-2 flex items-center gap-1 rounded-lg bg-black/70 p-1 text-white/85 ring-1 ring-white/15">
            <ToolButton title={t('overlaySmaller')} onClick={() => update({ fontSize: settings.fontSize - 2 })}>
              <span className="text-[11px] font-semibold">A−</span>
            </ToolButton>
            <ToolButton title={t('overlayLarger')} onClick={() => update({ fontSize: settings.fontSize + 2 })}>
              <span className="text-[14px] font-semibold">A+</span>
            </ToolButton>
            <ToolButton title={t('overlayLines')} onClick={() => update({ lines: (settings.lines % 4) + 1 })}>
              <span className="flex items-center gap-1 text-[11px] font-semibold">
                <LinesIcon /> {settings.lines}
              </span>
            </ToolButton>
            <ToolButton
              title={t('overlayOriginal')}
              active={settings.showOriginal}
              onClick={() => update({ showOriginal: !settings.showOriginal })}
            >
              <span className="text-[11px] font-semibold">Aa</span>
            </ToolButton>
            <ToolButton title={t('overlayLock')} onClick={() => update({ locked: true })}>
              <LockIcon locked={false} />
            </ToolButton>
            <ToolButton title={t('overlayHide')} onClick={() => void window.api.hideOverlay()}>
              <CloseIcon />
            </ToolButton>
          </div>
        ) : (
          hover && (
            <button
              title={t('overlayUnlock')}
              // The window ignores the mouse while locked; it becomes clickable only while the
              // cursor is on this button.
              onMouseEnter={() => window.api.setOverlayInteractive(true)}
              onMouseLeave={() => window.api.setOverlayInteractive(false)}
              onClick={() => {
                window.api.setOverlayInteractive(false)
                update({ locked: false })
              }}
              className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-lg bg-black/60 text-white/80 ring-1 ring-white/15 hover:text-white"
            >
              <LockIcon locked />
            </button>
          )
        )}

        {!locked && <ResizeGrip />}
      </div>
    </div>
  )
}

function ToolButton(props: {
  title: string
  onClick: () => void
  active?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={props.title}
      onClick={props.onClick}
      className={`grid h-7 min-w-7 place-items-center rounded-md px-1.5 transition hover:bg-white/15 ${
        props.active ? 'bg-white/20 text-white' : ''
      }`}
    >
      {props.children}
    </button>
  )
}

// Transparent windows have no usable OS resize border, so the overlay resizes itself.
function ResizeGrip(): React.JSX.Element {
  const start = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const frame = useRef(0)
  return (
    <div
      title={t('overlayResize')}
      className="overlay-no-drag absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.screenX, y: e.screenY, w: window.innerWidth, h: window.innerHeight }
      }}
      onPointerMove={(e) => {
        const s = start.current
        if (!s) return
        const width = s.w + (e.screenX - s.x)
        const height = s.h + (e.screenY - s.y)
        cancelAnimationFrame(frame.current)
        frame.current = requestAnimationFrame(() => window.api.resizeOverlay({ width, height }))
      }}
      onPointerUp={() => {
        start.current = null
      }}
    >
      <svg width="20" height="20" viewBox="0 0 20 20" className="text-white/50">
        <path d="M18 8v10H8M18 13v5h-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </div>
  )
}

function LockIcon({ locked }: { locked: boolean }): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d={locked ? 'M8 11V7a4 4 0 0 1 8 0v4' : 'M8 11V7a4 4 0 0 1 7.5-2'} />
    </svg>
  )
}

function LinesIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M4 7h16M4 12h16M4 17h10" />
    </svg>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}
