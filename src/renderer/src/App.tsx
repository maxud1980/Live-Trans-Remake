import { memo, useEffect, useRef, useState } from 'react'
import { LANGUAGES, shortLabel } from './lib/languages'
import { SystemAudioCapture } from './audio/capture'
import { MicrophoneAudioCapture } from './audio/microphone'
import { LiveTranslateClient } from './gemini/liveClient'

type Status = 'idle' | 'connecting' | 'listening' | 'error'
type AudioDevice = { deviceId: string; label: string }
const SYSTEM_AUDIO_ID = '__system_audio__'

// Transcripts stream for the whole length of a video; cap the retained text so a long
// session can't grow an unbounded string that re-renders slower and slower.
const MAX_TRANSCRIPT_CHARS = 8000
function appendCapped(prev: string, addition: string): string {
  const next = prev + addition
  return next.length > MAX_TRANSCRIPT_CHARS ? next.slice(next.length - MAX_TRANSCRIPT_CHARS) : next
}

const STATUS_LABEL: Record<Status, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  listening: 'Listening',
  error: 'Error'
}

export default function App(): React.JSX.Element {
  const [apiKey, setApiKey] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  const [sourceLang, setSourceLang] = useState('auto')
  const [targetLang, setTargetLang] = useState('en')
  const [audioSourceId, setAudioSourceId] = useState(SYSTEM_AUDIO_ID)
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')
  const [level, setLevel] = useState(0)

  // Transcripts arrive as incremental deltas (small fragments), so we append them.
  // turnComplete is rare/absent for this model; we add a line break when it does arrive.
  const [original, setOriginal] = useState('')
  const [translated, setTranslated] = useState('')
  const [showSettings, setShowSettings] = useState(true)
  // macOS uses a hidden-inset title bar (content slides under the traffic lights); Windows/Linux
  // keep the native frame, so we only reserve the traffic-light strip on macOS.
  const [isMac, setIsMac] = useState(false)

  const systemCaptureRef = useRef<SystemAudioCapture | null>(null)
  const microphoneCaptureRef = useRef<MicrophoneAudioCapture | null>(null)
  const clientRef = useRef<LiveTranslateClient | null>(null)
  const startingRef = useRef(false)
  const microphonePrimeRef = useRef<Promise<boolean> | null>(null)
  const origRef = useRef<HTMLDivElement | null>(null)
  const transRef = useRef<HTMLDivElement | null>(null)

  const running = status === 'connecting' || status === 'listening'
  const targetName = shortLabel(targetLang)
  const sourceName = sourceLang === 'auto' ? 'Auto-detect' : shortLabel(sourceLang)

  // ---- initial load ----
  useEffect(() => {
    void window.api.debugLog('app.mount', { href: window.location.href, userAgent: navigator.userAgent, platform: navigator.platform, language: navigator.language })
    const onDeviceChange = () => {
      void window.api.debugLog('mediaDevices.devicechange')
      void refreshDevices()
    }
    navigator.mediaDevices?.addEventListener('devicechange', onDeviceChange)
    void navigator.permissions?.query({ name: 'microphone' as PermissionName }).then((permission) => {
      void window.api.debugLog('permissions.microphone.initial', { state: permission.state })
      permission.onchange = () => void window.api.debugLog('permissions.microphone.change', { state: permission.state })
    }).catch((err) => {
      void window.api.debugLog('permissions.microphone.query-error', { error: String(err) })
    })
    void window.api.getDebugLogPath().then((path) => window.api.debugLog('debug-log-path', { path }))
    let cancelled = false

    void (async () => {
      try {
        void window.api.debugLog('app.initial-load.begin')
        const s = await window.api.getSettings()
        void window.api.debugLog('app.initial-load.settings', { ...s, apiKey: s.apiKey ? '<present>' : '' })
        if (cancelled) return

        setApiKey(s.apiKey)
        setKeySaved(s.hasApiKey)
        setSourceLang(s.sourceLang)
        setTargetLang(s.targetLang)
        setAudioSourceId(s.audioSourceId || SYSTEM_AUDIO_ID)
        setIsMac(s.platform === 'darwin')
        if (s.hasApiKey) setShowSettings(false)

        // Let Chromium's getUserMedia be the only microphone authorization path.
        // Prime it exactly once on macOS so device labels become available, then only
        // enumerate on subsequent device-change events. Calling getUserMedia from
        // refreshDevices() itself would re-trigger TCC when macOS reports a devicechange.
        if (!cancelled) {
          if (s.platform === 'darwin') await ensureMicrophoneAccess()
          await refreshDevices()
        }
      } catch (err) {
        void window.api.debugLog('app.initial-load.error', { error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) })
        // Permission/device enumeration errors are handled when capture starts.
      }
    })()

    return () => {
      cancelled = true
      navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange)
      void window.api.debugLog('app.unmount')
    }
  }, [])

  // auto-scroll transcripts
  useEffect(() => {
    origRef.current?.scrollTo({ top: origRef.current.scrollHeight })
  }, [original])
  useEffect(() => {
    transRef.current?.scrollTo({ top: transRef.current.scrollHeight })
  }, [translated])

  async function ensureMicrophoneAccess(): Promise<boolean> {
    if (!isMac) return true
    if (microphonePrimeRef.current) return microphonePrimeRef.current

    const promise = (async () => {
      try {
        void window.api.debugLog('devices.prime-microphone.begin')
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach((track) => track.stop())
        void window.api.debugLog('devices.prime-microphone.success')
        return true
      } catch (err) {
        void window.api.debugLog('devices.prime-microphone.error', { error: err instanceof Error ? { name: err.name, message: err.message } : String(err) })
        return false
      }
    })()
    microphonePrimeRef.current = promise
    return promise
  }

  async function refreshDevices(): Promise<void> {
    try {
      void window.api.debugLog('devices.enumerate.begin')
      const devices = await navigator.mediaDevices.enumerateDevices()
      void window.api.debugLog('devices.enumerate.result', devices.map((d) => ({
        kind: d.kind,
        deviceId: d.deviceId,
        groupId: d.groupId,
        label: d.label
      })))
      const inputs = devices
        .filter((d) => d.kind === 'audioinput')
        .map((d, index) => ({ deviceId: d.deviceId, label: d.label || "Microphone " + (index + 1) }))
      void window.api.debugLog('devices.audio-inputs', inputs)
      setAudioDevices(inputs)
    } catch (err) {
      void window.api.debugLog('devices.enumerate.error', { error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) })
      /* ignore */
    }
  }

  async function saveKey(): Promise<void> {
    const ok = await window.api.setApiKey(apiKey.trim())
    setKeySaved(ok && !!apiKey.trim())
    setMessage(ok ? 'API key saved (encrypted).' : 'Could not save key — OS encryption unavailable.')
  }

  async function start(): Promise<void> {
    void window.api.debugLog('app.start.called', { starting: startingRef.current, running, audioSourceId, apiKeyPresent: !!apiKey.trim() })
    if (startingRef.current || running) {
      void window.api.debugLog('app.start.ignored', { reason: startingRef.current ? 'already-starting' : 'already-running' })
      return
    }
    startingRef.current = true
    if (!apiKey.trim()) {
      setStatus('error')
      setMessage('Enter your Gemini API key first.')
      setShowSettings(true)
      startingRef.current = false
      return
    }
    setStatus('connecting')
    setMessage(audioSourceId === SYSTEM_AUDIO_ID ? 'Connecting — preparing system audio…' : 'Connecting — preparing microphone…')
    setOriginal('')
    setTranslated('')
    void window.api.debugLog('app.start.session-begin', { audioSourceId, sourceLang, targetLang })

    // Permissions are requested once when the app starts. A translation session
    // only checks the already-granted microphone state and never asks macOS again.
    if (audioSourceId !== SYSTEM_AUDIO_ID) {
      const microphoneStatus = await window.api.microphonePermissionStatus()
      void window.api.debugLog('app.start.microphone-status', { microphoneStatus })
      if (microphoneStatus !== 'granted') {
        void window.api.debugLog('app.start.microphone-not-granted', { microphoneStatus })
        setStatus('error')
        setMessage('Microphone permission is not enabled. Enable it in System Settings → Privacy & Security → Microphone, then restart live-trans.')
        startingRef.current = false
        return
      }
      await refreshDevices()
    }

    void window.api.debugLog('app.start.create-capture', { audioSourceId, isSystemAudio: audioSourceId === SYSTEM_AUDIO_ID })
    const client = new LiveTranslateClient()
    const systemCapture = audioSourceId === SYSTEM_AUDIO_ID ? new SystemAudioCapture() : null
    const microphoneCapture = audioSourceId === SYSTEM_AUDIO_ID ? null : new MicrophoneAudioCapture()
    systemCaptureRef.current = systemCapture
    microphoneCaptureRef.current = microphoneCapture
    clientRef.current = client

    const handlers = {
      onChunk: (b64: string) => client.sendAudioChunk(b64),
      onLevel: (rms: number) => setLevel(rms),
      onError: (m: string) => {
        void window.api.debugLog('capture.handler.error', { message: m })
        setStatus('error')
        setMessage(`Capture error: ${m}`)
      }
    }

    void window.api.debugLog('gemini.connect.call')
    client.connect(
      { apiKey: apiKey.trim(), sourceLanguageCode: sourceLang, targetLanguageCode: targetLang },
      {
        onReady: async () => {
          void window.api.debugLog('gemini.onReady', { audioSourceId })
          setMessage(audioSourceId === SYSTEM_AUDIO_ID ? 'Connected — capturing system audio…' : 'Connected — capturing microphone…')
          try {
            if (systemCapture) {
              void window.api.debugLog('system-capture.start')
              await systemCapture.start(handlers)
              void window.api.debugLog('system-capture.start.success')
            } else {
              void window.api.debugLog('microphone-capture.start.call', { audioSourceId })
              await microphoneCapture?.start(audioSourceId, handlers)
              void window.api.debugLog('microphone-capture.start.returned')
            }
            setStatus('listening')
            setMessage(audioSourceId === SYSTEM_AUDIO_ID ? 'Listening to system audio.' : 'Listening to microphone.')
            startingRef.current = false
          } catch (err) {
            void window.api.debugLog('capture.start.error', { error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) })
            startingRef.current = false
            /* capture.start already reported the error */
          }
        },
        onReconnecting: (attempt, delayMs) => {
          void window.api.debugLog('gemini.onReconnecting', { attempt, delayMs })
          setStatus((s) => (s === 'error' ? s : 'connecting'))
          setMessage(attempt === 0 ? 'Session rotating — reconnecting…' : `Connection dropped — reconnecting (attempt ${attempt})…`)
        },
        onReconnected: () => {
          void window.api.debugLog('gemini.onReconnected')
          setStatus((s) => (s === 'error' ? s : 'listening'))
          setMessage('Reconnected — resuming translation.')
        },
        onInputTranscript: (t) => { void window.api.debugLog('gemini.input-transcript', { length: t.length }); setOriginal((p) => appendCapped(p, t)) },
        onOutputTranscript: (t) => { void window.api.debugLog('gemini.output-transcript', { length: t.length }); setTranslated((p) => appendCapped(p, t)) },
        onTurnComplete: () => {
          setOriginal((p) => (p.endsWith('\n') ? p : p + '\n'))
          setTranslated((p) => (p.endsWith('\n') ? p : p + '\n'))
        },
        onInterrupted: () => {},
        onError: (m) => {
          void window.api.debugLog('gemini.handler.error', { message: m })
          setStatus('error')
          setMessage(m)
        },
        onClose: ({ code, reason }) => {
          void window.api.debugLog('gemini.onClose', { code, reason })
          startingRef.current = false
          setStatus((s) => (s === 'error' ? s : 'idle'))
          setMessage(reason ? `Disconnected (${code}): ${reason}` : `Disconnected (${code}).`)
        }
      }
    )
  }

  async function stop(): Promise<void> {
    void window.api.debugLog('app.stop.called', { audioSourceId, status })
    await systemCaptureRef.current?.stop()
    await microphoneCaptureRef.current?.stop()
    clientRef.current?.close()
    systemCaptureRef.current = null
    microphoneCaptureRef.current = null
    clientRef.current = null
    setStatus('idle')
    setLevel(0)
    setMessage('Stopped.')
  }

  function toggle(): void {
    if (running) void stop()
    else void start()
  }

  function onSourceLangChange(code: string): void {
    setSourceLang(code)
    window.api.setPrefs({ sourceLang: code })
  }

  function onTargetChange(code: string): void {
    setTargetLang(code)
    window.api.setPrefs({ targetLang: code })
  }

  async function onAudioSourceChange(id: string): Promise<void> {
    void window.api.debugLog('audio-source.change', { from: audioSourceId, to: id, running, starting: startingRef.current })
    if (running || startingRef.current) return
    setAudioSourceId(id)
    void window.api.setPrefs({ audioSourceId: id })
  }

  const dot =
    status === 'listening'
      ? 'bg-emerald-400'
      : status === 'connecting'
        ? 'bg-amber-400'
        : status === 'error'
          ? 'bg-red-400'
          : 'bg-faint'
  const pill =
    status === 'listening'
      ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300'
      : status === 'connecting'
        ? 'border-amber-400/25 bg-amber-400/10 text-amber-300'
        : status === 'error'
          ? 'border-red-400/25 bg-red-400/10 text-red-300'
          : 'border-border bg-surface text-muted'

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* ---- Title bar ---- */}
      <header className="drag-region flex shrink-0 flex-col border-b border-border/60">
        {/* thin strip reserving space for the macOS traffic-light buttons (none on Windows/Linux) */}
        <div className={isMac ? 'h-9 shrink-0' : 'h-3 shrink-0'} />
        <div className="flex items-center justify-between px-4 pb-3.5">
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-[9px] bg-linear-to-br from-accent to-[#0e8f80] shadow-sm ring-1 ring-white/10">
              <HeadphonesIcon />
            </div>
            <div className="leading-tight">
              <h1 className="text-[13px] font-semibold tracking-tight">live-trans</h1>
              <p className="text-[11px] text-faint">
                Gemini 3.5 Live Translate · <span className="font-medium text-muted">{targetName}</span>
              </p>
            </div>
          </div>

          <div className="no-drag flex items-center gap-2">
          <span
            className={`flex h-8 items-center gap-2 rounded-full border px-3 text-[11px] font-medium transition-colors ${pill}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${dot} ${running ? 'animate-pulse' : ''}`} />
            {STATUS_LABEL[status]}
          </span>
          <button
            onClick={() => setShowSettings(true)}
            className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface text-muted transition hover:border-border-strong hover:text-foreground"
            title="Settings"
          >
            <GearIcon />
          </button>
          </div>
        </div>
      </header>

      {/* ---- Transcripts ---- */}
      <main className="grid min-h-0 flex-1 grid-cols-2 gap-3 px-4 pb-3 pt-3">
        <Column
          title={sourceName}
          accent={false}
          innerRef={origRef}
          text={original}
          live={running}
          empty="Source speech appears here."
        />
        <Column
          title={`Translation · ${targetName}`}
          accent
          innerRef={transRef}
          text={translated}
          live={running}
          empty="Translated text appears here."
        />
      </main>

      {/* ---- Control dock ---- */}
      <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border bg-surface/60 px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={toggle}
            className={`flex h-10 items-center gap-2 rounded-lg px-4 text-[13px] font-semibold transition active:scale-[0.98] ${
              running
                ? 'border border-border-strong bg-surface-2 text-red-300 hover:bg-elevated'
                : 'bg-accent text-accent-fg shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_2px_8px_rgba(20,184,166,0.25)] hover:bg-accent-hover'
            }`}
          >
            {running ? (
              <>
                <StopIcon /> Stop
              </>
            ) : (
              <>
                <PlayIcon /> Enable translation
              </>
            )}
          </button>

          <div className="flex items-center gap-2">
            <Select value={sourceLang} onChange={onSourceLangChange}>
              <option value="auto">Auto-detect source</option>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </Select>
            <span className="text-faint">→</span>
            <Select value={targetLang} onChange={onTargetChange}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </Select>
            <Select value={audioSourceId} onChange={onAudioSourceChange}>
              <option value={SYSTEM_AUDIO_ID}>System audio</option>
              {audioDevices.map((d) => <option key={d.deviceId} value={d.deviceId}>🎤 {d.label}</option>)}

            </Select>
          </div>
          <Meter level={level} active={running} />
        </div>

      </footer>

      {/* ---- Status line ---- */}
      <div className="shrink-0 border-t border-border bg-background px-4 py-1.5 text-[11px] text-faint">
        {message || 'Ready.'}
      </div>

      {/* ---- Settings modal ---- */}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          apiKey={apiKey}
          setApiKey={setApiKey}
          keySaved={keySaved}
          saveKey={saveKey}
        />
      )}

    </div>
  )
}

