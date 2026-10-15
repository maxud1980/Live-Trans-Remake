import { contextBridge, ipcRenderer } from 'electron'

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

// Mirror of the main-process flag, so disabled logging costs no IPC round-trip at all.
let debugEnabled = false
void ipcRenderer.invoke('debug:enabled').then((v: boolean) => {
  debugEnabled = !!v
})

const api = {
  debugLog: (event: string, data?: unknown): Promise<boolean> =>
    debugEnabled ? ipcRenderer.invoke('debug:log', event, data) : Promise.resolve(false),
  getDebugLogPath: (): Promise<string> => ipcRenderer.invoke('debug:getPath'),
  openDebugLogFolder: (): Promise<string> => ipcRenderer.invoke('debug:openFolder'),
  setDebugLogging: async (enabled: boolean): Promise<boolean> => {
    debugEnabled = await ipcRenderer.invoke('settings:setDebugLogging', enabled)
    return debugEnabled
  },
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setApiKey: (key: string): Promise<boolean> => ipcRenderer.invoke('settings:setApiKey', key),
  setPrefs: (prefs: {
    sourceLang?: string
    targetLang?: string
    audioSourceId?: string
  }): Promise<boolean> => ipcRenderer.invoke('settings:setPrefs', prefs),
  // Short-lived Live API token minted by the main process; the API key never enters the renderer.
  createLiveToken: (): Promise<LiveTokenResult> => ipcRenderer.invoke('live:createToken'),
  microphonePermissionStatus: (): Promise<string> => ipcRenderer.invoke('perm:microphoneStatus'),
  requestMicrophonePermission: (): Promise<boolean> => ipcRenderer.invoke('perm:requestMicrophone'),
  openMicrophoneSettings: (): Promise<void> => ipcRenderer.invoke('perm:openMicrophoneSettings'),

  // System-audio capture via the native loopback helper (excludes our own process tree).
  // Main streams 100ms PCM frames (base64 + rms) to the renderer over 'capture:pcm'.
  startCapture: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('capture:start'),
  stopCapture: (): Promise<boolean> => ipcRenderer.invoke('capture:stop'),
  onCapturePcm: (cb: (frame: { b64: string; rms: number }) => void): (() => void) => {
    const listener = (_e: unknown, frame: { b64: string; rms: number }): void => cb(frame)
    ipcRenderer.on('capture:pcm', listener)
    return () => ipcRenderer.removeListener('capture:pcm', listener)
  },
  onCaptureError: (cb: (message: string) => void): (() => void) => {
    const listener = (_e: unknown, message: string): void => cb(message)
    ipcRenderer.on('capture:error', listener)
    return () => ipcRenderer.removeListener('capture:error', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
