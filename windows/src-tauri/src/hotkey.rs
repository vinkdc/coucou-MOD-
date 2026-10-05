// Global hotkeys: Mochi on demand, and "look this up" from anywhere.
//
// The island has no resting place on Windows, so besides the tray these are the
// ways to call it up. A press is forwarded to the island page as a "hotkey"
// event naming the action ("summon" or "lookup"); the page decides what it
// means. For a lookup the selected text is captured here first, while the
// other app still has the keyboard (see platform::selected_text).

use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::island::WINDOW_LABEL;

/// Shipped enabled: with the island hidden by default, a keyboard way to reach
/// it matters more here than on the Mac. Ctrl+Alt rather than Win: most Win+…
/// combinations are reserved by the shell.
pub const DEFAULT_ACCELERATOR: &str = "Ctrl+Alt+C";
pub const DEFAULT_LOOKUP: &str = "Ctrl+Alt+J";

/// Id of the registered lookup shortcut (0 = none), so the handler can tell the two apart.
static LOOKUP_ID: AtomicU32 = AtomicU32::new(0);

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if shortcut.id() == LOOKUP_ID.load(Ordering::Relaxed) {
                lookup(app.clone());
            } else {
                let _ = app.emit_to(WINDOW_LABEL, "hotkey", json!({ "action": "summon" }));
            }
        })
        .build()
}

/// Captures the selection off the main thread (it waits for the user's modifier
/// keys to come up and for the other app to answer Ctrl+C), then tells the page.
fn lookup(app: AppHandle) {
    std::thread::spawn(move || {
        let text = crate::platform::selected_text();
        let payload = match text {
            Ok(t) => json!({ "action": "lookup", "text": t }),
            Err(e) => json!({ "action": "lookup", "error": e }),
        };
        let _ = app.emit_to(WINDOW_LABEL, "hotkey", payload);
    });
}

fn parse(accelerator: &str) -> Result<Shortcut, String> {
    accelerator
        .trim()
        .parse::<Shortcut>()
        .map_err(|e| format!("\"{accelerator}\" is not a shortcut Kotoba understands ({e})"))
}

/// Registers exactly the requested shortcuts (or none). Kotoba only ever holds
/// these two, so everything else it registered is dropped first.
pub fn apply(app: &AppHandle, enabled: bool, summon: &str, lookup: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    LOOKUP_ID.store(0, Ordering::Relaxed);
    if !enabled {
        return Ok(());
    }
    let a = parse(summon)?;
    let b = parse(lookup)?;
    if a == b {
        return Err("Both actions would use the same keys. Pick two different ones.".into());
    }
    gs.register(a).map_err(|e| format!("{summon} is already taken by another app or by Windows ({e})"))?;
    if let Err(e) = gs.register(b) {
        let _ = gs.unregister_all();
        return Err(format!("{lookup} is already taken by another app or by Windows ({e})"));
    }
    LOOKUP_ID.store(b.id(), Ordering::Relaxed);
    Ok(())
}

/// Switches to new shortcuts, or keeps the old ones working if the new ones
/// cannot be had — a typo must never leave the user without a hotkey.
pub fn replace(app: &AppHandle, old: (bool, &str, &str), new: (bool, &str, &str)) -> Result<(), String> {
    match apply(app, new.0, new.1, new.2) {
        Ok(()) => Ok(()),
        Err(err) => {
            if let Err(again) = apply(app, old.0, old.1, old.2) {
                crate::log::line(format!("hotkey: could not restore the previous ones: {again}"));
            }
            Err(err)
        }
    }
}
