/// <reference types="vite/client" />

export type AppSettings = {
  hasApiKey: boolean
  apiKey: string
  sourceLang: string
  targetLang: string
  audioSourceId: string
  encryptionAvailable: boolean
  platform: string
}

export interface PreloadApi {
  debugLog: (event: string, data?: unknown) => Promise<boolean>
  getDebugLogPath: () => Promise<string>
  getSettings: () => Promise<AppSettings>
  setApiKey: (key: string) => Promise<boolean>
  setPrefs: (prefs: {
    sourceLang?: string
    targetLang?: string
    audioSourceId?: string
  }) => Promise<boolean>
  microphonePermissionStatus: () => Promise<string>
  requestMicrophonePermission: () => Promise<boolean>
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
