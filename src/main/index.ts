import { app, BrowserWindow, clipboard, dialog, ipcMain, net, safeStorage, shell, session, systemPreferences } from 'electron'
import { join, dirname } from 'node:path'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import Store from 'electron-store'

type ProviderId = 'gemini' | 'soniox'

type Persisted = {
  apiKeyEnc?: string // base64 of safeStorage-encrypted Gemini API key
  sonioxKeyEnc?: string // base64 of safeStorage-encrypted Soniox API key
  provider: ProviderId
  sourceLang: string
  targetLang: string
  audioSourceId: string
  echoTargetLanguage: boolean
  debugLogging: boolean
}

const store = new Store<Persisted>({
  defaults: {
    sourceLang: 'auto',
    targetLang: 'en',
    audioSourceId: '__system_audio__',
    provider: 'gemini',
    echoTargetLanguage: false,
    debugLogging: false
  }
})

// Diagnostic logging is opt-in (Settings → Debug logging). It used to be always on, which
// grew the log files without bound and pushed every transcript fragment through IPC.
let debugEnabled = store.get('debugLogging')

// Verbose Chromium/native logging can only be configured before the app is ready, so this
// part of the setting takes effect on the next launch.
const chromiumDebugLogPath = join(app.getPath('userData'), 'chromium-debug.log')
if (debugEnabled) {
  try {
    mkdirSync(dirname(chromiumDebugLogPath), { recursive: true })
    app.commandLine.appendSwitch('enable-logging', 'file')
    app.commandLine.appendSwitch('log-file', chromiumDebugLogPath)
    app.commandLine.appendSwitch('v', '1')
  } catch {
    // Diagnostic logging must never prevent the app from starting.
  }
}

type SecretField = 'apiKeyEnc' | 'sonioxKeyEnc'

