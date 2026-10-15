// Ephemeral-token sessions must use the v1beta "Constrained" endpoint. The long-lived API key
// never reaches this process: the main process mints a short-lived token for every socket.
const WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained'

export const LIVE_TRANSLATE_MODEL = 'models/gemini-3.5-live-translate-preview'

// Reconnect/backoff tuning. goAway-driven reconnects are graceful and reset the
// attempt counter on success, so these caps only bite during real network loss.
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 8000
const GOAWAY_RECONNECT_MS = 200
const MAX_RECONNECT_ATTEMPTS = 8

// Audio captured while a reconnect is in flight is held here and flushed once the new
// session is ready, so a session rotation does not swallow the middle of a sentence.
// 30 frames x 100 ms = 3 s; older frames are dropped first.
const MAX_BUFFERED_FRAMES = 30

export type LiveConfig = {
  sourceLanguageCode: string
  targetLanguageCode: string
}

export type LiveHandlers = {
  // Fires once, the first time setup completes — start capture here.
  onReady: () => void
  // Reconnect lifecycle (capture stays alive across these).
  onReconnecting: (attempt: number, delayMs: number) => void
  onReconnected: () => void
  // Transcripts arrive as incremental deltas (small fragments) — append them.
  // onTurnComplete (rare for this model) marks a turn boundary.
  onInputTranscript: (delta: string) => void
  onOutputTranscript: (delta: string) => void
  onTurnComplete: () => void
  onInterrupted: () => void
  // Fatal for this session: the caller is expected to tear everything down.
  onError: (message: string) => void
  // Terminal close only: user stopped, the first connect failed, or retries ran out.
  onClose: (info: { code: number; reason: string }) => void
}

export class LiveTranslateClient {
  private ws: WebSocket | null = null
  private ready = false

  private config: LiveConfig | null = null
  private handlers: LiveHandlers | null = null

  // In-session resumption only: a handle the server issues mid-session, replayed
  // on a transparent reconnect (goAway / network drop) so the SAME live session
  // continues without a gap. Reset on every fresh connect() — we never resume an
  // old session across manual start/stop or app restarts.
  private resumptionHandle: string | null = null

  private hasReadyOnce = false
  private closedByUser = false
  private serverGoingAway = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pendingAudio: string[] = []

  connect(config: LiveConfig, handlers: LiveHandlers): void {
    void window.api.debugLog('gemini.connect', {
      sourceLanguageCode: config.sourceLanguageCode,
      targetLanguageCode: config.targetLanguageCode
    })
    this.config = config
    this.handlers = handlers
    this.resumptionHandle = null
    this.hasReadyOnce = false
    this.closedByUser = false
    this.reconnectAttempts = 0
    this.pendingAudio = []
    void this.openSocket()
  }

  private async openSocket(): Promise<void> {
    const config = this.config
    const handlers = this.handlers
    if (!config || !handlers || this.closedByUser) return

    this.serverGoingAway = false

    const token = await window.api.createLiveToken()
    // The user may have pressed Stop while the token request was in flight.
    if (this.closedByUser) return
    if (!token.ok) {
      void window.api.debugLog('gemini.token.error', { error: token.error })
      if (!this.hasReadyOnce) {
        handlers.onError(token.error)
        handlers.onClose({ code: 0, reason: token.error })
      } else {
        this.scheduleReconnect({ code: 0, reason: token.error })
      }
      return
    }

    const url = `${WS_BASE}?access_token=${encodeURIComponent(token.token)}`
    void window.api.debugLog('gemini.websocket.open', { resume: !!this.resumptionHandle })
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      const setup = {
        setup: {
          model: LIVE_TRANSLATE_MODEL,
          // translationConfig + responseModalities live under generationConfig on the wire.
          generationConfig: {
            responseModalities: ['AUDIO'],
            translationConfig: {
              targetLanguageCode: config.targetLanguageCode
            }
          },
          inputAudioTranscription:
            config.sourceLanguageCode === 'auto' ? {} : { languageCodes: [config.sourceLanguageCode] },
          outputAudioTranscription: {},
          // Enabling sessionResumption makes the server emit sessionResumptionUpdate
          // handles; replaying the last handle resumes the same session.
          sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {}
        }
      }
      ws.send(JSON.stringify(setup))
    }

