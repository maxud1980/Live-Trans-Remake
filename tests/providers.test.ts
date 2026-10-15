import { beforeEach, describe, expect, test } from 'bun:test'

// ---- Minimal browser stand-ins: a scriptable WebSocket and the preload bridge ----
type Sent = string | Uint8Array
class FakeWS {
  static OPEN = 1
  static instances: FakeWS[] = []
  readyState = 1
  sent: Sent[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(
    public url: string,
    public protocols?: string[]
  ) {
    FakeWS.instances.push(this)
    queueMicrotask(() => this.onopen?.())
  }
  send(d: Sent): void {
    this.sent.push(d)
  }
  close(): void {
    this.closed = true
    this.readyState = 3
  }
  receive(o: unknown): void {
    this.onmessage?.({ data: JSON.stringify(o) })
  }
  json(i: number): any {
    return JSON.parse(this.sent[i] as string)
  }
}

let tokenOk = true
const g = globalThis as any
g.WebSocket = FakeWS
g.window = {
  api: {
    debugLog: async () => false,
    createLiveToken: async () => (tokenOk ? { ok: true, token: 'auth_tokens/abc' } : { ok: false, error: 'bad key' }),
    createSonioxToken: async () => (tokenOk ? { ok: true, token: 'snx_temp_123' } : { ok: false, error: 'bad soniox key' })
  }
}

const { SonioxProvider } = await import('../src/renderer/src/providers/soniox')
const { GeminiProvider } = await import('../src/renderer/src/providers/gemini')

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

function recorder() {
  const ev: string[] = []
  const src: string[] = []
  const tgt: string[] = []
  return {
    ev,
    src,
    tgt,
    handlers: {
      onReady: () => ev.push('ready'),
      onReconnecting: (a: number) => ev.push(`reconnecting:${a}`),
      onReconnected: () => ev.push('reconnected'),
      onInputTranscript: (t: string) => src.push(t),
      onOutputTranscript: (t: string) => tgt.push(t),
      onTurnComplete: () => ev.push('turn'),
      onSourceLanguage: (c: string) => ev.push(`lang:${c}`),
      onError: (m: string) => ev.push(`error:${m}`),
      onClose: (c: { reason: string }) => ev.push(`close:${c.reason}`)
    }
  }
}

beforeEach(() => {
  FakeWS.instances = []
  tokenOk = true
})

describe('SonioxProvider', () => {
  test('authenticates via subprotocol and sends a one-way translation config', async () => {
    const r = recorder()
    const p = new SonioxProvider()
    p.connect({ sourceLanguageCode: 'ru', targetLanguageCode: 'uk', echoTargetLanguage: false }, r.handlers)
    await tick()
    const ws = FakeWS.instances[0]
    expect(ws.url).toBe('wss://stt-rt.soniox.com/transcribe-websocket')
    expect(ws.protocols).toEqual(['soniox-api-key', 'snx_temp_123'])
    const cfg = ws.json(0)
    expect(cfg.api_key).toBeUndefined()
    expect(cfg).toMatchObject({
      model: 'stt-rt-v5',
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
      language_hints: ['ru'],
      translation: { type: 'one_way', target_language: 'uk' }
    })
    expect(r.ev).toEqual(['ready'])
    p.close()
  })

  test('maps app codes to Soniox codes and omits hints for auto-detect', async () => {
    const p = new SonioxProvider()
    p.connect({ sourceLanguageCode: 'auto', targetLanguageCode: 'zh-Hans', echoTargetLanguage: false }, recorder().handlers)
    await tick()
    const cfg = FakeWS.instances[0].json(0)
    expect(cfg.language_hints).toBeUndefined()
    expect(cfg.translation.target_language).toBe('zh')
    p.close()
  })

  test('appends only final tokens, routes translations, handles <end> and language', async () => {
    const r = recorder()
    const p = new SonioxProvider()
    p.connect({ sourceLanguageCode: 'auto', targetLanguageCode: 'uk', echoTargetLanguage: false }, r.handlers)
    await tick()
    const ws = FakeWS.instances[0]
    ws.receive({
      tokens: [
        { text: 'Привет', is_final: true, translation_status: 'original', language: 'ru' },
        { text: ' как', is_final: false, translation_status: 'original', language: 'ru' }
      ]
    })
    ws.receive({
      tokens: [
        { text: ' как дела', is_final: true, translation_status: 'original', language: 'ru' },
        { text: 'Привіт, як справи', is_final: true, translation_status: 'translation', language: 'uk' },
        { text: 'Як справи?', is_final: true, translation_status: 'none', language: 'uk' },
        { text: '<end>', is_final: true }
      ]
    })
    expect(r.src.join('')).toBe('Привет как делаЯк справи?')
    expect(r.tgt).toEqual(['Привіт, як справи']) // echo off: 'none' text is not repeated
    expect(r.ev).toContain('lang:ru')
    expect(r.ev).toContain('lang:uk')
    expect(r.ev).toContain('turn')
    p.close()
  })

  test('echo on repeats speech already in the target language', async () => {
    const r = recorder()
    const p = new SonioxProvider()
    p.connect({ sourceLanguageCode: 'auto', targetLanguageCode: 'uk', echoTargetLanguage: true }, r.handlers)
    await tick()
    FakeWS.instances[0].receive({ tokens: [{ text: 'Як справи?', is_final: true, translation_status: 'none' }] })
    expect(r.tgt).toEqual(['Як справи?'])
    p.close()
  })

  test('sends audio as binary PCM and buffers it across a reconnect', async () => {
    const r = recorder()
    const p = new SonioxProvider()
    p.connect({ sourceLanguageCode: 'ru', targetLanguageCode: 'uk', echoTargetLanguage: false }, r.handlers)
    await tick()
    const ws0 = FakeWS.instances[0]
    p.sendAudioChunk(btoa(String.fromCharCode(1, 2, 3, 4)))
    expect(ws0.sent[1]).toEqual(new Uint8Array([1, 2, 3, 4]))

    ws0.readyState = 3
    ws0.onclose?.({ code: 1006, reason: '' })
    p.sendAudioChunk(btoa('a'))
    p.sendAudioChunk(btoa('b'))
    await tick(600)
    const ws1 = FakeWS.instances[1]
    expect(ws1.json(0).model).toBe('stt-rt-v5')
    expect(ws1.sent.slice(1)).toEqual([new Uint8Array([97]), new Uint8Array([98])])
    expect(r.ev).toEqual(['ready', 'reconnecting:1', 'reconnected'])
    p.close()
  })

  test('an error frame is reported as fatal', async () => {
    const r = recorder()
    const p = new SonioxProvider()
    p.connect({ sourceLanguageCode: 'ru', targetLanguageCode: 'uk', echoTargetLanguage: false }, r.handlers)
    await tick()
    FakeWS.instances[0].receive({ error_code: 401, error_type: 'unauthorized', error_message: 'Invalid API key' })
    expect(r.ev).toContain('error:Soniox error 401: Invalid API key')
    p.close()
  })

  test('token failure on first connect fails without opening a socket', async () => {
    tokenOk = false
    const r = recorder()
    const p = new SonioxProvider()
    p.connect({ sourceLanguageCode: 'ru', targetLanguageCode: 'uk', echoTargetLanguage: false }, r.handlers)
    await tick()
    expect(FakeWS.instances.length).toBe(0)
    expect(r.ev).toEqual(['error:bad soniox key', 'close:bad soniox key'])
  })

  test('unsupported target language fails clearly', async () => {
    const r = recorder()
    const p = new SonioxProvider()
    p.connect({ sourceLanguageCode: 'auto', targetLanguageCode: 'am', echoTargetLanguage: false }, r.handlers)
    await tick()
    expect(FakeWS.instances.length).toBe(0)
    expect(r.ev[0]).toStartWith('error:Soniox does not support')
  })

  test('close ends the audio stream with an empty text frame', async () => {
    const p = new SonioxProvider()
    p.connect({ sourceLanguageCode: 'ru', targetLanguageCode: 'uk', echoTargetLanguage: false }, recorder().handlers)
    await tick()
    const ws = FakeWS.instances[0]
    p.close()
    expect(ws.sent.at(-1)).toBe('')
    expect(ws.closed).toBe(true)
  })
})

describe('GeminiProvider', () => {
  test('sends echoTargetLanguage and Gemini language codes in setup', async () => {
    const p = new GeminiProvider()
    p.connect({ sourceLanguageCode: 'ru', targetLanguageCode: 'pt-BR', echoTargetLanguage: true }, recorder().handlers)
    await tick()
    const ws = FakeWS.instances[0]
    expect(ws.url).toContain('BidiGenerateContentConstrained?access_token=auth_tokens%2Fabc')
    const setup = ws.json(0).setup
    expect(setup.generationConfig.translationConfig).toEqual({ targetLanguageCode: 'pt-BR', echoTargetLanguage: true })
    expect(setup.inputAudioTranscription).toEqual({ languageCodes: ['ru'] })
    p.close()
  })

  test('reports the detected source language once per change', async () => {
    const r = recorder()
    const p = new GeminiProvider()
    p.connect({ sourceLanguageCode: 'auto', targetLanguageCode: 'uk', echoTargetLanguage: false }, r.handlers)
    await tick()
    const ws = FakeWS.instances[0]
    ws.receive({ setupComplete: {} })
    ws.receive({ serverContent: { inputTranscription: { text: 'Привет', languageCode: 'ru' } } })
    ws.receive({ serverContent: { inputTranscription: { text: ' мир', languageCode: 'ru' } } })
    expect(r.ev.filter((e) => e.startsWith('lang:'))).toEqual(['lang:ru'])
    expect(r.src.join('')).toBe('Привет мир')
    p.close()
  })
})
