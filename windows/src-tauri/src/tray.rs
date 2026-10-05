// Notification-area icon: today's progress at a glance, and the way back in.
//
// Menu: status line, Study…, Ask Mochi, Settings…, Quit.
// A left click on the icon opens the study panel; the right click opens the menu.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::island::WINDOW_LABEL;

const TRAY_ID: &str = "kotoba";

/// The items whose text follows the app's state.
pub struct TrayItems {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "No study yet today", false, None::<&str>)?;
    let study = MenuItem::with_id(app, "study", "Study…", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Ask Mochi", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&status, &sep1, &study, &toggle, &settings, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Kotoba")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            "study" => crate::show_study_window(app, None),
            id => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::show_study_window(tray.app_handle(), None);
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    app.manage(TrayItems { status, toggle });
    Ok(())
}

/// Called by the island page when what the tray shows has changed — never per
/// frame, so a hidden island still costs nothing.
pub fn sync(app: &AppHandle, status: &str, visible: bool) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.status.set_text(status);
        let _ = items.toggle.set_text(if visible { "Hide Mochi" } else { "Ask Mochi" });
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("Kotoba — {status}")));
    }
}
