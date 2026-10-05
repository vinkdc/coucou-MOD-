// Windows: Win32 for the island window and the cursor, %APPDATA% for files.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

use tauri::{AppHandle, Manager, WebviewWindow};

use ::windows::core::BOOL;
use ::windows::Win32::Foundation::{HWND, LPARAM, POINT};
use ::windows::Win32::System::Ole::RevokeDragDrop;
use ::windows::Win32::System::SystemInformation::GetLocalTime;
use ::windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use ::windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetClassNameW, GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW,
    GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use super::LocalTime;
use crate::island::WINDOW_LABEL;

/// Environment variable holding the home directory.
#[allow(dead_code)]
pub const HOME_VAR: &str = "USERPROFILE";

/// Keeps spawned helpers from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Files ─────────────────────────────────────────────────────────────────────

/// %APPDATA%\Kotoba — preferences and learner progress.
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Kotoba")
}

/// %LOCALAPPDATA%\Kotoba — the voice cache and the log.
pub fn local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Kotoba")
}

/// %APPDATA% and %LOCALAPPDATA% are already private to the user.
pub fn ensure_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Nothing to set up before the webview starts.
pub fn prepare_environment() {}

pub fn local_time() -> LocalTime {
    let t = unsafe { GetLocalTime() };
    LocalTime {
        year: t.wYear.into(),
        month: t.wMonth.into(),
        day: t.wDay.into(),
        hour: t.wHour.into(),
        minute: t.wMinute.into(),
        second: t.wSecond.into(),
    }
}

// ── Processes ─────────────────────────────────────────────────────────────────

/// Spawned helpers must never flash a console window.
pub fn no_console(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

pub fn open_url(url: &str) {
    let _ = no_console(Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url]))
        .spawn();
}

// ── Who we are ────────────────────────────────────────────────────────────────
//
// Named pipes share one machine-wide namespace, so the SID in the name is what
// keeps two accounts on the same machine from ever meeting on `coucou-*`.
// coucou-hook computes the same string (hook/src/win.rs) and additionally checks
// that the process serving the pipe really is us.

// ── Cursor ────────────────────────────────────────────────────────────────────

/// The 60 Hz poll reads the cursor and flips click-through from it.
pub const CURSOR_POLL: bool = true;

/// Cursor position in physical screen pixels.
pub fn cursor_physical() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

pub fn left_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

// ── Selected text ─────────────────────────────────────────────────────────────

const CF_UNICODETEXT: u32 = 13;

/// The text on the clipboard, if it holds any.
fn clipboard_text() -> Option<String> {
    use ::windows::Win32::Foundation::{HANDLE, HGLOBAL};
    use ::windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard};
    use ::windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    unsafe {
        IsClipboardFormatAvailable(CF_UNICODETEXT).ok()?;
        // Another app may hold the clipboard for a moment right after copying.
        let mut opened = false;
        for _ in 0..10 {
            if OpenClipboard(None).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if !opened {
            return None;
        }
        let result = (|| {
            let handle: HANDLE = GetClipboardData(CF_UNICODETEXT).ok()?;
            let global = HGLOBAL(handle.0);
            let ptr = GlobalLock(global) as *const u16;
            if ptr.is_null() {
                return None;
            }
            let units = GlobalSize(global) / 2;
            // Copied out before unlocking: the clipboard owns this memory.
            let mut buf = std::slice::from_raw_parts(ptr, units).to_vec();
            let _ = GlobalUnlock(global);
            if let Some(end) = buf.iter().position(|&c| c == 0) {
                buf.truncate(end);
            }
            Some(String::from_utf16_lossy(&buf))
        })();
        let _ = CloseClipboard();
        result
    }
}

/// True when the clipboard holds something that is not text (a picture, files…):
/// overwriting it with a copy would lose what the user put there.
fn clipboard_has_other_data() -> bool {
    use ::windows::Win32::System::DataExchange::{CountClipboardFormats, IsClipboardFormatAvailable};
    unsafe { CountClipboardFormats() > 0 && IsClipboardFormatAvailable(CF_UNICODETEXT).is_err() }
}

