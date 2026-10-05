// Kotoba — app wiring and the commands the pages call.
//
// Two surfaces: the study window (conversation + stats), and Mochi's island, a
// summoned overlay for quick questions and the daily nudge.

mod assistant;
mod claude;
mod fishaudio;
mod gemini;
mod hotkey;
mod island;
mod learner;
mod log;
mod platform;
mod secrets;
mod settings;
mod skins;
mod tray;
mod tutor;

use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use assistant::{Chat, ChatReply};
use island::{PollGate, ScreenInfo};
use learner::Learner;
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

/// What Kotoba knows about the learner, and when they last wrote (for study minutes).
pub struct Progress {
    learner: Mutex<Learner>,
    last_message: Mutex<Option<Instant>>,
}

/// The study conversation and the island's quick questions keep separate histories.
#[derive(Default)]
pub struct Chats {
    study: Chat,
    quick: Chat,
    lookup: Chat,
}

impl Chats {
    fn get(&self, which: &str) -> &Chat {
        match which {
            "quick" => &self.quick,
            "lookup" => &self.lookup,
            _ => &self.study,
        }
    }
}

/// A gap longer than this between two messages isn't counted as study time.
const MAX_GAP_MINUTES: f64 = 3.0;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let settings = shared.settings.lock().unwrap().clone();
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo { settings, screen, version: env!("CARGO_PKG_VERSION").to_string(), cursor_poll: platform::CURSOR_POLL }
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
        log::line(format!("could not save settings: {err}"));
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            log::line(format!("autostart: {err}"));
        }
    }
    if screen_changed || position_changed {
        island::apply_geometry(&app, &settings.screen, &settings.position);
    }
    // Keep every window in step (island ⇄ study ⇄ settings).
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
    lookup: String,
) -> Result<Settings, String> {
    let accelerator = accelerator.trim().to_string();
    let lookup = lookup.trim().to_string();
    let (old_enabled, old_accel, old_lookup) = {
        let s = shared.settings.lock().unwrap();
        (s.hotkey_enabled, s.hotkey_accelerator.clone(), s.hotkey_lookup.clone())
    };
    hotkey::replace(&app, (old_enabled, &old_accel, &old_lookup), (enabled, &accelerator, &lookup))?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hotkey_enabled = enabled;
        current.hotkey_accelerator = accelerator;
        current.hotkey_lookup = lookup;
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated.clone());
    Ok(updated)
}

/// The island page reports what the tray should say; see tray::sync.
#[tauri::command]
fn tray_sync(app: AppHandle, status: String, visible: bool) {
    tray::sync(&app, &status, visible);
}

