// One chat loop over any provider (Claude, Gemini or DeepSeek): call the model, run
// the tools it asks for, repeat until it answers in plain text. The tools are
// the tutor's bookkeeping (see tutor.rs) — nothing here touches the PC.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::{claude, deepseek, gemini, secrets};

/// Tool rounds per message: log progress, maybe assess, then answer.
const MAX_ROUNDS: usize = 6;

// ── Chat state ────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct Chat {
    /// Multi-turn history in the active provider's own format.
    messages: Mutex<Vec<Value>>,
    /// Which provider the history belongs to; switching starts over.
    provider: Mutex<String>,
    /// How much of the history a session recap already covers.
    recapped: Mutex<usize>,
}

impl Chat {
    pub fn reset(&self) {
        self.messages.lock().unwrap().clear();
        *self.recapped.lock().unwrap() = 0;
    }

    /// The messages no recap has covered yet; they count as covered from now on.
    pub fn take_unrecapped(&self) -> Vec<Value> {
        let messages = self.messages.lock().unwrap();
        let mut recapped = self.recapped.lock().unwrap();
        let from = (*recapped).min(messages.len());
        *recapped = messages.len();
        messages[from..].to_vec()
    }

    fn adopt(&self, provider: &str) {
        let mut current = self.provider.lock().unwrap();
        if *current != provider {
            *current = provider.to_string();
            self.reset();
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

/// Extra context sent with a first message. Kept for the providers' message
/// builders; Kotoba sends none today.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[allow(dead_code)]
pub enum ChatContext {
    File { name: String, path: String },
    Window { app_name: String, title: String, url: Option<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
}

// ── Tools ─────────────────────────────────────────────────────────────────────

pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema for the arguments (object / string / number / boolean / enum /
    /// array only, which both APIs accept). `None` = no arguments.
    pub params: Option<Value>,
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
    pub fn ok(text: impl Into<String>) -> Self {
        Self { text: text.into(), is_error: false, attachment: None }
    }
    pub fn err(text: impl Into<String>) -> Self {
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

pub fn obj(props: Value, required: &[&str]) -> Option<Value> {
    Some(json!({ "type": "object", "properties": props, "required": required }))
}

// ── The loop ──────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Claude,
    Gemini,
    DeepSeek,
}

impl Provider {
    pub fn from_setting(s: &str) -> Self {
        match s {
            "gemini" => Provider::Gemini,
            "deepseek" => Provider::DeepSeek,
            _ => Provider::Claude,
        }
    }
    fn key_name(self) -> &'static str {
        match self {
            Provider::Claude => "anthropic-api-key",
            Provider::Gemini => "gemini-api-key",
            Provider::DeepSeek => "deepseek-api-key",
        }
    }
    fn id(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Gemini => "gemini",
            Provider::DeepSeek => "deepseek",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Gemini => "Gemini",
            Provider::DeepSeek => "DeepSeek",
        }
    }
}

/// Where a turn's text streams to: the window and the chat it belongs to.
pub struct Stream<'a> {
    pub window: &'a str,
    pub chat: &'a str,
}

/// One user message: call the model, run the tools it asks for, repeat until it
/// answers in plain text or MAX_ROUNDS is reached. `exec` runs a tool call;
/// tools here are bookkeeping, so they run without asking.
#[allow(clippy::too_many_arguments)]
pub async fn run_turn(
    app: &AppHandle,
    chat: &Chat,
    provider: Provider,
    model: &str,
    system: &str,
    defs: &[ToolDef],
    query: String,
    stream: Stream<'_>,
    exec: &(dyn Fn(&ToolCall) -> ToolOutput + Sync),
) -> Result<ChatReply, String> {
    let key = secrets::get(provider.key_name())
        .ok_or_else(|| format!("{} API key missing. Open Settings.", provider.label()))?;
    chat.adopt(provider.id());
    // "Automatic" Gemini: if the chosen model turns out to have no quota on this
    // key, it moves on to the next candidate instead of failing.
    let automatic = provider == Provider::Gemini && model.is_empty();
    let mut model = match provider {
        Provider::Gemini if automatic => gemini::default_model(&key).await?,
        Provider::DeepSeek if model.is_empty() => deepseek::default_model(&key).await?,
        _ => model.to_string(),
    };
    let mut fallbacks = 0;
    // A model call that came back with nothing visible gets one more try.
    let mut empty_retries = 0;

    let start = chat.len();
    chat.push(match provider {
        Provider::Claude => claude::user_message(&query, None),
        Provider::Gemini => gemini::user_message(&query, None),
        Provider::DeepSeek => deepseek::user_message(&query),
    });

    let mut texts: Vec<String> = Vec::new();
    for round in 0..MAX_ROUNDS {
        let history = chat.snapshot();
        // Every model call streams into its own part of the reply; `round` tells
        // the page which part a piece of text belongs to.
        let stream_to = app.clone();
        let (window, chat_id) = (stream.window.to_string(), stream.chat.to_string());
        let mut on_text = move |piece: &str| {
            let _ = stream_to.emit_to(
                window.as_str(),
                "assistant-stream",
                json!({ "chat": chat_id, "round": round, "delta": piece }),
            );
        };
        let turn = match provider {
            Provider::Claude => claude::turn(&key, &model, system, &history, defs, &mut on_text).await,
            Provider::Gemini => gemini::turn(&key, &model, automatic, system, &history, defs, &mut on_text).await,
            Provider::DeepSeek => deepseek::turn(&key, &model, system, &history, defs, &mut on_text).await,
        };
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
            if texts.is_empty() {
                chat.truncate(start);
                return Err("No response text.".into());
            }
            // The model may write before and after its bookkeeping: all of it is the reply.
            return Ok(ChatReply { text: texts.join("\n") });
        }

        let results: Vec<(ToolCall, ToolOutput)> = turn
            .calls
            .into_iter()
            .map(|call| {
                let output = exec(&call);
                (call, output)
            })
            .collect();
        match provider {
            Provider::Claude => chat.push(claude::tool_results(&results)),
            Provider::Gemini => chat.push(gemini::tool_results(&results)),
            // One `tool` message per call, not one message for the round.
            Provider::DeepSeek => deepseek::tool_results(&results).into_iter().for_each(|m| chat.push(m)),
        }
    }
    if texts.is_empty() {
        chat.truncate(start);
        return Err("I got lost in my notes. Try again?".into());
    }
    Ok(ChatReply { text: texts.join("\n") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_reader_reassembles_events_split_across_chunks() {
        let mut r = SseReader::default();
        assert!(r.push(b"event: x\r\ndata: {\"a\":").is_empty());
        let out = r.push(b"1}\r\n\r\ndata: \xC3");
        assert_eq!(out, vec!["{\"a\":1}".to_string()]);
        // A UTF-8 character split across chunks survives.
        assert_eq!(r.push(b"\xA9\n\n"), vec!["é".to_string()]);
    }
}
