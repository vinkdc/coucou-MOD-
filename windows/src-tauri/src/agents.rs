// Which AI coding agents are running on this PC, and what they are doing, for the Today
// tab's Work page. Status only, and nothing to install: Claude Code and Codex already
// write each session to a file as they work, so the newest of those files tell the
// story (how long since the last line, and what that line was). Nothing is edited or
// sent anywhere, and only the end of each file is read.
//
//   Claude Code: ~/.claude/projects/<project>/<session>.jsonl
//   Codex:       ~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::platform;

/// Sessions quiet for longer than this are not shown.
const KEEP: Duration = Duration::from_secs(30 * 60);
/// Only files touched this recently are even opened.
const LOOK_BACK: Duration = Duration::from_secs(6 * 3600);
/// A line this fresh means the agent is busy right now.
const BUSY: Duration = Duration::from_secs(6);
/// How much of the end of a file is read: plenty for the last few entries.
const TAIL: u64 = 96 * 1024;
const MAX_SESSIONS: usize = 8;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    /// "claude" or "codex".
    pub agent: &'static str,
    pub project: String,
    /// "working", "waiting" or "idle".
    pub state: &'static str,
    /// What it is doing or last did, in a few words.
    pub detail: String,
    /// Epoch ms of the last line.
    pub at: u64,
    /// The task: the learner's last prompt.
    pub prompt: String,
    /// The last tool and what it was aimed at ("Edit", "NotchFlyPages.tsx").
    pub tool: String,
    pub target: String,
    /// Lines added and removed by the last file edit.
    pub added: u32,
    pub removed: u32,
    /// Short model name ("opus-4-5"), the git branch, and the size of the last turn in tokens.
    pub model: String,
    pub branch: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
}

fn secs_since(t: SystemTime) -> Duration {
    SystemTime::now().duration_since(t).unwrap_or_default()
}

fn epoch_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn last_component(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_string()
}

fn clip(s: &str, max: usize) -> String {
    let one_line: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        one_line
    } else {
        format!("{}…", one_line.chars().take(max - 1).collect::<String>())
    }
}

/// The last `TAIL` bytes of a file as lines (the first may be cut, so it is dropped).
fn tail_lines(path: &Path) -> Option<Vec<String>> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    Some(lines)
}

/// Newest-first files under `dir` (one level of sub-folders) that end in `.jsonl`, touched recently.
fn recent_files(dir: &Path, depth: u8, out: &mut Vec<(PathBuf, SystemTime)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() && depth > 0 {
            recent_files(&path, depth - 1, out);
        } else if meta.is_file() && path.extension().is_some_and(|e| e == "jsonl") {
            if let Ok(modified) = meta.modified() {
                if secs_since(modified) <= LOOK_BACK {
                    out.push((path, modified));
                }
            }
        }
    }
}

// ── Claude Code ───────────────────────────────────────────────────────────────

/// What the end of the conversation looks like.
enum Last {
    /// The learner's prompt or a tool's result went in: the agent should be thinking.
    Input,
    /// The agent asked for a tool and nothing came back yet.
    ToolPending,
    /// The agent finished a turn in plain text.
    Said(String),
}

/// The folder a session started in: the first `cwd` near the top of its file (the last one drifts with every `cd`).
fn first_cwd(path: &Path) -> Option<String> {
    let mut head = Vec::new();
    File::open(path).ok()?.take(16 * 1024).read_to_end(&mut head).ok()?;
    String::from_utf8_lossy(&head).lines().find_map(|l| {
        serde_json::from_str::<Value>(l).ok()?.get("cwd")?.as_str().map(last_component)
    })
}

/// "claude-opus-4-5-20251101" → "opus-4-5".
fn short_model(m: &str) -> String {
    let m = m.strip_prefix("claude-").unwrap_or(m);
    let parts: Vec<&str> = m.split('-').collect();
    let keep: Vec<&str> = parts.iter().copied().take_while(|p| !(p.len() == 8 && p.chars().all(|c| c.is_ascii_digit()))).collect();
    keep.join("-")
}

fn line_count(s: &str) -> u32 {
    if s.is_empty() { 0 } else { s.lines().count() as u32 }
}

