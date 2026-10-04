// The island's assistant: one loop over either provider (Claude or Gemini) that
// lets the model use tools — Coucou's own features, opening things on the PC,
// reading files and the screen, running commands.
//
// Harmless tools run straight away. Anything that opens apps, touches files,
// captures the screen or runs a command is shown to the user verbatim in the chat
// and runs only after an Allow click. Nothing here can approve a Claude Code
// permission: that stays an explicit click on the approval card.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::island::WINDOW_LABEL;
use crate::{claude, gemini, platform, secrets};

/// Tool rounds per message. Enough for "look, then act, then check".
const MAX_ROUNDS: usize = 8;
/// An unanswered confirmation card is a "no".
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);
/// The page answers its own tools instantly; anything longer means it is gone.
const PAGE_TIMEOUT: Duration = Duration::from_secs(10);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_COMMAND_OUTPUT: usize = 8_000;
const MAX_TEXT_FILE: u64 = 200_000;
/// Images and PDFs handed to the model: well under both APIs' inline limits.
const MAX_BINARY_FILE: u64 = 4_000_000;
const MAX_LISTING: usize = 200;
const SCREENSHOT_MAX_W: u32 = 1280;

pub const SYSTEM_PROMPT: &str = "You are Mochi, a personal AI assistant living at the top of the user's screen, inside the Coucou app. \
You can search the web and help with absolutely anything — research, coding, recommendations, tasks, questions. \
You also have tools to act: Coucou's own settings and features, opening links, folders and apps, reading files and folders, taking a screenshot, and running PowerShell commands (sh on Linux). \
Use a tool when the user asks you to do something, not just to talk about it. \
Opening folders or apps, reading files, screenshots and commands are shown to the user, who must click Allow; if they decline, accept it and do not retry the same action. \
For music and video that is already playing or open (pause, resume, skip, previous, volume, mute) call media_control: it presses the media keys, so the page or app that is already open answers and nothing new is opened. To play a particular song or video the user names, call play_music with the title and artist: it finds the first match on YouTube and opens it so it starts by itself. Never call media_control next or run Start-Process to play a song, and never open a Spotify link for it: Spotify cannot be started from here. \
Never claim you did something unless a tool result says it succeeded. Prefer read-only commands, and never run anything destructive the user did not explicitly ask for. Commands start in the user's home folder, which holds their whole profile: never git init, git add or run anything recursive there, and for a project first cd into its folder (ask which one if unsure). \
Whenever the user asks how to do something, or asks for help doing something, on their computer, in an app or on a website (turn on night mode, change a setting, create a Facebook post, find a feature), you MUST call start_guide instead of explaining in the chat or just opening the page. Put the page in start_guide's url or page argument, never in open_url, and keep your reply to one short sentence. Every step names the exact thing to click. Never say a step worked: you cannot see the screen. \
You cannot approve Claude Code's permission requests — the user does that themselves. \
Respond in the user's language. Be thorough but concise. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

/// Longest character persona a skin may add to the system prompt.
const MAX_PERSONA: usize = 8_000;

/// Longest name the user may give for the chat to call them.
const MAX_USER_NAME: usize = 40;

