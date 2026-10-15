// One language list for every translation provider. `code` is the app's own id (and the
// Gemini BCP-47 code); each provider entry is the code that provider expects, or absent
// when the provider does not support that language.
//
// Gemini 3.5 Live Translate: 78 languages (ai.google.dev/gemini-api/docs/live-api/live-translate)
// Soniox stt-rt-v5:          60 languages, translation between any pair (soniox.com/docs)

export type ProviderId = 'gemini' | 'soniox'

export type Lang = {
  code: string
  label: string
  gemini?: string
  soniox?: string
  // Provider-specific label where the provider's variant is broader than ours.
  sonioxLabel?: string
}

// [app code, native label, English name, soniox code or '' when unsupported]
const ROWS: [string, string, string, string][] = [
  ['af', 'Afrikaans', 'Afrikaans', 'af'],
  ['ak', 'Akan', 'Akan', ''],
  ['sq', 'Shqip', 'Albanian', 'sq'],
  ['am', 'አማርኛ', 'Amharic', ''],
  ['ar', 'العربية', 'Arabic', 'ar'],
  ['hy', 'Հայերեն', 'Armenian', ''],
  ['az', 'Azərbaycanca', 'Azerbaijani', 'az'],
  ['eu', 'Euskara', 'Basque', 'eu'],
  ['be', 'Беларуская', 'Belarusian', 'be'],
  ['bn', 'বাংলা', 'Bengali', 'bn'],
  ['bg', 'Български', 'Bulgarian', 'bg'],
  ['my', 'မြန်မာ', 'Burmese', ''],
  ['ca', 'Català', 'Catalan', 'ca'],
  ['zh-Hans', '中文 简体', 'Chinese, Simplified', 'zh'],
  ['zh-Hant', '中文 繁體', 'Chinese, Traditional', ''],
  ['hr', 'Hrvatski', 'Croatian', 'hr'],
  ['cs', 'Čeština', 'Czech', 'cs'],
  ['da', 'Dansk', 'Danish', 'da'],
  ['nl', 'Nederlands', 'Dutch', 'nl'],
  ['en', 'English', 'English', 'en'],
  ['et', 'Eesti', 'Estonian', 'et'],
  ['fil', 'Filipino', 'Filipino', 'tl'],
  ['fi', 'Suomi', 'Finnish', 'fi'],
  ['fr', 'Français', 'French', 'fr'],
  ['gl', 'Galego', 'Galician', 'gl'],
  ['ka', 'ქართული', 'Georgian', ''],
  ['de', 'Deutsch', 'German', 'de'],
  ['el', 'Ελληνικά', 'Greek', 'el'],
  ['gu', 'ગુજરાતી', 'Gujarati', 'gu'],
  ['ha', 'Hausa', 'Hausa', ''],
  ['he', 'עברית', 'Hebrew', 'he'],
  ['hi', 'हिन्दी', 'Hindi', 'hi'],
  ['hu', 'Magyar', 'Hungarian', 'hu'],
  ['is', 'Íslenska', 'Icelandic', ''],
  ['id', 'Bahasa Indonesia', 'Indonesian', 'id'],
  ['it', 'Italiano', 'Italian', 'it'],
  ['ja', '日本語', 'Japanese', 'ja'],
  ['jv', 'Basa Jawa', 'Javanese', ''],
  ['kn', 'ಕನ್ನಡ', 'Kannada', 'kn'],
  ['kk', 'Қазақ тілі', 'Kazakh', 'kk'],
  ['km', 'ខ្មែរ', 'Khmer', ''],
  ['rw', 'Kinyarwanda', 'Kinyarwanda', ''],
  ['ko', '한국어', 'Korean', 'ko'],
  ['lo', 'ລາວ', 'Lao', ''],
  ['lv', 'Latviešu', 'Latvian', 'lv'],
  ['lt', 'Lietuvių', 'Lithuanian', 'lt'],
  ['mk', 'Македонски', 'Macedonian', 'mk'],
  ['ms', 'Bahasa Melayu', 'Malay', 'ms'],
  ['ml', 'മലയാളം', 'Malayalam', 'ml'],
  ['mr', 'मराठी', 'Marathi', 'mr'],
  ['mn', 'Монгол', 'Mongolian', ''],
  ['ne', 'नेपाली', 'Nepali', ''],
  ['no', 'Norsk', 'Norwegian', 'no'],
  ['fa', 'فارسی', 'Persian', 'fa'],
  ['pl', 'Polski', 'Polish', 'pl'],
  ['pt-BR', 'Português do Brasil', 'Portuguese, Brazil', 'pt'],
  ['pt-PT', 'Português europeu', 'Portuguese, Portugal', ''],
  ['pa', 'ਪੰਜਾਬੀ', 'Punjabi', 'pa'],
  ['ro', 'Română', 'Romanian', 'ro'],
  ['ru', 'Русский', 'Russian', 'ru'],
  ['sr', 'Српски', 'Serbian', 'sr'],
  ['sd', 'سنڌي', 'Sindhi', ''],
  ['si', 'සිංහල', 'Sinhala', ''],
  ['sk', 'Slovenčina', 'Slovak', 'sk'],
  ['sl', 'Slovenščina', 'Slovenian', 'sl'],
  ['es', 'Español', 'Spanish', 'es'],
  ['su', 'Basa Sunda', 'Sundanese', ''],
  ['sw', 'Kiswahili', 'Swahili', 'sw'],
  ['sv', 'Svenska', 'Swedish', 'sv'],
  ['ta', 'தமிழ்', 'Tamil', 'ta'],
  ['te', 'తెలుగు', 'Telugu', 'te'],
  ['th', 'ไทย', 'Thai', 'th'],
  ['tr', 'Türkçe', 'Turkish', 'tr'],
  ['uk', 'Українська', 'Ukrainian', 'uk'],
  ['ur', 'اردو', 'Urdu', 'ur'],
  ['uz', 'Oʻzbekcha', 'Uzbek', ''],
  ['vi', 'Tiếng Việt', 'Vietnamese', 'vi'],
  ['zu', 'isiZulu', 'Zulu', '']
]

