export type MicrophoneHandlers = {
  onChunk: (base64Pcm: string) => void
  onLevel: (rms: number) => void
  onError: (message: string) => void
}

const FRAME_SAMPLES = 1600 // 100 ms at 16 kHz

// Runs on the audio rendering thread. It packs the incoming float samples into exact 100 ms
// Int16 frames and transfers each finished frame (plus its RMS) to the main thread, so the
// UI thread no longer does per-sample work and UI load can't cause dropouts.
const WORKLET_SOURCE = `
class PcmFramer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = new Int16Array(${FRAME_SAMPLES})
    this.fill = 0
    this.sumSq = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]))
      this.sumSq += s * s
      this.frame[this.fill++] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
      if (this.fill === ${FRAME_SAMPLES}) {
        const rms = Math.sqrt(this.sumSq / ${FRAME_SAMPLES})
        this.port.postMessage({ pcm: this.frame.buffer, rms }, [this.frame.buffer])
        this.frame = new Int16Array(${FRAME_SAMPLES})
        this.fill = 0
        this.sumSq = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-framer', PcmFramer)
`

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)))
  }
  return btoa(binary)
}

/** Captures a selected microphone/input device and converts it to 16 kHz mono PCM. */
export class MicrophoneAudioCapture {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private worklet: AudioWorkletNode | null = null
  private silentGain: GainNode | null = null

  async start(deviceId: string, handlers: MicrophoneHandlers): Promise<void> {
    await this.stop()
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
        video: false
      })
      const track = this.stream.getAudioTracks()[0]
      void window.api.debugLog('microphone.stream', { label: track?.label, settings: track?.getSettings() })
      track?.addEventListener('ended', () => handlers.onError('The microphone was disconnected.'))

      // Chromium resamples the device rate to 16 kHz for us.
      this.ctx = new AudioContext({ sampleRate: 16000 })
      const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
      try {
        await this.ctx.audioWorklet.addModule(moduleUrl)
      } finally {
        URL.revokeObjectURL(moduleUrl)
      }

      this.source = this.ctx.createMediaStreamSource(this.stream)
      this.worklet = new AudioWorkletNode(this.ctx, 'pcm-framer', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      })
      this.worklet.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
        handlers.onLevel(event.data.rms)
        handlers.onChunk(bytesToBase64(new Uint8Array(event.data.pcm)))
      }
      // The graph must reach the destination to be pulled; a zero gain keeps it silent.
      this.silentGain = this.ctx.createGain()
      this.silentGain.gain.value = 0
      this.source.connect(this.worklet)
      this.worklet.connect(this.silentGain)
      this.silentGain.connect(this.ctx.destination)
      await this.ctx.resume()
      void window.api.debugLog('microphone.started', { state: this.ctx.state, sampleRate: this.ctx.sampleRate })
    } catch (err) {
      void window.api.debugLog('microphone.start-error', { error: String(err) })
      await this.stop()
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone permission was denied.'
          : err instanceof Error
            ? err.message
            : String(err)
      handlers.onError(message)
      throw new Error(message)
    }
  }

  async stop(): Promise<void> {
    if (this.worklet) this.worklet.port.onmessage = null
    this.worklet?.disconnect()
    this.silentGain?.disconnect()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    await this.ctx?.close().catch(() => {})
    this.worklet = null
    this.silentGain = null
    this.source = null
    this.stream = null
    this.ctx = null
  }
}
