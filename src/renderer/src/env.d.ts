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