fn set_clipboard_text(text: &str) -> bool {
    use ::windows::Win32::Foundation::{HANDLE, HGLOBAL};
    use ::windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use ::windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0);
    unsafe {
        if OpenClipboard(None).is_err() {
            return false;
        }
        let ok = (|| {
            EmptyClipboard().ok()?;
            let global: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).ok()?;
            let ptr = GlobalLock(global) as *mut u16;
            if ptr.is_null() {
                return None;
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
            let _ = GlobalUnlock(global);
            // The clipboard owns the memory once SetClipboardData succeeds.
            SetClipboardData(CF_UNICODETEXT, Some(HANDLE(global.0))).ok()?;
            Some(())
        })()
        .is_some();
        let _ = CloseClipboard();
        ok
    }
}

fn key_down(vk: u16) -> bool {
    unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 }
}

/// Sends Ctrl+C to whatever has the keyboard.
fn send_copy() {
    use ::windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY,
    };
    let key = |vk: u16, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    const CONTROL: u16 = 0x11;
    const C: u16 = 0x43;
    let inputs = [key(CONTROL, false), key(C, false), key(C, true), key(CONTROL, true)];
    // SAFETY: `inputs` is a valid array of fully initialised INPUT structs.
    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
}

/// The text selected in whatever app is in front.
///
/// The hotkey was pressed with modifiers held, so those come up first (a Ctrl+Alt
/// still down would turn the copy into Ctrl+Alt+C). Then Ctrl+C is sent and the
/// clipboard read; the previous text is put back afterwards. A clipboard holding
/// something other than text is never touched: the user is asked to copy first.
/// If the app ignores Ctrl+C (nothing selected), the text already on the
/// clipboard is used.
pub fn selected_text() -> Result<String, String> {
    use ::windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    const MODIFIERS: [u16; 5] = [0x11, 0x12, 0x10, 0x5B, 0x5C]; // Ctrl, Alt, Shift, LWin, RWin

    for _ in 0..40 {
        if !MODIFIERS.iter().any(|&vk| key_down(vk)) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let previous = clipboard_text();
    if previous.is_none() && clipboard_has_other_data() {
        return Err("Your clipboard holds a picture or files, so I won't overwrite it. Copy the text with Ctrl+C, then press the shortcut again.".into());
    }
    let before = unsafe { GetClipboardSequenceNumber() };
    send_copy();
    let mut copied = false;
    for _ in 0..25 {
        std::thread::sleep(std::time::Duration::from_millis(20));
        if unsafe { GetClipboardSequenceNumber() } != before {
            copied = true;
            break;
        }
    }
    let selected = if copied { clipboard_text() } else { None };
    if copied {
        // The user's own clipboard comes back; only the lookup saw the selection.
        match &previous {
            Some(text) => {
                set_clipboard_text(text);
            }
            None => {
                set_clipboard_text("");
            }
        }
    }
    match selected.or(previous).map(|t| t.trim().to_string()) {
        Some(t) if !t.is_empty() => Ok(t),
        _ => Err("Nothing is selected. Select some text, then press the shortcut.".into()),
    }
}

// ── Island window ─────────────────────────────────────────────────────────────

fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
    let raw = win.hwnd().ok()?.0 as isize;
    if raw == 0 {
        return None;
    }
    Some(HWND(raw as *mut _))
}

