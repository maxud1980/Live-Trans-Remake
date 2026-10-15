import { t } from '../lib/i18n'
import { fromProviderCode, providerCode } from '../lib/languages'
import {
  AudioBacklog,
  MAX_RECONNECT_ATTEMPTS,
  backoffDelay,
  type LiveConfig,
  type LiveHandlers,
  type TranslationProvider
} from './types'

// Soniox real-time speech-to-text with built-in translation. Unlike Gemini Live Translate it
// returns text natively (no synthesized audio), with original and translated tokens in one
// stream — a natural fit for a subtitles-only app.
// Docs: soniox.com/docs/stt/api-reference/websocket-api, /docs/guides/websocket-authentication
const WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'
export const SONIOX_MODEL = 'stt-rt-v5'

// Soniox closes a connection that receives nothing for a while; keepalive covers silent
// stretches where the capture helper sends no frames.
const KEEPALIVE_CHECK_MS = 5000
const KEEPALIVE_AFTER_IDLE_MS = 15_000

type SonioxToken = {
  text: string
  is_final?: boolean
  translation_status?: 'none' | 'original' | 'translation'
  language?: string
}

type SonioxResponse = {
  tokens?: SonioxToken[]
  finished?: boolean
  error_code?: number
  error_type?: string
  error_message?: string
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export class SonioxProvider implements TranslationProvider {
  private ws: WebSocket | null = null
  private ready = false
  private config: LiveConfig | null = null
  private handlers: LiveHandlers | null = null
  private hasReadyOnce = false
  private closedByUser = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private lastSentAt = 0
  private backlog = new AudioBacklog()
  private lastDetectedLanguage = ''

  connect(config: LiveConfig, handlers: LiveHandlers): void {
    void window.api.debugLog('soniox.connect', {
      sourceLanguageCode: config.sourceLanguageCode,
      targetLanguageCode: config.targetLanguageCode
    })
    this.config = config
    this.handlers = handlers
    this.hasReadyOnce = false
    this.closedByUser = false
    this.reconnectAttempts = 0
    this.backlog.clear()
    this.lastDetectedLanguage = ''
    void this.openSocket()
  }

  private async openSocket(): Promise<void> {
    const config = this.config
    const handlers = this.handlers
    if (!config || !handlers || this.closedByUser) return

    const target = providerCode('soniox', config.targetLanguageCode)
    if (!target) {
      const msg = t('sonioxUnsupportedTarget')
      handlers.onError(msg)
      handlers.onClose({ code: 0, reason: msg })
      return
    }
    const source = config.sourceLanguageCode === 'auto' ? null : providerCode('soniox', config.sourceLanguageCode)

    const token = await window.api.createSonioxToken()
    if (this.closedByUser) return
    if (!token.ok) {
      void window.api.debugLog('soniox.token.error', { error: token.error })
      if (!this.hasReadyOnce) {
        handlers.onError(token.error)
        handlers.onClose({ code: 0, reason: token.error })
      } else {
        this.scheduleReconnect({ code: 0, reason: token.error })
      }
      return
    }

    // Browsers cannot set an Authorization header on a WebSocket, so the temporary key goes
    // in the subprotocol list, as Soniox documents for client-side connections.
    const ws = new WebSocket(WS_URL, ['soniox-api-key', token.token])
    this.ws = ws

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          model: SONIOX_MODEL,
          audio_format: 'pcm_s16le',
          sample_rate: 16000,
          num_channels: 1,
          enable_endpoint_detection: true,
          max_endpoint_delay_ms: 1000,
          enable_language_identification: true,
          ...(source ? { language_hints: [source] } : {}),
          translation: { type: 'one_way', target_language: target },
          client_reference_id: 'live-trans'
        })
      )
      // Soniox has no setup acknowledgement; the stream is usable once the config is sent.
      // A rejected key or config arrives as an error frame, which is fatal (see onmessage).
      this.ready = true
      this.reconnectAttempts = 0
      this.lastSentAt = Date.now()
      this.startKeepalive()
      if (!this.hasReadyOnce) {
        this.hasReadyOnce = true
        handlers.onReady()
      } else {
        for (const frame of this.backlog.drain()) this.sendFrame(ws, frame)
        handlers.onReconnected()
      }
    }

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return
      try {
        this.handleMessage(JSON.parse(ev.data) as SonioxResponse, config, handlers)
      } catch (err) {
        void window.api.debugLog('soniox.parse-error', { error: String(err) })
        handlers.onError(t('parseError', { message: String(err) }))
      }
    }

    ws.onerror = () => void window.api.debugLog('soniox.websocket.error', { hasReadyOnce: this.hasReadyOnce })

    ws.onclose = (ev: CloseEvent) => {
      void window.api.debugLog('soniox.websocket.close', { code: ev.code, reason: ev.reason, closedByUser: this.closedByUser })
      this.ready = false
      this.stopKeepalive()
      if (this.ws === ws) this.ws = null
      if (this.closedByUser) return
      if (!this.hasReadyOnce) {
        const reason = ev.reason || t('sonioxOpenFailed')
        handlers.onError(reason)
        handlers.onClose({ code: ev.code, reason })
        return
      }
      this.scheduleReconnect({ code: ev.code, reason: ev.reason })
    }
  }

  private handleMessage(msg: SonioxResponse, config: LiveConfig, handlers: LiveHandlers): void {
    if (msg.error_code) {
      void window.api.debugLog('soniox.api-error', msg)
      handlers.onError(t('sonioxError', { code: msg.error_code, message: msg.error_message ?? msg.error_type ?? t('unknownError') }))
      return
    }
    for (const t of msg.tokens ?? []) {
      // Non-final tokens are provisional and get replaced by later responses; only final
      // tokens are appended, so the transcript never shows text that later changes.
      if (!t.is_final || !t.text) continue
      if (t.text === '<end>') {
        handlers.onTurnComplete()
        continue
      }
      if (t.text.startsWith('<') && t.text.endsWith('>')) continue // other control markers

      if (t.translation_status === 'translation') {
        handlers.onOutputTranscript(t.text)
        continue
      }
      handlers.onInputTranscript(t.text)
      // 'none' = spoken text that is not translated because it already is the target language.
      if (t.translation_status === 'none' && config.echoTargetLanguage) handlers.onOutputTranscript(t.text)
      if (t.language && t.language !== this.lastDetectedLanguage) {
        this.lastDetectedLanguage = t.language
        const app = fromProviderCode('soniox', t.language)
        if (app) handlers.onSourceLanguage?.(app)
      }
    }
  }

  private scheduleReconnect(ev: { code: number; reason: string }): void {
    const handlers = this.handlers
    if (!handlers || this.closedByUser) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.backlog.clear()
      handlers.onClose({
        code: ev.code,
        reason: ev.reason
          ? `${ev.reason} (${t('gaveUp', { n: MAX_RECONNECT_ATTEMPTS })})`
          : t('gaveUp', { n: MAX_RECONNECT_ATTEMPTS })
      })
      return
    }
    const attempt = ++this.reconnectAttempts
    const delay = backoffDelay(attempt)
    handlers.onReconnecting(attempt, delay)
    this.reconnectTimer = setTimeout(() => void this.openSocket(), delay)
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    this.keepaliveTimer = setInterval(() => {
      const ws = this.ws
      if (ws && ws.readyState === WebSocket.OPEN && Date.now() - this.lastSentAt >= KEEPALIVE_AFTER_IDLE_MS) {
        ws.send(JSON.stringify({ type: 'keepalive' }))
        this.lastSentAt = Date.now()
      }
    }, KEEPALIVE_CHECK_MS)
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = null
  }

  sendAudioChunk(base64Pcm16k: string): void {
    if (this.closedByUser) return
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.ready) {
      this.sendFrame(this.ws, base64Pcm16k)
      return
    }
    if (this.hasReadyOnce) this.backlog.push(base64Pcm16k)
  }

  private sendFrame(ws: WebSocket, base64Pcm16k: string): void {
    ws.send(base64ToBytes(base64Pcm16k))
    this.lastSentAt = Date.now()
  }

  close(): void {
    void window.api.debugLog('soniox.close')
    this.ready = false
    this.closedByUser = true
    this.backlog.clear()
    this.stopKeepalive()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        // An empty text frame tells Soniox the audio stream has ended.
        if (ws.readyState === WebSocket.OPEN) ws.send('')
        ws.close()
      } catch {
        // ignore
      }
    }
  }
}