/* =========================== Transcript column =========================== */

// Memoized so frequent VU-meter updates don't re-render the growing transcript text.
const Column = memo(function Column(props: {
  title: string
  accent: boolean
  text: string
  empty: string
  live: boolean
  innerRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface/40">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span
          className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${
            props.accent ? 'text-accent' : 'text-muted'
          }`}
        >
          {props.title}
        </span>
        {props.live && props.text && (
          <span className="flex items-center gap-1.5 text-[10px] text-faint">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            live
          </span>
        )}
      </div>
      <div
        ref={props.innerRef}
        className="flex-1 overflow-y-auto px-4 py-3.5 text-[15px] leading-relaxed"
      >
        {props.text ? (
          <p className="whitespace-pre-wrap text-foreground/90">{props.text}</p>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="max-w-[18rem] text-center text-[13px] text-faint">{props.empty}</p>
          </div>
        )}
      </div>
    </section>
  )
})

/* =========================== VU meter =========================== */

const METER_BARS = 20
function Meter({ level, active }: { level: number; active: boolean }): React.JSX.Element {
  // RMS is a linear amplitude value (0..1). A linear UI scale makes normal
  // speech/music levels look almost dead, so map -60..0 dBFS to the meter.
  const db = level > 0 ? 20 * Math.log10(level) : -Infinity
  const pct = active ? Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) : 0
  const lit = Math.round((pct / 100) * METER_BARS)
  return (
    <div className="flex h-10 items-center gap-2.5 rounded-lg border border-border bg-background/40 px-3">
      <span className={active ? 'text-accent' : 'text-faint'}>
        <MicIcon />
      </span>
      <div className="flex h-4 items-center gap-0.5">
        {Array.from({ length: METER_BARS }).map((_, i) => {
          const on = i < lit
          return (
            <span
              key={i}
              className="rounded-full transition-all duration-100"
              style={{
                width: 3,
                height: on ? '100%' : '38%',
                background: on ? 'var(--color-accent)' : 'var(--color-border-strong)'
              }}
            />
          )
        })}
      </div>
    </div>
  )
}


/* =========================== Settings modal =========================== */

function SettingsModal(props: {
  onClose: () => void
  apiKey: string
  setApiKey: (v: string) => void
  keySaved: boolean
  saveKey: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/55 p-6 backdrop-blur-sm"
      onClick={props.onClose}
    >
      <div
        className="no-drag flex max-h-[88vh] w-full max-w-lg animate-pop-in flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Settings</h2>
            <p className="text-[11px] text-muted">Configure your translation session</p>
          </div>
          <button
            onClick={props.onClose}
            className="grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-foreground"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Modal body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <Field label="Gemini API key" hint="Stored encrypted on this device via the OS keychain.">
            <div className="flex gap-2">
              <input
                type="password"
                value={props.apiKey}
                onChange={(e) => props.setApiKey(e.target.value)}
                placeholder="AIza…"
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-accent"
              />
              <button
                onClick={props.saveKey}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition hover:bg-accent-hover"
              >
                {props.keySaved ? 'Update' : 'Save'}
              </button>
            </div>
          </Field>

        </div>

        {/* Modal footer */}
        <div className="flex justify-end border-t border-border px-5 py-3">
          <button
            onClick={props.onClose}
            className="rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-foreground transition hover:bg-elevated"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

/* =========================== Settings primitives =========================== */

function Field(props: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
        {props.label}
      </label>
      {props.children}
      {props.hint && <p className="mt-1.5 text-[11px] text-faint">{props.hint}</p>}
    </div>
  )
}

function Select(props: {
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="relative">
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full appearance-none rounded-lg border border-border bg-background px-3 py-2 pr-9 text-sm outline-none transition focus:border-accent"
      >
        {props.children}
      </select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted">
        <ChevronIcon />
      </span>
    </div>
  )
}

function Toggle(props: {
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  desc: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => props.onChange(!props.checked)}
      className="flex w-full items-center justify-between gap-4 rounded-lg px-3 py-2.5 text-left transition hover:bg-surface-2"
    >
      <span>
        <span className="block text-[13px] font-medium text-foreground">{props.title}</span>
        <span className="block text-[11px] text-faint">{props.desc}</span>
      </span>
      <span
        className={`relative h-5.5 w-9.5 shrink-0 rounded-full transition-colors ${
          props.checked ? 'bg-accent' : 'bg-border-strong'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow transition-transform ${
            props.checked ? 'translate-x-4.5' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  )
}

/* =========================== Icons =========================== */

function MicIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v3" />
    </svg>
  )
}

function HeadphonesIcon(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 14v-2a9 9 0 0 1 18 0v2" />
      <path d="M21 15a2 2 0 0 1-2 2h-1v-5h1a2 2 0 0 1 2 2zM3 15a2 2 0 0 0 2 2h1v-5H5a2 2 0 0 0-2 2z" />
    </svg>
  )
}

function GearIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function PlayIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function StopIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
