import { describe, expect, test } from 'bun:test'
import { Segmenter, formatTxt } from '../src/renderer/src/lib/segments'

const pairs = (s: Segmenter): [string, string][] => s.segments.map((x) => [x.source.trim(), x.target.trim()])

// Feeds words one by one like the Live API's small deltas, ticking every 500 ms like the app.
function stream(s: Segmenter, events: [number, 'src' | 'tgt', string][], until: number): void {
  const sorted = [...events].sort((a, b) => a[0] - b[0])
  let i = 0
  for (let t = 0; t <= until; t += 50) {
    while (i < sorted.length && sorted[i][0] <= t) {
      const [at, kind, text] = sorted[i++]
      if (kind === 'src') s.addSource(text, at)
      else s.addTarget(text, at)
    }
    if (t % 500 === 0) s.tick(t)
  }
}

function words(start: number, kind: 'src' | 'tgt', text: string, step = 60): [number, 'src' | 'tgt', string][] {
  return text.split(' ').map((w, i) => [start + i * step, kind, w + ' '])
}

describe('Segmenter', () => {
  test('pairs a line with its trailing translation', () => {
    const s = new Segmenter()
    stream(s, [...words(0, 'src', 'Как вас зовут?'), ...words(700, 'tgt', 'Як вас звати?')], 4000)
    expect(pairs(s)).toEqual([['Как вас зовут?', 'Як вас звати?']])
    expect(s.segments.every((x) => !x.open)).toBe(true)
  })

  test('attaches a translation that lags past the pause', () => {
    const s = new Segmenter()
    stream(s, [...words(0, 'src', 'Длинная фраза.'), ...words(2000, 'tgt', 'Довга фраза.')], 5000)
    expect(pairs(s)).toEqual([['Длинная фраза.', 'Довга фраза.']])
  })

  test('an untranslated line (already in the target language) does not take the next translation', () => {
    const s = new Segmenter()
    stream(
      s,
      [
        ...words(0, 'src', 'Як потрапили в полон?'),
        ...words(2400, 'src', 'Нас окружили под Работино, связи не было.'),
        ...words(3200, 'tgt', 'Нас оточили під Роботиним, звʼязку не було.')
      ],
      7000
    )
    expect(pairs(s)).toEqual([
      ['Як потрапили в полон?', ''],
      ['Нас окружили под Работино, связи не было.', 'Нас оточили під Роботиним, звʼязку не було.']
    ])
  })

  test('a translation is never split across rows', () => {
    const s = new Segmenter()
    stream(
      s,
      [...words(0, 'src', 'Раз два три.'), ...words(1700, 'src', 'Четыре.'), ...words(1900, 'tgt', 'Раз два три.', 200)],
      6000
    )
    expect(s.segments.filter((x) => x.target).length).toBe(1)
  })

  test('long continuous speech splits only once the translation has caught up', () => {
    const s = new Segmenter()
    let t = 0
    for (let i = 0; i < 30; i++) {
      s.addSource(`слово${i} `, t)
      if (i > 2) s.addTarget(`слово${i - 3} `, t + 200)
      t += 1000
      s.tick(t)
    }
    expect(s.segments.length).toBe(1)
    s.addSource('конец.', t)
    s.tick(t + 100)
    expect(s.segments[0].open).toBe(true)
    s.addTarget('кінець.', t + 300)
    expect(s.tick(t + 400)).toBe(true)
    expect(s.segments[0].open).toBe(false)
  })

  test('closing an empty line removes it', () => {
    const s = new Segmenter()
    s.addSource('  ', 0)
    s.close(10)
    expect(s.segments.length).toBe(0)
  })
})

describe('formatTxt', () => {
  const session = {
    startedAt: new Date(2026, 9, 15, 10, 0).getTime(),
    endedAt: new Date(2026, 9, 15, 10, 42).getTime(),
    segments: [
      { source: 'Как дела?', target: 'Як справи?' },
      { source: 'Як вас звати?', target: '' }
    ]
  }
  const labels = { source: 'Русский', target: 'Українська' }

  test('original + translation, no timecodes', () => {
    expect(formatTxt(session, labels, 'both')).toBe(
      'live-trans · 2026-10-15 10:00–10:42\nРусский → Українська\n\nКак дела?\n→ Як справи?\n\nЯк вас звати?\n→ —\n'
    )
  })

  test('translation only skips untranslated lines', () => {
    expect(formatTxt(session, labels, 'target')).toBe('live-trans · 2026-10-15 10:00–10:42\nУкраїнська\n\nЯк справи?\n')
  })
})
