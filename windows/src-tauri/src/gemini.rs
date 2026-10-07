// Gemini API client — the same chat as claude.rs, on Google's generateContent
// endpoint, with the assistant's tools as function declarations and Google
// Search grounding.
//
// Only called when the user picked Gemini in Settings and stored their own key;
// the key never leaves the Credential Manager / Secret Service.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};

use crate::assistant::{ChatContext, OnText, SseReader, ToolCall, ToolDef, ToolOutput, Turn};
use crate::claude::base64_for;

const BASE: &str = "https://generativelanguage.googleapis.com/v1beta";
/// Gemini's thinking models count their thoughts against this budget too.
const MAX_OUTPUT_TOKENS: u32 = 8192;
const MAX_INLINE_TEXT: u64 = 200_000;
const MAX_INLINE_BINARY: u64 = 4_000_000;

/// Some models refuse Google Search next to function declarations. Learned on
/// the first refusal and remembered for the session.
static SEARCH_WITH_TOOLS: AtomicBool = AtomicBool::new(true);
/// The model picked when the user has not chosen one, resolved once.
static DEFAULT_MODEL: Mutex<Option<String>> = Mutex::new(None);

pub fn user_message(query: &str, context: Option<&ChatContext>) -> Value {
    let mut parts: Vec<Value> = Vec::new();
    match context {
        Some(ChatContext::File { name, path }) => {
            if let Some(part) = file_part(path) {
                parts.push(part);
            }
            parts.push(json!({ "text": format!("File: {name}") }));
        }
        Some(ChatContext::Window { app_name, title, url }) => {
            let mut text = format!("Context — App: {app_name}, Window: {title}");
            if let Some(url) = url {
                text.push_str(&format!(", URL: {url}"));
            }
            parts.push(json!({ "text": text }));
        }
        None => {}
    }
    parts.push(json!({ "text": query }));
    json!({ "role": "user", "parts": parts })
}

fn declarations(defs: &[ToolDef]) -> Vec<Value> {
    defs.iter()
        .map(|d| {
            let mut decl = json!({ "name": d.name, "description": d.description });
            // A no-argument function simply has no `parameters`: an empty object
            // schema is rejected.
            if let Some(p) = &d.params {
                decl["parameters"] = p.clone();
            }
            decl
        })
        .collect()
}

/// Said last in the instructions when Google Search is off, so the model (and
/// any character it plays) doesn't promise a search it cannot run.
const NO_SEARCH: &str = "Web search is NOT available right now: this Gemini key doesn't include Google Search. \
If the user asks you to search or look something up online, say so plainly in one short sentence (in character if you play one), \
suggest switching the tutor to Claude in Kotoba's settings for web search, and answer from what you already know when you can. \
Never say you are searching, never ask the user to wait for results.";

