# Windows app: developer notes

This folder holds the Windows app of Coucou MOD (it also builds on Linux). The project
overview, screenshots and install steps are in the [root README](../README.md); this file is
about how the code is organised and how to work on it.

## How it fits together

```
Claude Code
   |  hook event (JSON on stdin)
   v
coucou-hook.exe            hook/            tiny relay, 300 ms to deliver, never blocks
   |  named pipe
   v
Rust backend               src-tauri/       window, pipe, settings, keys, chat, pollers
   |  Tauri events and commands
   v
Island page                src/             TypeScript, no framework, Canvas 2D character
```

- The island is one transparent, always-on-top window that never takes focus on its own.
  Rust decides when the cursor is over the island and toggles click-through, so clicks outside
  it reach the apps underneath.
- Hook events arrive in `pipe.rs`, are forwarded to the page as a `hook` event, and are turned
  into state by `src/island/hooks.ts`. Views only read `State` (`src/core/state.ts`) and
  repaint when it notifies.
- Permission requests are the one place the relay waits: it holds the pipe open until the
  island answers, and falls back to Claude Code's own prompt if nobody does.
- The chat assistant runs in `assistant.rs`: it streams the model's answer, runs the tools it
  asks for, and asks the page for an Allow or Deny card before anything risky.

## Layout

```
windows/
  src/
    core/         state, layout constants, bridge to Rust, keys, snippets, usage, sounds
    island/       the window controller, open and close state machine, hook handling
    views/        every island screen (home card, editor, chat, cockpit, upload, settings)
    mochi/        the character engine, skin rig, skin bundle loader, greeting
    skineditor/   the skin editor window
    settings/     the settings window
    upload/       the file-drop animation
    highlight/    the click-through ring used by the guided help
  src-tauri/src/
    lib.rs        app wiring and every command the page can call
    island.rs     window geometry and the cursor poll
    pipe.rs       hook transport
    hooks.rs      reading and writing Claude Code's settings.json
    assistant.rs, claude.rs, gemini.rs     chat, tools, providers
    skins.rs      validating, storing and serving imported skins
    ide.rs        which editor the user works in
    repo.rs, usage.rs, integrations.rs     what the Home cards read
    platform/     everything that differs between Windows and Linux
  hook/           coucou-hook, the relay
  scripts/        icon generator, packaging, sample skin generator
  dev/            a looping preview of the file-drop animation
```

## Working on it

Requirements are listed in the root README.

```powershell
npm install
npm run tauri dev       # live-reloading app
npm run dev             # the front end alone, in an ordinary browser
npx tsc --noEmit        # type-check
cargo test --lib        # run from src-tauri/
npm run pack            # installer in release/
```

`npm run dev` is enough for most visual work: the pages render in a browser, and calls to Rust
are no-ops there. The settings window is `settings.html`, the skin editor `skin-editor.html`.

The sounds are the macOS app's files and are never copied into this folder. Their path is
declared once as `SOUNDS_DIR` at the top of `vite.config.ts`.

Icons are generated in code:

```powershell
npm run icons           # rewrites src-tauri/icons from scripts/gen-icons.mjs
```

Sample skins can be generated without any image editor:

```powershell
node scripts/make-example-skin.mjs
node skin-samples/make-claude-mascot.mjs
```

### Local skins

Skins kept outside Git go in `src/mochi/local/`. They load only in development builds, and the
build blanks that folder so nothing in it can reach a release. Imported skin bundles are the
supported way to use a skin in a release build.

## Conventions

- No third-party runtime dependencies beyond Tauri, and none added lightly. Rust crates need a
  reason.
- Secrets go to the Windows Credential Manager, never to a file or into the page.
- The relay must never block Claude Code. Anything on that path has a short timeout and exits
  cleanly.
- The user's Claude Code settings are never overwritten: dated backup, merge, show the diff,
  write after a click.
- Surfaces are separated by fill, tone and spacing, not by light borders. A nested rounded
  shape takes its parent's radius minus the gap, so the corners stay concentric.
- Text uses `var(--font)`, which is Inter, bundled with the app and never fetched.
- A hidden island costs nothing: its animation loop and cursor poll are stopped.

## Files on disk

| Path | Contents |
|---|---|
| `%APPDATA%\Coucou\settings.json` | preferences, no secrets |
| `%LOCALAPPDATA%\Coucou\coucou.log` | hook events, decisions, poller problems |
| `%LOCALAPPDATA%\Coucou\skins\` | imported skins |
| `%LOCALAPPDATA%\Coucou\inbox\` | copies of dropped files, removed after a week |
| `%LOCALAPPDATA%\Coucou\bin\coucou-hook.exe` | the relay, copied at launch |

## Linux

The same code builds for Linux; what differs lives in `src-tauri/src/platform/` and
`hook/src/unix.rs`.

```bash
sudo apt install build-essential pkg-config \
  libwebkit2gtk-4.1-dev libgtk-layer-shell-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libdbus-1-dev patchelf \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good
npm install
npm run tauri dev
npm run pack            # AppImage, .deb and .rpm in release/
```

- On compositors with layer-shell (COSMIC, KDE Plasma, Hyprland, Sway) the island is an overlay
  anchored to the top edge. GNOME has none, so it opens as a normal window. Set
  `COUCOU_LAYER_SHELL=0` to force that anywhere.
- Click-through is the window's input region, kept equal to the island's shape.
- The hook relay talks over a Unix socket at `$XDG_RUNTIME_DIR/coucou.sock`, and both ends
  check they run as the same user.
- Keys live in the Secret Service (GNOME Keyring or KWallet).
- Media control uses `playerctl` and `pactl`, and the assistant says so if they are missing.
