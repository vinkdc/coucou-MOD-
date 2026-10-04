// Notification-area icon. With the island hidden by default, the tray is the
// ambient channel: what the agents are doing at a glance, and the way back in.
//
// Menu: status line, Show/Hide, Add a file…, Settings…, Pause/Resume, Quit.
// A left click on the icon shows or hides the island; the right click opens the menu.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::island::WINDOW_LABEL;

const TRAY_ID: &str = "coucou";

/// The items whose text follows the island's state.
pub struct TrayItems {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    pause: MenuItem<Wry>,
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Nothing running", false, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Show Coucou", true, None::<&str>)?;
    let pick = MenuItem::with_id(app, "pick", "Add a file…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[&status, &sep1, &toggle, &pick, &sep2, &settings, &pause, &sep3, &quit],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Coucou")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
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
                let _ = tray.app_handle().emit_to(WINDOW_LABEL, "tray", "toggle".to_string());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    app.manage(TrayItems { status, toggle, pause });
    Ok(())
}

/// Called by the island page when what the tray shows has changed — never per
/// frame, so a hidden island still costs nothing.
pub fn sync(app: &AppHandle, status: &str, visible: bool, paused: bool) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.status.set_text(status);
        let _ = items.toggle.set_text(if visible { "Hide Coucou" } else { "Show Coucou" });
        let _ = items.pause.set_text(if paused { "Resume" } else { "Pause" });
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("Coucou — {status}")));
    }
}
