/// <reference types="vite/client" />

export type AppSettings = {
  hasApiKey: boolean
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
  }) => Promise<boolean>
  createLiveToken: () => Promise<LiveTokenResult>
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
}

declare global {
  interface Window {
    api: PreloadApi
  }
}