/// Character cards (SillyTavern and friends) write the user as `{{user}}` or
/// `<USER>`. Left as is, the model repeats the placeholder back.
fn fill_user(persona: &str, name: &str) -> String {
    let who = if name.is_empty() { "you" } else { name };
    let mut out = String::with_capacity(persona.len());
    let mut rest = persona;
    while let Some(start) = rest.find(['{', '<']) {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let lower = tail.to_ascii_lowercase();
        let token = ["{{user}}", "<user>"].into_iter().find(|t| lower.starts_with(t));
        match token {
            Some(t) => {
                out.push_str(who);
                rest = &tail[t.len()..];
            }
            None => {
                out.push_str(&tail[..1]);
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The system prompt, with the active skin's persona after it when there is
/// one. The persona changes how Mochi talks, never what it may do: everything
/// above it (tools, Allow cards, never approving Claude Code) still holds.
fn system_prompt(persona: Option<&str>, user_name: &str) -> String {
    let name: String = user_name
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_USER_NAME)
        .collect::<String>()
        .trim()
        .to_string();
    let who = if name.is_empty() {
        "The user hasn't said what to call them: never make up a name for them, and never write a placeholder such as {{user}}.".to_string()
    } else {
        format!("The user's name is {name}.")
    };
    match persona.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => {
            let p: String = fill_user(p, &name).chars().take(MAX_PERSONA).collect();
            format!(
                "{SYSTEM_PROMPT}
{who}

Character: the user chose a character for you. Speak and behave as this character in every reply, while every rule above still applies.
{p}"
            )
        }
        None => format!("{SYSTEM_PROMPT}\n{who}"),
    }
}

// ── Chat state ────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct Chat {
    /// Multi-turn history in the active provider's own format.
    messages: Mutex<Vec<Value>>,
    /// Which provider the history belongs to; switching starts over.
    provider: Mutex<String>,
}

impl Chat {
    pub fn reset(&self) {
        self.messages.lock().unwrap().clear();
    }

    fn adopt(&self, provider: &str) {
        let mut current = self.provider.lock().unwrap();
        if *current != provider {
            *current = provider.to_string();
            self.messages.lock().unwrap().clear();
        }
    }

    fn len(&self) -> usize {
        self.messages.lock().unwrap().len()
    }

    fn push(&self, message: Value) {
        self.messages.lock().unwrap().push(message);
    }

    fn truncate(&self, len: usize) {
        self.messages.lock().unwrap().truncate(len);
    }

    fn snapshot(&self) -> Vec<Value> {
        self.messages.lock().unwrap().clone()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatContext {
    File { name: String, path: String },
    Window { app_name: String, title: String, url: Option<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
    /// What the assistant did on the way, one line each, shown above the reply.
    pub actions: Vec<String>,
}

// ── Tools ─────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Runs {
    /// Coucou's own features live in the island page.
    Page,
    Rust,
}

pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema for the arguments (object / string / number / boolean / enum only,
    /// which both APIs accept). `None` = no arguments.
    pub params: Option<Value>,
    pub confirm: bool,
    pub runs: Runs,
}

/// A tool call from the model, provider-neutral.
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: Value,
}

/// A file handed back to the model alongside a tool's text result.
#[derive(Debug, Clone)]
pub struct Attachment {
    pub mime: &'static str,
    pub data_b64: String,
}

#[derive(Debug, Clone)]
pub struct ToolOutput {
    pub text: String,
    pub is_error: bool,
    pub attachment: Option<Attachment>,
}

impl ToolOutput {
    fn ok(text: impl Into<String>) -> Self {
        Self { text: text.into(), is_error: false, attachment: None }
    }
    fn err(text: impl Into<String>) -> Self {
        Self { text: text.into(), is_error: true, attachment: None }
    }
}

/// What a provider returns for one model call.
pub struct Turn {
    /// The model's message, stored verbatim in the history.
    pub message: Value,
    pub text: String,
    pub calls: Vec<ToolCall>,
    /// Claude's `pause_turn`: a long server-side search wants another round.
    pub paused: bool,
}

/// Splits a server-sent-events byte stream into the `data:` payload of each
/// event. Bytes are buffered until an event is complete, so a UTF-8 character
/// or a JSON object split across network chunks is never cut.
#[derive(Default)]
pub struct SseReader {
    buf: Vec<u8>,
}

impl SseReader {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        // Both "\n\n" and "\r\n\r\n" separate events; drop the CRs once here.
        self.buf.extend(chunk.iter().copied().filter(|&b| b != b'\r'));
        let mut events = Vec::new();
        while let Some(pos) = self.buf.windows(2).position(|w| w == b"\n\n") {
            let raw: Vec<u8> = self.buf.drain(..pos + 2).collect();
            let text = String::from_utf8_lossy(&raw);
            let data: Vec<&str> = text
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(|d| d.strip_prefix(' ').unwrap_or(d))
                .collect();
            if !data.is_empty() {
                events.push(data.join("\n"));
            }
        }
        events
    }
}

/// Receives text as the model writes it.
pub type OnText<'a> = &'a mut (dyn FnMut(&str) + Send);

fn obj(props: Value, required: &[&str]) -> Option<Value> {
    Some(json!({ "type": "object", "properties": props, "required": required }))
}

pub fn tools() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "coucou_status",
            description: "What the coding agents watched by Coucou are doing (Claude Code and others), any pending permission request, whether Coucou is paused, and its sound settings.",
            params: None,
            confirm: false,
            runs: Runs::Page,
        },
        ToolDef {
            name: "set_sound",
            description: "Turn Coucou's sounds on or off and/or set the volume (0-100).",
            params: obj(
                json!({
                    "enabled": { "type": "boolean", "description": "true = sounds on" },
                    "volume": { "type": "number", "description": "0 to 100" }
                }),
                &[],
            ),
            confirm: false,
            runs: Runs::Page,
        },
        ToolDef {
            name: "set_island_edge",
            description: "Choose which screen edge the Coucou island appears from.",
            params: obj(
                json!({ "edge": { "type": "string", "enum": ["top", "bottom"] } }),
                &["edge"],
            ),
            confirm: false,
            runs: Runs::Page,
        },
        ToolDef {
            name: "set_paused",
            description: "Pause or resume Coucou (paused: no alerts, integrations stop polling).",
            params: obj(json!({ "paused": { "type": "boolean" } }), &["paused"]),
            confirm: false,
            runs: Runs::Page,
        },
        ToolDef {
            name: "open_file_picker",
            description: "Open a file dialog so the user can give you a file to work with.",
            params: None,
            confirm: false,
            runs: Runs::Page,
        },
        ToolDef {
            name: "open_settings",
            description: "Open Coucou's settings window.",
            params: None,
            confirm: false,
            runs: Runs::Page,
        },
        ToolDef {
            name: "start_guide",
            description: "Walk the user through a small task on their computer one step at a time: Mochi shows the steps in the island with Back/Next. Use it for 'help me turn on X', 'how do I change Y'. Give 3 to 7 short imperative steps, one action each, using the exact menu names. Optionally open the matching Windows Settings page first.",
            params: obj(
                json!({
                    "title": { "type": "string", "description": "Short title, e.g. Turn on night light" },
                    "steps": { "type": "string", "description": "The steps, one per line, no numbering" },
                    "page": {
                        "type": "string",
                        "enum": crate::SETTINGS_PAGES.iter().map(|(k, _)| *k).collect::<Vec<_>>(),
                        "description": "Windows Settings page to open before step 1, when one fits"
                    },
                    "url": {
                        "type": "string",
                        "description": "http(s) page to open before step 1 for a how-to on a website, e.g. https://www.facebook.com"
                    }
                }),
                &["title", "steps"],
            ),
            confirm: false,
            runs: Runs::Page,
        },
        ToolDef {
            name: "open_integration",
            description: "Open the dashboard of one of Coucou's integrations in the browser (or the Claude Code project in VS Code).",
            params: obj(
                json!({ "integration": { "type": "string", "enum": [
                    "claude", "github", "vercel", "stripe", "resend", "notion", "calcom", "n8n"
                ] } }),
                &["integration"],
            ),
            confirm: false,
            runs: Runs::Page,
        },
        ToolDef {
            name: "open_url",
            description: "Open an http(s) link in the user's default browser.",
            params: obj(json!({ "url": { "type": "string" } }), &["url"]),
            confirm: false,
            runs: Runs::Rust,
        },
        ToolDef {
            name: "open_folder",
            description: "Open a folder in the file manager. Path may start with ~ for the home folder.",
            params: obj(json!({ "path": { "type": "string" } }), &["path"]),
            confirm: true,
            runs: Runs::Rust,
        },
        ToolDef {
            name: "launch_app",
            description: "Launch an application by name (e.g. notepad, chrome, code, calc) or by full path.",
            params: obj(json!({ "app": { "type": "string" } }), &["app"]),
            confirm: true,
            runs: Runs::Rust,
        },
        ToolDef {
            name: "list_folder",
            description: "List the files and folders in a folder. Path may start with ~.",
            params: obj(json!({ "path": { "type": "string" } }), &["path"]),
            confirm: true,
            runs: Runs::Rust,
        },
        ToolDef {
            name: "read_file",
            description: "Read a file: text and code files as text, images and PDFs so you can see them. Path may start with ~.",
            params: obj(json!({ "path": { "type": "string" } }), &["path"]),
            confirm: true,
            runs: Runs::Rust,
        },
        ToolDef {
            name: "screenshot",
            description: "Take a screenshot of the user's main display so you can see what they are looking at.",
            params: None,
            confirm: true,
            runs: Runs::Rust,
        },
        ToolDef {
            name: "media_control",
            description: "Control what is already playing on this computer (a Spotify or YouTube tab in the browser, a music app) with the media keys: play or pause, next, previous, stop, volume up or down (times = how many steps), mute. It never opens anything; it cannot choose a particular song.",
            params: obj(
                json!({
                    "action": { "type": "string", "enum": ["play_pause", "next", "previous", "stop", "volume_up", "volume_down", "mute"] },
                    "times": { "type": "integer", "description": "How many presses for volume (default 1, at most 25); ignored for the others" }
                }),
                &["action"],
            ),
            confirm: false,
            runs: Runs::Rust,
        },
        ToolDef {
            name: "play_music",
            description: "Play a specific song or video the user names: looks it up on YouTube and opens the first match, which starts playing by itself. Give the title and artist, e.g. \"Lot of Me Yuri\". For pause, skip or volume use media_control instead.",
            params: obj(json!({ "query": { "type": "string", "description": "Title and artist" } }), &["query"]),
            confirm: false,
            runs: Runs::Rust,
        },
        ToolDef {
            name: "run_command",
            description: "Run a command on the user's computer: Windows PowerShell 5.1 (chain with ; — it has no && or ||) or sh on Linux. It always starts in the user's HOME folder, never in a project: for anything about a project, cd into that project's folder first, and ask which folder if you do not know it. Never run git init, git add ., or any recursive command over the home folder. 60 second limit, after which the command and everything it started is stopped; returns the output.",
            params: obj(json!({ "command": { "type": "string" } }), &["command"]),
            confirm: true,
            runs: Runs::Rust,
        },
    ]
}