fn body(system: &str, history: &[Value], defs: &[ToolDef], with_search: bool) -> Value {
    // An empty list of function declarations is rejected, so a tool-less call omits it.
    let mut tools = if defs.is_empty() { vec![] } else { vec![json!({ "functionDeclarations": declarations(defs) })] };
    let system = if with_search {
        system.to_string()
    } else {
        format!("{system}\n\n{NO_SEARCH}")
    };
    if with_search {
        tools.push(json!({ "googleSearch": {} }));
    }
    let mut body = json!({
        "systemInstruction": { "parts": [{ "text": system }] },
        "contents": history,
        "generationConfig": { "maxOutputTokens": MAX_OUTPUT_TOKENS },
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    body
}

/// Most other models tried with Google Search after the chosen one refuses it.
const SEARCH_PROBES: usize = 5;

fn stream_url(model: &str) -> String {
    format!("{BASE}/models/{model}:streamGenerateContent?alt=sse")
}

/// The order to try other models in for Google Search: the 2.5 family first
/// (Google documents a free daily allowance of search for it), then the rest
/// as "Automatic" ranks them. Models already refused are left out.
fn search_order(candidates: Vec<String>, refused: &[String]) -> Vec<String> {
    let (mut first, rest): (Vec<String>, Vec<String>) = candidates
        .into_iter()
        .filter(|m| !refused.contains(m))
        .partition(|m| m.starts_with("gemini-2.5-"));
    first.extend(rest);
    first
}

/// Google Search was refused on `model`: tries the same request, with search,
/// on the other models the key can use. The first one that takes it becomes
/// "Automatic"'s model for the session, so search keeps working.
async fn search_elsewhere(
    key: &str,
    model: &str,
    body: &Value,
) -> Option<(String, reqwest::Response)> {
    let list = models(key).await.ok()?;
    let unusable = UNUSABLE.lock().unwrap().clone();
    let refused: Vec<String> = [unusable, vec![model.to_string()]].concat();
    for other in search_order(automatic_candidates(&list), &refused).into_iter().take(SEARCH_PROBES) {
        match post(key, &stream_url(&other), body).await {
            Ok(response) => return Some((other, response)),
            Err(err) => crate::log::line(format!("gemini: Google Search refused on {other} too ({})", short_err(&err))),
        }
    }
    None
}

/// One model call, streamed: text reaches `on_text` as Gemini writes it.
/// `automatic`: the model is Coucou's pick, so it may switch to one that allows
/// Google Search (the switch is read back through `default_model`).
pub async fn turn(
    key: &str,
    model: &str,
    automatic: bool,
    system: &str,
    history: &[Value],
    defs: &[ToolDef],
    on_text: OnText<'_>,
) -> Result<Turn, String> {
    let url = stream_url(model);
    let search = SEARCH_WITH_TOOLS.load(Ordering::Relaxed);
    let mut response = match post(key, &url, &body(system, history, defs, search)).await {
        // Google Search isn't allowed on every model a key can use: on some, a
        // free key gets the whole request refused as "quota exceeded" (429), and
        // some models reject search next to function declarations (400). Try it
        // on the other models first; only if none takes it, drop search for the
        // rest of the session and retry without.
        Err(err) if search && is_search_refusal(&err) => {
            crate::log::line(format!("gemini: Google Search refused on {model} ({})", short_err(&err)));
            let elsewhere = if automatic {
                search_elsewhere(key, model, &body(system, history, defs, true)).await
            } else {
                None
            };
            match elsewhere {
                Some((other, response)) => {
                    crate::log::line(format!("gemini: Google Search works on {other}; using it from now on"));
                    *DEFAULT_MODEL.lock().unwrap() = Some(other);
                    response
                }
                None => {
                    crate::log::line("gemini: no model takes Google Search on this key; continuing without search".to_string());
                    SEARCH_WITH_TOOLS.store(false, Ordering::Relaxed);
                    post(key, &url, &body(system, history, defs, false)).await?
                }
            }
        }
        other => other?,
    };

    // Each event is a partial response carrying the next parts of the answer.
    // They are kept exactly as they come — thought signatures included.
    let mut parts: Vec<Value> = Vec::new();
    let mut finish = String::new();
    let mut sse = SseReader::default();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Network error: {e}"))? {
        for data in sse.push(&chunk) {
            let Ok(event) = serde_json::from_str::<Value>(&data) else { continue };
            if let Some(err) = event.get("error") {
                let msg = err.get("message").and_then(Value::as_str).unwrap_or("stream error");
                return Err(format!("Gemini API: {msg}"));
            }
            if let Some(reason) = event
                .get("promptFeedback")
                .and_then(|f| f.get("blockReason"))
                .and_then(Value::as_str)
            {
                return Err(format!("Gemini blocked this request ({reason})."));
            }
            let Some(candidate) = event.get("candidates").and_then(|c| c.get(0)) else { continue };
            if let Some(r) = candidate.get("finishReason").and_then(Value::as_str) {
                finish = r.to_string();
            }
            for part in candidate
                .get("content")
                .and_then(|c| c.get("parts"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if part.get("thought").and_then(Value::as_bool) != Some(true) {
                    if let Some(t) = part.get("text").and_then(Value::as_str) {
                        on_text(t);
                    }
                }
                parts.push(part.clone());
            }
        }
    }
    if parts.is_empty() {
        let reason = if finish.is_empty() { "no content" } else { finish.as_str() };
        return Err(format!("Gemini returned nothing ({reason})."));
    }
    let content = json!({ "role": "model", "parts": parts.clone() });

    let text = parts
        .iter()
        // Thought summaries are not part of the answer.
        .filter(|p| p.get("thought").and_then(Value::as_bool) != Some(true))
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");

    let calls: Vec<ToolCall> = parts
        .iter()
        .filter_map(|p| p.get("functionCall"))
        .enumerate()
        .map(|(i, f)| ToolCall {
            id: f.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("call-{i}")),
            name: f.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
            args: f.get("args").cloned().unwrap_or_else(|| json!({})),
        })
        .collect();

    if text.trim().is_empty() && calls.is_empty() {
        // Nothing the user can see: say why in the log (thoughts only, an empty
        // text part, a safety stop…). The caller decides whether to ask again.
        let kinds: Vec<&str> = parts
            .iter()
            .map(|p| {
                if p.get("thought").and_then(Value::as_bool) == Some(true) {
                    "thought"
                } else if p.get("text").is_some() {
                    "empty text"
                } else {
                    "other"
                }
            })
            .collect();
        crate::log::line(format!("gemini {model}: no visible answer (finish={finish}, parts={kinds:?})"));
    }
    // Stored verbatim: thought signatures must go back exactly as they came.
    Ok(Turn { message: content, text, calls, paused: false })
}

/// Every function response for one round, in one user turn, followed by any
/// files the tools produced (a screenshot, an image or PDF that was read).
pub fn tool_results(results: &[(ToolCall, ToolOutput)]) -> Value {
    let mut parts = Vec::new();
    for (call, out) in results {
        let key = if out.is_error { "error" } else { "result" };
        let mut response = json!({ "name": call.name, "response": { key: out.text } });
        if !call.id.starts_with("call-") {
            response["id"] = json!(call.id);
        }
        parts.push(json!({ "functionResponse": response }));
    }
    for (_, out) in results {
        if let Some(a) = &out.attachment {
            parts.push(json!({ "inlineData": { "mimeType": a.mime, "data": a.data_b64 } }));
        }
    }
    json!({ "role": "user", "parts": parts })
}

fn file_part(path: &str) -> Option<Value> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "pdf" => Some("application/pdf"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    };
    let len = std::fs::metadata(path).ok()?.len();
    if let Some(mime) = mime {
        if len > MAX_INLINE_BINARY {
            return None;
        }
        let bytes = std::fs::read(path).ok()?;
        return Some(json!({ "inlineData": { "mimeType": mime, "data": base64_for(&bytes) } }));
    }
    if len > MAX_INLINE_TEXT {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(json!({ "text": format!("File contents:\n{text}") }))
}

// ── Models ────────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}

/// The chat models this key can use, from the live list — nothing hardcoded.
pub async fn models(key: &str) -> Result<Vec<ModelInfo>, String> {
    let url = format!("{BASE}/models?pageSize=1000");
    let v = get(key, &url).await?;
    let mut out: Vec<ModelInfo> = v
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|m| {
            m.get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .is_some_and(|a| a.iter().any(|x| x == "generateContent"))
        })
        .filter_map(|m| {
            let id = m.get("name")?.as_str()?.trim_start_matches("models/").to_string();
            let lower = id.to_lowercase();
            if !lower.starts_with("gemini") || ["tts", "embedding", "image", "audio"].iter().any(|w| lower.contains(w)) {
                return None;
            }
            let label = m.get("displayName").and_then(Value::as_str).unwrap_or(&id).to_string();
            Some(ModelInfo { id, label })
        })
        .collect();
    out.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(out)
}