/// A file shows as its name; a command or a pattern as its first words.
fn target_of(input: &Value) -> String {
    let get = |k: &str| input.get(k).and_then(Value::as_str);
    match (get("file_path").or_else(|| get("path")), get("command").or_else(|| get("pattern"))) {
        (Some(file), _) => last_component(file),
        (None, Some(text)) => clip(text, 40),
        _ => String::new(),
    }
}

/// Lines added and removed by an edit-like tool call.
fn diff_of(name: &str, input: &Value) -> (u32, u32) {
    let text = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(line_count).unwrap_or(0);
    match name {
        "Edit" => (text(input, "new_string"), text(input, "old_string")),
        "Write" => (text(input, "content"), 0),
        "MultiEdit" => input
            .get("edits")
            .and_then(Value::as_array)
            .map(|e| e.iter().fold((0, 0), |(a, r), x| (a + text(x, "new_string"), r + text(x, "old_string"))))
            .unwrap_or((0, 0)),
        _ => (0, 0),
    }
}

fn claude_session(path: &Path, modified: SystemTime) -> Option<Session> {
    let age = secs_since(modified);
    if age > KEEP {
        return None;
    }
    let lines = tail_lines(path)?;
    let mut out = Session { agent: "claude", project: first_cwd(path).unwrap_or_default(), at: epoch_ms(modified), ..Default::default() };
    let mut last: Option<Last> = None;
    let mut have_tool = false;
    let mut have_usage = false;
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if out.project.is_empty() {
            if let Some(cwd) = v.get("cwd").and_then(Value::as_str) {
                out.project = last_component(cwd);
            }
        }
        if out.branch.is_empty() {
            if let Some(b) = v.get("gitBranch").and_then(Value::as_str) {
                out.branch = b.to_string();
            }
        }
        if v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        let content = v.pointer("/message/content");
        let parts = content.and_then(Value::as_array);
        if kind == "assistant" {
            if !have_usage {
                if let (Some(model), Some(u)) = (v.pointer("/message/model").and_then(Value::as_str), v.pointer("/message/usage")) {
                    let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
                    out.model = short_model(model);
                    out.tokens_in = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
                    out.tokens_out = n("output_tokens");
                    have_usage = true;
                }
            }
            let tool = parts.and_then(|p| p.iter().find(|c| c.get("type").and_then(Value::as_str) == Some("tool_use")));
            if let Some(t) = tool {
                let name = t.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
                let input = t.get("input").cloned().unwrap_or(Value::Null);
                if !have_tool {
                    out.target = target_of(&input);
                    (out.added, out.removed) = diff_of(&name, &input);
                    out.tool = name;
                    have_tool = true;
                }
            }
        }
        if last.is_none() && (kind == "user" || kind == "assistant") {
            last = Some(if kind == "user" {
                Last::Input
            } else if out.tool.is_empty() || !have_tool {
                let text = parts
                    .and_then(|p| p.iter().find_map(|c| c.get("text").and_then(Value::as_str)))
                    .or_else(|| content.and_then(Value::as_str))
                    .unwrap_or("");
                Last::Said(clip(text, 70))
            } else {
                // The newest assistant entry asked for a tool (it is the one just read).
                Last::ToolPending
            });
            // An assistant entry with text only is a finished turn, even if an older one used a tool.
            if kind == "assistant" && parts.is_some_and(|p| !p.iter().any(|c| c.get("type").and_then(Value::as_str) == Some("tool_use"))) {
                let text = parts.and_then(|p| p.iter().find_map(|c| c.get("text").and_then(Value::as_str))).unwrap_or("");
                last = Some(Last::Said(clip(text, 70)));
                out.tool.clear();
                out.target.clear();
                (out.added, out.removed) = (0, 0);
                have_tool = false;
            }
        }
        // The task: the newest prompt the learner typed (not a tool result).
        if out.prompt.is_empty() && kind == "user" {
            let text = content
                .and_then(Value::as_str)
                .or_else(|| parts.and_then(|p| p.iter().find_map(|c| (c.get("type").and_then(Value::as_str) == Some("text")).then(|| c.get("text").and_then(Value::as_str)).flatten())));
            // A pasted screenshot leaves an "[Image: …]" marker in the text: the words before it are the task.
            let text = text.map(|t| t.split("[Image").next().unwrap_or(""));
            if let Some(t) = text.filter(|t| !t.trim().is_empty() && !t.trim_start().starts_with('<')) {
                out.prompt = clip(t, 140);
            }
        }
    }
    let last = last?;
    let tool_line = if out.target.is_empty() { out.tool.clone() } else { format!("{} · {}", out.tool, out.target) };
    let (state, detail) = match last {
        Last::Input if age < Duration::from_secs(120) => ("working", if tool_line.is_empty() { "Thinking…".to_string() } else { tool_line.clone() }),
        Last::Input => ("idle", "Waiting for a prompt".to_string()),
        Last::ToolPending if age < BUSY => ("working", tool_line.clone()),
        // Quiet after asking for a tool: it is usually waiting for an approval (or a long command).
        Last::ToolPending if age < Duration::from_secs(15 * 60) => ("waiting", tool_line.clone()),
        Last::ToolPending => ("idle", "Paused".to_string()),
        Last::Said(text) => ("idle", if text.is_empty() { "Finished".to_string() } else { text }),
    };
    out.state = state;
    out.detail = detail;
    out.id = path.file_stem()?.to_string_lossy().into_owned();
    if out.project.is_empty() {
        out.project = "Claude Code".into();
    }
    Some(out)
}