// Provider keys are stored encrypted with the OS keychain (safeStorage) and only ever
// decrypted here in the main process.
function getSecret(field: SecretField): string {
  const enc = store.get(field)
  if (!enc) return ''
  if (!safeStorage.isEncryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}

function setSecret(field: SecretField, key: string): boolean {
  if (!key) {
    store.delete(field)
    return true
  }
  if (!safeStorage.isEncryptionAvailable()) return false
  store.set(field, safeStorage.encryptString(key).toString('base64'))
  return true
}

const getApiKey = (): string => getSecret('apiKeyEnc')

let mainWindow: BrowserWindow | null = null

// Diagnostic logging: kept intentionally verbose for troubleshooting microphone/TCC issues.
// Never log API keys or raw audio payloads.
const debugLogPath = join(app.getPath('userData'), 'live-trans-debug.log')
function debugLog(event: string, data?: unknown): void {
  if (!debugEnabled) return
  const timestamp = new Date().toISOString()
  let suffix = ''
  if (data !== undefined) {
    try {
      suffix = ' ' + JSON.stringify(data)
    } catch {
      suffix = ' ' + String(data)
    }
  }
  try {
    mkdirSync(dirname(debugLogPath), { recursive: true })
    appendFileSync(debugLogPath, `[${timestamp}] [main] ${event}${suffix}\n`, 'utf8')
  } catch {
    // Logging must never affect the application.
  }
}

debugLog('process-start', {
  pid: process.pid,
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  os: process.getSystemVersion(),
  appVersion: app.getVersion()
})

function createWindow(): void {
  debugLog('create-window')
  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    show: false,
    backgroundColor: '#0b0f1a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The renderer only talks to the OS through the preload bridge, so it can run sandboxed.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow = win
  debugLog('window-created', { webContentsId: win.webContents.id })
  win.on('ready-to-show', () => { debugLog('window-ready-to-show'); win.show() })
  win.webContents.on('did-finish-load', () => debugLog('renderer-did-finish-load'))
  win.webContents.on('did-fail-load', (_e, code, desc, url) => debugLog('renderer-did-fail-load', { code, desc, url }))

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    debugLog('renderer-console', { level, message, line, sourceId })
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---- System audio capture (per-platform loopback tap) ----
// We capture the WHOLE system output EXCEPT our own Electron process tree, so the model never
// hears the translated audio we play back (that was the feedback/looping cause). Both backends
// emit the SAME contract: raw 16 kHz / 16-bit / mono PCM on stdout, JSON log lines on stderr.
//   - macOS:   audiotee (Core Audio process tap), excluding our audio.mojom.AudioService PID(s).
//   - Windows: live-trans-capture.exe (WASAPI process loopback), excluding our whole process tree.
let audioProc: ChildProcessWithoutNullStreams | null = null
let captureActive = false
let pcmLeftover: Buffer<ArrayBufferLike> = Buffer.alloc(0)
const FRAME_BYTES = 3200 // 100ms @ 16kHz, 16-bit mono

function audioteeBinaryPath(): string {
  // Resolve the prebuilt Swift binary shipped inside the audiotee package.
  const dist = require.resolve('audiotee')
  const path = join(dirname(dist), '..', 'bin', 'audiotee')
  // In a packaged build the binary is asarUnpack'd; require.resolve still reports the
  // path inside app.asar, so redirect to the unpacked copy we can actually exec.
  return app.isPackaged ? path.replace('app.asar', 'app.asar.unpacked') : path
}

function winCaptureBinaryPath(): string {
  // Packaged via electron-builder `extraResources` (electron-builder.yml) → resources/win-audio-capture/.
  // In dev, the CMake build output sits under the repo at native/win-audio-capture/build/Release/.
  return app.isPackaged
    ? join(process.resourcesPath, 'win-audio-capture', 'live-trans-capture.exe')
    : join(app.getAppPath(), 'native', 'win-audio-capture', 'build', 'Release', 'live-trans-capture.exe')
}

// Resolve the capture command + args for the current platform, or an error string if unsupported
// / the binary is missing. The stdout (PCM) and stderr (JSON) handling downstream is identical.
function captureSpawnSpec(): { file: string; args: string[] } | { error: string } {
  if (process.platform === 'darwin') {
    const exclude = ownAudioServicePids()
    const args = ['--sample-rate', '16000', '--chunk-duration', '0.1']
    if (exclude.length) args.push('--exclude-processes', ...exclude.map(String))
    return { file: audioteeBinaryPath(), args }
  }
  if (process.platform === 'win32') {
    const file = winCaptureBinaryPath()
    if (!existsSync(file)) {
      return {
        error:
          'Windows audio capture helper not found. Build it with native/win-audio-capture (see docs/BUILD.md).'
      }
    }
    // EXCLUDE our main process tree (renderer + gpu + audio service) so the app itself is never re-captured.
    return {
      file,
      args: ['--sample-rate', '16000', '--chunk-duration', '0.1', '--exclude-process-tree', String(process.pid)]
    }
  }
  return { error: `System audio capture is not supported on ${process.platform} yet.` }
}

// PIDs in our own process subtree (descendants of the main process).
function processSubtree(root: number): Set<number> {
  const set = new Set<number>([root])
  try {
    const out = execSync('ps -axo pid=,ppid=', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    const childrenOf = new Map<number, number[]>()
    for (const line of out.trim().split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
      if (!childrenOf.has(ppid)) childrenOf.set(ppid, [])
      childrenOf.get(ppid)!.push(pid)
    }
    const stack = [root]
    while (stack.length) {
      const p = stack.pop()!
      for (const c of childrenOf.get(p) ?? []) {
        if (!set.has(c)) {
          set.add(c)
          stack.push(c)
        }
      }
    }
  } catch {
    // fall through with just root
  }
  return set
}

// Chromium routes audio OUTPUT through the audio.mojom.AudioService utility process.
// Excluding just that PID removes our translated playback from the tap, without passing
// non-audio PIDs (gpu/network/renderer) which lack a Core Audio object and make the tap fail.
function ownAudioServicePids(): number[] {
  const tree = processSubtree(process.pid)
  try {
    const out = execSync('ps -axo pid=,command=', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    const pids: number[] = []
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/)
      if (!m) continue
      const pid = Number(m[1])
      if (tree.has(pid) && m[2].includes('audio.mojom.AudioService')) pids.push(pid)
    }
    return pids
  } catch {
    return []
  }
}

function rms16(buf: Buffer): number {
  const n = Math.floor(buf.length / 2)
  if (n === 0) return 0
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 0x8000
    sumSq += s * s
  }
  return Math.sqrt(sumSq / n)
}

function stopCapture(): void {
  debugLog('capture-stop')
  captureActive = false
  pcmLeftover = Buffer.alloc(0)
}

function disposeCaptureProcess(): void {
  captureActive = false
  if (audioProc) {
    try {
      audioProc.kill()
    } catch {
      // ignore
    }
    audioProc = null
  }
  pcmLeftover = Buffer.alloc(0)
}

function startCaptureProcess(): { ok: boolean; error?: string } {
  if (audioProc) { debugLog('capture-process-already-running', { pid: audioProc.pid }); return { ok: true } }

  const spec = captureSpawnSpec()
  debugLog('capture-spawn-spec', spec)
  if ('error' in spec) {
    return { ok: false, error: spec.error }
  }
  let proc: ChildProcessWithoutNullStreams
  try {
    debugLog('capture-spawn', { file: spec.file, args: spec.args })
    proc = spawn(spec.file, spec.args)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  audioProc = proc
  debugLog('capture-process-started', { pid: proc.pid })

  proc.stdout.on('data', (chunk: Buffer) => {
    // Re-frame the byte stream into exact 100ms frames so each chunk is sample-aligned.
    pcmLeftover = pcmLeftover.length ? Buffer.concat([pcmLeftover, chunk]) : chunk
    let offset = 0
    while (pcmLeftover.length - offset >= FRAME_BYTES) {
      const frame = pcmLeftover.subarray(offset, offset + FRAME_BYTES)
      offset += FRAME_BYTES
      if (captureActive) {
        mainWindow?.webContents.send('capture:pcm', {
          b64: frame.toString('base64'),
          rms: rms16(frame)
        })
      }
    }
    pcmLeftover = offset > 0 ? Buffer.from(pcmLeftover.subarray(offset)) : pcmLeftover
  })

  // Keep the complete helper stderr in our diagnostic log. AudioTee normally emits
  // structured JSON, but non-JSON native/CoreAudio diagnostics are equally important here.
  let lastError = ''
  proc.stderr.on('data', (d: Buffer) => {
    const raw = d.toString('utf8')
    debugLog('capture-process-stderr', { pid: proc.pid, data: raw })
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed)
        if (msg.message_type === 'error') {
          lastError = String(msg.data?.message ?? 'audio error')
          mainWindow?.webContents.send('capture:error', lastError)
        }
      } catch {
        lastError = trimmed
      }
    }
  })

  proc.on('error', (e) => {
    debugLog('capture-process-error', { message: e.message })
    mainWindow?.webContents.send('capture:error', e.message)
  })
  proc.on('exit', (code, signal) => {
    debugLog('capture-process-exit', { code, signal })
    if (code && code !== 0 && audioProc === proc) {
      mainWindow?.webContents.send(
        'capture:error',
        lastError || `audio capture stopped (code ${code})`
      )
    }
    if (audioProc === proc) audioProc = null
  })

  return { ok: true }
}

