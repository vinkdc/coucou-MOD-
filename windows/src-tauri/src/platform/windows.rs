// Windows: Win32 for the island window and the cursor, %APPDATA% for files.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicIsize, Ordering};

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
    set_clipboard_text_as(text, false)
}

/// Puts `text` on the clipboard. `private` marks it as a throwaway: Windows' clipboard
/// history (Win+V) and cloud clipboard are told not to record it, so it never shows up
/// there to be deleted. (The same two flags password managers set.)
fn set_clipboard_text_as(text: &str, private: bool) -> bool {
    use ::windows::core::PCWSTR;
    use ::windows::Win32::Foundation::{HANDLE, HGLOBAL};
    use ::windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData};
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
            if private {
                // Each flag is a DWORD of 0 under a registered format name. A failure here only
                // means the entry may show in history; the text itself is already on the clipboard.
                for name in ["CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"] {
                    let wide_name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
                    let format = RegisterClipboardFormatW(PCWSTR(wide_name.as_ptr()));
                    if format == 0 {
                        continue;
                    }
                    if let Ok(flag) = GlobalAlloc(GMEM_MOVEABLE, 4) {
                        let ptr = GlobalLock(flag) as *mut u32;
                        if !ptr.is_null() {
                            ptr.write(0);
                            let _ = GlobalUnlock(flag);
                            let _ = SetClipboardData(format, Some(HANDLE(flag.0)));
                        }
                    }
                }
            }
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

/// Sends Ctrl+<letter> to whatever has the keyboard.
fn send_ctrl(letter: u16) {
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
    let inputs = [key(CONTROL, false), key(letter, false), key(letter, true), key(CONTROL, true)];
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
    send_ctrl(0x43); // C
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

// ── Clipboard backup ──────────────────────────────────────────────────────────

/// Everything that was on the clipboard, format by format, so it can be put back
/// exactly (a picture, copied files, rich text, whatever it was).
pub struct Snapshot(Vec<(u32, Vec<u8>)>);

/// Most a backup may hold; a bigger clipboard is left alone rather than risked.
const MAX_BACKUP_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, PartialEq)]
enum Plan {
    Copy,
    /// Windows rebuilds it from another format on its own.
    Skip,
    /// Held as a handle I can't copy faithfully.
    Refuse,
}

const CF_BITMAP: u32 = 2;
const CF_DIB: u32 = 8;
const CF_PALETTE: u32 = 9;
const CF_DIBV5: u32 = 17;

/// What to do with one clipboard format. A bitmap or palette is always offered
/// next to a device-independent bitmap (CF_DIB / CF_DIBV5), which carries the same
/// picture as plain bytes: that one is copied and Windows rebuilds the rest.
/// Metafiles, owner-drawn and GDI-object formats are handles to live objects.
fn plan(format: u32, has_dib: bool) -> Plan {
    match format {
        CF_BITMAP | CF_PALETTE if has_dib => Plan::Skip,
        CF_BITMAP | CF_PALETTE | 3 | 14 | 0x80 | 0x82 | 0x83 | 0x8E | 0x300..=0x3FF => Plan::Refuse,
        _ => Plan::Copy,
    }
}

