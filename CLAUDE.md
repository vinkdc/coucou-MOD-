# Coucou — guide for AI coding agents

Coucou is a native macOS app (`NotchBuddy/`); `windows/` is the Tauri version for Windows and Linux. Mochi, a small animated character living in the MacBook notch, shows AI coding agent sessions (Claude Code, Gemini CLI, Antigravity and more) and a few integrations, and lets the user approve, answer, chat and drop files from the notch.

## Where things are
- `NotchBuddy/Sources/App/` — all Swift code. `NotchBuddy/Resources/sounds/` — the 28 WAV sounds. `NotchBuddy/project.yml` — XcodeGen project (never edit the `.xcodeproj` by hand).
- `NotchBuddy/Sources/App/PillCatalog.swift` — single source of truth for all declared pills (workspace tools, agents, AI providers, services). Every pill ID, color, category and subtitle lives here.
- `docs/SPEC.md`, `docs/INTEGRATIONS.md` — behaviour, views, states, integrations (in French).
- `design/prototype/notch-buddy.html` — original prototype, the visual source of truth. `design/captures/` — target screenshots.
- `windows/` — **on the `kotoba` branch this is Kotoba**, a Japanese-learning app (AI tutor + Fish Audio TTS + learner stats) built from Coucou's Tauri shell; the hook relay, integrations and dev tools are removed there. Rust in `src-tauri/` (tutor.rs, learner.rs, fishaudio.rs), study panel (a view of the island, CSS scoped under `.study-embed`) in `src/study/`, island in `src/`. Identifier `fr.louisraille.kotoba`. Read `windows/README.md` first.
- `docs/*.html` — the GitHub Pages site (privacy, terms, support, legal notice).

## Build
```
cd NotchBuddy && xcodegen && xcodebuild -scheme NotchBuddy -configuration Debug build
```
Windows and Linux: `cd windows && npm install && npm run tauri dev`

## Rules
- Swift 6, SwiftUI + AppKit. No third-party dependencies unless truly unavoidable. The character is drawn in code (`Canvas` + `TimelineView`), no Rive/Lottie/images.
- Secrets live in the Keychain, never on disk or in git.
- No telemetry. Network calls only to services the user configured.
- Never block Claude Code: if the app doesn't answer, the hook exits immediately.
- Never overwrite `~/.claude/settings.json`: dated backup, merge, show the diff, write only after the user confirms.
- Never send an email or approve a Claude Code permission without an explicit click.
- Performance: 0 % CPU when the island is hidden.
- Keep the bundle identifier `fr.louisraille.NotchBuddy` (Keychain items, preferences and permissions depend on it).
- Never restyle what already ships (pills, cards, Settings, chat…): existing views stay exactly as they are in `main`, which is the App Store build. Change the look of an existing view only when explicitly asked.
- Pill IDs are stable contract values (Keychain, UserDefaults, hook routing): never rename an existing pill ID.
- No white or light borders on UI surfaces (cards, panels, fields, chips, bubbles, buttons, code wells). Separate things with fill, tone and spacing; show focus by brightening the fill, never with a light ring. Dividers inside a surface are dark grooves, not light lines. A border tinted with a state or agent colour (the overview pills) is fine.
- Corners are concentric: a rounded shape nested in another gets the outer radius minus the gap between them, so the two curves read as one corner (island 22 px − 10 px inset = 12 px cards; `--card-radius` in `windows/src/style.css`). Never nest two equal or near-equal radii.
- Typography is Apple-like. macOS uses the system font (SF Pro). Windows and Linux use **Inter**, bundled from `@fontsource-variable/inter` (optical sizes) and never fetched from the web — the closest free match to SF Pro, whose licence only allows Apple platforms, so never ship SF Pro there. Always set text with `var(--font)`; don't introduce other typefaces. Exception: Japanese text falls back to installed system CJK faces (Yu Gothic UI, Meiryo, Noto Sans CJK JP) via `--font-ja` / `[lang="ja"]`, since Inter has no kana or kanji; never fetch a web font for it.
- New views follow the existing app style. `design/prototype/notch-buddy.html` and `design/captures/` are references for new work, not a reason to change existing views.
- Icons are **Phosphor, Fill weight** (solid, MIT, https://phosphoricons.com), never outline or stroke icons and never text glyphs (▶ → ✓ ✕) or emoji as icons. On `windows/` they are copied into `src/views/phosphor.ts` (`icon("name", size)`; header buttons in `src/views/icons.ts`), so nothing is fetched and there is no dependency. Add a new icon by copying its `-fill.svg` shapes there.
