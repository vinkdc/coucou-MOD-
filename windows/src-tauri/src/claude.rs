// Claude API client — the same integration as ClaudeService.swift: multi-turn
// chat with web search, and files sent as document/image/text blocks — plus the
// assistant's tools (see assistant.rs), sent as custom tools next to web search.
//
// Everything happens here rather than in the island: the API key never leaves
// the Credential Manager, and file bytes never cross the IPC boundary.

use serde_json::{json, Value};

use crate::assistant::{ChatContext, OnText, SseReader, ToolCall, ToolDef, ToolOutput, Turn};

const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Server-side fallback: on a policy decline the API retries the same request on
/// a fallback model inside the same call, so the island never shows a dead end.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MAX_TOKENS: u32 = 4096;
/// Text and code files are inlined; anything larger is skipped, as on macOS.
const MAX_INLINE_TEXT: u64 = 200_000;

pub const DEFAULT_MODEL: &str = "claude-opus-5";

/// The user's message. File / window context rides along with the first
/// message only, exactly like ClaudeService.chat().
pub fn user_message(query: &str, context: Option<&ChatContext>) -> Value {
    let mut content: Vec<Value> = Vec::new();
    match context {
        Some(ChatContext::File { name, path }) => {
            if let Some(block) = file_block(path) {
                content.push(block);
            }
            content.push(json!({ "type": "text", "text": format!("File: {name}") }));
        }
        Some(ChatContext::Window { app_name, title, url }) => {
            let mut text = format!("Context — App: {app_name}, Window: {title}");
            if let Some(url) = url {
                text.push_str(&format!(", URL: {url}"));
            }
            content.push(json!({ "type": "text", "text": text }));
        }
        None => {}
    }
    content.push(json!({ "type": "text", "text": query }));
    json!({ "role": "user", "content": content })
}

/// A user message carrying one PNG, for the guide's "Check my step".
pub fn user_message_with_image(query: &str, png_b64: &str) -> Value {
    json!({ "role": "user", "content": [
        { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": png_b64 } },
        { "type": "text", "text": query },
    ] })
}

/// A lean, non-streaming one-shot: no tools, no web search, a short system
/// prompt and a small output cap. For small side questions (the guide), where
/// the chat's full tool list would cost more than the question itself.
pub async fn ask(key: &str, model: &str, system: &str, message: &Value, max_tokens: u32) -> Result<String, String> {
    let body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "fallbacks": "default",
        "messages": [message],
    });
    let reply: Value = call(key, &body)
        .await?
        .json()
        .await
        .map_err(|e| format!("Unexpected API response: {e}"))?;
    let text = reply
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        return Err("Unexpected API response.".into());
    }
    Ok(text)
}

fn tool_specs(defs: &[ToolDef]) -> Vec<Value> {
    let mut specs = vec![json!({ "type": "web_search_20260209", "name": "web_search", "max_uses": 5 })];
    for d in defs {
        let schema = d.params.clone().unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
        specs.push(json!({ "name": d.name, "description": d.description, "input_schema": schema }));
    }
    specs
}

/// One model call over the whole history, streamed: text reaches `on_text` as
/// it is written. Returns the assistant message to store (tool_use and
/// server-tool blocks included), its text and its tool calls.
pub async fn turn(
    key: &str,
    model: &str,
    system: &str,
    history: &[Value],
    defs: &[ToolDef],
    on_text: OnText<'_>,
) -> Result<Turn, String> {
    let body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "tools": tool_specs(defs),
        "fallbacks": "default",
        "messages": history,
        "stream": true,
    });

    let mut response = call(key, &body).await?;
    let mut stream = StreamedMessage::default();
    let mut sse = SseReader::default();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Network error: {e}"))? {
        for data in sse.push(&chunk) {
            stream.apply(&data, on_text)?;
        }
    }
    let (blocks, stop, stop_details) = stream.finish();

    // A policy decline arrives as an ordinary stop with reason "refusal".
    if stop == "refusal" {
        let why = stop_details
            .as_ref()
            .and_then(|d| d.get("explanation"))
            .and_then(Value::as_str)
            .unwrap_or("Claude declined this one.");
        return Err(why.to_string());
    }
    if blocks.is_empty() {
        return Err("Unexpected API response.".into());
    }

    let text = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");

    let calls = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
        .map(|b| ToolCall {
            id: b.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            name: b.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
            args: b.get("input").cloned().unwrap_or_else(|| json!({})),
        })
        .collect();

    Ok(Turn {
        // Store the whole content so the next turn has the right context.
        message: json!({ "role": "assistant", "content": blocks }),
        text,
        calls,
        paused: stop == "pause_turn",
    })
}

