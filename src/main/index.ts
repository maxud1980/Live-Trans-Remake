import { app, BrowserWindow, ipcMain, safeStorage, shell, session, systemPreferences } from 'electron'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import Store from 'electron-store'

type Persisted = {
  apiKeyEnc?: string // base64 of safeStorage-encrypted API key
  sourceLang: string
  targetLang: string
  audioSourceId: string
}

const store = new Store<Persisted>({
  defaults: {
    sourceLang: 'auto',
    targetLang: 'en',
    audioSourceId: '__system_audio__'
  }
})

function getApiKey(): string {
  const enc = store.get('apiKeyEnc')
  if (!enc) return ''
  if (!safeStorage.isEncryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}

function setApiKey(key: string): boolean {
  if (!key) {
    store.delete('apiKeyEnc')
    return true
  }
  if (!safeStorage.isEncryptionAvailable()) return false
  const enc = safeStorage.encryptString(key).toString('base64')
  store.set('apiKeyEnc', enc)
  return true
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
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
      sandbox: false
    }
  })

  mainWindow = win
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
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

ipcMain.handle('capture:start', () => {
  stopCapture()
  const spec = captureSpawnSpec()
  if ('error' in spec) {
    return { ok: false, error: spec.error }
  }
  let proc: ChildProcessWithoutNullStreams
  try {
    proc = spawn(spec.file, spec.args)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  audioProc = proc

  proc.stdout.on('data', (chunk: Buffer) => {
    // Re-frame the byte stream into exact 100ms frames so each chunk is sample-aligned.
    pcmLeftover = pcmLeftover.length ? Buffer.concat([pcmLeftover, chunk]) : chunk
    let offset = 0
    while (pcmLeftover.length - offset >= FRAME_BYTES) {
      const frame = pcmLeftover.subarray(offset, offset + FRAME_BYTES)
      offset += FRAME_BYTES
      mainWindow?.webContents.send('capture:pcm', {
        b64: frame.toString('base64'),
        rms: rms16(frame)
      })
    }
    pcmLeftover = offset > 0 ? Buffer.from(pcmLeftover.subarray(offset)) : pcmLeftover
  })

  // AudioTee emits structured JSON log lines on stderr; only surface real errors.
  let lastError = ''
  proc.stderr.on('data', (d: Buffer) => {
    for (const line of d.toString('utf8').split('\n')) {
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
    mainWindow?.webContents.send('capture:error', e.message)
  })
  proc.on('exit', (code) => {
    if (code && code !== 0 && audioProc === proc) {
      mainWindow?.webContents.send(
        'capture:error',
        lastError || `audio capture stopped (code ${code})`
      )
    }
    if (audioProc === proc) audioProc = null
  })

  return { ok: true }
})

ipcMain.handle('capture:stop', () => {
  stopCapture()
  return true
})

app.on('before-quit', stopCapture)

// ---- IPC ----
ipcMain.handle('settings:get', () => ({
  hasApiKey: !!store.get('apiKeyEnc'),
  apiKey: getApiKey(),
  sourceLang: store.get('sourceLang'),
  targetLang: store.get('targetLang'),
  audioSourceId: store.get('audioSourceId'),
  encryptionAvailable: safeStorage.isEncryptionAvailable(),
  platform: process.platform
}))

ipcMain.handle('settings:setApiKey', (_e, key: string) => setApiKey(key))

ipcMain.handle('perm:microphoneStatus', () => {
  if (process.platform !== 'darwin') return 'granted'
  return systemPreferences.getMediaAccessStatus('microphone')
})

let microphonePermissionRequest: Promise<boolean> | null = null

ipcMain.handle('perm:requestMicrophone', async () => {
  if (process.platform !== 'darwin') return true

  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'granted') return true
  if (status === 'denied' || status === 'restricted') return false
  if (microphonePermissionRequest) return microphonePermissionRequest

  microphonePermissionRequest = (async () => {
    try {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      if (!granted) return false

      // macOS can resolve requestAccessForMediaType before the TCC status
      // observable by Chromium has caught up. Do not let getUserMedia race
      // that transition and trigger a second native permission dialog.
      for (let i = 0; i < 20; i++) {
        if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return systemPreferences.getMediaAccessStatus('microphone') === 'granted'
    } catch {
      return false
    } finally {
      microphonePermissionRequest = null
    }
  })()

  return microphonePermissionRequest
})

ipcMain.handle('settings:setPrefs', (_e, prefs: Partial<Persisted>) => {
  if (typeof prefs.sourceLang === 'string') store.set('sourceLang', prefs.sourceLang)
  if (typeof prefs.targetLang === 'string') store.set('targetLang', prefs.targetLang)
  if (typeof prefs.audioSourceId === 'string') store.set('audioSourceId', prefs.audioSourceId)
  return true
})

app.whenReady().then(() => {
  // Native macOS TCC consent is requested explicitly before microphone capture.
  // Once macOS has granted it, also grant Chromium's media permission for this
  // local renderer so getUserMedia() does not start a second permission flow.
  // System-audio mode never touches this path because it does not call getUserMedia().
  const ses = session.defaultSession
  ses.setPermissionCheckHandler((_webContents, permission, _requestingOrigin, details) => {
    if (permission !== 'media') return false
    if (process.platform !== 'darwin') return true
    if (details?.mediaType && details.mediaType !== 'audio') return false
    return systemPreferences.getMediaAccessStatus('microphone') === 'granted'
  })
  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission !== 'media') return callback(false)
    if (process.platform !== 'darwin') return callback(true)
    const mediaTypes = details && 'mediaTypes' in details ? details.mediaTypes : []
    const wantsAudio = mediaTypes.length === 0 || mediaTypes.includes('audio')
    callback(wantsAudio && systemPreferences.getMediaAccessStatus('microphone') === 'granted')
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