/// Models "Automatic" found it may not use (a free tier with a quota of 0).
static UNUSABLE: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// `gemini-2.5-flash` → Some(2.5). Only the plain, stable naming counts: no
/// `-lite`, `-preview`, dated or specialised variants, which is what keeps an
/// odd model (one with no free quota, say) from winning by name.
fn stable_version(id: &str, family: &str) -> Option<f64> {
    let parts: Vec<&str> = id.split('-').collect();
    match parts.as_slice() {
        ["gemini", v, f] if *f == family => v.parse::<f64>().ok(),
        _ => None,
    }
}

/// Every model "Automatic" may try, best first. Flash-Lite leads: on the free
/// tier it allows hundreds of requests a day where Flash allows about twenty,
/// and one assistant message can take several requests (one per tool round).
/// Then the newest stable Flash, the `gemini-flash-latest` alias, then any
/// other Flash.
fn automatic_candidates(list: &[ModelInfo]) -> Vec<String> {
    let mut ranked: Vec<(u8, f64, String)> = Vec::new();
    for m in list {
        let id = &m.id;
        let rank = if let Some(v) = id
            .strip_suffix("-lite")
            .and_then(|base| stable_version(base, "flash"))
        {
            (0, v)
        } else if let Some(v) = stable_version(id, "flash") {
            (1, v)
        } else if id == "gemini-flash-latest" {
            (2, 0.0)
        } else if id.contains("flash") && !id.contains("preview") && !id.contains("exp") {
            (3, 0.0)
        } else {
            continue;
        };
        ranked.push((rank.0, rank.1, id.clone()));
    }
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.total_cmp(&a.1)).then(a.2.cmp(&b.2)));
    ranked.into_iter().map(|r| r.2).collect()
}