/// Opens the clipboard, waiting briefly if another app has it.
fn open_clipboard() -> bool {
    use ::windows::Win32::System::DataExchange::OpenClipboard;
    for _ in 0..10 {
        // SAFETY: no window handle is needed; the clipboard is closed by the caller.
        if unsafe { OpenClipboard(None) }.is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    false
}

/// Copies every format on the clipboard, or says why it can't (then nothing has been touched).
fn snapshot_clipboard() -> Result<Snapshot, String> {
    use ::windows::Win32::Foundation::HGLOBAL;
    use ::windows::Win32::System::DataExchange::{CloseClipboard, EnumClipboardFormats, GetClipboardData};
    use ::windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    if !open_clipboard() {
        return Err("Couldn't reach the clipboard.".into());
    }
    // SAFETY: the clipboard is open for the whole block; each handle is locked only while it is read.
    let result = unsafe {
        (|| {
            let mut formats = Vec::new();
            let mut f = EnumClipboardFormats(0);
            while f != 0 {
                formats.push(f);
                f = EnumClipboardFormats(f);
            }
            let has_dib = formats.contains(&CF_DIB) || formats.contains(&CF_DIBV5);
            let mut items = Vec::new();
            let mut total = 0usize;
            for f in formats {
                match plan(f, has_dib) {
                    Plan::Skip => continue,
                    Plan::Refuse => return Err("Your clipboard holds something I can't back up, so I left it alone.".to_string()),
                    Plan::Copy => {}
                }
                let Ok(handle) = GetClipboardData(f) else {
                    return Err("Couldn't read your clipboard, so I left it alone.".to_string());
                };
                let global = HGLOBAL(handle.0);
                let size = GlobalSize(global);
                if size == 0 {
                    continue;
                }
                total += size;
                if total > MAX_BACKUP_BYTES {
                    return Err("Your clipboard is too big to back up, so I left it alone.".to_string());
                }
                let ptr = GlobalLock(global) as *const u8;
                if ptr.is_null() {
                    return Err("Couldn't read your clipboard, so I left it alone.".to_string());
                }
                let bytes = std::slice::from_raw_parts(ptr, size).to_vec();
                let _ = GlobalUnlock(global);
                items.push((f, bytes));
            }
            Ok(Snapshot(items))
        })()
    };
    // SAFETY: closes the clipboard opened above.
    let _ = unsafe { CloseClipboard() };
    result
}

/// Puts a backup back, replacing whatever is on the clipboard now.
fn restore_clipboard(snapshot: &Snapshot) -> bool {
    use ::windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use ::windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, SetClipboardData};
    use ::windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    if !open_clipboard() {
        return false;
    }
    let mut all = true;
    // SAFETY: the clipboard is open; the clipboard owns each block once SetClipboardData succeeds.
    unsafe {
        let _ = EmptyClipboard();
        for (format, bytes) in &snapshot.0 {
            let Ok(global) = GlobalAlloc(GMEM_MOVEABLE, bytes.len()) else {
                all = false;
                continue;
            };
            let ptr = GlobalLock(global) as *mut u8;
            if ptr.is_null() {
                let _ = GlobalFree(Some(global));
                all = false;
                continue;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
            let _ = GlobalUnlock(global);
            if SetClipboardData(*format, Some(HANDLE(global.0))).is_err() {
                let _ = GlobalFree(Some(HGLOBAL(global.0)));
                all = false;
            }
        }
        let _ = CloseClipboard();
    }
    all
}

/// Replaces the selection in the app in front with `text`: backs up the whole
/// clipboard, puts the text on it (marked private, so Win+V history never records
/// it), sends Ctrl+V, then puts everything back exactly as it was: text, a picture,
/// copied files. (Typing the characters in instead is unreliable with an input
/// method active.) If the clipboard can't be backed up faithfully, nothing is touched.
pub fn paste_text(text: &str) -> Result<(), String> {
    use ::windows::Win32::System::DataExchange::GetClipboardSequenceNumber;

    let backup = snapshot_clipboard()?;
    if !set_clipboard_text_as(text, true) {
        // Setting it may already have emptied the clipboard.
        restore_clipboard(&backup);
        return Err("Couldn't reach the clipboard.".into());
    }
    // SAFETY: no arguments.
    let ours = unsafe { GetClipboardSequenceNumber() };
    send_ctrl(0x56); // V
    // The app reads the clipboard as it handles the paste; give it a moment before restoring.
    std::thread::sleep(std::time::Duration::from_millis(400));
    // If the user copied something in those 400 ms, that is the clipboard now: leave it.
    // SAFETY: no arguments.
    if unsafe { GetClipboardSequenceNumber() } == ours && !restore_clipboard(&backup) {
        crate::log::line("clipboard: could not restore every format after replacing a selection");
    }
    Ok(())
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
        // Remember who had the keyboard (YouTube, an editor…) so closing the
        // island can hand it back; a repeated call while already in front keeps it.
        if !front.is_invalid() && front != hwnd {
            PREVIOUS_FOREGROUND.store(front.0 as isize, Ordering::Relaxed);
        }
        let front_thread = if front.is_invalid() { 0 } else { GetWindowThreadProcessId(front, None) };
        let mine = GetCurrentThreadId();
        let joined = front_thread != 0 && front_thread != mine && AttachThreadInput(mine, front_thread, true).as_bool();
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        // Some apps (Electron ones, or a window mid-IME-composition) still refuse.
        // A synthetic key tap counts as fresh input for this process, which lifts
        // the restriction; F24 is a key nothing listens to.
        if GetForegroundWindow() != hwnd {
            use ::windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VIRTUAL_KEY};
            keybd_event(VIRTUAL_KEY(0x87).0 as u8, 0, Default::default(), 0);
            keybd_event(VIRTUAL_KEY(0x87).0 as u8, 0, KEYEVENTF_KEYUP, 0);
            let _ = SetForegroundWindow(hwnd);
        }
        if joined {
            let _ = AttachThreadInput(mine, front_thread, false);
        }
    }
}