/// Lets dropped files reach the app again.
///
/// wry installs its drop target by walking the webview's child windows **once**,
/// when the webview is created. WebView2 creates `Chrome_RenderWidgetHostHWND`
/// later and registers its own target on it; being the innermost window, that one
/// wins, and since the page has no HTML5 drop handler it refuses everything — the
/// "no drop" cursor, with nothing reaching Tauri. Revoking it makes OLE fall
/// through to the target wry registered on the parent widget, which is the one
/// that feeds Tauri's drag events.
///
/// Cheap and idempotent, so it is simply re-run whenever a drag might be starting.
pub fn unblock_webview_drops(app: &AppHandle) {
    for label in [WINDOW_LABEL, "settings"] {
        let Some(win) = app.get_webview_window(label) else { continue };
        let Some(hwnd) = hwnd_of(&win) else { continue };
        unsafe {
            let _ = EnumChildWindows(Some(hwnd), Some(revoke_render_widget), LPARAM(0));
        }
    }
}

unsafe extern "system" fn revoke_render_widget(hwnd: HWND, _: LPARAM) -> BOOL {
    let mut name = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut name) };
    if len > 0 {
        let class = String::from_utf16_lossy(&name[..len as usize]);
        if class == "Chrome_RenderWidgetHostHWND" {
            let _ = unsafe { RevokeDragDrop(hwnd) };
        }
    }
    true.into()
}


/// WS_EX_NOACTIVATE keeps clicks from stealing focus; WS_EX_TOOLWINDOW keeps the
/// island out of Alt-Tab.
pub fn make_non_activating(win: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// True while a full-screen game, video or presentation owns the screen — the
/// same signal Windows uses to hold back its own notifications. The island must
/// not pop over it; the badge and the tray carry the news instead.
pub fn fullscreen_active() -> bool {
    use ::windows::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE,
        QUNS_RUNNING_D3D_FULL_SCREEN,
    };
    match unsafe { SHQueryUserNotificationState() } {
        Ok(state) => {
            state == QUNS_BUSY
                || state == QUNS_RUNNING_D3D_FULL_SCREEN
                || state == QUNS_PRESENTATION_MODE
        }
        Err(_) => false,
    }
}

/// Shows the island. It has to go through Tauri: a raw ShowWindow leaves the
/// WebView2 controller believing it is hidden, and the transparent window then
/// draws nothing at all. The window was created with `focus: false` and
/// WS_EX_NOACTIVATE, which keeps the show from taking the keyboard.
pub fn show_without_focus(win: &WebviewWindow) {
    let _ = win.show();
}

/// Milliseconds since the user last touched the keyboard or mouse, anywhere.
pub fn idle_ms() -> u64 {
    use ::windows::Win32::System::SystemInformation::GetTickCount;
    use ::windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    // SAFETY: `info` is a valid, correctly sized LASTINPUTINFO for the call.
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return u64::MAX;
    }
    // Both counters wrap together at ~49 days; the difference stays right.
    u64::from(unsafe { GetTickCount() }.wrapping_sub(info.dwTime))
}

/// Takes the keyboard for the island even though another app is in front.
///
/// Windows refuses `SetForegroundWindow` to a process that did not just receive
/// input — which is exactly the island's position after Mochi opened a page or
/// an app and that app came forward. Joining the foreground thread's input queue
/// for the moment the call is made is the documented way to be allowed.
pub fn force_foreground(win: &WebviewWindow) {
    use ::windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use ::windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    };
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let front = GetForegroundWindow();
        let front_thread = if front.is_invalid() { 0 } else { GetWindowThreadProcessId(front, None) };
        let mine = GetCurrentThreadId();
        let joined = front_thread != 0 && front_thread != mine && AttachThreadInput(mine, front_thread, true).as_bool();
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        if joined {
            let _ = AttachThreadInput(mine, front_thread, false);
        }
    }
}

/// Temporarily allow activation so a text field inside the island can be typed in.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = if activating {
            ex & !(WS_EX_NOACTIVATE.0 as isize)
        } else {
            ex | WS_EX_NOACTIVATE.0 as isize
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Click-through here is the poll's WS_EX_TRANSPARENT toggle, not a region.
pub fn set_input_region(_win: &WebviewWindow, _rect: Option<(f64, f64, f64, f64)>) {}
