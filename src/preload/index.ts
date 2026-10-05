import { contextBridge, ipcRenderer } from 'electron'

export type AppSettings = {
  hasApiKey: boolean
  apiKey: string
  sourceLang: string
  targetLang: string
  audioSourceId: string
  encryptionAvailable: boolean
  platform: string
}

const api = {
  debugLog: (event: string, data?: unknown): Promise<boolean> => ipcRenderer.invoke('debug:log', event, data),
  getDebugLogPath: (): Promise<string> => ipcRenderer.invoke('debug:getPath'),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setApiKey: (key: string): Promise<boolean> => ipcRenderer.invoke('settings:setApiKey', key),
  setPrefs: (prefs: {
    sourceLang?: string
    targetLang?: string
    audioSourceId?: string
  }): Promise<boolean> => ipcRenderer.invoke('settings:setPrefs', prefs),
  microphonePermissionStatus: (): Promise<string> => ipcRenderer.invoke('perm:microphoneStatus'),
  requestMicrophonePermission: (): Promise<boolean> => ipcRenderer.invoke('perm:requestMicrophone'),

  // System-audio capture via AudioTee (Core Audio tap, excludes our own process tree).
  // Main streams 100ms PCM frames (base64 + rms) to the renderer over 'capture:pcm'.
  startCapture: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('capture:start'),
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