// ── Codex ─────────────────────────────────────────────────────────────────────

fn codex_session(path: &Path, modified: SystemTime) -> Option<Session> {
    let age = secs_since(modified);
    if age > KEEP {
        return None;
    }
    // The first line of a rollout names the working folder.
    let mut head = Vec::new();
    File::open(path).ok()?.take(8 * 1024).read_to_end(&mut head).ok()?;
    let text = String::from_utf8_lossy(&head).into_owned();
    let project = text
        .lines()
        .next()
        .and_then(|l| serde_json::from_str::<Value>(l).ok())
        .and_then(|v| v.pointer("/payload/cwd").or_else(|| v.get("cwd")).and_then(Value::as_str).map(last_component))
        .unwrap_or_else(|| "Codex".to_string());
    let (state, detail) = if age < BUSY { ("working", "Working…".to_string()) } else { ("idle", "Finished or waiting".to_string()) };
    Some(Session { id: path.file_stem()?.to_string_lossy().into_owned(), agent: "codex", project, state, detail, at: epoch_ms(modified), ..Default::default() })
}

/// The agents running now, newest first.
pub fn scan() -> Vec<Session> {
    let home = platform::home_dir();
    let mut sessions = Vec::new();

    let mut claude = Vec::new();
    recent_files(&home.join(".claude").join("projects"), 1, &mut claude);
    claude.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, modified) in claude.into_iter().take(MAX_SESSIONS) {
        sessions.extend(claude_session(&path, modified));
    }

    let mut codex = Vec::new();
    recent_files(&home.join(".codex").join("sessions"), 3, &mut codex);
    codex.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, modified) in codex.into_iter().take(MAX_SESSIONS) {
        sessions.extend(codex_session(&path, modified));
    }

    sessions.sort_by(|a, b| b.at.cmp(&a.at));
    sessions.truncate(MAX_SESSIONS);
    sessions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names() {
        assert_eq!(last_component("C:\\Users\\me\\coucou\\"), "coucou");
        assert_eq!(last_component("/home/me/app"), "app");
    }

    #[test]
    fn clipping() {
        assert_eq!(clip("a  b\nc", 10), "a b c");
        assert_eq!(clip("abcdefghij", 5), "abcd…");
    }

    /// Run by hand with an agent open: `cargo test --lib agents -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn shows_running_agents() {
        for s in scan() {
            println!("{} | {} | {} | {} {} +{} -{} | {} | {}/{} tok | {} | {}", s.agent, s.project, s.state, s.tool, s.target, s.added, s.removed, s.model, s.tokens_in, s.tokens_out, s.branch, s.prompt);
        }
    }
}
