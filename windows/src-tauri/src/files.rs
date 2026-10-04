// Dropped files are copied into %LOCALAPPDATA%\Coucou\inbox so the original is
// never touched and the copy survives the drag source going away.
// The inbox is swept of anything older than a week, as on macOS.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::settings;

const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

pub fn inbox_dir() -> PathBuf {
    settings::local_dir().join("inbox")
}

pub fn ingest(source: &str) -> Result<DroppedFile, String> {
    let src = Path::new(source);
    let meta = std::fs::metadata(src).map_err(|e| format!("cannot read {source}: {e}"))?;
    if meta.is_dir() {
        return Err("Folders can't be dropped yet.".into());
    }
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let dest = inbox_slot(&name)?;
    std::fs::copy(src, &dest).map_err(|e| format!("cannot copy: {e}"))?;
    landed(name, dest, meta.len())
}

/// Largest file the page may hand over as bytes. A drop through the webview
/// arrives as the file's contents, not its path.
pub const MAX_DROPPED_BYTES: usize = 200 * 1024 * 1024;

/// A file dropped onto the webview itself: the page read it and sent its
/// contents. Only the last component of `name` is used, so a name can never
/// point outside the inbox.
pub fn ingest_bytes(name: &str, bytes: &[u8]) -> Result<DroppedFile, String> {
    if bytes.len() > MAX_DROPPED_BYTES {
        return Err("That file is too big to drop (200 MB at most).".into());
    }
    let name = Path::new(name.trim())
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty() && n != "." && n != "..")
        .unwrap_or_else(|| "file".into());
    let dest = inbox_slot(&name)?;
    std::fs::write(&dest, bytes).map_err(|e| format!("cannot save: {e}"))?;
    landed(name, dest, bytes.len() as u64)
}

/// A free path in the inbox for `name`: "a.txt", else "a (2).txt", and so on.
fn inbox_slot(name: &str) -> Result<PathBuf, String> {
    let dir = inbox_dir();
    crate::platform::ensure_private_dir(&settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut dest = dir.join(name);
    if dest.exists() {
        let p = Path::new(name);
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = p.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
        for i in 2..1000 {
            let candidate = dir.join(format!("{stem} ({i}){ext}"));
            if !candidate.exists() {
                dest = candidate;
                break;
            }
        }
    }
    Ok(dest)
}

fn landed(name: String, dest: PathBuf, size: u64) -> Result<DroppedFile, String> {
    // CopyFileEx carries the source's timestamps across, so a file last edited
    // three years ago would arrive already older than the sweep window and be
    // deleted on the spot. The inbox ages from when *we* copied it.
    if let Ok(file) = std::fs::File::options().write(true).open(&dest) {
        let _ = file.set_modified(SystemTime::now());
    }
    sweep(&inbox_dir());
    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size,
    })
}

/// Largest picture shown as a thumbnail in the chat.
const MAX_PREVIEW: u64 = 15 * 1024 * 1024;

/// A dropped picture as a data: URL, for the chat's thumbnail. Only files in
/// the inbox (where every drop, snip and paste lands) and only pictures: the
/// page can never use this to read anything else on disk.
pub fn preview(path: &str) -> Option<String> {
    let inbox = inbox_dir().canonicalize().ok()?;
    let file = Path::new(path).canonicalize().ok()?;
    if !file.starts_with(&inbox) || !file.is_file() {
        return None;
    }
    let ext = file.extension()?.to_string_lossy().to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => return None,
    };
    if std::fs::metadata(&file).ok()?.len() > MAX_PREVIEW {
        return None;
    }
    let bytes = std::fs::read(&file).ok()?;
    Some(format!("data:{mime};base64,{}", crate::claude::base64_for(&bytes)))
}

/// Largest source file the Home view will read to show a few lines of it.
const MAX_SNIPPET_FILE: u64 = 256 * 1024;

/// A few lines of a source file for the Home view (see `src/core/snippet.ts`).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    /// 1-based line of the first match, or of the requested offset.
    pub line: usize,
    pub before: Vec<String>,
    /// The requested window (range mode); empty in needle mode.
    pub body: Vec<String>,
    pub after: Vec<String>,
}

/// Names that routinely hold secrets: never shown, even inside the session folder.
fn looks_secret(file: &Path) -> bool {
    let name = file.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let ext = file.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    name.starts_with(".env")
        || name.contains("secret")
        || name.contains("credential")
        || name.starts_with("id_rsa")
        || matches!(ext.as_str(), "pem" | "key" | "pfx" | "p12" | "kdbx")
}