// ── Pending confirmations and page calls ──────────────────────────────────────

#[derive(Default)]
pub struct Pending {
    confirms: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    page: Mutex<HashMap<String, oneshot::Sender<PageResult>>>,
}

#[derive(Debug, Deserialize)]
pub struct PageResult {
    pub ok: bool,
    pub text: String,
}

static COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_id(prefix: &str) -> String {
    format!("{prefix}-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

impl Pending {
    /// The user clicked Allow or Deny on a card.
    pub fn answer_confirm(&self, id: &str, allow: bool) {
        if let Some(tx) = self.confirms.lock().unwrap().remove(id) {
            let _ = tx.send(allow);
        }
    }

    pub fn answer_page(&self, id: &str, result: PageResult) {
        if let Some(tx) = self.page.lock().unwrap().remove(id) {
            let _ = tx.send(result);
        }
    }

    /// The chat was reset: every open card is a "no".
    pub fn cancel_all(&self) {
        self.confirms.lock().unwrap().clear();
        self.page.lock().unwrap().clear();
    }
}

#[derive(Serialize, Clone)]
struct ConfirmRequest {
    id: String,
    title: String,
    detail: String,
}

async fn confirm(app: &AppHandle, title: String, detail: String) -> bool {
    let pending = app.state::<Pending>();
    let id = next_id("confirm");
    let (tx, rx) = oneshot::channel();
    pending.confirms.lock().unwrap().insert(id.clone(), tx);
    let _ = app.emit_to(WINDOW_LABEL, "assistant-confirm", ConfirmRequest { id: id.clone(), title, detail });
    match tokio::time::timeout(CONFIRM_TIMEOUT, rx).await {
        Ok(Ok(allow)) => allow,
        // Dropped (chat reset) or timed out: no.
        _ => {
            pending.confirms.lock().unwrap().remove(&id);
            let _ = app.emit_to(WINDOW_LABEL, "assistant-confirm-expired", id);
            false
        }
    }
}

async fn page_call(app: &AppHandle, call: &ToolCall) -> ToolOutput {
    let pending = app.state::<Pending>();
    let id = next_id("tool");
    let (tx, rx) = oneshot::channel();
    pending.page.lock().unwrap().insert(id.clone(), tx);
    let _ = app.emit_to(
        WINDOW_LABEL,
        "assistant-tool",
        json!({ "id": id, "name": call.name, "args": call.args }),
    );
    match tokio::time::timeout(PAGE_TIMEOUT, rx).await {
        Ok(Ok(r)) if r.ok => ToolOutput::ok(r.text),
        Ok(Ok(r)) => ToolOutput::err(r.text),
        _ => {
            pending.page.lock().unwrap().remove(&id);
            ToolOutput::err("Coucou did not respond.")
        }
    }
}

// ── The loop ──────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Claude,
    Gemini,
}

impl Provider {
    pub fn from_setting(s: &str) -> Self {
        if s == "gemini" { Provider::Gemini } else { Provider::Claude }
    }
    fn key_name(self) -> &'static str {
        match self {
            Provider::Claude => "anthropic-api-key",
            Provider::Gemini => "gemini-api-key",
        }
    }
    fn id(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Gemini => "gemini",
        }
    }
}

