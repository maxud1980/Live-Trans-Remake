import { contextBridge, ipcRenderer } from 'electron'

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

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

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
    provider?: ProviderId
    echoTargetLanguage?: boolean
    uiLanguage?: UiLanguage
  }): Promise<boolean> => ipcRenderer.invoke('settings:setPrefs', prefs),
  // Short-lived Live API token minted by the main process; the API key never enters the renderer.
  createLiveToken: (): Promise<LiveTokenResult> => ipcRenderer.invoke('live:createToken'),
  setSonioxKey: (key: string): Promise<boolean> => ipcRenderer.invoke('settings:setSonioxKey', key),
  // Soniox temporary key (snx_temp_…), minted by the main process from the stored key.
  createSonioxToken: (): Promise<LiveTokenResult> => ipcRenderer.invoke('soniox:createToken'),
  // Session history (JSON files in userData/history) and plain-text export.
  saveHistory: (record: HistoryRecord): Promise<boolean> => ipcRenderer.invoke('history:save', record),
  listHistory: (): Promise<HistorySummary[]> => ipcRenderer.invoke('history:list'),
  getHistory: (id: string): Promise<HistoryRecord | null> => ipcRenderer.invoke('history:get', id),
  deleteHistory: (id: string): Promise<boolean> => ipcRenderer.invoke('history:delete', id),
  saveTextFile: (defaultName: string, content: string): Promise<SaveTextResult> =>
    ipcRenderer.invoke('export:saveText', defaultName, content),
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:writeText', text),
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
  // Global shortcut / tray asked the main window to start or stop translation.
  onToggleTranslationRequest: (cb: () => void): (() => void) => subscribe('hotkey:toggleTranslation', cb),
  reportStatus: (running: boolean): void => ipcRenderer.send('app:status', { running }),
  getShortcuts: (): Promise<ShortcutInfo> => ipcRenderer.invoke('shortcuts:get'),

  // Floating subtitles window.
  toggleOverlay: (): Promise<boolean> => ipcRenderer.invoke('overlay:toggle'),
  hideOverlay: (): Promise<void> => ipcRenderer.invoke('overlay:hide'),
  isOverlayVisible: (): Promise<boolean> => ipcRenderer.invoke('overlay:isVisible'),
  getOverlaySettings: (): Promise<OverlaySettings> => ipcRenderer.invoke('overlay:getSettings'),
  setOverlaySettings: (patch: Partial<OverlaySettings>): Promise<OverlaySettings> =>
    ipcRenderer.invoke('overlay:setSettings', patch),
  getOverlayLines: (): Promise<OverlayLine[]> => ipcRenderer.invoke('overlay:getLines'),
  sendOverlayLines: (lines: OverlayLine[]): void => ipcRenderer.send('overlay:lines', lines),
  setOverlayInteractive: (interactive: boolean): void => ipcRenderer.send('overlay:setInteractive', interactive),
  resizeOverlay: (size: { width: number; height: number }): void => ipcRenderer.send('overlay:resize', size),
  onOverlayLines: (cb: (lines: OverlayLine[]) => void): (() => void) => subscribe('overlay:lines', cb),
  onOverlaySettings: (cb: (s: OverlaySettings) => void): (() => void) => subscribe('overlay:settings', cb),
  onOverlayVisible: (cb: (visible: boolean) => void): (() => void) => subscribe('overlay:visible', cb),
  onUiLanguage: (cb: (lang: UiLanguage) => void): (() => void) => subscribe('ui:language', cb),

  onCaptureError: (cb: (message: string) => void): (() => void) => {
    const listener = (_e: unknown, message: string): void => cb(message)
    ipcRenderer.on('capture:error', listener)
    return () => ipcRenderer.removeListener('capture:error', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
