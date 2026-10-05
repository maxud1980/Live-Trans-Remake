export type MicrophoneHandlers = {
  onChunk: (base64Pcm: string) => void
  onLevel: (rms: number) => void
  onError: (message: string) => void
}

const FRAME_SAMPLES = 1600 // 100 ms at 16 kHz

function floatToBase64Pcm16(samples: Float32Array): { b64: string; rms: number } {
  const bytes = new Uint8Array(samples.length * 2)
  let sumSq = 0
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    sumSq += s * s
    const value = s < 0 ? s * 0x8000 : s * 0x7fff
    view.setInt16(i * 2, Math.round(value), true)
  }
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)))
  }
  return { b64: btoa(binary), rms: Math.sqrt(sumSq / Math.max(1, samples.length)) }
}

/** Captures a selected microphone/input device and converts it to 16 kHz mono PCM. */
export class MicrophoneAudioCapture {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private silentGain: GainNode | null = null
  private pending = new Float32Array(0)

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
      this.ctx = new AudioContext({ sampleRate: 16000 })
      this.source = this.ctx.createMediaStreamSource(this.stream)
      this.processor = this.ctx.createScriptProcessor(4096, 1, 1)
      this.silentGain = this.ctx.createGain()
      this.silentGain.gain.value = 0
      this.processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0)
        const merged = new Float32Array(this.pending.length + input.length)
        merged.set(this.pending)
        merged.set(input, this.pending.length)
        let offset = 0
        while (merged.length - offset >= FRAME_SAMPLES) {
          const frame = merged.slice(offset, offset + FRAME_SAMPLES)
          offset += FRAME_SAMPLES
          const { b64, rms } = floatToBase64Pcm16(frame)
          handlers.onLevel(rms)
          handlers.onChunk(b64)
        }
        this.pending = merged.slice(offset)
      }
      this.source.connect(this.processor)
      this.processor.connect(this.silentGain)
      this.silentGain.connect(this.ctx.destination)
      await this.ctx.resume()
    } catch (err) {
      await this.stop()
      const message = err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone permission was denied.'
        : err instanceof Error ? err.message : String(err)
      handlers.onError(message)
      throw new Error(message)
    }
  }

  async stop(): Promise<void> {
    this.processor?.disconnect()
    this.silentGain?.disconnect()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    await this.ctx?.close().catch(() => {})
    this.processor = null
    this.silentGain = null
    this.source = null
    this.stream = null
    this.ctx = null
    this.pending = new Float32Array(0)
  }
}