/// One user message: call the model, run the tools it asks for, repeat until it
/// answers in plain text or MAX_ROUNDS is reached.
#[allow(clippy::too_many_arguments)]
pub async fn run_turn(
    app: &AppHandle,
    chat: &Chat,
    provider: Provider,
    model: &str,
    query: String,
    context: Option<ChatContext>,
    persona: Option<String>,
    user_name: &str,
) -> Result<ChatReply, String> {
    let system = system_prompt(persona.as_deref(), user_name);
    let key = secrets::get(provider.key_name()).ok_or_else(|| {
        format!("{} API key missing. Open settings.", if provider == Provider::Gemini { "Gemini" } else { "Claude" })
    })?;
    chat.adopt(provider.id());
    // "Automatic" Gemini: if the chosen model turns out to have no quota on this
    // key, it moves on to the next candidate instead of failing.
    let automatic = provider == Provider::Gemini && model.is_empty();
    let mut model = match provider {
        Provider::Gemini if automatic => gemini::default_model(&key).await?,
        _ => model.to_string(),
    };
    let mut fallbacks = 0;
    // A model call that came back with nothing visible gets one more try.
    let mut empty_retries = 0;

    let defs = tools();
    let start = chat.len();
    let first = start == 0;
    chat.push(match provider {
        Provider::Claude => claude::user_message(&query, if first { context.as_ref() } else { None }),
        Provider::Gemini => gemini::user_message(&query, if first { context.as_ref() } else { None }),
    });

    let mut actions = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    for round in 0..MAX_ROUNDS {
        let history = chat.snapshot();
        // Every model call streams into its own bubble; `round` tells the page
        // which bubble a piece of text belongs to.
        let stream_to = app.clone();
        let mut on_text = move |piece: &str| {
            let _ = stream_to.emit_to(WINDOW_LABEL, "assistant-stream", json!({ "round": round, "delta": piece }));
        };
        let turn = match provider {
            Provider::Claude => claude::turn(&key, &model, &system, &history, &defs, &mut on_text).await,
            Provider::Gemini => gemini::turn(&key, &model, automatic, &system, &history, &defs, &mut on_text).await,
        };
        // "Automatic" may have moved to a model that allows Google Search: the
        // next rounds go there too.
        if automatic {
            if let Ok(m) = gemini::default_model(&key).await {
                model = m;
            }
        }
        let turn = match turn {
            Ok(t) => t,
            Err(err) if automatic && fallbacks < 6 && gemini::is_out_of_quota(&err) => {
                crate::log::line(format!("gemini: {model} is out of quota, trying the next model"));
                gemini::mark_unusable(&model);
                model = match gemini::default_model(&key).await {
                    Ok(m) => m,
                    Err(e) => {
                        chat.truncate(start);
                        return Err(e);
                    }
                };
                fallbacks += 1;
                continue;
            }
            Err(err) => {
                // Keep the history consistent with what the model has seen.
                chat.truncate(start);
                return Err(err);
            }
        };
        // Nothing to show and nothing to do: Gemini's lighter models now and
        // then stop on thoughts alone or an empty part. Not stored, so the
        // retry sees the same history; a second blank is reported as before.
        if turn.text.trim().is_empty() && turn.calls.is_empty() && !turn.paused && empty_retries < 1 {
            empty_retries += 1;
            crate::log::line("assistant: empty answer, asking again".to_string());
            continue;
        }
        chat.push(turn.message.clone());
        if !turn.text.trim().is_empty() {
            texts.push(turn.text.trim().to_string());
        }
        if turn.paused {
            continue;
        }
        if turn.calls.is_empty() {
            let text = texts.last().cloned().unwrap_or_default();
            if text.is_empty() && actions.is_empty() {
                chat.truncate(start);
                return Err("No response text.".into());
            }
            return Ok(ChatReply { text, actions });
        }

        let mut results = Vec::new();
        for call in turn.calls {
            let output = execute(app, &defs, &call, &mut actions).await;
            results.push((call, output));
        }
        chat.push(match provider {
            Provider::Claude => claude::tool_results(&results),
            Provider::Gemini => gemini::tool_results(&results),
        });
    }
    Ok(ChatReply {
        text: texts.last().cloned().unwrap_or_else(|| "I stopped after too many steps.".into()),
        actions,
    })
}

/// What "Check my step" found.
#[derive(Serialize)]
pub struct GuideCheck {
    pub done: bool,
    pub hint: String,
}

/// The guide's "Check my step": one screenshot of the main display, sent on its
/// own to the chosen model with the step text, and a verdict back. It runs only
/// from a click on that button, so it needs no Allow card, and it never touches
/// the chat history.
pub async fn guide_check(provider: Provider, model: &str, title: &str, step: &str) -> Result<GuideCheck, String> {
    let query = format!(
        "The user is following a guide called \"{title}\" and says they have just done this step: \"{step}\". \
         Look at the screenshot of their screen. Reply with exactly one line starting with DONE if the screen shows the step was completed, \
         or NOT YET if it does not or you cannot tell. After a dash, add one short sentence: what you see, or what to do next. \
         Plain text, no tools."
    );
    Ok(parse_verdict(&screen_question(provider, model, "check", title, step, &query, GUIDE_SHOT_W_CHECK).await?))
}

// ── What the guide's side questions cost ──────────────────────────────────────
//
// Check and Show me are answered by a lean call (no tool list, no web search, a
// short system prompt, a small output cap), on a mid-size model for Claude, and
// a repeat on a screen that has not changed is answered from memory.

const GUIDE_SYSTEM: &str = "You help a user follow a step-by-step guide by looking at a screenshot of their screen. Answer exactly in the format asked, with no extra text.";
const GUIDE_MAX_OUTPUT: u32 = 1024;
/// Claude's guide questions run here, not on the (often much larger) chat model.
const GUIDE_CLAUDE_MODEL: &str = "claude-sonnet-5-5";
/// Pointing needs detail; judging a screen does not.
const GUIDE_SHOT_W_LOCATE: u32 = 1568;
const GUIDE_SHOT_W_CHECK: u32 = 960;
/// Remembered answers; the oldest are dropped past this.
const GUIDE_CACHE_MAX: usize = 16;
/// A screen is "the same" when at most this share of its coarse cells changed.
const SAME_SCREEN: f64 = 0.04;

