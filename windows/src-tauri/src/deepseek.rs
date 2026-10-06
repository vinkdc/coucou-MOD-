// DeepSeek API client — the same chat as claude.rs, on DeepSeek's OpenAI-style
// chat/completions endpoint, with the assistant's tools as function tools.
//
// Only called when the user picked DeepSeek in Settings and stored their own
// key; the key never leaves the Credential Manager / Secret Service.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};

use crate::assistant::{OnText, SseReader, ToolCall, ToolDef, ToolOutput, Turn};

const BASE: &str = "https://api.deepseek.com";
const MAX_TOKENS: u32 = 4096;

/// Said last in the instructions: DeepSeek has no web search here, so the model
/// (and any character it plays) must not promise one.
const NO_SEARCH: &str = "Web search is NOT available with this AI. If the user asks you to search or look something up online, \
say so plainly in one short sentence (in character if you play one), suggest switching the tutor to Claude or Gemini in Kotoba's settings, \
and answer from what you already know when you can. Never say you are searching.";

/// The model picked when the user has not chosen one, resolved once.
static DEFAULT_MODEL: Mutex<Option<String>> = Mutex::new(None);

#[derive(Serialize, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}

pub fn user_message(query: &str) -> Value {
    json!({ "role": "user", "content": query })
}

fn tool_specs(defs: &[ToolDef]) -> Vec<Value> {
    defs.iter()
        .map(|d| {
            let schema = d.params.clone().unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
            json!({ "type": "function", "function": { "name": d.name, "description": d.description, "parameters": schema } })
        })
        .collect()
}

/// The system prompt goes first on every call and is not stored in the history,
/// so the start of each request is identical and DeepSeek's context cache hits.
fn body(model: &str, system: &str, history: &[Value], defs: &[ToolDef]) -> Value {
    let mut messages = vec![json!({ "role": "system", "content": format!("{system}\n\n{NO_SEARCH}") })];
    messages.extend(history.iter().cloned());
    let mut body = json!({
        "model": model,
        "messages": messages,
        "max_tokens": MAX_TOKENS,
        "stream": true,
        // Thinking tokens are billed as output and would have to round-trip
        // through the history; a tutor's short answers don't need them.
        "thinking": { "type": "disabled" },
    });
    if !defs.is_empty() {
        body["tools"] = json!(tool_specs(defs));
    }
    body
}