ipcMain.handle('capture:start', () => {
  debugLog('capture-start-ipc')
  const res = startCaptureProcess()
  if (res.ok) captureActive = true
  return res
})

ipcMain.handle('capture:stop', () => {
  debugLog('capture-stop-ipc')
  // macOS keeps the Core Audio tap alive between sessions so TCC does not prompt again.
  // Windows has no such constraint, so the WASAPI helper is terminated instead of idling.
  if (process.platform === 'win32') disposeCaptureProcess()
  else stopCapture()
  return true
})

app.on('before-quit', () => { debugLog('before-quit'); disposeCaptureProcess() })

// ---- IPC ----
ipcMain.handle('debug:getPath', () => debugLogPath)
ipcMain.handle('debug:enabled', () => debugEnabled)

ipcMain.handle('debug:log', (_e, event: string, data?: unknown) => {
  debugLog(`renderer:${String(event)}`, data)
  return true
})

ipcMain.handle('debug:openFolder', () => shell.openPath(dirname(debugLogPath)))

ipcMain.handle('settings:setDebugLogging', (_e, enabled: boolean) => {
  debugEnabled = !!enabled
  store.set('debugLogging', debugEnabled)
  if (debugEnabled) debugLog('debug-logging-enabled', { appVersion: app.getVersion(), platform: process.platform })
  return debugEnabled
})

