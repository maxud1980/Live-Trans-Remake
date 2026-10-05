export type CaptureHandlers = {
  onChunk: (base64Pcm: string) => void
  onLevel: (rms: number) => void
  onError: (message: string) => void
}

/** Captures the whole system output using the native per-platform loopback helper. */
export class SystemAudioCapture {
  private unsubPcm: (() => void) | null = null
  private unsubErr: (() => void) | null = null

  async start(handlers: CaptureHandlers): Promise<void> {
    this.unsubPcm = window.api.onCapturePcm((frame) => {
      handlers.onLevel(frame.rms)
      handlers.onChunk(frame.b64)
    })
    this.unsubErr = window.api.onCaptureError((message) => handlers.onError(message))
    const res = await window.api.startCapture()
    if (!res.ok) {
      await this.stop()
      const msg = res.error || 'Could not start system audio capture.'
      handlers.onError(msg)
      throw new Error(msg)
    }
  }

  async stop(): Promise<void> {
    this.unsubPcm?.()
    this.unsubErr?.()
    this.unsubPcm = null
    this.unsubErr = null
    await window.api.stopCapture().catch(() => {})
  }
}
