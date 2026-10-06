// Select text in any app and a small popup offers to ask Mochi about it
// (Explain / Ask… / Listen). Windows only; elsewhere the hotkey lookup remains.
//
// How it stays light: a low-level mouse hook watches for the end of a drag or a
// double-click (the hook only records clicks and hands them to a worker thread);
// the worker waits a moment, then reads the selection through Windows UI
// Automation. No clipboard is touched and no key is simulated, so terminals are
// safe, and nothing is read from password fields. The text stays in memory until
// a button is pressed; only then does it go anywhere. Off, the hook is removed
// and nothing runs.

use std::sync::Mutex;

use tauri::AppHandle;

/// Label of the popup window (created hidden at launch, see lib.rs).
pub const WINDOW_LABEL: &str = "askpop";
/// Popup size in logical pixels: three buttons in a capsule, four in a text field
/// (the extra one translates what was typed).
pub const POPUP_SIZE: (f64, f64) = (252.0, 44.0);
pub const POPUP_SIZE_EDITABLE: (f64, f64) = (336.0, 44.0);

/// Where the popup waits, off every screen (physical pixels, both axes).
pub const PARKED: i32 = -32000;

/// Longest selection offered: a sentence or two, not a page.
const MAX_CHARS: usize = 400;
/// Shortest worth offering.
const MIN_CHARS: usize = 2;

/// Apps never offered a popup: terminals (a selection there is usually code or
/// output) and password managers.
pub const DEFAULT_IGNORED: &[&str] = &[
    "windowsterminal.exe", "wt.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "conhost.exe", "openconsole.exe",
    "mintty.exe", "alacritty.exe", "wezterm-gui.exe", "putty.exe", "1password.exe", "bitwarden.exe", "keepass.exe",
    "keepassxc.exe", "lastpass.exe", "dashlane.exe",
];

/// The user's own additions, as typed: names separated by commas, spaces or lines.
pub fn parse_ignore(text: &str) -> Vec<String> {
    text.split(|c: char| c == ',' || c == ';' || c.is_whitespace())
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .map(|s| if s.ends_with(".exe") { s } else { format!("{s}.exe") })
        .collect()
}

/// Longest message the "Japanese" button replaces in a text field: it must be
/// translated whole, never cut.
pub(crate) const EDIT_MAX_CHARS: usize = 1500;

/// Collapses whitespace and trims; None when too short to be worth a popup.
pub fn clean(text: &str) -> Option<String> {
    clean_to(text, MAX_CHARS)
}

pub(crate) fn clean_to(text: &str, max: usize) -> Option<String> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = text.chars().collect();
    if chars.len() < MIN_CHARS {
        return None;
    }
    Some(if chars.len() > max { format!("{}…", chars[..max].iter().collect::<String>()) } else { text })
}

/// What the popup is about, until a button is pressed or it goes away.
static CURRENT: Mutex<Option<String>> = Mutex::new(None);

/// The selected text, taken out (a button was pressed).
pub fn take_current() -> Option<String> {
    CURRENT.lock().unwrap().take()
}

/// Tells the popup's page what to show: its buttons (`editable` adds "Japanese"),
/// "busy" (translating) or "error".
fn tell_popup(app: &AppHandle, payload: serde_json::Value) {
    use tauri::Emitter;
    let _ = app.emit_to(WINDOW_LABEL, "askpop-state", payload);
}

/// The popup shows "Translating…" and stays up.
pub fn show_busy(app: &AppHandle) {
    tell_popup(app, serde_json::json!({ "state": "busy" }));
}

