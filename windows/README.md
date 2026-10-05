# Kotoba — learn Japanese by talking with Mochi

Kotoba (言葉, "words") is an immersion app for learning Japanese on Windows and Linux. You
talk with Mochi, an AI tutor that starts you as a complete beginner, works out your level as
you go, and teaches one step above it. Every Japanese line comes with furigana, optional
romaji and a translation, and Fish Audio voices read it aloud.

It is built from the Tauri app of Coucou (the Mochi character, the summonable island, the
Settings window and the Credential Manager plumbing). The macOS app in `../NotchBuddy` is
not part of Kotoba.

## What it does

- **The study panel** lives in the island: Kotoba opens on it, and the island grows into a
  large panel (about 1000×660) that stays open until you close it (the ✕ in its rail, `Esc`
  outside a text field, the hotkey, or the tray). From the tray (left click or Study…) or
  the island's Study tab it opens again. Three views:
  - **Talk**: pick a situation (free talk, self-introduction, café, directions, shopping,
    daily routine) and chat. Replies show the Japanese with ruby furigana, a romaji line,
    a ▶ button, the English, correction cards for your mistakes, and chips for new words.
    The side panel shows today's goal ring, your streak, and the words met in this
    conversation.
  - **Progress**: level (0–100, with rough JLPT bands) and its trend, streak, words learned,
    solid and weak, 30-day accuracy, a 12-week activity heatmap, mistakes by kind, words to
    review (one click turns them into a practice conversation), and recent corrections.
- **Mochi's island** (hotkey `Ctrl+Alt+C`, or the tray's Ask Mochi): a quick "how do I
  say…" from anywhere, plus Today at a glance.

## Learning in the flow of your day

- **Look up anything on screen.** Select Japanese (or English) in any app and press
  `Ctrl+Alt+J`: the island shows the reading, meaning and a short breakdown, reads it aloud,
  and `+ word` chips add the new words to your reviews. Kotoba copies the selection with
  Ctrl+C, then puts your clipboard back (it never overwrites a picture or files: it asks you
  to copy first). The text goes to your AI only when you press the shortcut. On Linux it
  reads the selection through `wl-paste` or `xclip`.
- **Reviews (spaced repetition).** Every word Mochi teaches or you look up comes back after
  1 day, then 3, then growing by its ease (a small SM-2: Again resets, Hard is slow, Easy is
  fast). **Review** in the study panel (keys `Space`, `1`-`4`) or a 2-minute session from
  the island's Today view. Cards alternate between seeing a word and hearing it.
- **Speaking.** The mic in the composer dictates instead of typing. The mic on each Japanese
  line records you saying it and shows how close it was to the line (what was recognised
  against what Mochi wrote; it does not judge pitch accent). Needs microphone permission.
  Speech recognition is Fish Audio's `transcribe-1-pro` (Beta). The recording stays in memory.
- **Reminders at natural breaks.** After you come back from a pause, or when cards pile up,
  Mochi offers a review, a word, or a quick question. Never in full-screen apps, quiet
  hours (22:00-08:00), while you type, more than 4 a day, or within 90 minutes of the last
  one; "Later" and "Not today" are remembered. All of it is in Settings → Reminders.

## How Mochi learns your level

The tutor has two silent tools (`src-tauri/src/tutor.rs`):

- `log_progress` records, after each of your messages, the words you used rightly or
  wrongly, your mistakes (vocab, grammar, particle, conjugation, kana), grammar points, and
  the words it is introducing.
- `assess_level` gives its estimate of your level from 0 to 100. Kotoba smooths it: the
  first reading is capped at the beginner range, then each new estimate moves the level at
  most 8 points.

All of it lives in `learner.json` (`src-tauri/src/learner.rs`). Word strength rises with
each right use and halves on a wrong one. A short summary (level, weak words, recent
mistakes) goes into the tutor's prompt on every message, so it recycles what you struggle with.

## Reply format

The tutor writes tagged lines, which the page parses (`src/study/markup.ts`):

```
FIX: わたしわ => 私{わたし}は | は (topic) is read "wa"
JP: 何{なに}を勉強{べんきょう}していますか。
EN: What are you studying?
NOTE: 〜ています describes something ongoing.
NEW: 勉強|べんきょう|study
```

Readings in braces become `<ruby>` furigana, and only the `JP` lines are spoken.
Romaji comes from the readings (`src/study/romaji.ts`).

## Setup

```
cd windows
npm install
npm run tauri dev
```

Then, in Settings:

1. **Voice (Fish Audio)**: paste an API key from fish.audio. Pick a Japanese voice (the list
   comes from Fish Audio's public models) and press ▶ Preview. The TTS model defaults to
   `s2.1-pro-free`, which the free developer tier allows.
2. **Claude** or **Gemini**: paste a key. "Mochi uses" picks which one teaches.

Keys go to the Windows Credential Manager (Secret Service on Linux), never to disk, under
the service `fr.louisraille.kotoba`.

## Layout

```
windows/
  index.html, src/         the island page: island/, views/, mochi/ (the character), core/
  src/study/               the study panel (a view of the island): app, conversation, cards, stats,
                           reply renderer, markup, romaji; its CSS is scoped under `.study-embed`
  settings.html            Settings (src/settings/)
  tests/                   `npm test` (Node's built-in runner): markup, romaji, pronunciation, reminder rules
  src/study/cards.ts       review sessions (study panel and island)
  src/island/reminders.ts  when Mochi may speak up (a pure function, tested)
  src-tauri/src/
    lib.rs                 commands and windows
    tutor.rs               tutor prompt, scenarios, bookkeeping tools
    learner.rs             learner model, stats, learner.json
    fishaudio.rs           text-to-speech, speech-to-text, voice list, on-disk clip cache
    assistant.rs           the model loop (Claude or Gemini, streamed, with tools)
    claude.rs, gemini.rs   the two providers
```

## Privacy

- No account and no telemetry.
- Your messages and a short summary of your progress go to the AI you chose (Anthropic or
  Google).
- Mochi's Japanese lines go to Fish Audio to be spoken, and your recordings go to Fish Audio
  to be transcribed (only when you press the mic).
- Text you select goes to your AI only when you press the lookup shortcut.
- Nothing else leaves the PC. Progress is kept in `%APPDATA%\Kotoba\learner.json`. Voice
  clips are cached in `%LOCALAPPDATA%\Kotoba\tts-cache` (capped at about 200 MB), so a
  replay costs no credits.

## Checks

```
cd windows/src-tauri && cargo test
cd windows && npx tsc --noEmit && npm test
```
