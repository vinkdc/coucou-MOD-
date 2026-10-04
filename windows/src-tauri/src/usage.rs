// Claude Code usage for the cockpit's Usage page, read from the transcripts
// Claude Code already keeps on disk (`<config>/projects/**/*.jsonl`). Nothing
// leaves the machine and nothing is written.
//
// The answer is tokens per UTC hour over the last week; the page works out the
// 5-hour window, today and the week from it in local time. Hours are exact for
// the window, which Claude starts on the hour of its first message.
//
// Asked for only when the Usage page is showing on an open island. Files are
// remembered by size, so a re-read parses only what was appended since.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::platform;

const WEEK: Duration = Duration::from_secs(7 * 24 * 3600);

#[derive(Serialize, Debug, Default, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    /// Start of the hour, in seconds since the epoch.
    pub hour: i64,
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub messages: u32,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Oldest first; only hours with activity.
    pub hours: Vec<Bucket>,
    /// Whether a Claude Code projects folder exists at all.
    pub found: bool,
}

#[derive(Clone, Copy)]
struct Entry {
    key: u64,
    hour: i64,
    input: u64,
    output: u64,
    cache_write: u64,
    cache_read: u64,
}

#[derive(Default)]
struct FileCache {
    /// Bytes parsed so far, always at a line boundary.
    offset: u64,
    entries: Vec<Entry>,
}

static CACHE: Mutex<Option<HashMap<PathBuf, FileCache>>> = Mutex::new(None);

/// `CLAUDE_CONFIG_DIR` (comma-separated), else `~/.claude` and `~/.config/claude`.
fn roots() -> Vec<PathBuf> {
    if let Some(v) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        let list: Vec<PathBuf> = v
            .to_string_lossy()
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| PathBuf::from(s).join("projects"))
            .collect();
        if !list.is_empty() {
            return list;
        }
    }
    let home = platform::home_dir();
    vec![home.join(".claude").join("projects"), home.join(".config").join("claude").join("projects")]
}

/// Transcripts touched in the last week, subagent folders included.
fn recent_files(root: &Path, since: SystemTime, out: &mut Vec<(PathBuf, u64)>, depth: u32) {
    let Ok(dir) = std::fs::read_dir(root) else { return };
    for item in dir.flatten() {
        let Ok(meta) = item.metadata() else { continue };
        let path = item.path();
        if meta.is_dir() {
            if depth < 4 {
                recent_files(&path, since, out, depth + 1);
            }
        } else if path.extension().is_some_and(|e| e == "jsonl")
            && meta.modified().is_ok_and(|m| m >= since)
        {
            out.push((path, meta.len()));
        }
    }
}

pub fn read() -> Usage {
    let now = SystemTime::now();
    let since = now - WEEK;
    let mut files = Vec::new();
    let mut found = false;
    for root in roots() {
        if root.is_dir() {
            found = true;
            recent_files(&root, since, &mut files, 0);
        }
    }

    let mut guard = CACHE.lock().unwrap();
    let cache = guard.get_or_insert_with(HashMap::new);
    // Forget files that dropped out of the week.
    let live: HashSet<&PathBuf> = files.iter().map(|(p, _)| p).collect();
    cache.retain(|p, _| live.contains(p));

    for (path, len) in &files {
        let fc = cache.entry(path.clone()).or_default();
        if *len < fc.offset {
            *fc = FileCache::default();
        }
        if *len > fc.offset {
            parse_from(path, fc);
        }
    }

    let cutoff = now.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) - WEEK.as_secs() as i64;
    let mut seen = HashSet::new();
    let mut hours: BTreeMap<i64, Bucket> = BTreeMap::new();
    for fc in cache.values() {
        for e in &fc.entries {
            // Streaming writes one message over several lines, and a resumed
            // session copies earlier ones: count each request once.
            if e.hour + 3600 <= cutoff || !seen.insert(e.key) {
                continue;
            }
            let b = hours.entry(e.hour).or_insert(Bucket { hour: e.hour, ..Default::default() });
            b.input += e.input;
            b.output += e.output;
            b.cache_write += e.cache_write;
            b.cache_read += e.cache_read;
            b.messages += 1;
        }
    }
    Usage { hours: hours.into_values().collect(), found }
}

fn parse_from(path: &Path, fc: &mut FileCache) {
    let Ok(mut f) = File::open(path) else { return };
    if f.seek(SeekFrom::Start(fc.offset)).is_err() {
        return;
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return;
    }
    // A line still being written is left for next time.
    let Some(end) = buf.iter().rposition(|&b| b == b'\n') else { return };
    for line in buf[..end].split(|&b| b == b'\n') {
        if let Some(e) = parse_line(line) {
            fc.entries.push(e);
        }
    }
    fc.offset += end as u64 + 1;
}

