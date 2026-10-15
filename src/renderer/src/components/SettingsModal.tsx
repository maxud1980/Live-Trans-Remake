import { useEffect, useState } from 'react'
import type { ProviderId } from '../lib/languages'

export const PROVIDER_INFO: Record<ProviderId, { name: string; short: string; desc: string; keyLabel: string; placeholder: string; keyUrl: string }> = {
  gemini: {
    name: 'Gemini 3.5 Live Translate',
    short: 'Gemini Live Translate',
    desc: '78 languages. Built for speech-to-speech; the app shows its transcripts.',
    keyLabel: 'Gemini API key',
    placeholder: 'AIza…',
    keyUrl: 'https://aistudio.google.com/apikey'
  },
  soniox: {
    name: 'Soniox real-time translation',
    short: 'Soniox',
    desc: '60 languages. Returns text directly — original and translation in one stream.',
    keyLabel: 'Soniox API key',
    placeholder: 'Soniox API key',
    keyUrl: 'https://console.soniox.com'
  }
}

export function SettingsModal(props: {
  onClose: () => void
  provider: ProviderId
  onProviderChange: (p: ProviderId) => void
  providerLocked: boolean
  keys: Record<ProviderId, boolean>
  onSaveKey: (p: ProviderId, key: string) => Promise<boolean>
  onRemoveKey: (p: ProviderId) => Promise<void>
  echoTargetLanguage: boolean
  onEchoChange: (v: boolean) => void
  debugLogging: boolean
  onDebugLoggingChange: (v: boolean) => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/55 p-6 backdrop-blur-sm"
      onClick={props.onClose}
    >
      <div
        className="no-drag flex max-h-[88vh] w-full max-w-lg animate-pop-in flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Settings</h2>
            <p className="text-[11px] text-muted">Configure your translation session</p>
          </div>
          <button
            onClick={props.onClose}
            className="grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-foreground"
            title="Close"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <Field
            label="Translation service"
            hint={props.providerLocked ? 'Stop the current translation to switch services.' : undefined}
          >
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(PROVIDER_INFO) as ProviderId[]).map((id) => {
                const selected = props.provider === id
                return (
                  <button
                    key={id}
                    disabled={props.providerLocked && !selected}
                    onClick={() => props.onProviderChange(id)}
                    className={`rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
                      selected ? 'border-accent bg-accent/10' : 'border-border bg-background hover:border-border-strong'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold text-foreground">{PROVIDER_INFO[id].short}</span>
                      <span
                        className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
                          selected ? 'border-accent bg-accent' : 'border-border-strong'
                        }`}
                      />
                    </span>
                    <span className="mt-1 block text-[11px] leading-snug text-faint">{PROVIDER_INFO[id].desc}</span>
                    <span className={`mt-2 block text-[10px] font-medium ${props.keys[id] ? 'text-emerald-300' : 'text-amber-300'}`}>
                      {props.keys[id] ? 'Key saved' : 'No key yet'}
                    </span>
                  </button>
                )
              })}
            </div>
          </Field>

          <KeyField provider={props.provider} saved={props.keys[props.provider]} onSave={props.onSaveKey} onRemove={props.onRemoveKey} />

          <Field label="Translation">
            <Toggle
              checked={props.echoTargetLanguage}
              onChange={props.onEchoChange}
              title="Repeat speech already in the target language"
              desc="When off, lines spoken in the target language (e.g. an interviewer’s questions) show only in the original column."
            />
          </Field>

          <Field label="Diagnostics">
            <Toggle
              checked={props.debugLogging}
              onChange={props.onDebugLoggingChange}
              title="Debug logging"
              desc="Writes a detailed log for troubleshooting. Verbose Chromium logging applies after a restart."
            />
            {props.debugLogging && (
              <button
                onClick={() => void window.api.openDebugLogFolder()}
                className="mt-1 px-3 text-[11px] text-accent hover:underline"
              >
                Open log folder
              </button>
            )}
          </Field>
        </div>

        <div className="flex justify-end border-t border-border px-5 py-3">
          <button
            onClick={props.onClose}
            className="rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-foreground transition hover:bg-elevated"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

// Key input for one provider. The saved key is never shown: the field only accepts a new one.
function KeyField(props: {
  provider: ProviderId
  saved: boolean
  onSave: (p: ProviderId, key: string) => Promise<boolean>
  onRemove: (p: ProviderId) => Promise<void>
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const info = PROVIDER_INFO[props.provider]

  useEffect(() => setValue(''), [props.provider])

  async function save(): Promise<void> {
    if (!value.trim()) return
    if (await props.onSave(props.provider, value.trim())) setValue('')
  }

  return (
    <Field
      label={info.keyLabel}
      hint={
        props.saved
          ? 'Saved, encrypted via the OS keychain. It never leaves the app’s main process; sessions use short-lived keys.'
          : 'Stored encrypted on this device via the OS keychain.'
      }
    >
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
          placeholder={props.saved ? '•••••••• saved — paste a new key to replace' : info.placeholder}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-accent"
        />
        <button
          onClick={() => void save()}
          disabled={!value.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {props.saved ? 'Replace' : 'Save'}
        </button>
        {props.saved && (
          <button
            onClick={() => void props.onRemove(props.provider)}
            className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-muted transition hover:bg-elevated hover:text-red-300"
          >
            Remove
          </button>
        )}
      </div>
      {!props.saved && (
        <a
          href={info.keyUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-block text-[11px] text-accent hover:underline"
        >
          Get a {info.short} key →
        </a>
      )}
    </Field>
  )
}

function Field(props: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">{props.label}</label>
      {props.children}
      {props.hint && <p className="mt-1.5 text-[11px] text-faint">{props.hint}</p>}
    </div>
  )
}

function Toggle(props: {
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  desc: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => props.onChange(!props.checked)}
      className="flex w-full items-center justify-between gap-4 rounded-lg px-3 py-2.5 text-left transition hover:bg-surface-2"
    >
      <span>
        <span className="block text-[13px] font-medium text-foreground">{props.title}</span>
        <span className="block text-[11px] text-faint">{props.desc}</span>
      </span>
      <span
        className={`relative h-5.5 w-9.5 shrink-0 rounded-full transition-colors ${props.checked ? 'bg-accent' : 'bg-border-strong'}`}
      >
        <span
          className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow transition-transform ${
            props.checked ? 'translate-x-4.5' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  )
}