// The API key itself never leaves the main process; the renderer only learns whether one exists.
ipcMain.handle('settings:get', () => ({
  hasApiKey: !!getApiKey(),
  hasSonioxKey: !!getSecret('sonioxKeyEnc'),
  provider: store.get('provider'),
  echoTargetLanguage: store.get('echoTargetLanguage'),
  sourceLang: store.get('sourceLang'),
  targetLang: store.get('targetLang'),
  audioSourceId: store.get('audioSourceId'),
  debugLogging: debugEnabled,
  encryptionAvailable: safeStorage.isEncryptionAvailable(),
  platform: process.platform
}))

ipcMain.handle('settings:setApiKey', (_e, key: string) => setSecret('apiKeyEnc', String(key ?? '').trim()))
ipcMain.handle('settings:setSonioxKey', (_e, key: string) => setSecret('sonioxKeyEnc', String(key ?? '').trim()))

// Soniox temporary key for one WebSocket connection, minted with the long-lived key that
// stays here. Temporary keys start with snx_temp_ and are passed via the subprotocol list.
const SONIOX_TEMP_KEY_URL = 'https://api.soniox.com/v1/auth/temporary-api-key'
ipcMain.handle('soniox:createToken', async (): Promise<{ ok: true; token: string } | { ok: false; error: string }> => {
  const apiKey = getSecret('sonioxKeyEnc')
  if (!apiKey) return { ok: false, error: 'Enter your Soniox API key in Settings first.' }
  try {
    const res = await net.fetch(SONIOX_TEMP_KEY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        usage_type: 'transcribe_websocket',
        expires_in_seconds: 120,
        single_use: true,
        client_reference_id: 'live-trans'
      })
    })
    const body = (await res.json().catch(() => ({}))) as {
      api_key?: string
      apiKey?: string
      error_message?: string
      message?: string
    }
    const token = body.api_key ?? body.apiKey
    if (!res.ok || !token) {
      const detail = body.error_message || body.message || `HTTP ${res.status}`
      debugLog('soniox-token-error', { status: res.status, detail })
      return { ok: false, error: `Could not create a Soniox session key: ${detail}` }
    }
    return { ok: true, token }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    debugLog('soniox-token-network-error', { detail })
    return { ok: false, error: `Could not reach Soniox: ${detail}` }
  }
})

// Mint a short-lived Live API token for one WebSocket connection. Called for every connect
// and reconnect, so a long session never outlives its token and the key stays here.
const AUTH_TOKENS_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens'
ipcMain.handle('live:createToken', async (): Promise<{ ok: true; token: string } | { ok: false; error: string }> => {
  const apiKey = getApiKey()
  if (!apiKey) return { ok: false, error: 'Enter your Gemini API key in Settings first.' }
  const now = Date.now()
  try {
    const res = await net.fetch(AUTH_TOKENS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        newSessionExpireTime: new Date(now + 2 * 60_000).toISOString()
      })
    })
    const body = (await res.json().catch(() => ({}))) as { name?: string; error?: { message?: string } }
    if (!res.ok || !body.name) {
      const detail = body.error?.message || `HTTP ${res.status}`
      debugLog('live-token-error', { status: res.status, detail })
      return { ok: false, error: `Could not create a session token: ${detail}` }
    }
    return { ok: true, token: body.name }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    debugLog('live-token-network-error', { detail })
    return { ok: false, error: `Could not reach the Gemini API: ${detail}` }
  }
})