/// The model "Automatic" uses: the best candidate not yet found unusable.
pub async fn default_model(key: &str) -> Result<String, String> {
    if let Some(m) = DEFAULT_MODEL.lock().unwrap().clone() {
        return Ok(m);
    }
    let list = models(key).await?;
    let unusable = UNUSABLE.lock().unwrap().clone();
    let candidates = automatic_candidates(&list);
    crate::log::line(format!(
        "gemini automatic: {} models listed; candidates {:?}; skipping {:?}",
        list.len(),
        candidates,
        unusable
    ));
    let pick = candidates
        .into_iter()
        .find(|id| !unusable.contains(id))
        .ok_or_else(|| {
            "None of the Gemini Flash models has free quota on this key. Pick a model in Settings → Gemini, or enable billing in Google AI Studio.".to_string()
        })?;
    *DEFAULT_MODEL.lock().unwrap() = Some(pick.clone());
    Ok(pick)
}

/// "Automatic" hit a model with zero quota: never pick it again this session.
pub fn mark_unusable(model: &str) {
    UNUSABLE.lock().unwrap().push(model.to_string());
    *DEFAULT_MODEL.lock().unwrap() = None;
}

/// An error that waiting a minute won't fix for this model: no quota for it
/// (limit 0, or none at all), today's quota used up, or the model retired.
/// "Automatic" moves on to the next model; a per-minute limit is just reported.
pub fn is_out_of_quota(err: &str) -> bool {
    err.starts_with(ZERO_QUOTA)
        || err.starts_with(DAILY_QUOTA)
        || err.starts_with(NO_ACCESS)
        || err.starts_with(RETIRED)
}

/// A refusal that may be about the Google Search tool rather than the model.
fn is_search_refusal(err: &str) -> bool {
    err.starts_with(NO_ACCESS)
        || err.starts_with(ZERO_QUOTA)
        || (err.starts_with("Gemini API 400") && err.to_lowercase().contains("tool"))
}

fn short_err(err: &str) -> String {
    err.chars().take(60).collect()
}

const NO_ACCESS: &str = "Google gives this key no quota";
const RETIRED: &str = "This Gemini model is no longer available";

const ZERO_QUOTA: &str = "This Gemini model has no free quota";
const DAILY_QUOTA: &str = "Today's free Gemini quota is used up";

/// "…, limit: 20, model: gemini-3.8-flash" → "gemini-3.8-flash".
fn quota_model(detail: &str) -> String {
    detail
        .rsplit("model: ")
        .next()
        .filter(|_| detail.contains("model: "))
        .map(|s| s.split(|c: char| c.is_whitespace() || c == ',').next().unwrap_or("").to_string())
        .unwrap_or_default()
}

// ── Speech to text ────────────────────────────────────────────────────────────

const TRANSCRIBE_PROMPT: &str = "Transcribe exactly what the speaker says, in the language they speak \
(Vietnamese, English or Japanese, possibly mixed). Write Japanese in normal kanji and kana. Output only \
the transcript, with no comments or quotes. If there is no intelligible speech, output nothing.";

