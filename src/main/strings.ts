// Strings shown by the main process (tray menu, dialogs, errors that reach the status line).
// The renderer has its own dictionary in src/renderer/src/lib/i18n.ts.

export type UiLanguage = 'uk' | 'en'

const STRINGS = {
  en: {
    trayShow: 'Show live-trans',
    trayStart: 'Start translation',
    trayStop: 'Stop translation',
    trayShowSubtitles: 'Show subtitles window',
    trayHideSubtitles: 'Hide subtitles window',
    trayQuit: 'Quit',
    trayIdle: 'idle',
    trayRunning: 'translating',
    exportTitle: 'Export transcript',
    exportFilter: 'Text',
    geminiKeyMissing: 'Enter your Gemini API key in Settings first.',
    sonioxKeyMissing: 'Enter your Soniox API key in Settings first.',
    geminiTokenFailed: 'Could not create a session token: {detail}',
    geminiUnreachable: 'Could not reach the Gemini API: {detail}',
    sonioxTokenFailed: 'Could not create a Soniox session key: {detail}',
    sonioxUnreachable: 'Could not reach Soniox: {detail}'
  },
  uk: {
    trayShow: 'Показати live-trans',
    trayStart: 'Почати переклад',
    trayStop: 'Зупинити переклад',
    trayShowSubtitles: 'Показати вікно субтитрів',
    trayHideSubtitles: 'Сховати вікно субтитрів',
    trayQuit: 'Вийти',
    trayIdle: 'очікування',
    trayRunning: 'перекладає',
    exportTitle: 'Експорт транскрипту',
    exportFilter: 'Текст',
    geminiKeyMissing: 'Спершу введіть ключ Gemini API в налаштуваннях.',
    sonioxKeyMissing: 'Спершу введіть ключ Soniox API в налаштуваннях.',
    geminiTokenFailed: 'Не вдалося створити токен сесії: {detail}',
    geminiUnreachable: 'Немає зʼєднання з Gemini API: {detail}',
    sonioxTokenFailed: 'Не вдалося створити ключ сесії Soniox: {detail}',
    sonioxUnreachable: 'Немає зʼєднання з Soniox: {detail}'
  }
} satisfies Record<UiLanguage, Record<string, string>>

export type MainStringKey = keyof (typeof STRINGS)['en']

export function mainText(lang: UiLanguage, key: MainStringKey, params: Record<string, string> = {}): string {
  return STRINGS[lang][key].replace(/\{(\w+)\}/g, (_m, k: string) => params[k] ?? '')
}

export function resolveUiLanguage(stored: string | undefined, systemLocale: string): UiLanguage {
  if (stored === 'uk' || stored === 'en') return stored
  return systemLocale.toLowerCase().startsWith('uk') ? 'uk' : 'en'
}