ipcMain.handle('perm:microphoneStatus', () => {
  if (process.platform !== 'darwin') {
    debugLog('microphone-status', { status: 'granted', platform: process.platform })
    return 'granted'
  }
  const status = systemPreferences.getMediaAccessStatus('microphone')
  debugLog('microphone-status', { status })
  return status
})

let microphonePermissionRequest: Promise<boolean> | null = null

// The ONE place the app asks macOS for microphone access.
//  - Already decided (granted / denied / restricted): just report it, never prompt.
//  - 'not-determined': call askForMediaAccess exactly once; concurrent callers share the promise.
// getUserMedia() is NOT used to trigger consent anymore (see renderer ensureMicrophoneAccess).
ipcMain.handle('perm:requestMicrophone', async () => {
  debugLog('microphone-permission-request-ipc')
  if (process.platform !== 'darwin') return true

  const status = systemPreferences.getMediaAccessStatus('microphone')
  debugLog('microphone-permission-request-status', { status })
  if (status === 'granted') return true
  if (status !== 'not-determined') return false // denied / restricted: macOS will not prompt again
  if (microphonePermissionRequest) {
    debugLog('microphone-permission-request-coalesced')
    return microphonePermissionRequest
  }

  microphonePermissionRequest = (async () => {
    try {
      debugLog('askForMediaAccess-start')
      const granted = await systemPreferences.askForMediaAccess('microphone')
      debugLog('askForMediaAccess-result', { granted })
      return granted
    } catch (err) {
      debugLog('microphone-permission-error', { error: err instanceof Error ? err.message : String(err) })
      return false
    } finally {
      microphonePermissionRequest = null
    }
  })()

  return microphonePermissionRequest
})

// Opens System Settings → Privacy & Security → Microphone (used when access was denied earlier).
ipcMain.handle('perm:openMicrophoneSettings', () =>
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
)

ipcMain.handle('settings:setPrefs', (_e, prefs: Partial<Persisted>) => {
  if (typeof prefs.sourceLang === 'string') store.set('sourceLang', prefs.sourceLang)
  if (typeof prefs.targetLang === 'string') store.set('targetLang', prefs.targetLang)
  if (typeof prefs.audioSourceId === 'string') store.set('audioSourceId', prefs.audioSourceId)
  if (prefs.provider === 'gemini' || prefs.provider === 'soniox') store.set('provider', prefs.provider)
  if (typeof prefs.echoTargetLanguage === 'boolean') store.set('echoTargetLanguage', prefs.echoTargetLanguage)
  return true
})

// ---- Session history ----
// One JSON file per session in userData/history. The renderer saves the running session
// periodically and on stop, so a crash loses at most a few seconds of transcript.
type HistorySegment = { source: string; target: string }
type HistoryRecord = {
  id: string
  startedAt: number
  endedAt: number
  sourceLang: string
  targetLang: string
  audioSource: string
  segments: HistorySegment[]
}

const historyDir = join(app.getPath('userData'), 'history')
const HISTORY_ID = /^[A-Za-z0-9-]{1,64}$/

function historyPath(id: string): string | null {
  return HISTORY_ID.test(id) ? join(historyDir, `${id}.json`) : null
}