struct Remembered {
    key: String,
    cells: Vec<u8>,
    answer: String,
}

static GUIDE_CACHE: Mutex<Vec<Remembered>> = Mutex::new(Vec::new());

/// A coarse picture of the screen (32 columns, 3 bits per channel), small enough
/// to compare and blind to a blinking cursor or a clock.
fn screen_cells(w: u32, h: u32, rgb: &[u8]) -> Vec<u8> {
    let (_, _, small) = downscale(w, h, rgb, 32);
    small.iter().map(|v| v >> 5).collect()
}

fn same_screen(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && !a.is_empty() && (a.iter().zip(b).filter(|(x, y)| x != y).count() as f64) <= a.len() as f64 * SAME_SCREEN
}

/// One screenshot of the main display plus one question, answered by the chosen
/// model on its own: no chat history, no tools. The same question about a screen
/// that has not changed is answered from memory, with no API call.
async fn screen_question(
    provider: Provider,
    model: &str,
    kind: &str,
    title: &str,
    step: &str,
    query: &str,
    max_w: u32,
) -> Result<String, String> {
    let key = secrets::get(provider.key_name()).ok_or_else(|| "API key missing. Open settings.".to_string())?;
    let (w, h, rgb) = tauri::async_runtime::spawn_blocking(platform::screenshot)
        .await
        .map_err(|e| e.to_string())??;

    let cells = screen_cells(w, h, &rgb);
    let cache_key = format!("{kind}|{title}|{step}");
    if let Some(hit) = GUIDE_CACHE
        .lock()
        .unwrap()
        .iter()
        .find(|r| r.key == cache_key && same_screen(&r.cells, &cells))
    {
        return Ok(hit.answer.clone());
    }

    let (w, h, rgb) = downscale(w, h, &rgb, max_w);
    let b64 = claude::base64_for(&encode_png(w, h, &rgb));
    let answer = match provider {
        Provider::Claude => {
            let message = claude::user_message_with_image(query, &b64);
            claude::ask(&key, GUIDE_CLAUDE_MODEL, GUIDE_SYSTEM, &message, GUIDE_MAX_OUTPUT).await?
        }
        Provider::Gemini => {
            let model = if model.is_empty() { gemini::default_model(&key).await? } else { model.to_string() };
            let message = gemini::user_message_with_image(query, &b64);
            gemini::ask(&key, &model, GUIDE_SYSTEM, &message, GUIDE_MAX_OUTPUT).await?
        }
    };

    let mut cache = GUIDE_CACHE.lock().unwrap();
    cache.retain(|r| r.key != cache_key);
    cache.push(Remembered { key: cache_key, cells, answer: answer.clone() });
    if cache.len() > GUIDE_CACHE_MAX {
        cache.remove(0);
    }
    Ok(answer)
}

/// Where the thing to click is, as fractions (0–1) of the main display:
/// left, top, width, height.
pub type Spot = (f64, f64, f64, f64);

/// The guide's "Show me": asks the model where, on a screenshot of the main
/// display, the user has to click or type for this step. Returns the spot and
/// the label the model says it was looking for.
pub async fn guide_locate(
    provider: Provider,
    model: &str,
    title: &str,
    step: &str,
) -> Result<Option<(Spot, String)>, String> {
    let query = format!(
        "Guide: \"{title}\". The user is about to do this step: \"{step}\".\n\
         Find the one element they must click or type in for this step. Name it first, then box it. \
         Reply with JSON only: {{\"label\":\"<its visible text or icon, 2-6 words>\",\"box\":[ymin,xmin,ymax,xmax]}}. \
         Box values run 0 to 1000 (fractions of the screenshot's height and width; 1000 is the far edge). \
         The box must hug that element alone, never a toolbar, a row of buttons or a whole panel. \
         If the step needs no click or typing on this screen (it is already done, or the user only has to wait or look), \
         or the element is not visible, reply {{\"label\":null,\"box\":null}}."
    );
    let text = screen_question(provider, model, "locate", title, step, &query, GUIDE_SHOT_W_LOCATE).await?;
    Ok(parse_spot(&text))
}

fn parse_spot(text: &str) -> Option<(Spot, String)> {
    let (start, end) = (text.find('{')?, text.rfind('}')?);
    let v: Value = serde_json::from_str(text.get(start..=end)?).ok()?;
    let b = v.get("box")?.as_array()?;
    if b.len() != 4 {
        return None;
    }
    let n: Vec<f64> = b.iter().filter_map(Value::as_f64).collect();
    if n.len() != 4 {
        return None;
    }
    let c = |x: f64| x.clamp(0.0, 1000.0) / 1000.0;
    let (y0, x0, y1, x1) = (c(n[0]), c(n[1]), c(n[2]), c(n[3]));
    // An empty or inverted box is no answer, and one covering a sizeable part of
    // the screen is a panel, not the element.
    if y1 <= y0 || x1 <= x0 || (x1 - x0) * (y1 - y0) > 0.25 {
        return None;
    }
    let label = v.get("label").and_then(Value::as_str).unwrap_or("").trim().to_string();
    Some(((x0, y0, x1 - x0, y1 - y0), label))
}

fn parse_verdict(text: &str) -> GuideCheck {
    let line = text.trim().lines().next().unwrap_or("").trim().to_string();
    let upper = line.to_uppercase();
    let done = upper.starts_with("DONE");
    let hint = line
        .split_once(['-', '—', '–'])
        .map(|(_, rest)| rest.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| if done { "Looks done.".into() } else { "I can't tell yet.".into() });
    GuideCheck { done, hint }
}

