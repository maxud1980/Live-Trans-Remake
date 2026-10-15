import { useEffect, useState } from 'react'
import type { ProviderId } from '../lib/languages'
import { t, UI_LANGUAGES, type UiLanguage } from '../lib/i18n'
import type { ShortcutInfo } from '../env'

type ProviderInfo = {
  name: string
  short: string
  desc: string
  keyLabel: string
  placeholder: string
  keyUrl: string
}

/** Display info for a translation service, in the current interface language. */
export function providerInfo(id: ProviderId): ProviderInfo {
  return id === 'soniox'
    ? {
        name: 'Soniox real-time translation',
        short: 'Soniox',
        desc: t('sonioxDesc'),
        keyLabel: t('sonioxKey'),
        placeholder: 'Soniox API key',
        keyUrl: 'https://console.soniox.com'
      }
    : {
        name: 'Gemini 3.5 Live Translate',
        short: 'Gemini Live Translate',
        desc: t('geminiDesc'),
        keyLabel: t('geminiKey'),
        placeholder: 'AIza…',
        keyUrl: 'https://aistudio.google.com/apikey'
      }
}

const PROVIDERS: ProviderId[] = ['gemini', 'soniox']

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
  uiLanguage: UiLanguage
  onUiLanguageChange: (lang: UiLanguage) => void
}): React.JSX.Element {
  const [shortcuts, setShortcuts] = useState<ShortcutInfo | null>(null)
  useEffect(() => {
    void window.api.getShortcuts().then(setShortcuts)
  }, [])

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
            <h2 className="text-sm font-semibold">{t('settings')}</h2>
            <p className="text-[11px] text-muted">{t('settingsSubtitle')}</p>
          </div>
          <button
            onClick={props.onClose}
            className="grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-foreground"
            title={t('close')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <Field label={t('interfaceLanguage')}>
            <div className="inline-flex rounded-lg border border-border bg-background p-0.5">
              {UI_LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  onClick={() => props.onUiLanguageChange(l.code)}
                  className={`rounded-md px-3 py-1.5 text-[13px] transition ${
                    props.uiLanguage === l.code ? 'bg-elevated font-medium text-foreground' : 'text-muted hover:text-foreground'
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label={t('translationService')} hint={props.providerLocked ? t('switchLocked') : undefined}>
            <div className="grid grid-cols-2 gap-2">
              {PROVIDERS.map((id) => {
                const info = providerInfo(id)
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
                      <span className="text-[13px] font-semibold text-foreground">{info.short}</span>
                      <span
                        className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
                          selected ? 'border-accent bg-accent' : 'border-border-strong'
                        }`}
                      />
                    </span>
                    <span className="mt-1 block text-[11px] leading-snug text-faint">{info.desc}</span>
                    <span className={`mt-2 block text-[10px] font-medium ${props.keys[id] ? 'text-emerald-300' : 'text-amber-300'}`}>
                      {props.keys[id] ? t('keySavedBadge') : t('noKeyBadge')}
                    </span>
                  </button>
                )
              })}
            </div>
          </Field>

          <KeyField provider={props.provider} saved={props.keys[props.provider]} onSave={props.onSaveKey} onRemove={props.onRemoveKey} />

          <Field label={t('translationSection')}>
            <Toggle
              checked={props.echoTargetLanguage}
              onChange={props.onEchoChange}
              title={t('echoTitle')}
              desc={t('echoDesc')}
            />
          </Field>

          {shortcuts && (
            <Field label={t('shortcutsSection')}>
              <div className="space-y-1.5 px-3">
                <ShortcutRow label={t('shortcutTranslation')} keys={shortcuts.translation} ok={shortcuts.registered.translation} />
                <ShortcutRow label={t('shortcutOverlay')} keys={shortcuts.overlay} ok={shortcuts.registered.overlay} />
              </div>
            </Field>
          )}

          <Field label={t('diagnostics')}>
            <Toggle
              checked={props.debugLogging}
              onChange={props.onDebugLoggingChange}
              title={t('debugTitle')}
              desc={t('debugDesc')}
            />
            {props.debugLogging && (
              <button
                onClick={() => void window.api.openDebugLogFolder()}
                className="mt-1 px-3 text-[11px] text-accent hover:underline"
              >
                {t('openLogFolder')}
              </button>
            )}
          </Field>
        </div>

        <div className="flex justify-end border-t border-border px-5 py-3">
          <button
            onClick={props.onClose}
            className="rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-foreground transition hover:bg-elevated"
          >
            {t('done')}
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
  const info = providerInfo(props.provider)

  useEffect(() => setValue(''), [props.provider])

  async function save(): Promise<void> {
    if (!value.trim()) return
    if (await props.onSave(props.provider, value.trim())) setValue('')
  }

  return (
    <Field
      label={info.keyLabel}
      hint={
        props.saved ? t('keySavedHint') : t('keyNewHint')
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
          placeholder={props.saved ? t('keySavedPlaceholder') : info.placeholder}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-accent"
        />
        <button
          onClick={() => void save()}
          disabled={!value.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {props.saved ? t('replace') : t('save')}
        </button>
        {props.saved && (
          <button
            onClick={() => void props.onRemove(props.provider)}
            className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-muted transition hover:bg-elevated hover:text-red-300"
          >
            {t('remove')}
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
          {t('getKey', { service: info.short })}
        </a>
      )}
    </Field>
  )
}

// Electron accelerator → readable keys for this platform.
function formatAccelerator(acc: string): string {
  const mac = navigator.userAgent.includes('Mac')
  return acc
    .replace('CommandOrControl', mac ? '⌘' : 'Ctrl')
    .replace('Shift', mac ? '⇧' : 'Shift')
    .replace('Alt', mac ? '⌥' : 'Alt')
    .split('+')
    .join(mac ? '' : ' + ')
}

function ShortcutRow(props: { label: string; keys: string; ok: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 text-[13px]">
      <span className="text-foreground">{props.label}</span>
      <span className="flex shrink-0 items-center gap-2">
        {!props.ok && <span className="text-[11px] text-amber-300">{t('shortcutTaken')}</span>}
        <kbd className={`shrink-0 whitespace-nowrap rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[12px] ${props.ok ? 'text-muted' : 'text-faint line-through'}`}>
          {formatAccelerator(props.keys)}
        </kbd>
      </span>
    </div>
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
