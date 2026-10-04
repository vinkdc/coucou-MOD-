// Global hotkey: summons or dismisses the island from anywhere.
//
// The island has no resting place on Windows, so besides the tray this is the
// only way to call it up on demand. The press is forwarded to the island page as
// a "hotkey" event; the page decides what it means (toggle), like the tray does.

use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::island::WINDOW_LABEL;

/// Shipped enabled: with the island hidden by default, a keyboard way to reach
/// it matters more here than on the Mac. Ctrl+Alt rather than Win: most Win+…
/// combinations are reserved by the shell.
pub const DEFAULT_ACCELERATOR: &str = "Ctrl+Alt+C";

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                let _ = app.emit_to(WINDOW_LABEL, "hotkey", ());
            }
        })
        .build()
}

fn parse(accelerator: &str) -> Result<Shortcut, String> {
    accelerator
        .trim()
        .parse::<Shortcut>()
        .map_err(|e| format!("\"{accelerator}\" is not a shortcut Coucou understands ({e})"))
}

/// Registers exactly the requested shortcut (or none). Coucou only ever holds
/// one, so everything else it registered is dropped first.
pub fn apply(app: &AppHandle, enabled: bool, accelerator: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if !enabled {
        return Ok(());
    }
    let shortcut = parse(accelerator)?;
    gs.register(shortcut).map_err(|e| {
        format!("{accelerator} is already taken by another app or by Windows ({e})")
    })
}

/// Switches to a new shortcut, or keeps the old one working if the new one
/// cannot be had — a typo must never leave the user without a hotkey.
pub fn replace(
    app: &AppHandle,
    old: (bool, &str),
    new: (bool, &str),
) -> Result<(), String> {
    match apply(app, new.0, new.1) {
        Ok(()) => Ok(()),
        Err(err) => {
            if let Err(again) = apply(app, old.0, old.1) {
                crate::log::line(format!("hotkey: could not restore the previous one: {again}"));
            }
            Err(err)
        }
    }
}