/// What was said in a short recording (WAV), through the user's Gemini key:
/// voice chat's "the AI gets the words" step, with no Fish Audio credit needed.
pub async fn transcribe(key: &str, audio: &[u8], mime: &str) -> Result<String, String> {
    if audio.is_empty() {
        return Err("The recording is empty.".into());
    }
    if audio.len() as u64 > MAX_INLINE_BINARY {
        return Err("That recording is too long. Keep it to a sentence or two.".into());
    }
    let body = json!({
        "contents": [{ "role": "user", "parts": [
            { "text": TRANSCRIBE_PROMPT },
            { "inlineData": { "mimeType": mime, "data": base64_for(audio) } },
        ]}],
        "generationConfig": { "temperature": 0.0, "maxOutputTokens": 1024 },
    });
    // Hearing is where the lite models slip, so the full Flash goes first and Flash-Lite is the
    // fallback; a busy (503) or out-of-quota model just moves on to the next one.
    let list = models(key).await?;
    let mut order = automatic_candidates(&list);
    order.sort_by_key(|id| id.ends_with("-lite"));
    let mut last = "No Gemini model is available for listening.".to_string();
    for model in order.into_iter().take(4) {
        let url = format!("{BASE}/models/{model}:generateContent");
        let result = match post(key, &url, &body).await {
            Ok(response) => parse(response, &url).await,
            Err(e) => Err(e),
        };
        match result {
            Ok(v) => {
                let text = v
                    .pointer("/candidates/0/content/parts")
                    .and_then(Value::as_array)
                    .map(|parts| parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<String>())
                    .unwrap_or_default();
                return Ok(text.trim().to_string());
            }
            Err(e) if e.contains("503") || e.contains("overloaded") || e.contains("unavailable") || is_out_of_quota(&e) => {
                last = e;
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            }
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

fn client() -> Result<reqwest::Client, String> {
    // No overall timeout: a long answer streams for as long as it takes. The
    // connection must come up promptly and never go silent for long.
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())
}

/// Sends a streaming request; on success hands back the response to read
/// events from, on failure the same explained error as any other call.
async fn post(key: &str, url: &str, body: &Value) -> Result<reqwest::Response, String> {
    let response = client()?
        .post(url)
        .header("x-goog-api-key", key)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| {
            crate::log::line(format!("gemini {} network error: {e}", endpoint(url)));
            format!("Network error: {e}")
        })?;
    if response.status().is_success() {
        crate::log::line(format!("gemini {} -> {}", endpoint(url), response.status().as_u16()));
        return Ok(response);
    }
    // Not a success, so parse() logs it and turns it into the explained error.
    Err(parse(response, url).await.err().unwrap_or_else(|| "Unexpected API response.".into()))
}

async fn get(key: &str, url: &str) -> Result<Value, String> {
    let response = client()?
        .get(url)
        .header("x-goog-api-key", key)
        .send()
        .await
        .map_err(|e| {
            crate::log::line(format!("gemini {} network error: {e}", endpoint(url)));
            format!("Network error: {e}")
        })?;
    parse(response, url).await
}

/// "…/v1beta/models/gemini-3.1-flash-lite:generateContent" → "models/gemini-3.1-flash-lite:generateContent".
/// The key travels in a header, never in the URL, so this is safe to log.
fn endpoint(url: &str) -> &str {
    url.strip_prefix(BASE).unwrap_or(url).trim_start_matches('/')
}

async fn parse(response: reqwest::Response, url: &str) -> Result<Value, String> {
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    // What Gemini answered, for the log: status always, and on failure its own
    // error JSON (quota ids, model, reason). Never the request, never the key.
    if status.is_success() {
        crate::log::line(format!("gemini {} -> {}", endpoint(url), status.as_u16()));
    } else {
        let compact: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let compact: String = compact.chars().take(2000).collect();
        crate::log::line(format!("gemini {} -> {} {compact}", endpoint(url), status.as_u16()));
    }
    if !status.is_success() {
        // Surface the API's own message, which is what makes a bad key obvious.
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error")?.get("message")?.as_str().map(str::to_string))
            .unwrap_or_else(|| text.chars().take(200).collect());
        // Quota errors are a paragraph of metric names: say what they mean.
        if status.as_u16() == 429 {
            let model = quota_model(&detail);
            let which = if model.is_empty() { String::new() } else { format!(" ({model})") };
            if detail.contains("limit: 0") {
                return Err(format!(
                    "{ZERO_QUOTA}{which} on your plan. Pick another model in Settings → Gemini, or enable billing in Google AI Studio."
                ));
            }
            // The quota id ("…PerDay…") is in the error details, not the message.
            if text.contains("PerDay") {
                return Err(format!(
                    "{DAILY_QUOTA}{which}. Pick a Flash-Lite model in Settings → Gemini (they allow far more requests a day), or try again tomorrow."
                ));
            }
            // No QuotaFailure details at all: Google is not naming a limit that
            // was hit, it is refusing this key any quota for this model. Waiting
            // will not help.
            if !text.contains("QuotaFailure") {
                let model = url
                    .rsplit("/models/")
                    .next()
                    .and_then(|s| s.split(':').next())
                    .unwrap_or("this model");
                return Err(format!(
                    "{NO_ACCESS} for {model}. Set Settings → Gemini → Model to Automatic or a Flash-Lite model. If every model says this, the key's Google project has no free Gemini access (check ai.dev/rate-limit)."
                ));
            }
            return Err(format!("Gemini's per-minute limit was reached{which}. Wait a minute and try again."));
        }
        if status.as_u16() == 404 && detail.contains("no longer available") {
            return Err(format!("{RETIRED} to new users. Pick another model in Settings → Gemini."));
        }
        let short: String = detail.chars().take(300).collect();
        return Err(format!("Gemini API {}: {short}", status.as_u16()));
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad API response: {e}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn search_is_tried_on_2_5_models_first_and_never_on_refused_ones() {
        let c = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let order = super::search_order(
            c(&["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-3.8-flash", "gemini-2.5-flash", "gemini-flash-latest"]),
            &c(&["gemini-3.5-flash-lite"]),
        );
        assert_eq!(order, c(&["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.1-flash-lite", "gemini-3.8-flash", "gemini-flash-latest"]));
    }

    #[test]
    fn without_search_the_model_is_told_so() {
        let defs = [ToolDef { name: "log_progress", description: "x", params: None }];
        let on = super::body("SYS", &[], &defs, true);
        let off = super::body("SYS", &[], &defs, false);
        // A call without tools (a lookup) sends no tools key at all.
        assert!(super::body("SYS", &[], &[], false).get("tools").is_none());
        let text = |b: &serde_json::Value| b["systemInstruction"]["parts"][0]["text"].as_str().unwrap().to_string();
        assert_eq!(text(&on), "SYS");
        assert!(text(&off).starts_with("SYS") && text(&off).contains("NOT available"));
        assert_eq!(on["tools"].as_array().unwrap().len(), 2);
        assert_eq!(off["tools"].as_array().unwrap().len(), 1);
    }

    use super::*;
    use crate::assistant::ToolDef;

    #[test]
    fn automatic_prefers_flash_lite_then_newest_stable_flash() {
        let list: Vec<ModelInfo> = [
            "gemini-omni-1.1-flash",
            "gemini-2.5-flash",
            "gemini-3.8-flash",
            "gemini-3-flash-preview",
            "gemini-2.5-flash-lite",
            "gemini-3.1-flash-lite",
            "gemini-flash-latest",
            "gemini-2.5-pro",
        ]
        .iter()
        .map(|id| ModelInfo { id: id.to_string(), label: id.to_string() })
        .collect();
        assert_eq!(
            automatic_candidates(&list),
            vec![
                "gemini-3.1-flash-lite",
                "gemini-2.5-flash-lite",
                "gemini-3.8-flash",
                "gemini-2.5-flash",
                "gemini-flash-latest",
                "gemini-omni-1.1-flash",
            ]
        );
    }

    #[test]
    fn quota_errors_name_the_model() {
        let detail = "Quota exceeded for metric: x, limit: 20, model: gemini-3.8-flash\nPlease retry in 3s.";
        assert_eq!(quota_model(detail), "gemini-3.8-flash");
        assert_eq!(quota_model("no model here"), "");
    }

    #[test]
    fn declarations_omit_parameters_for_no_arg_tools() {
        let defs = [
            ToolDef { name: "bare", description: "no args", params: None },
            ToolDef { name: "log_progress", description: "x", params: crate::assistant::obj(json!({}), &[]) },
        ];
        let decls = declarations(&defs);
        assert!(decls[0].get("parameters").is_none());
        assert_eq!(decls[1]["parameters"]["type"], "object");
    }

    #[test]
    fn tool_results_put_files_after_responses() {
        let call = ToolCall { id: "call-0".into(), name: "screenshot".into(), args: json!({}) };
        let out = ToolOutput {
            text: "ok".into(),
            is_error: false,
            attachment: Some(crate::assistant::Attachment { mime: "image/png", data_b64: "AAAA".into() }),
        };
        let msg = tool_results(&[(call, out)]);
        let parts = msg["parts"].as_array().unwrap();
        assert!(parts[0].get("functionResponse").is_some());
        assert!(parts[0]["functionResponse"].get("id").is_none());
        assert_eq!(parts[1]["inlineData"]["mimeType"], "image/png");
    }
}