async fn execute(app: &AppHandle, defs: &[ToolDef], call: &ToolCall, actions: &mut Vec<String>) -> ToolOutput {
    let Some(def) = defs.iter().find(|d| d.name == call.name) else {
        return ToolOutput::err(format!("Unknown tool {}", call.name));
    };
    let (title, detail) = describe(call);
    if def.confirm && !confirm(app, title.clone(), detail.clone()).await {
        note(app, actions, format!("Declined: {title}"));
        return ToolOutput::err("The user declined this action. Do not retry it.");
    }
    let output = match def.runs {
        Runs::Page => page_call(app, call).await,
        Runs::Rust => {
            let call = call.clone();
            tauri::async_runtime::spawn_blocking(move || run_rust_tool(&call))
                .await
                .unwrap_or_else(|e| ToolOutput::err(e.to_string()))
        }
    };
    let line = if detail.is_empty() { title } else { format!("{title}: {}", short(&detail, 80)) };
    note(app, actions, if output.is_error { format!("{line} (failed)") } else { line });
    output
}

/// A step the assistant took: shown in the chat the moment it happens, and
/// kept for the reply.
fn note(app: &AppHandle, actions: &mut Vec<String>, line: String) {
    let _ = app.emit_to(WINDOW_LABEL, "assistant-action", line.clone());
    actions.push(line);
}

fn arg<'a>(call: &'a ToolCall, name: &str) -> &'a str {
    call.args.get(name).and_then(Value::as_str).unwrap_or("")
}

/// The card's title and the exact thing being authorised.
fn describe(call: &ToolCall) -> (String, String) {
    match call.name.as_str() {
        "open_folder" => ("Open folder".into(), arg(call, "path").into()),
        "launch_app" => ("Launch app".into(), arg(call, "app").into()),
        "list_folder" => ("List folder".into(), arg(call, "path").into()),
        "read_file" => ("Read file".into(), arg(call, "path").into()),
        "screenshot" => ("Take a screenshot".into(), String::new()),
        "run_command" => ("Run command".into(), arg(call, "command").into()),
        "media_control" => ("Media".into(), arg(call, "action").replace('_', " ")),
        "play_music" => ("Play".into(), arg(call, "query").into()),
        "open_url" => ("Opened".into(), arg(call, "url").into()),
        "start_guide" => ("Guide".into(), arg(call, "title").into()),
        other => (other.replace('_', " "), String::new()),
    }
}

fn short(s: &str, n: usize) -> String {
    let s = s.lines().next().unwrap_or("");
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n).collect::<String>()) }
}

// ── Rust-side tools ───────────────────────────────────────────────────────────

fn resolve_path(raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("No path given.".into());
    }
    let home = platform::home_dir();
    let path = if raw == "~" {
        home
    } else if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        home.join(rest)
    } else {
        let p = PathBuf::from(raw);
        if p.is_absolute() { p } else { home.join(p) }
    };
    Ok(path)
}

fn run_rust_tool(call: &ToolCall) -> ToolOutput {
    let result = match call.name.as_str() {
        "open_url" => open_url(arg(call, "url")),
        "open_folder" => open_folder(arg(call, "path")),
        "launch_app" => platform::launch_app(arg(call, "app").trim()).map(|_| ToolOutput::ok("Launched.")),
        "list_folder" => list_folder(arg(call, "path")),
        "read_file" => read_file(arg(call, "path")),
        "screenshot" => screenshot(),
        "run_command" => run_command(arg(call, "command")),
        "media_control" => media_control(call),
        "play_music" => play_music(arg(call, "query")),
        other => Err(format!("Unknown tool {other}")),
    };
    result.unwrap_or_else(ToolOutput::err)
}

/// The first ordinary video in a YouTube results page: its `videoRenderer`
/// (Shorts, ads and playlists use other renderers).
fn first_video_id(html: &str) -> Option<String> {
    const MARK: &str = "\"videoRenderer\":{\"videoId\":\"";
    let rest = &html[html.find(MARK)? + MARK.len()..];
    let id: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
    (id.len() == 11).then_some(id)
}

/// Looks the song up on YouTube (a plain web request, no account) and opens the
/// first match; `watch?v=` pages start playing by themselves.
fn play_music(query: &str) -> Result<ToolOutput, String> {
    let query: String = query.chars().filter(|c| !c.is_control()).take(120).collect();
    let query = query.trim();
    if query.is_empty() {
        return Err("No song given.".into());
    }
    let encoded: String = query
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    let url = format!("https://www.youtube.com/results?search_query={encoded}");
    let html = tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(12))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
            .build()
            .map_err(|e| e.to_string())?;
        client
            .get(&url)
            .header("Accept-Language", "en-US,en;q=0.9")
            // Skips the cookie-consent page some regions get instead of results.
            .header("Cookie", "CONSENT=YES+1")
            .send()
            .await
            .map_err(|e| format!("Couldn't reach YouTube: {e}"))?
            .text()
            .await
            .map_err(|e| e.to_string())
    })?;
    let id = first_video_id(&html).ok_or("YouTube returned no video for that.")?;
    platform::open_url(&format!("https://www.youtube.com/watch?v={id}"));
    Ok(ToolOutput::ok(format!("Opened the first YouTube result for \"{query}\"; it starts playing by itself.")))
}

fn media_control(call: &ToolCall) -> Result<ToolOutput, String> {
    let action = arg(call, "action");
    let times = call.args.get("times").and_then(Value::as_u64).unwrap_or(1).min(25) as u32;
    platform::media_key(action, times)?;
    Ok(ToolOutput::ok(format!("Sent \"{}\" to whatever is playing.", action.replace('_', " "))))
}

fn open_url(url: &str) -> Result<ToolOutput, String> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http and https links can be opened.".into());
    }
    platform::open_url(url);
    Ok(ToolOutput::ok("Opened in the browser."))
}

fn open_folder(raw: &str) -> Result<ToolOutput, String> {
    let path = resolve_path(raw)?;
    if !path.is_dir() {
        return Err(format!("{} is not a folder.", path.display()));
    }
    platform::reveal_folder(&path.to_string_lossy());
    Ok(ToolOutput::ok(format!("Opened {}", path.display())))
}