/// Every tool result for one round, in one user message, as the API requires.
pub fn tool_results(results: &[(ToolCall, ToolOutput)]) -> Value {
    let content: Vec<Value> = results
        .iter()
        .map(|(call, out)| {
            let mut parts = vec![json!({ "type": "text", "text": out.text })];
            if let Some(a) = &out.attachment {
                let kind = if a.mime == "application/pdf" { "document" } else { "image" };
                parts.push(json!({
                    "type": kind,
                    "source": { "type": "base64", "media_type": a.mime, "data": a.data_b64 },
                }));
            }
            json!({
                "type": "tool_result",
                "tool_use_id": call.id,
                "content": parts,
                "is_error": out.is_error,
            })
        })
        .collect();
    json!({ "role": "user", "content": content })
}

/// Rebuilds the Messages API response from its stream events, so what is
/// stored in the history is exactly what a non-streamed call would return.
#[derive(Default)]
struct StreamedMessage {
    blocks: Vec<Value>,
    /// Tool arguments arrive as JSON fragments, per block index.
    partial_json: std::collections::HashMap<usize, String>,
    stop_reason: String,
    stop_details: Option<Value>,
}

impl StreamedMessage {
    fn apply(&mut self, data: &str, on_text: OnText<'_>) -> Result<(), String> {
        let Ok(event) = serde_json::from_str::<Value>(data) else { return Ok(()) };
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "content_block_start" => {
                let mut block = event.get("content_block").cloned().unwrap_or_else(|| json!({}));
                match block.get("type").and_then(Value::as_str) {
                    Some("text") if block.get("text").is_none() => block["text"] = json!(""),
                    Some("tool_use") | Some("server_tool_use") => {
                        self.partial_json.insert(index, String::new());
                    }
                    _ => {}
                }
                if self.blocks.len() <= index {
                    self.blocks.resize(index + 1, Value::Null);
                }
                self.blocks[index] = block;
            }
            "content_block_delta" => {
                let delta = event.get("delta").cloned().unwrap_or_default();
                let Some(block) = self.blocks.get_mut(index) else { return Ok(()) };
                match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text_delta" => {
                        let piece = delta.get("text").and_then(Value::as_str).unwrap_or("");
                        let text = block.get("text").and_then(Value::as_str).unwrap_or("").to_string() + piece;
                        block["text"] = json!(text);
                        on_text(piece);
                    }
                    "input_json_delta" => {
                        let piece = delta.get("partial_json").and_then(Value::as_str).unwrap_or("");
                        self.partial_json.entry(index).or_default().push_str(piece);
                    }
                    "citations_delta" => {
                        if let Some(c) = delta.get("citation") {
                            if !block.get("citations").is_some_and(Value::is_array) {
                                block["citations"] = json!([]);
                            }
                            block["citations"].as_array_mut().unwrap().push(c.clone());
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let (Some(raw), Some(block)) = (self.partial_json.remove(&index), self.blocks.get_mut(index)) {
                    block["input"] = if raw.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str(&raw).unwrap_or_else(|_| json!({}))
                    };
                }
            }
            "message_delta" => {
                if let Some(delta) = event.get("delta") {
                    if let Some(r) = delta.get("stop_reason").and_then(Value::as_str) {
                        self.stop_reason = r.to_string();
                    }
                    if let Some(d) = delta.get("stop_details").filter(|d| !d.is_null()) {
                        self.stop_details = Some(d.clone());
                    }
                }
            }
            "error" => {
                let msg = event
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("stream error");
                return Err(format!("Claude API: {msg}"));
            }
            _ => {}
        }
        Ok(())
    }

    fn finish(self) -> (Vec<Value>, String, Option<Value>) {
        let blocks = self.blocks.into_iter().filter(|b| !b.is_null()).collect();
        (blocks, self.stop_reason, self.stop_details)
    }
}

/// Sends the request; on success hands back the response to stream from.
async fn call(key: &str, body: &Value) -> Result<reqwest::Response, String> {
    // No overall timeout: a long answer streams for as long as it takes. The
    // connection itself still has to come up promptly.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(ENDPOINT)
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.map_err(|e| e.to_string())?;
        // Surface the API's own message, which is what makes a bad key obvious.
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("Claude API {status}: {detail}"));
    }
    Ok(response)
}

/// PDF → document block, image → image block, text/code → inline text.
/// Mirrors readFileAsBlock() in ClaudeService.swift.
fn file_block(path: &str) -> Option<Value> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let media_type = match ext.as_str() {
        "pdf" => Some(("document", "application/pdf")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "png" => Some(("image", "image/png")),
        "gif" => Some(("image", "image/gif")),
        "webp" => Some(("image", "image/webp")),
        _ => None,
    };

    if let Some((block_type, media)) = media_type {
        let bytes = std::fs::read(path).ok()?;
        return Some(json!({
            "type": block_type,
            "source": { "type": "base64", "media_type": media, "data": base64(&bytes) },
        }));
    }

    let len = std::fs::metadata(path).ok()?.len();
    if len > MAX_INLINE_TEXT {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(json!({ "type": "text", "text": format!("File contents:\n{text}") }))
}

/// Small standalone base64 encoder — not worth another dependency.
/// Also used for Stripe's basic auth.
pub(crate) fn base64_for(bytes: &[u8]) -> String {
    base64(bytes)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
