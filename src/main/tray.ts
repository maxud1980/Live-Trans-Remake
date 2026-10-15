import { Menu, Tray, nativeImage } from 'electron'
import { TRAY_ICON_32, TRAY_ICON_64 } from './trayIcon'

export type TrayLabels = {
  show: string
  start: string
  stop: string
  showSubtitles: string
  hideSubtitles: string
  quit: string
  tooltipIdle: string
  tooltipRunning: string
}

type Deps = {
  onShowWindow: () => void
  onToggleTranslation: () => void
  onToggleOverlay: () => void
  onQuit: () => void
}

/** Tray / menu-bar icon with quick controls, so translation can be run without the main window. */
export class AppTray {
  private tray: Tray | null = null
  private running = false
  private overlayVisible = false
  private labels: TrayLabels | null = null
  private shortcuts: { translation: string; overlay: string } = { translation: '', overlay: '' }

  constructor(private readonly deps: Deps) {}

  create(labels: TrayLabels, shortcuts: { translation: string; overlay: string }): void {
    this.labels = labels
    this.shortcuts = shortcuts
    if (this.tray) return this.rebuild()
    const icon = nativeImage.createFromDataURL(TRAY_ICON_32)
    icon.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_64 })
    this.tray = new Tray(process.platform === 'darwin' ? icon.resize({ width: 18, height: 18 }) : icon)
    this.tray.on('click', () => this.deps.onShowWindow())
    this.rebuild()
  }

  setLabels(labels: TrayLabels): void {
    this.labels = labels
    this.rebuild()
  }

  setRunning(running: boolean): void {
    this.running = running
    this.rebuild()
  }

  setOverlayVisible(visible: boolean): void {
    this.overlayVisible = visible
    this.rebuild()
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private rebuild(): void {
    const l = this.labels
    if (!this.tray || !l) return
    this.tray.setToolTip(`live-trans — ${this.running ? l.tooltipRunning : l.tooltipIdle}`)
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: l.show, click: () => this.deps.onShowWindow() },
        { type: 'separator' },
        {
          label: this.running ? l.stop : l.start,
          accelerator: this.shortcuts.translation || undefined,
          registerAccelerator: false, // shown for reference; the global shortcut does the work
          click: () => this.deps.onToggleTranslation()
        },
        {
          label: this.overlayVisible ? l.hideSubtitles : l.showSubtitles,
          accelerator: this.shortcuts.overlay || undefined,
          registerAccelerator: false,
          click: () => this.deps.onToggleOverlay()
        },
        { type: 'separator' },
        { label: l.quit, click: () => this.deps.onQuit() }
      ])
    )
  }
}