function sanitizeRecord(r: unknown): HistoryRecord | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  if (typeof o.id !== 'string' || !HISTORY_ID.test(o.id) || !Array.isArray(o.segments)) return null
  return {
    id: o.id,
    startedAt: Number(o.startedAt) || 0,
    endedAt: Number(o.endedAt) || 0,
    sourceLang: String(o.sourceLang ?? ''),
    targetLang: String(o.targetLang ?? ''),
    audioSource: String(o.audioSource ?? ''),
    segments: o.segments.map((s) => ({
      source: String((s as HistorySegment)?.source ?? ''),
      target: String((s as HistorySegment)?.target ?? '')
    }))
  }
}

ipcMain.handle('history:save', async (_e, raw: unknown) => {
  const record = sanitizeRecord(raw)
  const path = record && historyPath(record.id)
  if (!record || !path) return false
  try {
    mkdirSync(historyDir, { recursive: true })
    // Write-then-rename so an interrupted write never leaves a truncated session file.
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(record), 'utf8')
    await rename(tmp, path)
    return true
  } catch (err) {
    debugLog('history-save-error', { error: String(err) })
    return false
  }
})

ipcMain.handle('history:list', async () => {
  let files: string[] = []
  try {
    files = (await readdir(historyDir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    try {
      const record = sanitizeRecord(JSON.parse(await readFile(join(historyDir, f), 'utf8')))
      if (!record) continue
      const { segments, ...meta } = record
      const first = segments.find((s) => s.target || s.source)
      out.push({ ...meta, segmentCount: segments.length, preview: (first?.target || first?.source || '').slice(0, 140) })
    } catch {
      // Skip unreadable files rather than failing the whole list.
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
})

ipcMain.handle('history:get', async (_e, id: string) => {
  const path = historyPath(String(id))
  if (!path) return null
  try {
    return sanitizeRecord(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
})

ipcMain.handle('history:delete', async (_e, id: string) => {
  const path = historyPath(String(id))
  if (!path) return false
  await rm(path, { force: true })
  return true
})

ipcMain.handle('export:saveText', async (_e, defaultName: string, content: string) => {
  const safeName = String(defaultName).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120) || 'live-trans.txt'
  const options = {
    title: 'Export transcript',
    defaultPath: join(app.getPath('documents'), safeName),
    filters: [{ name: 'Text', extensions: ['txt'] }]
  }
  const res = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
  if (res.canceled || !res.filePath) return { ok: false, canceled: true }
  try {
    await writeFile(res.filePath, String(content), 'utf8')
    return { ok: true, path: res.filePath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('clipboard:writeText', (_e, text: string) => {
  clipboard.writeText(String(text))
  return true
})

app.whenReady().then(() => {
  debugLog('app-ready', {
    platform: process.platform,
    arch: process.arch,
    os: process.getSystemVersion(),
    microphoneStatus: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'n/a'
  })
  const ses = session.defaultSession
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    debugLog('permission-check', { permission, requestingOrigin, details })
    if (permission !== 'media') return false
    if (process.platform !== 'darwin') return true
    // Let Chromium/macOS TCC own the actual microphone authorization decision.
    // The previous status-gated check could race TCC and turn one getUserMedia()
    // authorization into repeated native prompts.
    return details?.mediaType === undefined || details.mediaType === 'audio'
  })
  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    debugLog('permission-request', { permission, details, microphoneStatus: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'n/a' })
    if (permission !== 'media') return callback(false)
    if (process.platform !== 'darwin') return callback(true)
    const mediaTypes = (details && 'mediaTypes' in details ? details.mediaTypes : undefined) ?? []
    const wantsAudio = mediaTypes.length === 0 || mediaTypes.includes('audio')
    // Grant the Chromium-level media permission only; the actual OS consent is requested once
    // by perm:requestMicrophone (askForMediaAccess) and never by getUserMedia.
    debugLog('permission-request-callback', { wantsAudio, allowed: wantsAudio })
    callback(wantsAudio)
  })

  createWindow()

  // Do not start the native system-audio helper at application startup.
  // It owns a separate Core Audio/TCC path and can interfere with microphone
  // authorization on macOS. Start it lazily when system-audio capture is requested.
  debugLog('capture-startup-skipped', { reason: 'lazy-start' })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