/// The popup shows a short message, then goes away.
pub fn show_error(app: &AppHandle, message: &str) {
    tell_popup(app, serde_json::json!({ "state": "error", "message": message }));
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(3500));
        hide(&app);
    });
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use ::windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use ::windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use ::windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use ::windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use ::windows::Win32::System::Threading::{
        GetCurrentProcessId, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use ::windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern, UIA_TextPatternId,
    };
    use ::windows::Win32::UI::Accessibility::{IUIAutomationValuePattern, UIA_EditControlTypeId, UIA_IsReadOnlyAttributeId, UIA_ValuePatternId};
    use ::windows::Win32::UI::Input::KeyboardAndMouse::{GetDoubleClickTime, GetKeyState, VK_SHIFT};
    use ::windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetForegroundWindow, GetMessageW, PostThreadMessageW, SetForegroundWindow, SetWindowsHookExW,
        UnhookWindowsHookEx, MSG, MSLLHOOKSTRUCT,
        WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_QUIT,
    };
    use tauri::{AppHandle, Manager, PhysicalPosition};

    use super::{clean, clean_to, parse_ignore, tell_popup, EDIT_MAX_CHARS, PARKED, CURRENT, DEFAULT_IGNORED, POPUP_SIZE, POPUP_SIZE_EDITABLE, WINDOW_LABEL};

    /// A drag shorter than this (physical px) is a click, not a selection.
    const DRAG_PX: i32 = 8;
    /// How long a popup stays when nobody touches it.
    const POPUP_LIFETIME: Duration = Duration::from_secs(8);
    /// The selection needs a moment to settle in the other app.
    const SETTLE: Duration = Duration::from_millis(140);

    enum Ev {
        Down(POINT),
        /// A button released: `select` = it ended a drag or a double click.
        Up { at: POINT, select: bool },
    }

    /// Where the hook sends clicks; None when off.
    static SENDER: Mutex<Option<Sender<Ev>>> = Mutex::new(None);
    /// Thread id of the hook's message loop (0 = none).
    static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
    static ENABLED: AtomicBool = AtomicBool::new(false);
    /// The user's extra ignored apps, lowercase.
    static EXTRA_IGNORED: Mutex<Vec<String>> = Mutex::new(Vec::new());
    /// The window that had the selection (0 = none): a replacement only goes there.
    static TARGET: AtomicIsize = AtomicIsize::new(0);

    /// What was selected, and whether it is in a field the user can type in.
    struct Picked {
        text: String,
        editable: bool,
    }

    /// Gives the keyboard back to the window that had the selection (the popup may
    /// hold it after a click) and says whether it has it, so a paste lands where the
    /// text was. False once the popup was dismissed: the selection may have moved.
    pub fn refocus_target() -> bool {
        let target = TARGET.load(Ordering::SeqCst);
        if target == 0 {
            return false;
        }
        let window = HWND(target as *mut _);
        // SAFETY: plain window calls on a handle that is re-checked by the foreground comparison.
        unsafe {
            if GetForegroundWindow() != window {
                let _ = SetForegroundWindow(window);
                std::thread::sleep(Duration::from_millis(80));
            }
            GetForegroundWindow() == window
        }
    }

    struct HookState {
        down: POINT,
        last_up: Option<(Instant, POINT)>,
        clicks: u32,
    }
    static HOOK_STATE: Mutex<HookState> = Mutex::new(HookState { down: POINT { x: 0, y: 0 }, last_up: None, clicks: 1 });

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            // SAFETY: for WH_MOUSE_LL, lparam points to a MSLLHOOKSTRUCT for the call's duration.
            let at = unsafe { (*(lparam.0 as *const MSLLHOOKSTRUCT)).pt };
            match wparam.0 as u32 {
                WM_LBUTTONDOWN => {
                    let mut st = HOOK_STATE.lock().unwrap();
                    let double = unsafe { GetDoubleClickTime() } as u128;
                    st.clicks = match st.last_up {
                        Some((t, p)) if t.elapsed().as_millis() <= double && (p.x - at.x).abs() <= 4 && (p.y - at.y).abs() <= 4 => st.clicks + 1,
                        _ => 1,
                    };
                    st.down = at;
                    drop(st);
                    send(Ev::Down(at));
                }
                WM_LBUTTONUP => {
                    let mut st = HOOK_STATE.lock().unwrap();
                    let (dx, dy) = ((st.down.x - at.x).abs(), (st.down.y - at.y).abs());
                    let dragged = dx >= DRAG_PX || dy >= DRAG_PX;
                    // Shift-click extends a selection but is rarely what the user wants offered.
                    let shift = unsafe { GetKeyState(VK_SHIFT.0 as i32) } < 0;
                    let select = !shift && (dragged || st.clicks >= 2);
                    st.last_up = Some((Instant::now(), at));
                    drop(st);
                    send(Ev::Up { at, select });
                }
                _ => {}
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    fn send(ev: Ev) {
        if let Some(tx) = SENDER.lock().unwrap().as_ref() {
            let _ = tx.send(ev);
        }
    }

    pub fn apply(app: &AppHandle, enabled: bool, ignore: &str) {
        *EXTRA_IGNORED.lock().unwrap() = parse_ignore(ignore);
        let was = ENABLED.swap(enabled, Ordering::SeqCst);
        if enabled == was {
            return;
        }
        if enabled {
            start(app.clone());
        } else {
            stop(app);
        }
    }

    fn start(app: AppHandle) {
        let (tx, rx) = mpsc::channel();
        *SENDER.lock().unwrap() = Some(tx);
        std::thread::spawn(move || {
            // SAFETY: a plain message loop on this thread; the hook is removed before it ends.
            unsafe {
                let module = GetModuleHandleW(None).ok();
                let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module.map(|m| m.into()), 0) {
                    Ok(h) => h,
                    Err(err) => {
                        crate::log::line(format!("selection popup: could not watch the mouse ({err})"));
                        *SENDER.lock().unwrap() = None;
                        ENABLED.store(false, Ordering::SeqCst);
                        return;
                    }
                };
                HOOK_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
                let _ = UnhookWindowsHookEx(hook);
                HOOK_THREAD.store(0, Ordering::SeqCst);
            }
        });
        let worker_app = app.clone();
        std::thread::spawn(move || worker(worker_app, rx));
    }

    fn stop(app: &AppHandle) {
        // Dropping the sender ends the worker; WM_QUIT ends the hook's loop.
        *SENDER.lock().unwrap() = None;
        let thread = HOOK_THREAD.swap(0, Ordering::SeqCst);
        if thread != 0 {
            // SAFETY: posting a thread message to our own hook thread.
            let _ = unsafe { PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0)) };
        }
        hide(app);
    }

    // ── Worker ────────────────────────────────────────────────────────────────

    fn worker(app: AppHandle, rx: Receiver<Ev>) {
        // SAFETY: COM for this thread's UI Automation calls.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let uia: Option<IUIAutomation> = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.ok();
        let Some(uia) = uia else {
            crate::log::line("selection popup: UI Automation is not available");
            return;
        };
        let mut shown: Option<(Instant, RECT)> = None;
        loop {
            let ev = match shown {
                Some((until, _)) => rx.recv_timeout(until.saturating_duration_since(Instant::now())),
                None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            match ev {
                Err(RecvTimeoutError::Timeout) => {
                    hide(&app);
                    shown = None;
                }
                Err(RecvTimeoutError::Disconnected) => break,
                Ok(Ev::Down(at)) => {
                    // A press anywhere but on the popup puts it away.
                    if let Some((_, rect)) = shown {
                        if !inside(&rect, at) {
                            hide(&app);
                            shown = None;
                        }
                    }
                }
                Ok(Ev::Up { at, select }) => {
                    if !select || shown.is_some_and(|(_, r)| inside(&r, at)) {
                        continue;
                    }
                    std::thread::sleep(SETTLE);
                    match read_selection(&uia, at) {
                        Some(picked) if !crate::platform::fullscreen_active() => {
                            crate::log::line(format!(
                                "selection popup: {} characters selected{}",
                                picked.text.chars().count(),
                                if picked.editable { " (in a text field)" } else { "" }
                            ));
                            *CURRENT.lock().unwrap() = Some(picked.text);
                            // SAFETY: no arguments.
                            TARGET.store(unsafe { GetForegroundWindow() }.0 as isize, Ordering::SeqCst);
                            shown = place(&app, at, picked.editable).map(|r| (Instant::now() + POPUP_LIFETIME, r));
                        }
                        _ => {
                            if shown.take().is_some() {
                                hide(&app);
                            }
                        }
                    }
                }
            }
        }
    }

    fn inside(r: &RECT, p: POINT) -> bool {
        p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom
    }

    /// Shows the popup above the point (below when there is no room), on the
    /// monitor it is on, and returns its rectangle in physical pixels.
    fn place(app: &AppHandle, at: POINT, editable: bool) -> Option<RECT> {
        let win = app.get_webview_window(WINDOW_LABEL)?;
        let scale = win.scale_factor().unwrap_or(1.0);
        let size = if editable { POPUP_SIZE_EDITABLE } else { POPUP_SIZE };
        let (w, h) = ((size.0 * scale).round() as i32, (size.1 * scale).round() as i32);
        let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
        tell_popup(app, serde_json::json!({ "state": "ready", "editable": editable }));
        let gap = (16.0 * scale).round() as i32;
        let mut work = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        // SAFETY: `work` is a valid MONITORINFO for the call.
        let have_work = unsafe { GetMonitorInfoW(MonitorFromPoint(at, MONITOR_DEFAULTTONEAREST), &mut work) }.as_bool();
        let area = if have_work { work.rcWork } else { RECT { left: 0, top: 0, right: i32::MAX, bottom: i32::MAX } };
        let x = (at.x - w / 2).clamp(area.left, (area.right - w).max(area.left));
        let above = at.y - h - gap;
        let y = if above >= area.top { above } else { at.y + gap * 2 };
        let y = y.clamp(area.top, (area.bottom - h).max(area.top));
        // The window is always "shown", parked off-screen when not in use: showing a
        // hidden webview window activates it whatever its styles say, which would take the
        // keyboard from the app that holds the selection and grey the highlight. Moving it
        // never activates anything.
        let _ = win.set_position(PhysicalPosition::new(x, y));
        Some(RECT { left: x, top: y, right: x + w, bottom: y + h })
    }

    pub fn hide(app: &AppHandle) {
        *CURRENT.lock().unwrap() = None;
        // Once the popup is gone (an outside click, a new selection, a timeout) a replacement no longer has a place to land.
        TARGET.store(0, Ordering::SeqCst);
        if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
            let _ = win.set_position(PhysicalPosition::new(PARKED, PARKED));
        }
    }

    // ── Reading the selection ─────────────────────────────────────────────────

    fn exe_name(pid: u32) -> Option<String> {
        // SAFETY: a short-lived query handle, closed below.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 520];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, ::windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(handle);
            if !ok {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit(['\\', '/']).next().map(|n| n.to_lowercase())
        }
    }

    fn ignored(pid: u32) -> bool {
        let Some(name) = exe_name(pid) else { return false };
        DEFAULT_IGNORED.contains(&name.as_str()) || EXTRA_IGNORED.lock().unwrap().contains(&name)
    }

    /// The text selected where the user just let go of the mouse, or None: nothing
    /// selected, an app that exposes no text, a password field, an ignored app.
    fn read_selection(uia: &IUIAutomation, at: POINT) -> Option<Picked> {
        // SAFETY: UI Automation calls on interfaces this thread created.
        unsafe {
            // The focused element first (a page, an editor); if it has no text,
            // the element under the cursor and its parents (a label, a pane).
            let mut candidates: Vec<IUIAutomationElement> = Vec::new();
            if let Ok(focused) = uia.GetFocusedElement() {
                candidates.push(focused);
            }
            if let Ok(under) = uia.ElementFromPoint(at) {
                let walker = uia.ControlViewWalker().ok();
                let mut node = Some(under);
                for _ in 0..4 {
                    let Some(el) = node else { break };
                    node = walker.as_ref().and_then(|w| w.GetParentElement(&el).ok());
                    candidates.push(el);
                }
            }
            for el in candidates {
                let pid = el.CurrentProcessId().ok().map(|p| p as u32).unwrap_or(0);
                // Our own windows hold the keyboard sometimes; the selection is elsewhere.
                if pid == GetCurrentProcessId() {
                    continue;
                }
                if pid != 0 && ignored(pid) {
                    return None;
                }
                if el.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false) {
                    return None;
                }
                let Ok(pattern) = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) else { continue };
                let Ok(ranges) = pattern.GetSelection() else { continue };
                if ranges.Length().unwrap_or(0) == 0 {
                    continue;
                }
                let mut text = String::new();
                let mut read_only = true;
                for i in 0..ranges.Length().unwrap_or(0).min(3) {
                    if let Ok(r) = ranges.GetElement(i) {
                        if let Ok(t) = r.GetText(2000) {
                            text.push_str(&t.to_string());
                            text.push(' ');
                        }
                        // A range of editable text says so; a mixed or unknown answer counts as read-only.
                        if i == 0 {
                            read_only = r
                                .GetAttributeValue(UIA_IsReadOnlyAttributeId)
                                .ok()
                                .and_then(|v| bool::try_from(&v).ok())
                                .unwrap_or(true);
                        }
                    }
                }
                // Chat boxes and fields: an edit control, or text its own app calls editable.
                let typeable = el.CurrentControlType().map(|t| t == UIA_EditControlTypeId).unwrap_or(false)
                    && el
                        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        .and_then(|v| v.CurrentIsReadOnly())
                        .map(|b| !b.as_bool())
                        .unwrap_or(true);
                // In a field the whole selection is kept (a cut message must not be translated and pasted back);
                // too long for that, it is offered as plain selected text.
                let whole = if !read_only || typeable { clean_to(&text, EDIT_MAX_CHARS).filter(|t| !t.ends_with('…')) } else { None };
                match whole {
                    Some(text) => return Some(Picked { text, editable: true }),
                    None => {
                        if let Some(text) = clean(&text) {
                            return Some(Picked { text, editable: false });
                        }
                    }
                }
            }
            None
        }
    }
}