// ── The assistant's PC tools ─────────────────────────────────────────────────

/// Presses a media key as if it were on the keyboard: whatever owns media
/// playback (Spotify, a browser tab, the system mixer) obeys it. `key` is one of
/// play_pause, next, previous, volume_up, volume_down, mute.
pub fn media_key(key: &str) -> bool {
    use ::windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP};
    let vk: u8 = match key {
        "play_pause" => 0xB3,
        "next" => 0xB0,
        "previous" => 0xB1,
        "volume_up" => 0xAF,
        "volume_down" => 0xAE,
        "mute" => 0xAD,
        _ => return false,
    };
    // SAFETY: plain keyboard input injection, no pointers involved.
    unsafe {
        keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY, 0);
        keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0);
    }
    true
}

/// A few harmless facts about this PC, one per line: nothing identifying beyond
/// the computer's name, no account name, no files.
pub fn system_summary() -> String {
    use ::windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use ::windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use ::windows::Win32::System::SystemInformation::{GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX};

    let mut lines = Vec::new();
    let t = local_time();
    lines.push(format!("Local time: {:04}-{:02}-{:02} {:02}:{:02}", t.year, t.month, t.day, t.hour, t.minute));
    let ver = no_console(Command::new("cmd").args(["/C", "ver"])).output().ok();
    if let Some(out) = ver {
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !text.is_empty() {
            lines.push(format!("OS: {text}"));
        }
    }
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        lines.push(format!("Computer name: {name}"));
    }
    if let Ok(n) = std::thread::available_parallelism() {
        lines.push(format!("CPU threads: {n}"));
    }
    let mut mem = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    // SAFETY: `mem` is a valid, correctly sized MEMORYSTATUSEX.
    if unsafe { GlobalMemoryStatusEx(&mut mem) }.is_ok() {
        let gb = |b: u64| b as f64 / 1_073_741_824.0;
        lines.push(format!("Memory: {:.1} GB free of {:.1} GB", gb(mem.ullAvailPhys), gb(mem.ullTotalPhys)));
    }
    let mut free = 0u64;
    let mut total = 0u64;
    // SAFETY: both out-pointers are valid for the call.
    if unsafe { GetDiskFreeSpaceExW(::windows::core::w!("C:\\"), Some(&mut free), Some(&mut total), None) }.is_ok() {
        let gb = |b: u64| b as f64 / 1_073_741_824.0;
        lines.push(format!("Disk C: {:.0} GB free of {:.0} GB", gb(free), gb(total)));
    }
    let mut power = SYSTEM_POWER_STATUS::default();
    // SAFETY: `power` is a valid SYSTEM_POWER_STATUS.
    if unsafe { GetSystemPowerStatus(&mut power) }.is_ok() && power.BatteryFlag != 128 {
        let pct = if power.BatteryLifePercent == 255 { "unknown".to_string() } else { format!("{}%", power.BatteryLifePercent) };
        lines.push(format!("Battery: {pct}, {}", if power.ACLineStatus == 1 { "plugged in" } else { "on battery" }));
    }
    let up = unsafe { GetTickCount64() } / 1000;
    lines.push(format!("Uptime: {}h {}m", up / 3600, (up / 60) % 60));
    lines.join("\n")
}

/// The window that had the keyboard before `force_foreground` took it.
static PREVIOUS_FOREGROUND: AtomicIsize = AtomicIsize::new(0);