// Soniox-only languages (not offered by Gemini Live Translate).
const SONIOX_ONLY: [string, string, string][] = [
  ['bs', 'Bosanski', 'Bosnian'],
  ['cy', 'Cymraeg', 'Welsh']
]

// Shown first in every list; the rest is alphabetical by English name.
const PINNED = ['uk', 'ru', 'en']

function build(): Lang[] {
  const all: Lang[] = [
    ...ROWS.map(([code, native, english, soniox]) => ({
      code,
      label: native === english ? native : `${native} (${english})`,
      gemini: code,
      soniox: soniox || undefined,
      sonioxLabel: code === 'zh-Hans' ? '中文 (Chinese)' : code === 'pt-BR' ? 'Português (Portuguese)' : undefined
    })),
    ...SONIOX_ONLY.map(([code, native, english]) => ({ code, label: `${native} (${english})`, soniox: code }))
  ]
  const english = (l: Lang): string => l.label.replace(/^.*\(([^)]+)\)$/, '$1')
  return all.sort((a, b) => {
    const pa = PINNED.indexOf(a.code)
    const pb = PINNED.indexOf(b.code)
    if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb)
    return english(a).localeCompare(english(b))
  })
}

export const LANGUAGES: Lang[] = build()

/** Languages a provider supports, with that provider's label. */
export function languagesFor(provider: ProviderId): Lang[] {
  return LANGUAGES.filter((l) => l[provider]).map((l) =>
    provider === 'soniox' && l.sonioxLabel ? { ...l, label: l.sonioxLabel } : l
  )
}

/** The code a provider expects for an app language code, or null if unsupported. */
export function providerCode(provider: ProviderId, code: string): string | null {
  return LANGUAGES.find((l) => l.code === code)?.[provider] ?? null
}

/** Map a provider's code (e.g. a detected language) back to the app's code. */
export function fromProviderCode(provider: ProviderId, code: string): string | null {
  const lower = code.toLowerCase()
  const exact = LANGUAGES.find((l) => l[provider]?.toLowerCase() === lower)
  if (exact) return exact.code
  // Detected codes may be bare ("pt", "zh") where the list has variants.
  const base = lower.split('-')[0]
  return LANGUAGES.find((l) => l[provider]?.toLowerCase().split('-')[0] === base)?.code ?? null
}

/** Older versions stored codes that are no longer valid ids. */
export function migrateLanguageCode(code: string): string {
  if (code === 'pt') return 'pt-BR'
  if (code === 'nb') return 'no'
  return code
}

export function labelFor(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code
}

// Native name only, without the parenthetical English gloss.
// "Tiếng Việt (Vietnamese)" -> "Tiếng Việt", "English" -> "English".
export function shortLabel(code: string): string {
  return labelFor(code).replace(/ \([^)]*\)$/, '')
}