/// Turns the popup on or off, and sets the user's extra ignored apps.
pub fn apply(app: &AppHandle, enabled: bool, ignore: &str) {
    #[cfg(windows)]
    imp::apply(app, enabled, ignore);
    #[cfg(not(windows))]
    let _ = (app, enabled, ignore);
}

/// Gives the keyboard back to the app the text was selected in and says whether it
/// has it (false if the popup was dismissed meanwhile).
pub fn refocus_target() -> bool {
    #[cfg(windows)]
    return imp::refocus_target();
    #[cfg(not(windows))]
    false
}

/// Puts the popup away.
pub fn hide(app: &AppHandle) {
    #[cfg(windows)]
    imp::hide(app);
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignore_lists_parse_loosely() {
        assert_eq!(parse_ignore("Code, notepad.exe;  slack\nGame.EXE"), vec!["code.exe", "notepad.exe", "slack.exe", "game.exe"]);
        assert!(parse_ignore("  ,; ").is_empty());
    }

    #[test]
    fn selections_are_cleaned_and_capped() {
        assert_eq!(clean("  猫が\n 好き  ").as_deref(), Some("猫が 好き"));
        assert_eq!(clean("a"), None);
        assert_eq!(clean("   "), None);
        let long = "あ".repeat(MAX_CHARS + 50);
        let cut = clean(&long).unwrap();
        assert_eq!(cut.chars().count(), MAX_CHARS + 1);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn fields_keep_the_whole_message() {
        let long = "あ".repeat(EDIT_MAX_CHARS - 1);
        assert_eq!(clean_to(&long, EDIT_MAX_CHARS).as_deref(), Some(long.as_str()));
        assert!(clean_to(&"あ".repeat(EDIT_MAX_CHARS + 1), EDIT_MAX_CHARS).unwrap().ends_with('…'));
        assert_eq!(clean_to(&long, MAX_CHARS).unwrap().chars().count(), MAX_CHARS + 1);
    }

    #[test]
    fn the_current_selection_is_taken_once() {
        *CURRENT.lock().unwrap() = Some("猫".into());
        assert_eq!(take_current().as_deref(), Some("猫"));
        assert_eq!(take_current(), None);
    }
}
