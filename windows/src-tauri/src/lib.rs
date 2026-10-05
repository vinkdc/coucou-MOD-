// Coucou for Windows — app wiring and the commands the island calls.

mod assistant;
mod claude;
mod devtools;
mod files;
mod gemini;
mod hooks;
mod hotkey;
mod ide;
mod integrations;
mod island;
mod log;
mod pipe;
mod platform;
mod repo;
mod secrets;
mod settings;
mod skins;
mod snip;
mod tray;
mod usage;

use std::process::Command;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use assistant::{Chat, ChatContext, ChatReply};
use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    settings.hooks_installed = hooks::status().installed;
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
        cursor_poll: platform::CURSOR_POLL,
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, position_changed, autostart_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let position_changed = current.position != settings.position;
        let autostart_changed = current.autostart != settings.autostart;
        *current = settings.clone();
        (screen_changed, position_changed, autostart_changed)
    };
    if let Err(err) = settings::save(&settings) {
        eprintln!("[coucou] could not save settings: {err}");
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[coucou] autostart: {err}");
        }
    }
    if screen_changed || position_changed {
        island::apply_geometry(&app, &settings.screen, &settings.position);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// Hidden island → hide the window and park the cursor poll; anything else →
/// show it on the right display and poll at 60 Hz.
#[tauri::command]
fn set_visible(app: AppHandle, shared: State<Shared>, visible: bool) {
    let (pref, position) = {
        let s = shared.settings.lock().unwrap();
        (s.screen.clone(), s.position.clone())
    };
    island::set_visible(&app, &shared.gate, &pref, &position, visible);
}

/// Settings → hotkey. Registers first and saves only what actually registered;
/// on a conflict the previous shortcut keeps working and the error goes back to
/// the settings window to show.
#[tauri::command]
fn set_hotkey(
    app: AppHandle,
    shared: State<Shared>,
    enabled: bool,
    accelerator: String,
) -> Result<Settings, String> {
    let accelerator = accelerator.trim().to_string();
    let (old_enabled, old_accel) = {
        let s = shared.settings.lock().unwrap();
        (s.hotkey_enabled, s.hotkey_accelerator.clone())
    };
    hotkey::replace(&app, (old_enabled, &old_accel), (enabled, &accelerator))?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hotkey_enabled = enabled;
        current.hotkey_accelerator = accelerator;
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated.clone());
    Ok(updated)
}