fn parse_line(line: &[u8]) -> Option<Entry> {
    // Most lines are tool output; skip them before paying for JSON.
    if !contains(line, b"\"usage\"") || !contains(line, b"\"assistant\"") {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(line).ok()?;
    let msg = v.get("message")?;
    let usage = msg.get("usage")?;
    let n = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let ts = parse_iso(v.get("timestamp")?.as_str()?)?;
    let id = msg.get("id").and_then(|x| x.as_str()).unwrap_or("");
    let req = v.get("requestId").and_then(|x| x.as_str()).unwrap_or("");
    let key = if id.is_empty() && req.is_empty() {
        // Nothing to dedupe on: keep the line, keyed by its own text.
        hash(line)
    } else {
        hash(format!("{id}:{req}").as_bytes())
    };
    Some(Entry {
        key,
        hour: ts - ts.rem_euclid(3600),
        input: n("input_tokens"),
        output: n("output_tokens"),
        cache_write: n("cache_creation_input_tokens"),
        cache_read: n("cache_read_input_tokens"),
    })
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

fn hash(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

/// `2026-10-04T06:17:03.041Z` (or with a `±hh:mm` offset) to epoch seconds.
pub fn parse_iso(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, se) = (num(11..13)?, num(14..16)?, num(17..19)?);
    // Skip fractional seconds, then read the zone.
    let mut i = 19;
    if b.get(i) == Some(&b'.') {
        i += 1;
        while b.get(i).is_some_and(|c| c.is_ascii_digit()) {
            i += 1;
        }
    }
    let offset = match b.get(i) {
        None | Some(b'Z') => 0,
        Some(&sign @ (b'+' | b'-')) => {
            let oh = num(i + 1..i + 3)?;
            let om = num(i + 4..i + 6)?;
            let o = oh * 3600 + om * 60;
            if sign == b'+' { o } else { -o }
        }
        _ => return None,
    };
    // Days from civil (Howard Hinnant).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86400 + h * 3600 + mi * 60 + se - offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_timestamps() {
        assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso("2026-10-04T06:17:03.041Z"), Some(1_791_094_623));
        assert_eq!(parse_iso("2026-10-04T08:17:03+02:00"), Some(1_791_094_623));
        assert_eq!(parse_iso("not a date"), None);
    }

    #[test]
    fn assistant_lines_only() {
        let line = br#"{"type":"assistant","requestId":"r1","timestamp":"2026-10-04T06:17:03Z","message":{"id":"m1","role":"assistant","usage":{"input_tokens":2,"output_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":7}}}"#;
        let e = parse_line(line).unwrap();
        assert_eq!((e.input, e.output, e.cache_write, e.cache_read), (2, 10, 5, 7));
        assert_eq!(e.hour % 3600, 0);
        assert!(parse_line(br#"{"type":"user","message":{"content":"hi"}}"#).is_none());
    }

    #[test]
    fn reads_this_machines_history_without_failing() {
        // Whatever is (or isn't) in ~/.claude, a read answers, and a re-read
        // never loses anything (a live session may append in between).
        let a = read();
        let b = read();
        let msgs = |u: &Usage| u.hours.iter().map(|x| x.messages).sum::<u32>();
        assert!(msgs(&b) >= msgs(&a), "a re-read never counts less");
        assert!(a.hours.windows(2).all(|w| w[0].hour < w[1].hour));
        let out: u64 = a.hours.iter().map(|x| x.output).sum();
        eprintln!("found={} hours={} output_tokens={out}", a.found, a.hours.len());
    }

    #[test]
    fn appended_lines_are_read_once_and_partial_lines_wait() {
        let dir = std::env::temp_dir().join(format!("coucou-usage-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let line = |id: &str| {
            format!(r#"{{"type":"assistant","requestId":"{id}","timestamp":"2026-10-04T06:00:00Z","message":{{"id":"{id}","usage":{{"output_tokens":1}}}}}}"#)
        };
        std::fs::write(&path, format!("{}\n{}", line("a"), line("b"))).unwrap();
        let mut fc = FileCache::default();
        parse_from(&path, &mut fc);
        assert_eq!(fc.entries.len(), 1, "the unterminated line waits");
        std::fs::write(&path, format!("{}\n{}\n", line("a"), line("b"))).unwrap();
        parse_from(&path, &mut fc);
        assert_eq!(fc.entries.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