/// Pure part of `snippet`: finds `needle` (or takes `count` lines from
/// `offset`) in `text` and returns the lines around it.
pub fn snippet_of(
    text: &str,
    needle: Option<&str>,
    offset: usize,
    count: usize,
    before: usize,
    after: usize,
) -> Option<Snippet> {
    let lines: Vec<&str> = text.lines().collect();
    let own = |from: usize, to: usize| -> Vec<String> {
        lines[from.min(lines.len())..to.min(lines.len())].iter().map(|l| l.trim_end_matches('\r').to_string()).collect()
    };
    if let Some(needle) = needle.filter(|n| !n.is_empty()) {
        let normalized = text.replace("\r\n", "\n");
        let at = normalized.find(&needle.replace("\r\n", "\n"))?;
        let first = normalized[..at].matches('\n').count();
        let span = needle.matches('\n').count() + 1;
        return Some(Snippet {
            line: first + 1,
            before: own(first.saturating_sub(before), first),
            body: Vec::new(),
            after: own(first + span, first + span + after),
        });
    }
    let first = offset.max(1) - 1;
    if first >= lines.len() {
        return None;
    }
    Some(Snippet { line: first + 1, before: Vec::new(), body: own(first, first + count), after: Vec::new() })
}

/// Reads a few lines of a file a session is working on. The path comes from a
/// hook payload, so it is data, not trust: it must sit inside the session's
/// folder, be a small text file, and not look like a secret.
pub fn snippet(
    path: &str,
    cwd: &str,
    needle: Option<&str>,
    offset: usize,
    count: usize,
    before: usize,
    after: usize,
) -> Option<Snippet> {
    if cwd.is_empty() {
        return None;
    }
    let root = Path::new(cwd).canonicalize().ok()?;
    let file = Path::new(path).canonicalize().ok()?;
    if !file.starts_with(&root) || !file.is_file() || looks_secret(&file) {
        return None;
    }
    if std::fs::metadata(&file).ok()?.len() > MAX_SNIPPET_FILE {
        return None;
    }
    let text = String::from_utf8(std::fs::read(&file).ok()?).ok()?;
    snippet_of(&text, needle, offset, count.min(40), before.min(6), after.min(6))
}

/// Drops anything copied here more than a week ago. `ingest` stamps every copy
/// with the time it landed, so this really is the age of the copy and not the
/// age of whatever the user happened to drag in.
fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(copied) = meta.modified() else { continue };
        if now.duration_since(copied).map(|age| age > KEEP_FOR).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippet_finds_a_needle_with_its_neighbours() {
        let text = "a\nb\nc\nd\ne\nf\n";
        let s = snippet_of(text, Some("d\ne"), 1, 0, 2, 2).unwrap();
        assert_eq!(s.line, 4);
        assert_eq!(s.before, vec!["b", "c"]);
        assert_eq!(s.after, vec!["f"]);
        assert!(snippet_of(text, Some("zzz"), 1, 0, 2, 2).is_none());
    }

    #[test]
    fn snippet_takes_a_window_from_an_offset() {
        let s = snippet_of("a\r\nb\r\nc\r\n", None, 2, 5, 0, 0).unwrap();
        assert_eq!((s.line, s.body), (2, vec!["b".to_string(), "c".to_string()]));
        assert!(snippet_of("a\n", None, 9, 5, 0, 0).is_none());
    }

    #[test]
    fn snippet_stays_inside_the_session_folder() {
        let tmp = std::env::temp_dir().join(format!("coucou-snippet-{}", std::process::id()));
        let inside = tmp.join("work");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::write(inside.join("ok.ts"), "one\ntwo\n").unwrap();
        std::fs::write(inside.join(".env"), "KEY=1\n").unwrap();
        std::fs::write(tmp.join("outside.ts"), "no\n").unwrap();
        let cwd = inside.to_str().unwrap();

        assert!(snippet(inside.join("ok.ts").to_str().unwrap(), cwd, None, 1, 3, 0, 0).is_some());
        assert!(snippet(tmp.join("outside.ts").to_str().unwrap(), cwd, None, 1, 3, 0, 0).is_none());
        assert!(snippet(inside.join(".env").to_str().unwrap(), cwd, None, 1, 3, 0, 0).is_none());
        assert!(snippet(inside.join("ok.ts").to_str().unwrap(), "", None, 1, 3, 0, 0).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ingest_copies_and_never_overwrites() {
        let tmp = std::env::temp_dir().join(format!("coucou-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let source = tmp.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let first = ingest(source.to_str().unwrap()).unwrap();
        assert_eq!(first.name, "note.txt");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        // A second drop of the same name must not clobber the first copy.
        std::fs::write(&source, b"second").unwrap();
        let second = ingest(source.to_str().unwrap()).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"second");

        // Folders are refused rather than silently ignored.
        assert!(ingest(tmp.to_str().unwrap()).is_err());

        // An ancient source must not arrive already older than the sweep window.
        let old_source = tmp.join("ancient.txt");
        std::fs::write(&old_source, b"old").unwrap();
        let long_ago = SystemTime::now() - KEEP_FOR - Duration::from_secs(60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old_source)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        let aged = ingest(old_source.to_str().unwrap()).unwrap();
        assert!(
            Path::new(&aged.path).exists(),
            "a file copied just now was swept as if it were a week old"
        );
        let _ = std::fs::remove_file(&aged.path);

        let _ = std::fs::remove_file(&first.path);
        let _ = std::fs::remove_file(&second.path);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
