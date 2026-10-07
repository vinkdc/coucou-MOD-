// Fish Audio: the voice that reads Japanese aloud. Text-to-speech and the list
// of public Japanese voices for the Settings picker. The key lives in the
// Credential Manager; only Japanese lines are ever sent.
//
// API (verified against docs.fish.audio, 2026-10-06): POST /v1/tts with a
// Bearer key, a JSON body and the TTS model in a `model` header; GET /model
// lists voice models.
//
// Every clip is cached on disk by (text, voice, model, speed), so replaying a
// line or meeting a phrase again costs no credits.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

const BASE: &str = "https://api.fish.audio";
/// Longest text one request may carry; tutor lines are far shorter.
const MAX_TEXT: usize = 600;
/// The cache is trimmed back under this, oldest clips first.
const CACHE_LIMIT: u64 = 200 * 1024 * 1024;

pub const KEY_NAME: &str = "fish-audio-api-key";
/// TTS models the Settings picker offers; the first is the default because it
/// works on the free developer tier.
pub const MODELS: &[&str] = &["s2.1-pro-free", "s2.1-pro", "s2-pro", "s1"];

/// One client for the whole run: its pooled connection skips the TCP and TLS
/// handshake (a few hundred ms) on every line after the first.
fn client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let built = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .connect_timeout(Duration::from_secs(10))
        .pool_idle_timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| built).clone())
}

/// Opens the connection to Fish Audio ahead of the first line of a reply, while
/// the model is still writing it. Only when a key is set (the user chose Fish Audio).
pub async fn warm() {
    if key().is_err() {
        return;
    }
    if let Ok(c) = client() {
        let _ = c.head(BASE).timeout(Duration::from_secs(5)).send().await;
    }
}

fn key() -> Result<String, String> {
    crate::secrets::get(KEY_NAME).ok_or_else(|| "No Fish Audio key yet. Add it in Settings → Voice.".to_string())
}