/// Gives the keyboard back to the window the island took it from. Does nothing
/// if the user already moved on: only acts while the island is still in front.
pub fn restore_foreground(win: &WebviewWindow) {
    use ::windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsWindow, IsWindowVisible, SetForegroundWindow};
    let Some(hwnd) = hwnd_of(win) else { return };
    let prev = HWND(PREVIOUS_FOREGROUND.swap(0, Ordering::Relaxed) as *mut _);
    if prev.is_invalid() || prev == hwnd {
        return;
    }
    unsafe {
        if GetForegroundWindow() == hwnd && IsWindow(Some(prev)).as_bool() && IsWindowVisible(prev).as_bool() {
            let _ = SetForegroundWindow(prev);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_plan_copies_bytes_and_refuses_live_handles() {
        // A copied picture: the DIB is copied, the bitmap and palette Windows rebuilds.
        assert_eq!(plan(CF_DIB, true), Plan::Copy);
        assert_eq!(plan(CF_DIBV5, true), Plan::Copy);
        assert_eq!(plan(CF_BITMAP, true), Plan::Skip);
        assert_eq!(plan(CF_PALETTE, true), Plan::Skip);
        // A bare bitmap handle can't be copied faithfully.
        assert_eq!(plan(CF_BITMAP, false), Plan::Refuse);
        // Text, files (CF_HDROP = 15), registered formats such as HTML or PNG (0xC000+): plain bytes.
        for f in [1, 7, 13, 15, 16, 0xC0A1, 0xC123] {
            assert_eq!(plan(f, false), Plan::Copy, "format {f}");
        }
        // Metafiles, owner-display and GDI-object formats are live handles.
        for f in [3, 14, 0x80, 0x82, 0x83, 0x8E, 0x300, 0x3FF] {
            assert_eq!(plan(f, true), Plan::Refuse, "format {f}");
        }
    }

    /// Touches the real clipboard, so it only runs on request:
    /// `cargo test --lib backup_round_trip -- --ignored`. Puts several formats on it,
    /// runs the backup, the private text and the restore, and checks every format is back.
    #[test]
    #[ignore]
    fn backup_round_trip_keeps_every_format() {
        use ::windows::core::PCWSTR;
        use ::windows::Win32::Foundation::{HANDLE, HGLOBAL};
        use ::windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, RegisterClipboardFormatW, SetClipboardData};
        use ::windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

        let name: Vec<u16> = "KotobaTestFormat".encode_utf16().chain(std::iter::once(0)).collect();
        let custom = unsafe { RegisterClipboardFormatW(PCWSTR(name.as_ptr())) };
        let payload: Vec<u8> = (0..=255u8).cycle().take(5000).collect();
        let put = |format: u32, bytes: &[u8]| unsafe {
            let global: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).unwrap();
            let ptr = GlobalLock(global) as *mut u8;
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
            let _ = GlobalUnlock(global);
            SetClipboardData(format, Some(HANDLE(global.0))).unwrap();
        };

        let original = snapshot_clipboard().expect("back up whatever the clipboard held");
        assert!(open_clipboard());
        unsafe { EmptyClipboard().unwrap() };
        let wide: Vec<u8> = "before".encode_utf16().chain(std::iter::once(0)).flat_map(|u| u.to_le_bytes()).collect();
        put(13, &wide); // CF_UNICODETEXT
        put(custom, &payload);
        unsafe { let _ = CloseClipboard(); }

        let mid = snapshot_clipboard().expect("back up the test clipboard");
        assert!(set_clipboard_text_as("temporary", true));
        assert_eq!(clipboard_text().as_deref(), Some("temporary"));
        assert!(restore_clipboard(&mid));

        let back = snapshot_clipboard().expect("read it again");
        let get = |snap: &Snapshot, f: u32| snap.0.iter().find(|(id, _)| *id == f).map(|(_, b)| b.clone());
        assert_eq!(get(&back, custom).as_deref(), Some(payload.as_slice()), "the custom format must come back byte for byte");
        assert_eq!(clipboard_text().as_deref(), Some("before"));
        assert!(restore_clipboard(&original), "the user's own clipboard goes back");
    }

    /// Touches the real clipboard, so it only runs on request:
    /// `cargo test --lib private_text -- --ignored`. The user's own text is put back.
    #[test]
    #[ignore]
    fn private_text_is_kept_out_of_clipboard_history() {
        use ::windows::core::PCWSTR;
        use ::windows::Win32::System::DataExchange::{IsClipboardFormatAvailable, RegisterClipboardFormatW};
        let flag = |name: &str| {
            let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
            let id = unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) };
            unsafe { IsClipboardFormatAvailable(id) }.is_ok()
        };
        let previous = clipboard_text();
        assert!(set_clipboard_text_as("private translation", true));
        let (history, cloud, text) = (flag("CanIncludeInClipboardHistory"), flag("CanUploadToCloudClipboard"), clipboard_text());
        // A plain copy carries no such flags.
        assert!(set_clipboard_text_as("plain", false));
        let plain_has_flag = flag("CanIncludeInClipboardHistory");
        set_clipboard_text(previous.as_deref().unwrap_or(""));
        assert!(history && cloud, "the private text must carry both flags");
        assert_eq!(text.as_deref(), Some("private translation"));
        assert!(!plain_has_flag);
    }
}