fn list_folder(raw: &str) -> Result<ToolOutput, String> {
    let path = resolve_path(raw)?;
    let entries = std::fs::read_dir(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut lines = Vec::new();
    let mut total = 0usize;
    for entry in entries.flatten() {
        total += 1;
        if lines.len() >= MAX_LISTING {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        match entry.metadata() {
            Ok(m) if m.is_dir() => lines.push(format!("{name}/")),
            Ok(m) => lines.push(format!("{name}  ({} bytes)", m.len())),
            Err(_) => lines.push(name),
        }
    }
    lines.sort_by_key(|l| l.to_lowercase());
    let mut text = format!("{} ({total} entries)\n{}", path.display(), lines.join("\n"));
    if total > MAX_LISTING {
        text.push_str(&format!("\n… and {} more", total - MAX_LISTING));
    }
    Ok(ToolOutput::ok(text))
}

fn binary_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    Some(match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

fn read_file(raw: &str) -> Result<ToolOutput, String> {
    let path = resolve_path(raw)?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.is_dir() {
        return Err(format!("{} is a folder; use list_folder.", path.display()));
    }
    if let Some(mime) = binary_mime(&path) {
        if meta.len() > MAX_BINARY_FILE {
            return Err(format!("{} is too large to read ({} bytes).", path.display(), meta.len()));
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        return Ok(ToolOutput {
            text: format!("Attached {} ({mime}).", path.display()),
            is_error: false,
            attachment: Some(Attachment { mime, data_b64: claude::base64_for(&bytes) }),
        });
    }
    if meta.len() > MAX_TEXT_FILE {
        return Err(format!("{} is too large to read ({} bytes).", path.display(), meta.len()));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let text = String::from_utf8(bytes).map_err(|_| format!("{} is not a text file.", path.display()))?;
    Ok(ToolOutput::ok(text))
}

fn screenshot() -> Result<ToolOutput, String> {
    let (w, h, rgb) = platform::screenshot()?;
    let (w, h, rgb) = downscale(w, h, &rgb, SCREENSHOT_MAX_W);
    let png = encode_png(w, h, &rgb);
    Ok(ToolOutput {
        text: format!("Screenshot of the main display ({w}×{h})."),
        is_error: false,
        attachment: Some(Attachment { mime: "image/png", data_b64: claude::base64_for(&png) }),
    })
}

fn run_command(command: &str) -> Result<ToolOutput, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("No command given.".into());
    }
    let mut cmd = platform::shell_command(command);
    cmd.current_dir(platform::home_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = platform::no_console(&mut cmd).spawn().map_err(|e| format!("Could not start: {e}"))?;

    // Drain both pipes on their own threads so a chatty command can't block on a
    // full pipe while we wait for it.
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut s = Vec::new();
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_end(&mut s);
        }
        s
    });
    let err_t = std::thread::spawn(move || {
        let mut s = Vec::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_end(&mut s);
        }
        s
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() > COMMAND_TIMEOUT => {
                // The whole tree: the shell's children must not outlive the limit.
                platform::kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let stdout = String::from_utf8_lossy(&out_t.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_t.join().unwrap_or_default()).into_owned();

    let mut text = String::new();
    match status {
        Some(s) => text.push_str(&format!("Exit code: {}\n", s.code().map_or("none".into(), |c| c.to_string()))),
        None => text.push_str("Stopped after 60 seconds.\n"),
    }
    if !stdout.trim().is_empty() {
        text.push_str(&format!("Output:\n{}\n", stdout.trim_end()));
    }
    if !stderr.trim().is_empty() {
        text.push_str(&format!("Errors:\n{}\n", stderr.trim_end()));
    }
    if text.chars().count() > MAX_COMMAND_OUTPUT {
        text = text.chars().take(MAX_COMMAND_OUTPUT).collect::<String>() + "\n… (output truncated)";
    }
    let failed = status.map_or(true, |s| !s.success());
    Ok(ToolOutput { text, is_error: failed, attachment: None })
}

// ── Screenshot helpers: downscale + a dependency-free PNG encoder ─────────────

/// Box-filter downscale of packed RGB to at most `max_w` wide.
fn downscale(w: u32, h: u32, rgb: &[u8], max_w: u32) -> (u32, u32, Vec<u8>) {
    if w <= max_w {
        return (w, h, rgb.to_vec());
    }
    let nw = max_w;
    let nh = ((h as u64 * nw as u64) / w as u64).max(1) as u32;
    let mut out = vec![0u8; (nw * nh * 3) as usize];
    for y in 0..nh {
        let y0 = y * h / nh;
        let y1 = ((y + 1) * h / nh).max(y0 + 1);
        for x in 0..nw {
            let x0 = x * w / nw;
            let x1 = ((x + 1) * w / nw).max(x0 + 1);
            let mut acc = [0u32; 3];
            let mut n = 0u32;
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let i = ((sy * w + sx) * 3) as usize;
                    acc[0] += rgb[i] as u32;
                    acc[1] += rgb[i + 1] as u32;
                    acc[2] += rgb[i + 2] as u32;
                    n += 1;
                }
            }
            let o = ((y * nw + x) * 3) as usize;
            for c in 0..3 {
                out[o + c] = (acc[c] / n) as u8;
            }
        }
    }
    (nw, nh, out)
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for chunk in data.chunks(5552) {
        for &x in chunk {
            a += x as u32;
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    (b << 16) | a
}

/// RGB8 → PNG with uncompressed ("stored") deflate blocks. Bigger than a real
/// encoder's output, but correct, tiny, and a 1280-wide capture stays well
/// within what both APIs accept.
pub(crate) fn encode_png(w: u32, h: u32, rgb: &[u8]) -> Vec<u8> {
    let row = (w * 3) as usize;
    let mut raw = Vec::with_capacity((row + 1) * h as usize);
    for y in 0..h as usize {
        raw.push(0); // filter: none
        raw.extend_from_slice(&rgb[y * row..(y + 1) * row]);
    }

    let mut z = vec![0x78, 0x01];
    let mut blocks = raw.chunks(65_535).peekable();
    if blocks.peek().is_none() {
        z.extend_from_slice(&[1, 0, 0, 0xFF, 0xFF]);
    }
    while let Some(block) = blocks.next() {
        z.push(if blocks.peek().is_none() { 1 } else { 0 });
        let len = block.len() as u16;
        z.extend_from_slice(&len.to_le_bytes());
        z.extend_from_slice(&(!len).to_le_bytes());
        z.extend_from_slice(block);
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());

    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let start = out.len();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let crc = crc32(&out[start..]);
        out.extend_from_slice(&crc.to_be_bytes());
    }

    let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]); // 8-bit, truecolour, deflate, no filter, no interlace
    chunk(&mut png, b"IHDR", &ihdr);
    chunk(&mut png, b"IDAT", &z);
    chunk(&mut png, b"IEND", &[]);
    png
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn character_cards_get_the_users_name_or_none() {
        let card = "Hello {{user}}! <USER>, {{User}}... {{char}} {not} <b>";
        assert_eq!(fill_user(card, "Bin"), "Hello Bin! Bin, Bin... {{char}} {not} <b>");
        assert_eq!(fill_user(card, ""), "Hello you! you, you... {{char}} {not} <b>");
        let named = system_prompt(Some("Hi {{user}}"), "  Bin  ");
        assert!(named.contains("The user's name is Bin.") && named.ends_with("Hi Bin"));
        let unnamed = system_prompt(Some("Hi {{user}}"), "");
        assert!(unnamed.contains("never make up a name") && unnamed.ends_with("Hi you"));
        assert!(system_prompt(None, "Bin").ends_with("The user's name is Bin."));
    }

    #[test]
    fn sse_reader_reassembles_events_split_across_chunks() {
        let mut r = SseReader::default();
        assert!(r.push(b"event: x\r\ndata: {\"a\":").is_empty());
        let out = r.push(b"1}\r\n\r\ndata: \xC3");
        assert_eq!(out, vec!["{\"a\":1}".to_string()]);
        // A UTF-8 character split across chunks survives.
        assert_eq!(r.push(b"\xA9\n\n"), vec!["é".to_string()]);
    }

    #[test]
    fn crc_and_adler_match_known_values() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
    }

    #[test]
    fn png_has_valid_structure() {
        let png = encode_png(2, 1, &[255, 0, 0, 0, 255, 0]);
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
        // IHDR CRC covers type + data.
        let crc = u32::from_be_bytes(png[29..33].try_into().unwrap());
        assert_eq!(crc, crc32(&png[12..29]));
    }

    #[test]
    fn downscale_keeps_aspect_and_averages() {
        let rgb = vec![10u8; 4 * 2 * 3];
        let (w, h, out) = downscale(4, 2, &rgb, 2);
        assert_eq!((w, h), (2, 1));
        assert!(out.iter().all(|&v| v == 10));
    }

    #[test]
    fn every_tool_has_an_object_schema_or_none() {
        for t in tools() {
            if let Some(p) = &t.params {
                assert_eq!(p["type"], "object", "{}", t.name);
            }
        }
    }

    #[test]
    fn verdict_is_read_from_the_first_line() {
        let v = parse_verdict("DONE - Night light shows as on.\nextra");
        assert!(v.done);
        assert_eq!(v.hint, "Night light shows as on.");
        let v = parse_verdict("NOT YET — the toggle is still off");
        assert!(!v.done);
        assert_eq!(v.hint, "the toggle is still off");
        assert!(!parse_verdict("").done);
    }

    #[test]
    fn spot_is_read_from_json_and_bad_boxes_are_refused() {
        let (s, label) = parse_spot("```json\n{\"label\":\"Post box\",\"box\":[100,200,150,400]}\n```").unwrap();
        assert!((s.0 - 0.2).abs() < 1e-9 && (s.1 - 0.1).abs() < 1e-9);
        assert!((s.2 - 0.2).abs() < 1e-9 && (s.3 - 0.05).abs() < 1e-9);
        assert_eq!(label, "Post box");
        assert!(parse_spot("{\"label\":null,\"box\":null}").is_none());
        assert!(parse_spot("{\"box\":[10,10,10,50]}").is_none());
        assert!(parse_spot("{\"box\":[0,0,1000,1000]}").is_none());
        // A panel-sized box (here 60% of the screen) is not an element.
        assert!(parse_spot("{\"box\":[100,100,700,900]}").is_none());
        assert!(parse_spot("no idea").is_none());
    }

    #[test]
    fn an_unchanged_screen_is_recognised_and_a_changed_one_is_not() {
        let a = vec![3u8; 200];
        let mut tiny = a.clone();
        tiny[0] = 4;
        let mut big = a.clone();
        big[..40].iter_mut().for_each(|v| *v = 7);
        assert!(same_screen(&a, &tiny));
        assert!(!same_screen(&a, &big));
        assert!(!same_screen(&a, &a[..100]));
        assert!(!same_screen(&[], &[]));
    }

    #[test]
    fn finds_the_first_ordinary_video_in_search_results() {
        let page = r#"..."reelItem":{"videoId":"SHORTSSHORT"}..."videoRenderer":{"videoId":"abcDEF_-123","thumbnail":{}}..."videoRenderer":{"videoId":"zzzzzzzzzzz"}"#;
        assert_eq!(first_video_id(page).as_deref(), Some("abcDEF_-123"));
        assert_eq!(first_video_id("no results here"), None);
        assert_eq!(first_video_id(r#""videoRenderer":{"videoId":"short"}"#), None);
    }

    #[test]
    fn risky_tools_need_confirmation() {
        for t in tools() {
            let risky = matches!(
                t.name,
                "open_folder" | "launch_app" | "list_folder" | "read_file" | "screenshot" | "run_command"
            );
            assert_eq!(t.confirm, risky, "{}", t.name);
        }
    }
}
