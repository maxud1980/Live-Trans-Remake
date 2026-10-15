import { useEffect, useRef, useState } from 'react'
import { languagesFor, migrateLanguageCode, providerCode, shortLabel, type ProviderId } from './lib/languages'
import { SystemAudioCapture } from './audio/capture'
import { MicrophoneAudioCapture } from './audio/microphone'
import { GeminiProvider } from './providers/gemini'
import { SonioxProvider } from './providers/soniox'
import type { TranslationProvider } from './providers/types'
import { providerInfo, SettingsModal } from './components/SettingsModal'
import { setUiLanguage, t, type StringKey, type UiLanguage } from './lib/i18n'
import { Segmenter, newSessionId, type Segment, type SessionRecord } from './lib/segments'
import { Transcript } from './components/Transcript'
import { ExportMenu } from './components/ExportMenu'
import { HistoryModal } from './components/HistoryModal'

type Status = 'idle' | 'connecting' | 'listening' | 'error'
type AudioDevice = { deviceId: string; label: string; index: number }
const SYSTEM_AUDIO_ID = '__system_audio__'

// How often pause-based line breaks are checked, and how often a running session is
// written to History (so a crash loses at most this much transcript).
const SEGMENT_TICK_MS = 500
const AUTOSAVE_MS = 10_000

type SessionMeta = Omit<SessionRecord, 'segments' | 'endedAt'>

// Keep a language choice valid for a provider: an unsupported source falls back to
// Auto-detect, an unsupported target to English.
function fitLanguages(p: ProviderId, source: string, target: string): { source: string; target: string } {
  return {
    source: source === 'auto' || providerCode(p, source) ? source : 'auto',
    target: providerCode(p, target) ? target : 'en'
  }
}

const STATUS_LABEL: Record<Status, StringKey> = {
  idle: 'statusIdle',
  connecting: 'statusConnecting',
  listening: 'statusListening',
  error: 'statusError'
}

// How many recent lines the subtitles window receives (it shows up to 4).
const OVERLAY_LINES = 6

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