/// One model call, streamed: text reaches `on_text` as DeepSeek writes it.
pub async fn turn(
    key: &str,
    model: &str,
    system: &str,
    history: &[Value],
    defs: &[ToolDef],
    on_text: OnText<'_>,
) -> Result<Turn, String> {
    let mut response = post(key, &format!("{BASE}/chat/completions"), &body(model, system, history, defs)).await?;

    let mut text = String::new();
    // Tool calls arrive in pieces, per index: id and name first, then the
    // arguments as JSON fragments.
    let mut pending: BTreeMap<usize, (String, String, String)> = BTreeMap::new();
    let mut finish = String::new();
    let mut sse = SseReader::default();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Network error: {e}"))? {
        for data in sse.push(&chunk) {
            if data.trim() == "[DONE]" {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(&data) else { continue };
            if let Some(err) = event.get("error") {
                let msg = err.get("message").and_then(Value::as_str).unwrap_or("stream error");
                return Err(format!("DeepSeek API: {msg}"));
            }
            let Some(choice) = event.get("choices").and_then(|c| c.get(0)) else { continue };
            if let Some(r) = choice.get("finish_reason").and_then(Value::as_str) {
                finish = r.to_string();
            }
            let Some(delta) = choice.get("delta") else { continue };
            if let Some(piece) = delta.get("content").and_then(Value::as_str).filter(|p| !p.is_empty()) {
                text.push_str(piece);
                on_text(piece);
            }
            for call in delta.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let entry = pending.entry(index).or_default();
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    entry.0 = id.to_string();
                }
                if let Some(f) = call.get("function") {
                    if let Some(name) = f.get("name").and_then(Value::as_str) {
                        entry.1.push_str(name);
                    }
                    if let Some(args) = f.get("arguments").and_then(Value::as_str) {
                        entry.2.push_str(args);
                    }
                }
            }
        }
    }

    if finish == "insufficient_system_resource" {
        return Err("DeepSeek is overloaded right now. Try again in a moment.".into());
    }
    if text.trim().is_empty() && pending.is_empty() {
        let reason = if finish.is_empty() { "no content" } else { finish.as_str() };
        crate::log::line(format!("deepseek {model}: no visible answer (finish={reason})"));
    }

    let mut calls = Vec::new();
    let mut stored = Vec::new();
    for (i, (id, name, args)) in pending {
        let id = if id.is_empty() { format!("call-{i}") } else { id };
        let args = if args.trim().is_empty() { "{}".to_string() } else { args };
        calls.push(ToolCall {
            id: id.clone(),
            name: name.clone(),
            args: serde_json::from_str(&args).unwrap_or_else(|_| json!({})),
        });
        stored.push(json!({ "id": id, "type": "function", "function": { "name": name, "arguments": args } }));
    }
    let mut message = json!({ "role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) } });
    if !stored.is_empty() {
        message["tool_calls"] = json!(stored);
    }
    Ok(Turn { message, text, calls, paused: false })
}

/// One `tool` message per call, in the order the model asked. This model can't
/// look at files, so an attachment is mentioned rather than sent.
pub fn tool_results(results: &[(ToolCall, ToolOutput)]) -> Vec<Value> {
    results
        .iter()
        .map(|(call, out)| {
            let mut content = if out.is_error { format!("Error: {}", out.text) } else { out.text.clone() };
            if out.attachment.is_some() {
                content.push_str("\n[A file came with this result, but this AI cannot view files.]");
            }
            json!({ "role": "tool", "tool_call_id": call.id, "content": content })
        })
        .collect()
}

// ── Models ────────────────────────────────────────────────────────────────────

/// The models this key can use, from the live list — nothing hardcoded.
pub async fn models(key: &str) -> Result<Vec<ModelInfo>, String> {
    let v = get(key, &format!("{BASE}/models")).await?;
    Ok(v.get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .map(|id| ModelInfo { id: id.to_string(), label: id.to_string() })
        .collect())
}

/// "Automatic": the cheapest tier, Flash, whatever it is called this month.
fn pick_default(list: &[ModelInfo]) -> Option<String> {
    list.iter()
        .find(|m| m.id.to_lowercase().contains("flash"))
        .or_else(|| list.first())
        .map(|m| m.id.clone())
}

pub async fn default_model(key: &str) -> Result<String, String> {
    if let Some(m) = DEFAULT_MODEL.lock().unwrap().clone() {
        return Ok(m);
    }
    let pick = pick_default(&models(key).await?).ok_or("DeepSeek lists no models for this key.")?;
    *DEFAULT_MODEL.lock().unwrap() = Some(pick.clone());
    Ok(pick)
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

async fn post(key: &str, url: &str, body: &Value) -> Result<reqwest::Response, String> {
    let response = client()?
        .post(url)
        .bearer_auth(key)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    ok_or_explain(response).await
}

async fn get(key: &str, url: &str) -> Result<Value, String> {
    let response = client()?
        .get(url)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let text = ok_or_explain(response).await?.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("Bad API response: {e}"))
}

/// A success passes through; a failure becomes a sentence that says what to do.
async fn ok_or_explain(response: reqwest::Response) -> Result<reqwest::Response, String> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let text = response.text().await.map_err(|e| e.to_string())?;
    let detail = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.get("error")?.get("message")?.as_str().map(str::to_string))
        .unwrap_or_else(|| text.chars().take(200).collect());
    crate::log::line(format!("deepseek -> {} {}", status.as_u16(), detail.chars().take(300).collect::<String>()));
    Err(match status.as_u16() {
        401 => "DeepSeek rejected the API key. Check it in Settings.".to_string(),
        402 => "Your DeepSeek balance is empty. Top up at platform.deepseek.com.".to_string(),
        429 => "DeepSeek is rate-limiting this key. Wait a moment and try again.".to_string(),
        code => format!("DeepSeek API {code}: {}", detail.chars().take(300).collect::<String>()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompt_leads_every_request_and_stays_out_of_the_history() {
        let history = vec![user_message("hi")];
        let b = body("m", "SYS", &history, &[]);
        let messages = b["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert!(messages[0]["content"].as_str().unwrap().starts_with("SYS"));
        assert_eq!(history.len(), 1);
        // A tool-less call sends no tools key at all.
        assert!(b.get("tools").is_none());
        assert_eq!(b["thinking"]["type"], "disabled");
    }

    #[test]
    fn tools_become_function_tools_with_an_object_schema() {
        let defs = [ToolDef { name: "bare", description: "no args", params: None }];
        let specs = tool_specs(&defs);
        assert_eq!(specs[0]["type"], "function");
        assert_eq!(specs[0]["function"]["parameters"]["type"], "object");
    }

    #[test]
    fn each_tool_result_is_its_own_tool_message() {
        let call = |id: &str| ToolCall { id: id.into(), name: "x".into(), args: json!({}) };
        let out = ToolOutput::err("nope");
        let msgs = tool_results(&[(call("a"), ToolOutput::ok("fine")), (call("b"), out)]);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["tool_call_id"], "a");
        assert_eq!(msgs[0]["content"], "fine");
        assert_eq!(msgs[1]["content"], "Error: nope");
    }

    #[test]
    fn automatic_prefers_flash_then_anything() {
        let m = |ids: &[&str]| ids.iter().map(|i| ModelInfo { id: i.to_string(), label: i.to_string() }).collect::<Vec<_>>();
        assert_eq!(pick_default(&m(&["deepseek-v4-pro", "deepseek-v4-flash"])), Some("deepseek-v4-flash".into()));
        assert_eq!(pick_default(&m(&["deepseek-v4-pro"])), Some("deepseek-v4-pro".into()));
        assert_eq!(pick_default(&[]), None);
    }
}