/// May the island summon itself right now (the daily nudge)? Not over a
/// full-screen app or a presentation.
#[tauri::command]
fn can_summon() -> bool {
    !platform::fullscreen_active()
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
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

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ── Tutor ─────────────────────────────────────────────────────────────────────

/// One message to Mochi. `which` is "study" (the study window's conversation)
/// or "quick" (the island). `today` is the learner's local date, YYYY-MM-DD.
#[tauri::command]
async fn chat_send(
    app: AppHandle,
    shared: State<'_, Shared>,
    progress: State<'_, Progress>,
    chats: State<'_, Chats>,
    which: String,
    query: String,
    scenario: Option<String>,
    today: String,
) -> Result<ChatReply, String> {
    if learner::day_number(&today).is_none() {
        return Err("Bad date.".into());
    }
    let (provider, model, prefs) = {
        let s = shared.settings.lock().unwrap();
        let provider = assistant::Provider::from_setting(&s.provider);
        let model = match provider {
            assistant::Provider::Claude => s.model.clone(),
            assistant::Provider::Gemini => s.gemini_model.clone(),
        };
        (provider, model, tutor::Prefs { english: s.english_support.clone(), user_name: s.user_name.clone() })
    };
    // A lookup is not a conversation: it neither counts as study minutes nor
    // remembers earlier lookups.
    if which == "lookup" {
        chats.lookup.reset();
    }

    // Study time: the gap since the previous message, capped.
    if which != "lookup" {
        let now = Instant::now();
        let mut last = progress.last_message.lock().unwrap();
        let minutes = last.map(|t| now.duration_since(t).as_secs_f64() / 60.0).unwrap_or(0.5).min(MAX_GAP_MINUTES);
        *last = Some(now);
        let mut l = progress.learner.lock().unwrap();
        l.message(minutes, &today);
    }

    let system = {
        let l = progress.learner.lock().unwrap();
        let mode = match which.as_str() {
            "quick" => tutor::Mode::Quick,
            "lookup" => tutor::Mode::Lookup,
            _ => tutor::Mode::Study { scenario: scenario.as_deref().unwrap_or("free") },
        };
        tutor::system_prompt(mode, &l, &prefs)
    };
    // A lookup only explains: it logs nothing, so it gets no tools.
    let defs = if which == "lookup" { Vec::new() } else { tutor::tools() };
    let exec = |call: &assistant::ToolCall| {
        let mut l = progress.learner.lock().unwrap();
        tutor::apply(&mut l, call, &today)
    };
    // Every conversation streams to the island page (the study panel lives in it);
    // each listener keeps only its own `chat`.
    let window = island::WINDOW_LABEL;
    let result = assistant::run_turn(
        &app,
        chats.get(&which),
        provider,
        &model,
        &system,
        &defs,
        query,
        assistant::Stream { window, chat: &which },
        &exec,
    )
    .await;

    let snapshot = progress.learner.lock().unwrap().clone();
    if let Err(err) = learner::save(&snapshot) {
        log::line(format!("could not save learner: {err}"));
    }
    let _ = app.emit("learner-changed", ());
    result
}

#[tauri::command]
fn chat_reset(chats: State<Chats>, which: String) {
    chats.get(&which).reset();
}

#[tauri::command]
fn learner_stats(progress: State<Progress>, today: String) -> Result<learner::Stats, String> {
    if learner::day_number(&today).is_none() {
        return Err("Bad date.".into());
    }
    Ok(progress.learner.lock().unwrap().stats(&today))
}

/// Persists the learner after a change made outside a chat turn, and tells the pages.
fn persist(app: &AppHandle, progress: &Progress) {
    let snapshot = progress.learner.lock().unwrap().clone();
    if let Err(err) = learner::save(&snapshot) {
        log::line(format!("could not save learner: {err}"));
    }
    let _ = app.emit("learner-changed", ());
}

/// The cards to review today, most overdue first.
#[tauri::command]
fn review_queue(progress: State<Progress>, today: String, limit: usize) -> Result<Vec<learner::Card>, String> {
    if learner::day_number(&today).is_none() {
        return Err("Bad date.".into());
    }
    Ok(progress.learner.lock().unwrap().due_words(&today, limit.clamp(1, 50)))
}

/// One card graded: again, hard, good or easy.
#[tauri::command]
fn review_grade(app: AppHandle, progress: State<Progress>, word: String, grade: String, today: String) -> Result<(), String> {
    if learner::day_number(&today).is_none() {
        return Err("Bad date.".into());
    }
    if !progress.learner.lock().unwrap().review(&word, &grade, &today) {
        return Err("Unknown card or grade.".into());
    }
    persist(&app, &progress);
    Ok(())
}

/// "Add to reviews" from a lookup. False when the word was already known.
#[tauri::command]
fn learner_add_word(
    app: AppHandle,
    progress: State<Progress>,
    word: String,
    reading: String,
    meaning: String,
    today: String,
) -> Result<bool, String> {
    if learner::day_number(&today).is_none() || word.trim().is_empty() || word.chars().count() > 40 {
        return Err("Bad word.".into());
    }
    let added = progress.learner.lock().unwrap().add_word(&word, &reading, &meaning, &today);
    persist(&app, &progress);
    Ok(added)
}

/// A shadowing attempt, scored by the page (0..1), for the Progress view.
#[tauri::command]
fn speaking_log(app: AppHandle, progress: State<Progress>, score: f64, today: String) -> Result<(), String> {
    if learner::day_number(&today).is_none() {
        return Err("Bad date.".into());
    }
    progress.learner.lock().unwrap().log_speaking(score, &today);
    persist(&app, &progress);
    Ok(())
}

/// What was said in a recording (raw bytes in the body, the MIME type in `x-mime`).
#[tauri::command]
async fn speech_transcribe(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("No recording.".into());
    };
    let mime = request
        .headers()
        .get("x-mime")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/webm")
        .to_string();
    fishaudio::transcribe(bytes, &mime, "ja").await
}

/// The Gemini models the stored key can use, for the Settings picker.
#[tauri::command]
async fn gemini_models() -> Result<Vec<gemini::ModelInfo>, String> {
    let key = secrets::get("gemini-api-key").ok_or_else(|| "No Gemini key yet.".to_string())?;
    gemini::models(&key).await
}

// ── Voice ─────────────────────────────────────────────────────────────────────

