// The assistant's hands on this PC: a handful of small, safe actions the model
// can take when the user asks for them in the chat — open a web page, search the
// web, control music (Spotify or any player), read a few basic facts about the
// computer. Nothing here reads files, runs commands the model wrote, or sends
// anything out; links are limited to http(s) and the Spotify app. The whole set
// is switched by Settings → "Let Mochi use this PC".

use serde_json::{json, Value};

use crate::assistant::{obj, ToolCall, ToolDef, ToolOutput};
use crate::platform;

const MAX_URL: usize = 2000;
const MAX_QUERY: usize = 300;

const NAMES: [&str; 5] = ["pc_info", "open_website", "web_search", "media_control", "open_spotify"];

/// Whether `name` is one of these tools.
pub fn handles(name: &str) -> bool {
    NAMES.contains(&name)
}

pub fn tools() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "pc_info",
            description: "Basic facts about this computer: local date and time, OS, memory, free disk space, battery, uptime. Call it when the user asks about their PC or what time it is.",
            params: None,
        },
        ToolDef {
            name: "open_website",
            description: "Open a web page in the user's default browser. Only when the user asked to open a site. http or https links only.",
            params: obj(json!({ "url": { "type": "string", "description": "The full address, starting with https://" } }), &["url"]),
        },
        ToolDef {
            name: "web_search",
            description: "Open a web search for the user in their browser. Only when the user asked to search or look something up on the web.",
            params: obj(json!({ "query": { "type": "string", "description": "What to search for" } }), &["query"]),
        },
        ToolDef {
            name: "media_control",
            description: "Control whatever is playing music or video on this PC, Spotify included: play or pause, next or previous track, volume. Only when the user asked.",
            params: obj(
                json!({ "action": { "type": "string", "enum": ["play_pause", "next", "previous", "volume_up", "volume_down", "mute"] } }),
                &["action"],
            ),
        },
        ToolDef {
            name: "open_spotify",
            description: "Open the Spotify app, optionally on a search for a song, artist or playlist. It does not start playing by itself: after it opens, tell the user to press play, or call media_control play_pause.",
            params: obj(json!({ "query": { "type": "string", "description": "A song, artist or playlist to search for; leave out to just open Spotify" } }), &[]),
        },
    ]
}

/// Percent-encodes a query for a URL.
fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// An address the browser may be sent to: http(s), one line, no spaces.
fn web_url(raw: &str) -> Option<String> {
    let url = raw.trim();
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let ok = !rest.is_empty() && url.len() <= MAX_URL && !url.chars().any(|c| c.is_whitespace() || c.is_control());
    ok.then(|| url.to_string())
}

fn text(args: &Value, key: &str) -> String {
    args.get(key).and_then(Value::as_str).unwrap_or("").trim().chars().filter(|c| !c.is_control()).take(MAX_QUERY).collect()
}

pub fn apply(call: &ToolCall) -> ToolOutput {
    match call.name.as_str() {
        "pc_info" => ToolOutput::ok(platform::system_summary()),
        "open_website" => {
            let raw = call.args.get("url").and_then(Value::as_str).unwrap_or("");
            match web_url(raw) {
                Some(url) => {
                    platform::open_url(&url);
                    ToolOutput::ok(format!("Opened {url} in the browser."))
                }
                None => ToolOutput::err("Only http:// or https:// addresses can be opened."),
            }
        }
        "web_search" => {
            let q = text(&call.args, "query");
            if q.is_empty() {
                return ToolOutput::err("query is required");
            }
            platform::open_url(&format!("https://www.google.com/search?q={}", encode(&q)));
            ToolOutput::ok(format!("Opened a web search for \"{q}\"."))
        }
        "media_control" => {
            let action = call.args.get("action").and_then(Value::as_str).unwrap_or("");
            if platform::media_key(action) {
                ToolOutput::ok(format!("Done: {action}."))
            } else {
                ToolOutput::err("Unknown action, or no media controls on this system.")
            }
        }
        "open_spotify" => {
            let q = text(&call.args, "query");
            let uri = if q.is_empty() { "spotify:".to_string() } else { format!("spotify:search:{}", encode(&q)) };
            platform::open_url(&uri);
            ToolOutput::ok(if q.is_empty() {
                "Opened Spotify (if it is installed).".to_string()
            } else {
                format!("Opened Spotify on a search for \"{q}\" (if it is installed). It is not playing yet.")
            })
        }
        other => ToolOutput::err(format!("Unknown tool {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_links_are_opened() {
        assert!(web_url("https://example.com/a?b=1").is_some());
        assert!(web_url("  http://example.com ").is_some());
        for bad in ["file:///C:/Windows/System32/cmd.exe", "javascript:alert(1)", "ms-settings:", "https://", "https://a b", "https://a\nb", "calc.exe", ""] {
            assert!(web_url(bad).is_none(), "{bad} should be refused");
        }
        assert!(web_url(&format!("https://{}", "a".repeat(MAX_URL))).is_none());
    }

    #[test]
    fn queries_are_percent_encoded() {
        assert_eq!(encode("lofi beats & chill"), "lofi%20beats%20%26%20chill");
        assert_eq!(encode("日本"), "%E6%97%A5%E6%9C%AC");
        assert_eq!(encode("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn every_declared_tool_is_handled() {
        for t in tools() {
            assert!(handles(t.name), "{} is not routed", t.name);
        }
        assert_eq!(tools().len(), NAMES.len());
        assert!(!handles("log_progress"));
    }

    #[test]
    fn bad_calls_are_refused_without_acting() {
        let call = |name: &str, args: Value| ToolCall { id: "1".into(), name: name.into(), args };
        assert!(apply(&call("open_website", json!({ "url": "file:///etc/passwd" }))).is_error);
        assert!(apply(&call("web_search", json!({ "query": "  " }))).is_error);
        assert!(apply(&call("media_control", json!({ "action": "format_disk" }))).is_error);
    }
}
