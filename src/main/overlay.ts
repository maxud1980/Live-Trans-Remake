import { BrowserWindow, ipcMain, screen } from 'electron'

// Floating subtitles window: transparent, frameless, always on top of other apps (including
// full-screen video players). Unlocked it can be dragged, resized and styled; locked it lets
// mouse clicks pass through to whatever is underneath.

export type OverlayBounds = { x: number; y: number; width: number; height: number }

export type OverlaySettings = {
  fontSize: number
  lines: number
  showOriginal: boolean
  locked: boolean
  bounds?: OverlayBounds
}

export const OVERLAY_DEFAULTS: OverlaySettings = {
  fontSize: 28,
  lines: 2,
  showOriginal: false,
  locked: false
}

export type OverlayLine = { source: string; target: string; open?: boolean }

type Deps = {
  preloadPath: string
  load: (win: BrowserWindow, hash: string) => void
  getSettings: () => OverlaySettings
  saveSettings: (s: OverlaySettings) => void
  getMainWindow: () => BrowserWindow | null
  onVisibilityChange: (visible: boolean) => void
}

const MIN_WIDTH = 320
const MIN_HEIGHT = 80

function clampSettings(s: Partial<OverlaySettings>, base: OverlaySettings): OverlaySettings {
  return {
    fontSize: Math.min(72, Math.max(14, Math.round(Number(s.fontSize ?? base.fontSize)))),
    lines: Math.min(4, Math.max(1, Math.round(Number(s.lines ?? base.lines)))),
    showOriginal: typeof s.showOriginal === 'boolean' ? s.showOriginal : base.showOriginal,
    locked: typeof s.locked === 'boolean' ? s.locked : base.locked,
    bounds: s.bounds ?? base.bounds
  }
}

// Keep a saved position only if it is still visible on one of the connected displays.
function visibleBounds(b: OverlayBounds | undefined): OverlayBounds | null {
  if (!b) return null
  const hit = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y < a.y + a.height - 20 && b.y + b.height > a.y
  })
  return hit ? b : null
}

function defaultBounds(): OverlayBounds {
  const a = screen.getPrimaryDisplay().workArea
  const width = Math.min(960, Math.round(a.width * 0.7))
  const height = 170
  return { x: Math.round(a.x + (a.width - width) / 2), y: a.y + a.height - height - 48, width, height }
}

export class OverlayController {
  private win: BrowserWindow | null = null
  private settings: OverlaySettings
  private lastLines: OverlayLine[] = []
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: Deps) {
    this.settings = clampSettings(deps.getSettings(), OVERLAY_DEFAULTS)
    this.registerIpc()
  }

  get visible(): boolean {
    return !!this.win && this.win.isVisible()
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  show(): void {
    if (!this.win) this.create()
    else {
      this.win.showInactive()
      this.notifyVisibility()
    }
  }

  hide(): void {
    this.win?.hide()
    this.notifyVisibility()
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }

  private create(): void {
    const b = visibleBounds(this.settings.bounds) ?? defaultBounds()
    const win = new BrowserWindow({
      ...b,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: 'live-trans subtitles',
      webPreferences: {
        preload: this.deps.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    // 'screen-saver' level keeps it above full-screen players on macOS; harmless elsewhere.
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.win = win
    this.applyLock()

    win.once('ready-to-show', () => {
      win.showInactive() // never steal focus from the video being watched
      this.notifyVisibility()
    })
    const persist = (): void => {
      if (this.saveTimer) clearTimeout(this.saveTimer)
      this.saveTimer = setTimeout(() => {
        if (!win.isDestroyed()) this.update({ bounds: win.getBounds() })
      }, 400)
    }
    win.on('moved', persist)
    win.on('resized', persist)
    win.on('closed', () => {
      if (this.win === win) this.win = null
      this.notifyVisibility()
    })
    this.deps.load(win, 'overlay')
  }

  private applyLock(): void {
    // forward: true still delivers mouse-move events, so the overlay can show its unlock
    // button on hover while every click goes through to the app underneath.
    this.win?.setIgnoreMouseEvents(this.settings.locked, { forward: true })
  }

  private update(patch: Partial<OverlaySettings>): OverlaySettings {
    this.settings = clampSettings({ ...this.settings, ...patch }, this.settings)
    this.deps.saveSettings(this.settings)
    if ('locked' in patch) this.applyLock()
    this.broadcast('overlay:settings', this.settings)
    return this.settings
  }

  private notifyVisibility(): void {
    const v = this.visible
    this.deps.getMainWindow()?.webContents.send('overlay:visible', v)
    this.deps.onVisibilityChange(v)
  }

  private broadcast(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload)
    this.deps.getMainWindow()?.webContents.send(channel, payload)
  }

  private registerIpc(): void {
    ipcMain.handle('overlay:toggle', () => {
      this.toggle()
      return this.visible
    })
    ipcMain.handle('overlay:isVisible', () => this.visible)
    ipcMain.handle('overlay:getSettings', () => this.settings)
    ipcMain.handle('overlay:setSettings', (_e, patch: Partial<OverlaySettings>) => {
      const { bounds: _ignored, ...rest } = patch ?? {}
      return this.update(rest)
    })
    ipcMain.handle('overlay:getLines', () => this.lastLines)
    // From the main window: the latest lines to display.
    ipcMain.on('overlay:lines', (_e, lines: OverlayLine[]) => {
      this.lastLines = Array.isArray(lines) ? lines.slice(-8) : []
      if (this.win && !this.win.isDestroyed()) this.win.webContents.send('overlay:lines', this.lastLines)
    })
    // While locked, the overlay asks to become clickable only while the cursor is on its
    // unlock button.
    ipcMain.on('overlay:setInteractive', (_e, interactive: boolean) => {
      if (!this.win || !this.settings.locked) return
      this.win.setIgnoreMouseEvents(!interactive, { forward: true })
    })
    // Resize from the overlay's own grip (transparent windows have no usable OS border).
    ipcMain.on('overlay:resize', (_e, size: { width: number; height: number }) => {
      if (!this.win) return
      const b = this.win.getBounds()
      this.win.setBounds({
        x: b.x,
        y: b.y,
        width: Math.max(MIN_WIDTH, Math.round(Number(size.width) || b.width)),
        height: Math.max(MIN_HEIGHT, Math.round(Number(size.height) || b.height))
      })
    })
    ipcMain.handle('overlay:hide', () => this.hide())
  }
}
