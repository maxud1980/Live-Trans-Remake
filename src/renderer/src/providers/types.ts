// Contract every translation provider implements. The app only talks to this interface, so
// providers can be switched in Settings without touching capture, segmentation or the UI.

export type LiveConfig = {
  // App language codes (see lib/languages.ts); each provider maps them to its own codes.
  sourceLanguageCode: string // 'auto' or a language code
  targetLanguageCode: string
  // Whether speech that is already in the target language is repeated in the translation
  // column. Off by default: an interviewer asking in the target language stays one-sided.
  echoTargetLanguage: boolean
}

export type LiveHandlers = {
  // Fires once, the first time the session is ready — start capture here.
  onReady: () => void
  // Reconnect lifecycle (capture stays alive across these).
  onReconnecting: (attempt: number, delayMs: number) => void
  onReconnected: () => void
  // Text arrives as incremental deltas — append them.
  onInputTranscript: (delta: string) => void
  onOutputTranscript: (delta: string) => void
  // A natural boundary between utterances (turn complete / endpoint detected).
  onTurnComplete: () => void
  // The language the provider detected in the source speech (app code), when known.
  onSourceLanguage?: (code: string) => void
  // Fatal for this session: the caller is expected to tear everything down.
  onError: (message: string) => void
  // Terminal close only: the first connect failed, or retries ran out.
  onClose: (info: { code: number; reason: string }) => void
}

export interface TranslationProvider {
  connect(config: LiveConfig, handlers: LiveHandlers): void
  // 100 ms of 16 kHz / 16-bit / mono PCM, base64-encoded.
  sendAudioChunk(base64Pcm16k: string): void
  close(): void
}

// Audio captured while a reconnect is in flight is held here and flushed once the new
// session is ready, so a reconnect does not swallow the middle of a sentence.
// 30 frames x 100 ms = 3 s; older frames are dropped first.
export class AudioBacklog {
  private frames: string[] = []
  constructor(private readonly max = 30) {}

  push(frame: string): void {
    this.frames.push(frame)
    if (this.frames.length > this.max) this.frames.splice(0, this.frames.length - this.max)
  }

  drain(): string[] {
    const out = this.frames
    this.frames = []
    return out
  }

  clear(): void {
    this.frames = []
  }
}

export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 8000
export const MAX_RECONNECT_ATTEMPTS = 8

export function backoffDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1))
}