export default function App(): React.JSX.Element {
  // Whether a key is saved per provider; the keys themselves never leave the main process.
  const [keys, setKeys] = useState<Record<ProviderId, boolean>>({ gemini: false, soniox: false })
  const [provider, setProvider] = useState<ProviderId>('gemini')
  const [echoTargetLanguage, setEchoTargetLanguage] = useState(false)
  // Language the service detected in the source speech (when the source is Auto-detect).
  const [detectedLang, setDetectedLang] = useState<string | null>(null)
  const [debugLogging, setDebugLogging] = useState(false)
  const [uiLanguage, setUiLanguageState] = useState<UiLanguage>('en')
  const [overlayVisible, setOverlayVisible] = useState(false)
  const [sourceLang, setSourceLang] = useState('auto')
  const [targetLang, setTargetLang] = useState('en')
  const [audioSourceId, setAudioSourceId] = useState(SYSTEM_AUDIO_ID)
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')
  const [level, setLevel] = useState(0)

  // Transcript deltas are grouped into paired lines (original ↔ translation) by the segmenter.
  const [segments, setSegments] = useState<Segment[]>([])
  const [showSettings, setShowSettings] = useState(true)
  const [showHistory, setShowHistory] = useState(false)
  // macOS uses a hidden-inset title bar (content slides under the traffic lights); Windows/Linux
  // keep the native frame, so we only reserve the traffic-light strip on macOS.
  const [isMac, setIsMac] = useState(false)

  const systemCaptureRef = useRef<SystemAudioCapture | null>(null)
  const microphoneCaptureRef = useRef<MicrophoneAudioCapture | null>(null)
  const clientRef = useRef<TranslationProvider | null>(null)
  const startingRef = useRef(false)
  // Incremented on every start/stop; callbacks from an older session check it and bail out.
  const sessionRef = useRef(0)
  const microphonePrimeRef = useRef<Promise<boolean> | null>(null)
  const segmenterRef = useRef(new Segmenter())
  // Metadata of the current (or most recently finished) session, for autosave and export.
  const sessionMetaRef = useRef<SessionMeta | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const running = status === 'connecting' || status === 'listening'
  const targetName = shortLabel(targetLang)
  const sourceName =
    sourceLang === 'auto'
      ? detectedLang
        ? t('autoDetectWith', { lang: shortLabel(detectedLang) })
        : t('autoDetect')
      : shortLabel(sourceLang)
  const deviceLabel = (d: AudioDevice): string => d.label || t('microphoneN', { n: d.index + 1 })
  const languages = languagesFor(provider)
  const keySaved = keys[provider]

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
        void window.api.debugLog('app.initial-load.settings', s)
        if (cancelled) return

        setDebugLogging(s.debugLogging)
        setUiLanguage(s.uiLanguage)
        setUiLanguageState(s.uiLanguage)
        const prov: ProviderId = s.provider === 'soniox' ? 'soniox' : 'gemini'
        setProvider(prov)
        setKeys({ gemini: s.hasApiKey, soniox: s.hasSonioxKey })
        setEchoTargetLanguage(s.echoTargetLanguage)
        const langs = fitLanguages(prov, migrateLanguageCode(s.sourceLang), migrateLanguageCode(s.targetLang))
        setSourceLang(langs.source)
        setTargetLang(langs.target)
        if (langs.source !== s.sourceLang || langs.target !== s.targetLang) {
          void window.api.setPrefs({ sourceLang: langs.source, targetLang: langs.target })
        }
        setAudioSourceId(s.audioSourceId || SYSTEM_AUDIO_ID)
        setIsMac(s.platform === 'darwin')
        if (prov === 'soniox' ? s.hasSonioxKey : s.hasApiKey) setShowSettings(false)

        // Let Chromium's getUserMedia be the only microphone authorization path.
        // Prime it exactly once on macOS so device labels become available, then only
        // enumerate on subsequent device-change events. Calling getUserMedia from
        // refreshDevices() itself would re-trigger TCC when macOS reports a devicechange.
        if (!cancelled) {
          if (s.platform === 'darwin') await ensureMicrophoneAccess(true)
          await refreshDevices()
        }
      } catch (err) {
        void window.api.debugLog('app.initial-load.error', { error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) })
        // Permission/device enumeration errors are handled when capture starts.
      }
    })()

    void window.api.isOverlayVisible().then(setOverlayVisible)
    const offOverlay = window.api.onOverlayVisible(setOverlayVisible)
    // Global shortcut and tray menu: routed through a ref so they always see current state.
    const offToggle = window.api.onToggleTranslationRequest(() => toggleRef.current())

    return () => {
      cancelled = true
      offOverlay()
      offToggle()
      navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange)
      void window.api.debugLog('app.unmount')
    }
  }, [])

  // Tray menu label follows the session state.
  useEffect(() => {
    window.api.reportStatus(running)
  }, [running])

  // Feed the subtitles window with the latest lines while it is open.
  useEffect(() => {
    if (!overlayVisible) return
    window.api.sendOverlayLines(
      segments.slice(-OVERLAY_LINES).map((s) => ({ source: s.source, target: s.target, open: s.open }))
    )
  }, [segments, overlayVisible])

  // While a session runs: close lines after a pause, and autosave it to History.
  useEffect(() => {
    if (!running) return
    const tick = setInterval(() => {
      if (segmenterRef.current.tick(Date.now())) setSegments(segmenterRef.current.segments)
    }, SEGMENT_TICK_MS)
    const save = setInterval(() => void saveSession(), AUTOSAVE_MS)
    return () => {
      clearInterval(tick)
      clearInterval(save)
    }
  }, [running])

  function sessionRecord(): SessionRecord | null {
    const meta = sessionMetaRef.current
    if (!meta) return null
    const lines = segmenterRef.current.segments
      .map((s) => ({ source: s.source.trim(), target: s.target.trim() }))
      .filter((s) => s.source || s.target)
    return { ...meta, endedAt: Date.now(), segments: lines }
  }

  async function saveSession(): Promise<void> {
    const record = sessionRecord()
    if (record && record.segments.length) await window.api.saveHistory(record)
  }

  function closeLine(): void {
    if (segmenterRef.current.close(Date.now())) setSegments(segmenterRef.current.segments)
  }

  // Microphone consent is decided ONCE by the main process via the native macOS API
  // (askForMediaAccess, only while status is 'not-determined'). Only after the OS reports
  // 'granted' do we touch getUserMedia — and then it can no longer prompt; it just unlocks
  // device labels for enumerateDevices().
  async function ensureMicrophoneAccess(shouldPrime = isMac): Promise<boolean> {
    if (!shouldPrime) return true
    if (microphonePrimeRef.current) return microphonePrimeRef.current

    const promise = (async () => {
      try {
        void window.api.debugLog('devices.prime-microphone.begin')
        const granted = await window.api.requestMicrophonePermission()
        if (!granted) {
          void window.api.debugLog('devices.prime-microphone.not-granted')
          return false
        }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          stream.getTracks().forEach((track) => track.stop())
        } catch (err) {
          // Labels are cosmetic; capture start reports real errors.
          void window.api.debugLog('devices.prime-microphone.labels-error', { error: String(err) })
        }
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
        .map((d, index) => ({ deviceId: d.deviceId, label: d.label, index }))
      void window.api.debugLog('devices.audio-inputs', inputs)
      setAudioDevices(inputs)
    } catch (err) {
      void window.api.debugLog('devices.enumerate.error', { error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) })
      /* ignore */
    }
  }

  async function saveKey(p: ProviderId, key: string): Promise<boolean> {
    const ok = await (p === 'soniox' ? window.api.setSonioxKey(key) : window.api.setApiKey(key))
    if (ok) setKeys((k) => ({ ...k, [p]: true }))
    setMessage(ok ? capitalize(t('keySaved', { key: providerInfo(p).keyLabel })) : t('keySaveFailed'))
    return ok
  }

  async function removeKey(p: ProviderId): Promise<void> {
    await (p === 'soniox' ? window.api.setSonioxKey('') : window.api.setApiKey(''))
    setKeys((k) => ({ ...k, [p]: false }))
    setMessage(capitalize(t('keyRemoved', { key: providerInfo(p).keyLabel })))
  }

  function onProviderChange(p: ProviderId): void {
    if (running || startingRef.current || p === provider) return
    setProvider(p)
    // Keep the chosen languages where the new service supports them.
    const langs = fitLanguages(p, sourceLang, targetLang)
    setSourceLang(langs.source)
    setTargetLang(langs.target)
    void window.api.setPrefs({ provider: p, sourceLang: langs.source, targetLang: langs.target })
    if (langs.target !== targetLang || langs.source !== sourceLang) {
      setMessage(t('languageReset', { service: providerInfo(p).short }))
    }
  }

  function onUiLanguageChange(lang: UiLanguage): void {
    setUiLanguage(lang)
    setUiLanguageState(lang)
    void window.api.setPrefs({ uiLanguage: lang })
  }

  function onEchoChange(v: boolean): void {
    setEchoTargetLanguage(v)
    void window.api.setPrefs({ echoTargetLanguage: v })
  }

  async function onDebugLoggingChange(enabled: boolean): Promise<void> {
    setDebugLogging(await window.api.setDebugLogging(enabled))
  }

  // The single exit path for a session: stops capture, closes the socket and settles the UI.
  // Every failure branch (capture, API error, connection loss) ends here, so a broken session
  // can never keep a WebSocket open in the background.
  async function teardown(outcome: { error?: string; message?: string } = {}): Promise<void> {
    sessionRef.current++
    startingRef.current = false
    const systemCapture = systemCaptureRef.current
    const microphoneCapture = microphoneCaptureRef.current
    const client = clientRef.current
    systemCaptureRef.current = null
    microphoneCaptureRef.current = null
    clientRef.current = null
    client?.close()
    await systemCapture?.stop()
    await microphoneCapture?.stop()
    closeLine()
    await saveSession()
    setActiveSessionId(null)
    setLevel(0)
    if (outcome.error) {
      setStatus('error')
      setMessage(outcome.error)
    } else {
      setStatus('idle')
      setMessage(outcome.message ?? t('stopped'))
    }
  }

  async function start(): Promise<void> {
    if (startingRef.current || running) return
    if (!keySaved) {
      setStatus('error')
      setMessage(t('enterKeyFirst', { key: providerInfo(provider).keyLabel }))
      setShowSettings(true)
      return
    }
    startingRef.current = true
    const session = ++sessionRef.current
    const isCurrent = (): boolean => sessionRef.current === session
    const isSystem = audioSourceId === SYSTEM_AUDIO_ID

    setStatus('connecting')
    setMessage(isSystem ? t('connectingSystem') : t('connectingMic'))
    const startedAt = Date.now()
    const meta: SessionMeta = {
      id: newSessionId(startedAt),
      startedAt,
      sourceLang,
      targetLang,
      audioSource: isSystem
        ? t('systemAudio')
        : (() => {
            const d = audioDevices.find((x) => x.deviceId === audioSourceId)
            return d ? deviceLabel(d) : t('microphone')
          })()
    }
    sessionMetaRef.current = meta
    setActiveSessionId(meta.id)
    segmenterRef.current.reset()
    setSegments([])
    void window.api.debugLog('app.start', { audioSourceId, sourceLang, targetLang })

    // Permissions are requested once when the app starts. A translation session
    // only checks the already-granted microphone state and never asks macOS again.
    if (!isSystem) {
      const microphoneStatus = await window.api.microphonePermissionStatus()
      if (!isCurrent()) return
      if (microphoneStatus !== 'granted') {
        void window.api.debugLog('app.start.microphone-not-granted', { microphoneStatus })
        void window.api.openMicrophoneSettings()
        await teardown({
          error: t('micPermission')
        })
        return
      }
      await refreshDevices()
      if (!isCurrent()) return
    }

    setDetectedLang(null)
    const client: TranslationProvider = provider === 'soniox' ? new SonioxProvider() : new GeminiProvider()
    const systemCapture = isSystem ? new SystemAudioCapture() : null
    const microphoneCapture = isSystem ? null : new MicrophoneAudioCapture()
    systemCaptureRef.current = systemCapture
    microphoneCaptureRef.current = microphoneCapture
    clientRef.current = client

    const captureHandlers = {
      onChunk: (b64: string) => client.sendAudioChunk(b64),
      onLevel: (rms: number) => {
        if (isCurrent()) setLevel(rms)
      },
      onError: (m: string) => {
        if (isCurrent()) void teardown({ error: t('captureError', { message: m }) })
      }
    }

    client.connect(
      { sourceLanguageCode: sourceLang, targetLanguageCode: targetLang, echoTargetLanguage },
      {
        onReady: async () => {
          if (!isCurrent()) return
          setMessage(isSystem ? t('connectedSystem') : t('connectedMic'))
          try {
            if (systemCapture) await systemCapture.start(captureHandlers)
            else await microphoneCapture?.start(audioSourceId, captureHandlers)
          } catch {
            // start() already reported through captureHandlers.onError → teardown.
            return
          }
          if (!isCurrent()) return
          startingRef.current = false
          setStatus('listening')
          setMessage(isSystem ? t('listeningSystem') : t('listeningMic'))
        },
        onReconnecting: (attempt) => {
          if (!isCurrent()) return
          closeLine()
          setStatus('connecting')
          setMessage(attempt === 0 ? t('rotating') : t('reconnecting', { n: attempt }))
        },
        onReconnected: () => {
          if (!isCurrent()) return
          setStatus('listening')
          setMessage(t('reconnected'))
        },
        onInputTranscript: (t) => {
          if (!isCurrent()) return
          segmenterRef.current.addSource(t, Date.now())
          setSegments(segmenterRef.current.segments)
        },
        onOutputTranscript: (t) => {
          if (!isCurrent()) return
          segmenterRef.current.addTarget(t, Date.now())
          setSegments(segmenterRef.current.segments)
        },
        onTurnComplete: () => {
          if (isCurrent()) closeLine()
        },
        onSourceLanguage: (code) => {
          if (isCurrent()) setDetectedLang(code)
        },
        onError: (m) => {
          if (isCurrent()) void teardown({ error: m })
        },
        onClose: ({ code, reason }) => {
          if (!isCurrent()) return
          const text = reason ? t('disconnectedReason', { code, reason }) : t('disconnected', { code })
          void teardown({ error: text })
        }
      }
    )
  }

  async function stop(): Promise<void> {
    void window.api.debugLog('app.stop', { audioSourceId, status })
    await teardown({ message: t('stopped') })
  }

  function toggle(): void {
    if (running) void stop()
    else void start()
  }
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle

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
                {providerInfo(provider).name} · <span className="font-medium text-muted">{targetName}</span>
              </p>
            </div>
          </div>

          <div className="no-drag flex items-center gap-2">
          <span
            className={`flex h-8 items-center gap-2 rounded-full border px-3 text-[11px] font-medium transition-colors ${pill}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${dot} ${running ? 'animate-pulse' : ''}`} />
            {t(STATUS_LABEL[status])}
          </span>
          <button
            onClick={() => void window.api.toggleOverlay()}
            className={`grid h-8 w-8 place-items-center rounded-lg border transition ${
              overlayVisible
                ? 'border-accent/50 bg-accent/15 text-accent'
                : 'border-border bg-surface text-muted hover:border-border-strong hover:text-foreground'
            }`}
            title={t('subtitlesWindow')}
          >
            <SubtitlesIcon />
          </button>
          <button
            onClick={() => setShowHistory(true)}
            className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface text-muted transition hover:border-border-strong hover:text-foreground"
            title={t('history')}
          >
            <HistoryIcon />
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface text-muted transition hover:border-border-strong hover:text-foreground"
            title={t('settings')}
          >
            <GearIcon />
          </button>
          </div>
        </div>
      </header>

      {/* ---- Transcripts ---- */}
      <main className="flex min-h-0 flex-1 flex-col px-4 pb-3 pt-3">
        <Transcript
          lines={segments}
          sourceTitle={sourceName}
          targetTitle={t('translationColumn', { lang: targetName })}
          live={running && segments.length > 0}
          emptyText={
            running
              ? t('waitingForSpeech')
              : t('emptyTranscript')
          }
          actions={
            <ExportMenu
              getSession={sessionRecord}
              disabled={segments.length === 0}
              onResult={setMessage}
              direction="down"
              compact
            />
          }
        />
      </main>

      {/* ---- Control dock ---- */}
      <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border bg-surface/60 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <button
            onClick={toggle}
            className={`flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-4 text-[13px] font-semibold transition active:scale-[0.98] ${
              running
                ? 'border border-border-strong bg-surface-2 text-red-300 hover:bg-elevated'
                : 'bg-accent text-accent-fg shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_2px_8px_rgba(20,184,166,0.25)] hover:bg-accent-hover'
            }`}
          >
            {running ? (
              <>
                <StopIcon /> {t('stop')}
              </>
            ) : (
              <>
                <PlayIcon />
                <span className="hidden min-[1000px]:inline">{t('start')}</span>
                <span className="min-[1000px]:hidden">{t('startShort')}</span>
              </>
            )}
          </button>

          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Select value={sourceLang} onChange={onSourceLangChange} className="min-w-28 max-w-56 flex-1 basis-0">
              <option value="auto">{t('autoDetectSource')}</option>
              {languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </Select>
            <span className="text-faint">→</span>
            <Select value={targetLang} onChange={onTargetChange} className="min-w-28 max-w-56 flex-1 basis-0">
              {languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </Select>
            <Select value={audioSourceId} onChange={onAudioSourceChange} className="min-w-28 max-w-44 flex-1 basis-0">
              <option value={SYSTEM_AUDIO_ID}>{t('systemAudio')}</option>
              {audioDevices.map((d) => <option key={d.deviceId} value={d.deviceId}>🎤 {deviceLabel(d)}</option>)}

            </Select>
          </div>
          {/* Full meter on wide windows, a compact one when space is tight. */}
          <div className="hidden shrink-0 min-[1000px]:block">
            <Meter level={level} active={running} bars={20} />
          </div>
          <div className="shrink-0 min-[1000px]:hidden">
            <Meter level={level} active={running} bars={8} />
          </div>
        </div>
      </footer>

      {/* ---- Status line ---- */}
      <div className="shrink-0 border-t border-border bg-background px-4 py-1.5 text-[11px] text-faint">
        {message || t('ready')}
      </div>

      {/* ---- Settings modal ---- */}
      {showHistory && (
        <HistoryModal
          onClose={() => setShowHistory(false)}
          activeSessionId={activeSessionId}
          onMessage={setMessage}
        />
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          provider={provider}
          onProviderChange={onProviderChange}
          providerLocked={running}
          keys={keys}
          onSaveKey={saveKey}
          onRemoveKey={removeKey}
          echoTargetLanguage={echoTargetLanguage}
          onEchoChange={onEchoChange}
          uiLanguage={uiLanguage}
          onUiLanguageChange={onUiLanguageChange}
          debugLogging={debugLogging}
          onDebugLoggingChange={onDebugLoggingChange}
        />
      )}

    </div>
  )
}

/* =========================== VU meter =========================== */

function Meter({ level, active, bars }: { level: number; active: boolean; bars: number }): React.JSX.Element {
  // RMS is a linear amplitude value (0..1). A linear UI scale makes normal
  // speech/music levels look almost dead, so map -60..0 dBFS to the meter.
  const db = level > 0 ? 20 * Math.log10(level) : -Infinity
  const pct = active ? Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) : 0
  const lit = Math.round((pct / 100) * bars)
  return (
    <div className="flex h-10 shrink-0 items-center gap-2.5 rounded-lg border border-border bg-background/40 px-3">
      <span className={active ? 'text-accent' : 'text-faint'}>
        <MicIcon />
      </span>
      <div className="flex h-4 items-center gap-0.5">
        {Array.from({ length: bars }).map((_, i) => {
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


/* =========================== Controls =========================== */

function Select(props: {
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={`relative ${props.className ?? ''}`}>
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

function SubtitlesIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M6.5 14.5h6M15 14.5h2.5M6.5 11h2.5M11.5 11h6" />
    </svg>
  )
}

function HistoryIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
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


function ChevronIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