/// Branch, changed files and ahead/behind of the folder a session works in,
/// read locally from git. Run off the main thread: git can take a moment.
#[tauri::command]
async fn repo_status(path: String) -> Result<repo::RepoStatus, String> {
    tauri::async_runtime::spawn_blocking(move || repo::status(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Claude Code tokens per hour over the last week, from its local transcripts.
#[tauri::command]
async fn claude_usage() -> Result<usage::Usage, String> {
    tauri::async_runtime::spawn_blocking(usage::read)
        .await
        .map_err(|e| e.to_string())
}

/// The island page reports what the tray should say; see tray::sync.
#[tauri::command]
fn tray_sync(app: AppHandle, status: String, visible: bool, paused: bool) {
    tray::sync(&app, &status, visible, paused);
}

/// May an event summon the island right now? Not over a full-screen app or a
/// presentation. Asked only for automatic summons; the tray, the hotkey and the
/// file picker always open it.
#[tauri::command]
fn can_summon() -> bool {
    !platform::fullscreen_active()
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

/// How long the user has left the keyboard and mouse alone, in milliseconds.
#[tauri::command]
fn idle_ms() -> u64 {
    platform::idle_ms()
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        platform::force_foreground(&win);
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let (pref, position) = {
        let s = shared.settings.lock().unwrap();
        (s.screen.clone(), s.position.clone())
    };
    island::apply_geometry(&app, &pref, &position);
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

/// The Windows Settings pages a guide may open. A fixed list keyed by short
/// names: what reaches ShellExecute is always one of these literals, never text
/// the model or a page typed.
pub const SETTINGS_PAGES: &[(&str, &str)] = &[
    ("nightlight", "ms-settings:nightlight"),
    ("display", "ms-settings:display"),
    ("sound", "ms-settings:sound"),
    ("bluetooth", "ms-settings:bluetooth"),
    ("wifi", "ms-settings:network-wifi"),
    ("network", "ms-settings:network"),
    ("apps", "ms-settings:appsfeatures"),
    ("defaultapps", "ms-settings:defaultapps"),
    ("personalization", "ms-settings:personalization"),
    ("colors", "ms-settings:colors"),
    ("notifications", "ms-settings:notifications"),
    ("focus", "ms-settings:quietmomentshome"),
    ("battery", "ms-settings:batterysaver"),
    ("storage", "ms-settings:storagesense"),
    ("privacy", "ms-settings:privacy"),
    ("windowsupdate", "ms-settings:windowsupdate"),
    ("startup", "ms-settings:startupapps"),
];

/// Opens one of [`SETTINGS_PAGES`]. False on other systems or for an unknown key.
#[tauri::command]
fn open_windows_settings(page: String) -> bool {
    if !cfg!(windows) {
        return false;
    }
    let Some((_, uri)) = SETTINGS_PAGES.iter().find(|(key, _)| *key == page) else {
        return false;
    };
    platform::launch_app(uri).is_ok()
}

/// "Open terminal" opens the working folder in VS Code when `code` is on PATH,
/// and falls back to the file manager otherwise.
#[tauri::command]
fn open_in_vscode(path: Option<String>, ide: Option<String>) -> bool {
    // No shell anywhere near this. The path is a project folder chosen by
    // whoever is using Claude Code, and a shell would happily read `&`, `^`, `%`
    // or `$` in a folder name as syntax. Finding the launcher ourselves and
    // handing the path over as a separate argument keeps it a path.
    let path = path.filter(|p| !p.is_empty());
    // It arrives in a hook payload: only an existing folder, given by its full
    // path, goes any further. `code` would read `--something` as an option, and
    // xdg-open would launch a file with whatever handles its type.
    if let Some(p) = path.as_deref() {
        let p = std::path::Path::new(p);
        if !(p.is_absolute() && p.is_dir()) {
            return false;
        }
    }
    // The editor the user works in (see ide.rs). An editor without a launcher, or
    // "none" (no editor open), opens the folder; no editor named at all keeps
    // the old behaviour of trying VS Code.
    let launcher = match ide.as_deref() {
        Some(id) => ide::launcher(id),
        None => Some("code"),
    };
    if let Some(code) = launcher.and_then(platform::find_on_path) {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref() {
            cmd.arg(p);
        }
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref() {
        platform::reveal_folder(p);
    }
    false
}

/// "Open terminal" on a Claude Code session: back to the very window it runs in
/// (Windows Terminal, VS Code, a console), found from the process chain the
/// relay recorded. Without one, or when that window is gone, the folder opens
/// as before.
#[tauri::command]
fn focus_session(pids: Vec<u32>, path: Option<String>) -> bool {
    if !pids.is_empty() && platform::focus_process_window(&pids) {
        return true;
    }
    open_in_vscode(path, None)
}

/// The editor the user works in, for the Home pill and its "Open …" link.
/// `pids` is the Claude Code session's process chain, when there is one.
#[tauri::command]
async fn detect_ide(pids: Vec<u32>) -> Option<ide::Ide> {
    tauri::async_runtime::spawn_blocking(move || ide::detect(&pids)).await.ok().flatten()
}

/// Developer tools tab: what is listening, and stopping one of those servers.
#[tauri::command]
async fn listening_ports() -> Vec<devtools::Port> {
    tauri::async_runtime::spawn_blocking(devtools::listening_ports).await.unwrap_or_default()
}

#[tauri::command]
async fn kill_port_process(pid: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || devtools::kill_port_process(pid))
        .await
        .map_err(|e| e.to_string())?
}

/// The scripts a project folder defines (package.json, Cargo.toml, Makefile).
#[tauri::command]
fn project_scripts(dir: String) -> Result<Vec<devtools::Script>, String> {
    devtools::project_scripts(&dir)
}

/// Runs one of those scripts in a visible terminal. Only a name the folder's own files define.
#[tauri::command]
fn run_script(dir: String, kind: String, name: String) -> Result<(), String> {
    devtools::run_script(&dir, &kind, &name)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

#[tauri::command]
fn hooks_status() -> HookStatus {
    hooks::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = install;
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    pipe::decline(&app, &request_id);
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// One chat turn, tools included, on the provider chosen in Settings. The API
/// key and any file bytes stay on the Rust side.
#[tauri::command]
async fn chat_send(
    app: AppHandle,
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    query: String,
    context: Option<ChatContext>,
    persona: Option<String>,
) -> Result<ChatReply, String> {
    let (provider, model, user_name) = {
        let s = shared.settings.lock().unwrap();
        let provider = assistant::Provider::from_setting(&s.provider);
        let model = match provider {
            assistant::Provider::Claude => s.model.clone(),
            assistant::Provider::Gemini => s.gemini_model.clone(),
        };
        (provider, model, s.user_name.clone())
    };
    assistant::run_turn(&app, &chat, provider, &model, query, context, persona, &user_name).await
}

/// The guide's "Check my step": a screenshot and the step go to the chosen
/// model, which says whether the step looks done.
#[tauri::command]
async fn guide_check(
    shared: State<'_, Shared>,
    title: String,
    step: String,
) -> Result<assistant::GuideCheck, String> {
    let (provider, model) = {
        let s = shared.settings.lock().unwrap();
        let provider = assistant::Provider::from_setting(&s.provider);
        let model = match provider {
            assistant::Provider::Claude => s.model.clone(),
            assistant::Provider::Gemini => s.gemini_model.clone(),
        };
        (provider, model)
    };
    assistant::guide_check(provider, &model, &title, &step).await
}

#[tauri::command]
fn chat_reset(chat: State<Chat>, pending: State<assistant::Pending>) {
    chat.reset();
    // Any card still on screen belongs to a conversation that no longer exists.
    pending.cancel_all();
}

/// Allow / Deny on an assistant action card. Only ever from a click.
#[tauri::command]
fn assistant_confirm(pending: State<assistant::Pending>, id: String, allow: bool) {
    pending.answer_confirm(&id, allow);
}

/// The island page finished one of Coucou's own tools.
#[tauri::command]
fn assistant_tool_result(pending: State<assistant::Pending>, id: String, result: assistant::PageResult) {
    pending.answer_page(&id, result);
}

/// The Gemini models the stored key can use, for the Settings picker.
#[tauri::command]
async fn gemini_models() -> Result<Vec<gemini::ModelInfo>, String> {
    let key = secrets::get("gemini-api-key").ok_or_else(|| "No Gemini key yet.".to_string())?;
    gemini::models(&key).await
}

/// A file dropped on the webview itself, as its contents: the body is the raw
/// bytes and the `x-file-name` header the name, percent-encoded (headers are
/// ASCII only). See platform::allow_webview_drops for why drops arrive this way.
#[tauri::command]
fn ingest_bytes(request: tauri::ipc::Request<'_>) -> Result<DroppedFile, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("No file contents.".into());
    };
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_default();
    files::ingest_bytes(&name, bytes)
}

/// Undoes encodeURIComponent; anything malformed is kept as it was.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The Snip button: Windows' snipping overlay, its result handed back to the
/// island as `snip-ready` (see snip.rs).
#[tauri::command]
fn snip_start(app: AppHandle) -> Result<(), String> {
    snip::start(&app)
}

/// A thumbnail for a dropped picture; `None` for anything else (see files::preview).
#[tauri::command]
async fn file_preview(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || files::preview(&path)).await.ok().flatten()
}

/// A few lines of a file a Claude Code session is working on, for the Home view.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn read_snippet(
    path: String,
    cwd: String,
    needle: Option<String>,
    offset: Option<usize>,
    count: Option<usize>,
    before: Option<usize>,
    after: Option<usize>,
) -> Option<files::Snippet> {
    tauri::async_runtime::spawn_blocking(move || {
        files::snippet(
            &path,
            &cwd,
            needle.as_deref(),
            offset.unwrap_or(1),
            count.unwrap_or(0),
            before.unwrap_or(0),
            after.unwrap_or(0),
        )
    })
    .await
    .ok()
    .flatten()
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

/// A project folder for the Scripts tool; same dialog rules as `pick_file`.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Choose a project folder");
    if let Some(win) = island::window(&app) {
        dialog = dialog.set_parent(&win);
    }
    dialog.pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let path = rx.await.ok().flatten()?;
    path.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

/// "Choose a file…" — the alternative to dragging one onto the island. Never the
/// blocking dialog: the main thread runs the window, so this waits off it and the
/// island keeps drawing while the dialog is up. `None` when the user cancels.
#[tauri::command]
async fn pick_file(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Give Mochi a file");
    // Owned by the island, so the dialog stays above its always-on-top window.
    if let Some(win) = island::window(&app) {
        dialog = dialog.set_parent(&win);
    }
    dialog.pick_file(move |path| {
        let _ = tx.send(path);
    });
    let path = rx.await.ok().flatten()?;
    path.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

/// Skin bundles the user imported (see skins.rs).
#[tauri::command]
fn skins_list() -> Vec<skins::SkinInfo> {
    skins::list()
}

/// "Import skin…": a .zip or a folder, checked in full before anything is kept.
#[tauri::command]
async fn skin_import(app: AppHandle, path: String, keep: bool) -> Result<skins::SkinInfo, String> {
    let info = tauri::async_runtime::spawn_blocking(move || skins::import(&path, keep))
        .await
        .map_err(|e| e.to_string())??;
    // A skin imported over a worn one (same id) has to be drawn again.
    if keep {
        let _ = app.emit("skins-changed", ());
    }
    Ok(info)
}

#[tauri::command]
fn skin_remove(app: AppHandle, id: String) -> Result<(), String> {
    skins::remove(&id)?;
    let _ = app.emit("skins-changed", ());
    Ok(())
}

#[tauri::command]
fn skin_manifest(id: String) -> Result<String, String> {
    skins::manifest(&id)
}

/// One layer picture, as raw bytes (no base64 round trip).
#[tauri::command]
fn skin_layer(id: String, name: String) -> Result<tauri::ipc::Response, String> {
    skins::layer(&id, &name).map(tauri::ipc::Response::new)
}

/// The skin editor's Save: installed (and worn by whoever picks it), or written
/// to `zip_path` to share. Checked exactly like an import either way.
#[tauri::command]
async fn skin_save(
    app: AppHandle,
    files: Vec<(String, String)>,
    zip_path: Option<String>,
) -> Result<skins::SkinInfo, String> {
    let export = zip_path.is_some();
    let info = tauri::async_runtime::spawn_blocking(move || skins::save(files, zip_path.as_deref()))
        .await
        .map_err(|e| e.to_string())??;
    if !export {
        let _ = app.emit("skins-changed", ());
    }
    Ok(info)
}

/// Where to write an exported skin.
#[tauri::command]
async fn pick_skin_zip(app: AppHandle, name: String) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let file: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    app.dialog()
        .file()
        .set_title("Export skin")
        .set_file_name(format!("{}.zip", if file.is_empty() { "skin" } else { &file }))
        .add_filter("Skin bundle", &["zip"])
        .save_file(move |p| {
            let _ = tx.send(p);
        });
    let path = rx.await.ok().flatten()?;
    path.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

/// Opens the skin editor: on a new skin, or on an installed one (`id`).
#[tauri::command]
fn open_skin_editor(app: AppHandle, id: Option<String>) {
    let Some(win) = app.get_webview_window(SKIN_EDITOR_LABEL) else {
        log::line("skin editor window missing");
        return;
    };
    let _ = win.emit("skin-editor-open", id);
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

/// The dialog behind "Import skin…": a zip file, or a folder when `folder`.
#[tauri::command]
async fn pick_skin(app: AppHandle, folder: bool) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let dialog = app.dialog().file().set_title("Import a skin");
    if folder {
        dialog.pick_folder(move |p| {
            let _ = tx.send(p);
        });
    } else {
        dialog.add_filter("Skin bundle", &["zip"]).pick_file(move |p| {
            let _ = tx.send(p);
        });
    }
    let path = rx.await.ok().flatten()?;
    path.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

#[tauri::command]
fn secret_clear(key: String) -> Result<(), String> {
    secrets::clear(&key)
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Settings — Coucou")
        .inner_size(560.0, 680.0)
        .min_inner_size(460.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

// ── Skin editor ───────────────────────────────────────────────────────────────

const SKIN_EDITOR_LABEL: &str = "skin-editor";

/// Like the settings window: created hidden at launch, then only shown and
/// hidden, because a WebView2 window created later comes up blank here.
fn create_skin_editor_window(app: &AppHandle) {
    let url = {
        #[cfg(dev)]
        let dev = app.config().build.dev_url.clone().map(|mut base| {
            base.set_path("/skin-editor.html");
            WebviewUrl::External(base)
        });
        #[cfg(not(dev))]
        let dev: Option<WebviewUrl> = None;
        dev.unwrap_or_else(|| WebviewUrl::App("skin-editor.html".into()))
    };
    match WebviewWindowBuilder::new(app, SKIN_EDITOR_LABEL, url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Skin editor — Coucou")
        // Pictures are dropped onto the page itself (HTML drag and drop).
        .disable_drag_drop_handler()
        .inner_size(1120.0, 740.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("skin editor window failed: {err}")),
    }
}

// ── Guide highlight ───────────────────────────────────────────────────────────

const HIGHLIGHT_LABEL: &str = "highlight";
/// How long a ring stays on screen if nothing clears it first.
const HIGHLIGHT_SECS: u64 = 20;
/// Bumped on every show and clear, so an old timer never hides a newer ring.
static HIGHLIGHT_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A transparent, click-through window the size of the main display, hidden
/// until a guide step asks to point at something. Created at launch for the
/// same reason as the settings window.
fn create_highlight_window(app: &AppHandle) {
    let url = {
        #[cfg(dev)]
        let dev = app.config().build.dev_url.clone().map(|mut base| {
            base.set_path("/highlight.html");
            WebviewUrl::External(base)
        });
        #[cfg(not(dev))]
        let dev: Option<WebviewUrl> = None;
        dev.unwrap_or_else(|| WebviewUrl::App("highlight.html".into()))
    };
    match WebviewWindowBuilder::new(app, HIGHLIGHT_LABEL, url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Coucou highlight")
        .inner_size(400.0, 300.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
    {
        Ok(win) => {
            let _ = win.set_ignore_cursor_events(true);
            platform::make_non_activating(&win);
        }
        Err(err) => log::line(format!("highlight window failed: {err}")),
    }
}

fn clear_highlight(app: &AppHandle) {
    HIGHLIGHT_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if let Some(win) = app.get_webview_window(HIGHLIGHT_LABEL) {
        let _ = app.emit_to(HIGHLIGHT_LABEL, "highlight-clear", ());
        let _ = win.hide();
    }
}

#[derive(serde::Serialize)]
struct Located {
    found: bool,
    /// What the model says it was looking for.
    label: String,
}

/// The guide's "Show me": a screenshot goes to the chosen model, which says where
/// the thing to click is, and a ring is drawn there over the main display.
#[tauri::command]
async fn guide_locate(
    app: AppHandle,
    shared: State<'_, Shared>,
    title: String,
    step: String,
) -> Result<Located, String> {
    let (provider, model) = {
        let s = shared.settings.lock().unwrap();
        let provider = assistant::Provider::from_setting(&s.provider);
        let model = match provider {
            assistant::Provider::Claude => s.model.clone(),
            assistant::Provider::Gemini => s.gemini_model.clone(),
        };
        (provider, model)
    };
    // The ring must not be in the picture, and the old one must not point at a
    // step that has passed. Hiding a window takes a frame to reach the screen.
    let ring_was_up = app
        .get_webview_window(HIGHLIGHT_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    clear_highlight(&app);
    if ring_was_up {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    let Some(((fx, fy, fw, fh), label)) = assistant::guide_locate(provider, &model, &title, &step).await? else {
        return Ok(Located { found: false, label: String::new() });
    };

    let Some(win) = app.get_webview_window(HIGHLIGHT_LABEL) else {
        return Err("The highlight window is missing.".into());
    };
    let Some(monitor) = app.primary_monitor().ok().flatten() else {
        return Err("No display found.".into());
    };
    let scale = monitor.scale_factor();
    let (pos, size) = (*monitor.position(), *monitor.size());
    let _ = win.set_size(tauri::PhysicalSize::new(size.width, size.height));
    let _ = win.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
    let (lw, lh) = (size.width as f64 / scale, size.height as f64 / scale);
    let gen = HIGHLIGHT_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let _ = win.show();
    let _ = win.set_always_on_top(true);
    let _ = app.emit_to(
        HIGHLIGHT_LABEL,
        "highlight",
        serde_json::json!({ "x": fx * lw, "y": fy * lh, "w": fw * lw, "h": fh * lh }),
    );

    let timer = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(HIGHLIGHT_SECS)).await;
        if HIGHLIGHT_GEN.load(std::sync::atomic::Ordering::Relaxed) == gen {
            clear_highlight(&timer);
        }
    });
    Ok(Located { found: true, label })
}

/// Removes the ring (next step, Done, or the guide closing).
#[tauri::command]
fn guide_clear(app: AppHandle) {
    clear_highlight(&app);
}

pub fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

pub fn run() {
    platform::prepare_environment();
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        .plugin(hotkey::plugin())
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .manage(Chat::default())
        .manage(assistant::Pending::default())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_visible,
            can_summon,
            set_hotkey,
            tray_sync,
            repo_status,
            claude_usage,
            set_island_rect,
            focus_window,
            idle_ms,
            reposition,
            open_url,
            open_windows_settings,
            open_in_vscode,
            detect_ide,
            pick_folder,
            listening_ports,
            kill_port_process,
            project_scripts,
            run_script,
            focus_session,
            quit_app,
            hooks_status,
            hooks_preview,
            hooks_apply,
            approval_decision,
            approval_ack,
            approval_decline,
            log_line,
            chat_send,
            chat_reset,
            guide_check,
            guide_locate,
            guide_clear,
            assistant_confirm,
            assistant_tool_result,
            gemini_models,
            ingest_file,
            ingest_bytes,
            snip_start,
            file_preview,
            read_snippet,
            skins_list,
            skin_import,
            skin_remove,
            skin_manifest,
            skin_layer,
            pick_skin,
            skin_save,
            pick_skin_zip,
            open_skin_editor,
            pick_file,
            secret_present,
            secret_set,
            secret_clear,
            refresh_integration,
            open_n8n,
            open_settings_window,
            set_paused,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);
            create_skin_editor_window(&handle);
            create_highlight_window(&handle);

            // The window starts hidden, with the poll parked: Coucou costs nothing
            // until the page summons the island (the launch greeting, an alert,
            // the tray or the hotkey). Sized now so the first show needs no resize.
            if let Some(win) = island::window(&handle) {
                platform::make_non_activating(&win);
                platform::allow_webview_drops(&win);
                island::apply_geometry(&handle, &loaded.screen, &loaded.position);
            }
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Coucou {} started ---", env!("CARGO_PKG_VERSION")));
            if let Err(err) = hotkey::apply(&handle, loaded.hotkey_enabled, &loaded.hotkey_accelerator) {
                log::line(format!("hotkey: {err}"));
            }
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Coucou");
}