/// MP3 bytes for a Japanese line, as a raw response (no base64 round trip).
/// `voice` overrides the chosen voice, for the Settings preview.
#[tauri::command]
async fn tts_speak(
    shared: State<'_, Shared>,
    text: String,
    voice: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let (chosen, model, speed) = {
        let s = shared.settings.lock().unwrap();
        (s.tts_voice.clone(), s.tts_model.clone(), s.tts_speed)
    };
    let voice = voice.unwrap_or(chosen);
    fishaudio::tts(&text, &voice, &model, speed).await.map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn fish_voices(mine: bool) -> Result<Vec<fishaudio::Voice>, String> {
    fishaudio::voices(mine).await
}

// ── Skins ─────────────────────────────────────────────────────────────────────

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
async fn skin_save(app: AppHandle, files: Vec<(String, String)>, zip_path: Option<String>) -> Result<skins::SkinInfo, String> {
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

// ── Secrets ───────────────────────────────────────────────────────────────────

/// Pages may only ask whether a key exists — never read it.
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

/// Lets the pages write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Windows ───────────────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so other windows need the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn page_url(app: &AppHandle, page: &str) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path(&format!("/{page}"));
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App(page.into())
}

/// Every secondary window is created hidden at launch and only ever shown and
/// hidden afterwards: a WebView2 window created later silently comes up blank in
/// this app, so the windows that work are the ones that exist before the
/// island's webview does. Closing one only hides it.
fn create_window(app: &AppHandle, label: &str, page: &str, title: &str, size: (f64, f64), min: (f64, f64), drops: bool) {
    let mut builder = WebviewWindowBuilder::new(app, label, page_url(app, page))
        .additional_browser_args(BROWSER_ARGS)
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(min.0, min.1)
        .resizable(true)
        .visible(false)
        .center();
    if !drops {
        builder = builder.disable_drag_drop_handler();
    }
    match builder.build() {
        Ok(win) => {
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("{label} window failed: {err}")),
    }
}

const SKIN_EDITOR_LABEL: &str = "skin-editor";

fn show_window(app: &AppHandle, label: &str) -> bool {
    let Some(win) = app.get_webview_window(label) else {
        log::line(format!("{label} window missing"));
        return false;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    true
}

pub fn show_settings_window(app: &AppHandle) {
    show_window(app, "settings");
}

/// Opens the study panel: it is a view of the island, so the island page is
/// told (optionally which tab: "chat", "review", "stats", or "ask:<text>").
pub fn show_study_window(app: &AppHandle, view: Option<String>) {
    let _ = app.emit_to(island::WINDOW_LABEL, "study-open", view.unwrap_or_else(|| "chat".into()));
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

#[tauri::command]
fn open_study_window(app: AppHandle, view: Option<String>) {
    show_study_window(&app, view);
}

pub fn run() {
    platform::prepare_environment();
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_study_window(app, None);
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        .plugin(hotkey::plugin())
        .manage(Shared { settings: Mutex::new(loaded.clone()), gate: gate.clone() })
        .manage(Progress { learner: Mutex::new(learner::load()), last_message: Mutex::new(None) })
        .manage(Chats::default())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_visible,
            can_summon,
            set_hotkey,
            tray_sync,
            set_island_rect,
            focus_window,
            idle_ms,
            reposition,
            open_url,
            quit_app,
            log_line,
            chat_send,
            chat_reset,
            learner_stats,
            review_queue,
            review_grade,
            learner_add_word,
            speech_transcribe,
            speaking_log,
            gemini_models,
            tts_speak,
            fish_voices,
            skins_list,
            skin_import,
            skin_remove,
            skin_manifest,
            skin_layer,
            pick_skin,
            skin_save,
            pick_skin_zip,
            open_skin_editor,
            secret_present,
            secret_set,
            secret_clear,
            open_settings_window,
            open_study_window,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_window.
            create_window(&handle, "settings", "settings.html", "Settings — Kotoba", (560.0, 680.0), (460.0, 480.0), true);
            create_window(&handle, SKIN_EDITOR_LABEL, "skin-editor.html", "Skin editor — Kotoba", (1120.0, 740.0), (900.0, 600.0), false);

            // The island starts hidden, with the poll parked: it costs nothing
            // until the page summons it (the greeting, the nudge, the tray or the
            // hotkey). Sized now so the first show needs no resize.
            if let Some(win) = island::window(&handle) {
                platform::make_non_activating(&win);
                island::apply_geometry(&handle, &loaded.screen, &loaded.position);
            }
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Kotoba {} started ---", env!("CARGO_PKG_VERSION")));
            if let Err(err) = hotkey::apply(&handle, loaded.hotkey_enabled, &loaded.hotkey_accelerator, &loaded.hotkey_lookup) {
                log::line(format!("hotkey: {err}"));
            }
            // The island page opens the study panel itself once it has loaded.
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Kotoba");
}
