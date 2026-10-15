/// <reference types="vite/client" />

export type ProviderId = 'gemini' | 'soniox'
export type UiLanguage = 'uk' | 'en'

export type OverlaySettings = {
  fontSize: number
  lines: number
  showOriginal: boolean
  locked: boolean
}
export type OverlayLine = { source: string; target: string; open?: boolean }
export type ShortcutInfo = {
  translation: string
  overlay: string
  registered: { translation: boolean; overlay: boolean }
}

export type AppSettings = {
  hasApiKey: boolean
  hasSonioxKey: boolean
  provider: ProviderId
  echoTargetLanguage: boolean
  uiLanguage: UiLanguage
  sourceLang: string
  targetLang: string
  audioSourceId: string
  debugLogging: boolean
  encryptionAvailable: boolean
  platform: string
}

export type HistorySegment = { source: string; target: string }
export type HistoryRecord = {
  id: string
  startedAt: number
  endedAt: number
  sourceLang: string
  targetLang: string
  audioSource: string
  segments: HistorySegment[]
}
export type HistorySummary = Omit<HistoryRecord, 'segments'> & { segmentCount: number; preview: string }
export type SaveTextResult = { ok: boolean; path?: string; canceled?: boolean; error?: string }

export type LiveTokenResult = { ok: true; token: string } | { ok: false; error: string }

export interface PreloadApi {
  debugLog: (event: string, data?: unknown) => Promise<boolean>
  getDebugLogPath: () => Promise<string>
  openDebugLogFolder: () => Promise<string>
  setDebugLogging: (enabled: boolean) => Promise<boolean>
  getSettings: () => Promise<AppSettings>
  setApiKey: (key: string) => Promise<boolean>
  setPrefs: (prefs: {
    sourceLang?: string
    targetLang?: string
    audioSourceId?: string
    provider?: ProviderId
    echoTargetLanguage?: boolean
    uiLanguage?: UiLanguage
  }) => Promise<boolean>
  createLiveToken: () => Promise<LiveTokenResult>
  setSonioxKey: (key: string) => Promise<boolean>
  createSonioxToken: () => Promise<LiveTokenResult>
  saveHistory: (record: HistoryRecord) => Promise<boolean>
  listHistory: () => Promise<HistorySummary[]>
  getHistory: (id: string) => Promise<HistoryRecord | null>
  deleteHistory: (id: string) => Promise<boolean>
  saveTextFile: (defaultName: string, content: string) => Promise<SaveTextResult>
  copyText: (text: string) => Promise<boolean>
  microphonePermissionStatus: () => Promise<string>
  requestMicrophonePermission: () => Promise<boolean>
  openMicrophoneSettings: () => Promise<void>
  startCapture: () => Promise<{ ok: boolean; error?: string }>
  stopCapture: () => Promise<boolean>
  onCapturePcm: (cb: (frame: { b64: string; rms: number }) => void) => () => void
  onCaptureError: (cb: (message: string) => void) => () => void
  onToggleTranslationRequest: (cb: () => void) => () => void
  reportStatus: (running: boolean) => void
  getShortcuts: () => Promise<ShortcutInfo>
  toggleOverlay: () => Promise<boolean>
  hideOverlay: () => Promise<void>
  isOverlayVisible: () => Promise<boolean>
  getOverlaySettings: () => Promise<OverlaySettings>
  setOverlaySettings: (patch: Partial<OverlaySettings>) => Promise<OverlaySettings>
  getOverlayLines: () => Promise<OverlayLine[]>
  sendOverlayLines: (lines: OverlayLine[]) => void
  setOverlayInteractive: (interactive: boolean) => void
  resizeOverlay: (size: { width: number; height: number }) => void
  onOverlayLines: (cb: (lines: OverlayLine[]) => void) => () => void
  onOverlaySettings: (cb: (s: OverlaySettings) => void) => () => void
  onOverlayVisible: (cb: (visible: boolean) => void) => () => void
  onUiLanguage: (cb: (lang: UiLanguage) => void) => () => void
}

declare global {
  interface Window {
    api: PreloadApi
  }
}