/// What is actually spoken: furigana readings dropped (`漢字{かんじ}` → `漢字`),
/// whitespace collapsed.
pub fn speakable(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut depth = 0;
    for c in text.chars() {
        match c {
            '{' => depth += 1,
            '}' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// FNV-1a: stable across builds, unlike std's hasher, so the cache survives updates.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

pub fn cache_key(text: &str, voice: &str, model: &str, speed: f64) -> String {
    let id = format!("{text}\u{1f}{voice}\u{1f}{model}\u{1f}{:.2}", speed);
    format!("{:016x}", fnv1a(id.as_bytes()))
}

fn cache_dir() -> PathBuf {
    crate::platform::local_dir().join("tts-cache")
}

pub fn clamp_speed(speed: f64) -> f64 {
    if speed.is_finite() { speed.clamp(0.5, 2.0) } else { 1.0 }
}

/// The request body, kept separate so it can be checked without a network.
pub fn tts_body(text: &str, voice: &str, speed: f64) -> Value {
    let mut body = json!({
        "text": text,
        "format": "mp3",
        "latency": "balanced",
        "prosody": { "speed": clamp_speed(speed) },
    });
    if !voice.trim().is_empty() {
        body["reference_id"] = json!(voice.trim());
    }
    body
}

/// One line ready to synthesise: the spoken text, the settings in effect and
/// where its clip is cached.
struct Line {
    text: String,
    model: &'static str,
    speed: f64,
    file: PathBuf,
}

fn line(text: &str, voice: &str, model: &str, speed: f64) -> Result<Line, String> {
    let text = speakable(text);
    if text.is_empty() {
        return Err("Nothing to say.".into());
    }
    if text.chars().count() > MAX_TEXT {
        return Err("That line is too long to read aloud.".into());
    }
    let model = MODELS.iter().copied().find(|m| *m == model).unwrap_or(MODELS[0]);
    let speed = clamp_speed(speed);
    let file = cache_dir().join(format!("{}.mp3", cache_key(&text, voice, model, speed)));
    Ok(Line { text, model, speed, file })
}

fn cached(line: &Line) -> Option<Vec<u8>> {
    std::fs::read(&line.file).ok().filter(|b| !b.is_empty())
}

async fn request(line: &Line, voice: &str) -> Result<reqwest::Response, String> {
    let response = client()?
        .post(format!("{BASE}/v1/tts"))
        .bearer_auth(key()?)
        .header("model", line.model)
        .json(&tts_body(&line.text, voice, line.speed))
        .send()
        .await
        .map_err(|e| format!("Fish Audio is unreachable: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(explain(status.as_u16(), &detail));
    }
    Ok(response)
}

/// Logs and caches a finished clip.
fn keep(line: &Line, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("Fish Audio sent back no audio.".into());
    }
    crate::log::line(format!("tts: {} chars, {} bytes", line.text.chars().count(), bytes.len()));
    if std::fs::create_dir_all(cache_dir()).is_ok() && std::fs::write(&line.file, bytes).is_ok() {
        trim_cache();
    }
    Ok(())
}

/// MP3 bytes for `text`, from the cache when possible.
pub async fn tts(text: &str, voice: &str, model: &str, speed: f64) -> Result<Vec<u8>, String> {
    let line = line(text, voice, model, speed)?;
    if let Some(bytes) = cached(&line) {
        return Ok(bytes);
    }
    let bytes = request(&line, voice).await?.bytes().await.map_err(|e| e.to_string())?.to_vec();
    keep(&line, &bytes)?;
    Ok(bytes)
}

/// Same as `tts`, but hands the MP3 over in pieces as Fish Audio sends them, so
/// playback can start while the rest is still being generated. A cached clip
/// comes as one piece.
pub async fn tts_stream(
    text: &str,
    voice: &str,
    model: &str,
    speed: f64,
    mut on_chunk: impl FnMut(Vec<u8>) -> Result<(), String>,
) -> Result<(), String> {
    let line = line(text, voice, model, speed)?;
    if let Some(bytes) = cached(&line) {
        return on_chunk(bytes);
    }
    let mut response = request(&line, voice).await?;
    let mut all = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Fish Audio stopped mid-line: {e}"))? {
        all.extend_from_slice(&chunk);
        on_chunk(chunk.to_vec())?;
    }
    keep(&line, &all)
}

fn explain(status: u16, detail: &str) -> String {
    let message = serde_json::from_str::<Value>(detail)
        .ok()
        .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    match status {
        401 => "Fish Audio refused the key. Check it in Settings → Voice.".into(),
        402 => "Fish Audio says this key has no credit for that model. Try the free model in Settings → Voice.".into(),
        404 => "That Fish Audio voice no longer exists. Pick another in Settings → Voice.".into(),
        429 => "Fish Audio is rate-limiting this key. Try again in a moment.".into(),
        _ if message.is_empty() => format!("Fish Audio error {status}."),
        _ => format!("Fish Audio error {status}: {message}"),
    }
}

/// Oldest clips go first once the cache passes CACHE_LIMIT.
fn trim_cache() {
    let Ok(entries) = std::fs::read_dir(cache_dir()) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            meta.is_file().then(|| (meta.modified().unwrap_or(std::time::UNIX_EPOCH), meta.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= CACHE_LIMIT {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= CACHE_LIMIT * 9 / 10 {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            total -= len;
        }
    }
}

// ── Speech to text ────────────────────────────────────────────────────────────
//
// POST /v1/asr (Beta), multipart. `transcribe-1-pro` goes in the `model` header,
// written exactly like that, or the request is silently served as the older
// model. It reads WebM, which is what the page's MediaRecorder makes.

/// Longest recording accepted: a spoken sentence, not a lecture.
const MAX_AUDIO_BYTES: usize = 5 * 1024 * 1024;
const ASR_MODEL: &str = "transcribe-1-pro";

/// A multipart/form-data body, built by hand (no extra crate for one request).
pub fn multipart(boundary: &str, audio: &[u8], mime: &str, fields: &[(&str, &str)]) -> Vec<u8> {
    let mut body = Vec::with_capacity(audio.len() + 512);
    for (name, value) in fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"speech.{}\"\r\nContent-Type: {mime}\r\n\r\n",
            extension(mime)
        )
        .as_bytes(),
    );
    body.extend_from_slice(audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

fn extension(mime: &str) -> &'static str {
    match mime.split(';').next().unwrap_or("").trim() {
        "audio/ogg" => "ogg",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mp4" | "audio/aac" => "m4a",
        _ => "webm",
    }
}

/// The transcript without speaker markers (`<|speaker:0|>`) or bracketed cues (`[laughter]`).
pub fn clean_transcript(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '<' if chars.peek() == Some(&'|') => {
                for d in chars.by_ref() {
                    if d == '>' {
                        break;
                    }
                }
            }
            '[' | '【' => {
                let close = if c == '[' { ']' } else { '】' };
                for d in chars.by_ref() {
                    if d == close {
                        break;
                    }
                }
            }
            _ => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// What was said in a short recording. `language` is only a hint ("ja").
pub async fn transcribe(audio: &[u8], mime: &str, language: &str) -> Result<String, String> {
    if audio.is_empty() {
        return Err("The recording is empty.".into());
    }
    if audio.len() > MAX_AUDIO_BYTES {
        return Err("That recording is too long. Keep it to a sentence or two.".into());
    }
    let key = key()?;
    let boundary = format!("kotoba{:016x}", fnv1a(&audio[..audio.len().min(4096)]) ^ audio.len() as u64);
    let mut fields = vec![("ignore_timestamps", "true"), ("tag_audio_events", "false")];
    if !language.is_empty() {
        fields.push(("language", language));
    }
    let body = multipart(&boundary, audio, mime, &fields);
    let response = client()?
        .post(format!("{BASE}/v1/asr"))
        .bearer_auth(key)
        .header("model", ASR_MODEL)
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Fish Audio is unreachable: {e}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        // Speech recognition has no free model, so the TTS advice in `explain` would mislead.
        if status.as_u16() == 402 {
            return Err("Fish Audio speech recognition has no credit on this key. Add credit on fish.audio; it has no free model.".into());
        }
        return Err(explain(status.as_u16(), &text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|_| "Fish Audio sent back something unexpected.".to_string())?;
    Ok(clean_transcript(v.get("text").and_then(Value::as_str).unwrap_or("")))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    pub id: String,
    pub title: String,
    pub description: String,
}

pub fn parse_voices(v: &Value) -> Vec<Voice> {
    v.get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|m| {
                    Some(Voice {
                        id: m.get("_id")?.as_str()?.to_string(),
                        title: m.get("title").and_then(Value::as_str).unwrap_or("Untitled").to_string(),
                        description: m
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .chars()
                            .take(120)
                            .collect(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Popular public Japanese voices, plus the user's own (`mine`).
pub async fn voices(mine: bool) -> Result<Vec<Voice>, String> {
    let key = key()?;
    let mut url = format!("{BASE}/model?page_size=40&language=ja&sort_by=score");
    if mine {
        url = format!("{BASE}/model?page_size=40&self=true");
    }
    let response = client()?.get(url).bearer_auth(key).send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(explain(status.as_u16(), &body.to_string()));
    }
    Ok(parse_voices(&body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn furigana_is_not_spoken() {
        assert_eq!(speakable("今日{きょう}は 何{なに}を\n食{た}べましたか。"), "今日は 何を 食べましたか。");
        assert_eq!(speakable("}{"), "}");
    }

    #[test]
    fn cache_key_depends_on_every_input() {
        let k = cache_key("こんにちは", "v1", "s1", 1.0);
        assert_eq!(k.len(), 16);
        assert_eq!(k, cache_key("こんにちは", "v1", "s1", 1.0));
        assert_ne!(k, cache_key("こんにちは", "v2", "s1", 1.0));
        assert_ne!(k, cache_key("こんにちは", "v1", "s1", 0.8));
        assert_ne!(k, cache_key("こんばんは", "v1", "s1", 1.0));
    }

    #[test]
    fn body_has_voice_only_when_chosen_and_speed_in_range() {
        let b = tts_body("はい", "", 9.0);
        assert!(b.get("reference_id").is_none());
        assert_eq!(b["prosody"]["speed"], 2.0);
        assert_eq!(b["format"], "mp3");
        let b = tts_body("はい", " abc ", 0.8);
        assert_eq!(b["reference_id"], "abc");
        assert_eq!(clamp_speed(f64::NAN), 1.0);
    }

    #[test]
    fn multipart_body_has_fields_then_the_file() {
        let body = multipart("BND", b"AUDIO", "audio/webm;codecs=opus", &[("language", "ja"), ("ignore_timestamps", "true")]);
        let text = String::from_utf8_lossy(&body).to_string();
        assert!(text.starts_with("--BND\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\nja\r\n"));
        assert!(text.contains("name=\"ignore_timestamps\"\r\n\r\ntrue\r\n"));
        assert!(text.contains("name=\"audio\"; filename=\"speech.webm\"\r\nContent-Type: audio/webm;codecs=opus\r\n\r\nAUDIO\r\n--BND--\r\n"));
        assert!(text.ends_with("--BND--\r\n"));
        assert_eq!(extension("audio/ogg;codecs=opus"), "ogg");
    }

    #[test]
    fn transcripts_lose_markers_and_cues() {
        assert_eq!(clean_transcript("<|speaker:0|> こんにちは [laughter] 元気ですか"), "こんにちは 元気ですか");
        assert_eq!(clean_transcript("はい【笑】"), "はい");
        assert_eq!(clean_transcript("  plain  text "), "plain text");
    }

    #[test]
    fn voices_are_read_from_the_items_list() {
        let v = json!({ "total": 2, "items": [
            { "_id": "a1", "title": "Sakura", "description": "calm" },
            { "title": "no id" },
        ] });
        let list = parse_voices(&v);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "a1");
        assert_eq!(list[0].title, "Sakura");
    }
}