    ws.onmessage = async (ev: MessageEvent) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : await (ev.data as Blob).text()
        this.handleMessage(JSON.parse(raw) as Record<string, any>, handlers)
      } catch (err) {
        void window.api.debugLog('gemini.websocket.parse-error', { error: String(err) })
        handlers.onError(`Failed to parse server message: ${String(err)}`)
      }
    }

    // onclose always follows onerror and decides what happens next.
    ws.onerror = () => void window.api.debugLog('gemini.websocket.error', { hasReadyOnce: this.hasReadyOnce })

    ws.onclose = (ev: CloseEvent) => {
      void window.api.debugLog('gemini.websocket.close', {
        code: ev.code,
        reason: ev.reason,
        closedByUser: this.closedByUser
      })
      this.ready = false
      if (this.ws === ws) this.ws = null
      if (this.closedByUser) return

      // A session that never became ready is almost always a configuration problem
      // (key, model access, quota). Retrying it eight times just hides the error.
      if (!this.hasReadyOnce) {
        const reason = ev.reason || 'Could not open a translation session — check your API key, network and model access.'
        handlers.onError(reason)
        handlers.onClose({ code: ev.code, reason })
        return
      }

      this.scheduleReconnect({ code: ev.code, reason: ev.reason })
    }
  }

  private scheduleReconnect(ev: { code: number; reason: string }): void {
    const handlers = this.handlers
    if (!handlers || this.closedByUser) return

    // A graceful goAway is expected (sessions rotate every few minutes); reconnect
    // fast and don't let it eat into the failure budget.
    if (this.serverGoingAway) {
      this.serverGoingAway = false
      handlers.onReconnecting(0, GOAWAY_RECONNECT_MS)
      this.reconnectTimer = setTimeout(() => void this.openSocket(), GOAWAY_RECONNECT_MS)
      return
    }

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.pendingAudio = []
      handlers.onClose({
        code: ev.code,
        reason: ev.reason
          ? `${ev.reason} (gave up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts)`
          : `gave up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`
      })
      return
    }

    const attempt = ++this.reconnectAttempts
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1))
    handlers.onReconnecting(attempt, delay)
    this.reconnectTimer = setTimeout(() => void this.openSocket(), delay)
  }

  private handleMessage(msg: Record<string, any>, handlers: LiveHandlers): void {
    if (msg.setupComplete) {
      this.ready = true
      this.reconnectAttempts = 0
      if (!this.hasReadyOnce) {
        this.hasReadyOnce = true
        handlers.onReady()
      } else {
        this.flushPendingAudio()
        handlers.onReconnected()
      }
      return
    }

    // Server hands us a resumption token; keep the latest resumable one in memory
    // so a transparent reconnect within this session can replay it. Not persisted.
    const resume = msg.sessionResumptionUpdate
    if (resume) {
      if (resume.resumable && resume.newHandle) {
        this.resumptionHandle = resume.newHandle
      }
      return
    }

    // Server is about to close this connection — reconnect with the handle when it does.
    if (msg.goAway) {
      void window.api.debugLog('gemini.goAway', msg.goAway)
      this.serverGoingAway = true
      return
    }

    const server = msg.serverContent
    if (server) {
      if (server.interrupted) handlers.onInterrupted()
      if (server.inputTranscription?.text) handlers.onInputTranscript(server.inputTranscription.text)
      if (server.outputTranscription?.text) handlers.onOutputTranscript(server.outputTranscription.text)
      // The translation model returns translated audio as its response modality.
      // This app is subtitles-only, so the audio stream is intentionally ignored.
      if (server.turnComplete) handlers.onTurnComplete()
    }

    if (msg.error) {
      const e = msg.error
      void window.api.debugLog('gemini.api-error', e)
      handlers.onError(`API error ${e.code ?? ''}: ${e.message ?? JSON.stringify(e)}`)
    }
  }

  sendAudioChunk(base64Pcm16k: string): void {
    if (this.closedByUser) return
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.ready) {
      this.sendFrame(this.ws, base64Pcm16k)
      return
    }
    // Only buffer across reconnects; before the first setupComplete capture hasn't started.
    if (!this.hasReadyOnce) return
    this.pendingAudio.push(base64Pcm16k)
    if (this.pendingAudio.length > MAX_BUFFERED_FRAMES) {
      this.pendingAudio.splice(0, this.pendingAudio.length - MAX_BUFFERED_FRAMES)
    }
  }

  private flushPendingAudio(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const frames = this.pendingAudio
    this.pendingAudio = []
    if (frames.length) void window.api.debugLog('gemini.flush-buffered-audio', { frames: frames.length })
    for (const frame of frames) this.sendFrame(ws, frame)
  }

  private sendFrame(ws: WebSocket, base64Pcm16k: string): void {
    ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: { data: base64Pcm16k, mimeType: 'audio/pcm;rate=16000' }
        }
      })
    )
  }

  close(): void {
    void window.api.debugLog('gemini.close')
    this.ready = false
    this.closedByUser = true
    this.pendingAudio = []
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
  }
}
