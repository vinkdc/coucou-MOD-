// Repo status for the island's cockpit: where the Claude Code session is
// working — branch, uncommitted files, ahead/behind, last commit and the GitHub
// remote. Read locally from git; nothing leaves the machine.
//
// Asked for only on events (a tool ran, the island opened), never on a timer.
// git is run directly, never through a shell, and the folder must be an
// existing absolute directory — the path arrives in a hook payload.

use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::platform;

const GIT_TIMEOUT: Duration = Duration::from_secs(2);

/// The GitHub repo and branch the session was last seen on, for the GitHub
/// poller's CI check. Set whenever a status read finds a GitHub remote.
static CURRENT: std::sync::Mutex<Option<(String, String)>> = std::sync::Mutex::new(None);

pub fn current() -> Option<(String, String)> {
    CURRENT.lock().unwrap().clone()
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub is_repo: bool,
    /// Branch name, or the short commit when HEAD is detached.
    pub branch: String,
    pub detached: bool,
    pub has_upstream: bool,
    pub ahead: u32,
    pub behind: u32,
    /// Files with changes, staged, unstaged or untracked.
    pub changed: u32,
    pub last_commit: String,
    /// `owner/repo` when origin is on GitHub.
    pub github: Option<String>,
}

/// Runs git without a shell; `None` on a timeout or a failure to start.
fn git(dir: &str, args: &[&str]) -> Option<(bool, String)> {
    let exe = platform::find_on_path("git")?;
    let mut cmd = std::process::Command::new(exe);
    // --no-optional-locks: reading status must never get in the way of the
    // user's own git commands.
    cmd.args(["--no-optional-locks", "-C", dir]).args(args);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = platform::no_console(&mut cmd).spawn().ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let started = Instant::now();
    let ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if started.elapsed() > GIT_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(_) => return None,
        }
    };
    Some((ok, reader.join().unwrap_or_default()))
}

pub fn status(path: &str) -> Result<RepoStatus, String> {
    let dir = std::path::Path::new(path);
    if !(dir.is_absolute() && dir.is_dir()) {
        return Err("not a folder".into());
    }
    let Some((ok, text)) = git(path, &["status", "--porcelain=v2", "--branch"]) else {
        return Err("git is not available".into());
    };
    if !ok {
        // Not a repository: a normal answer, not an error.
        return Ok(RepoStatus::default());
    }
    let mut s = parse_status(&text);
    s.is_repo = true;
    if let Some((true, subject)) = git(path, &["log", "-1", "--format=%s"]) {
        s.last_commit = subject.trim().chars().take(120).collect();
    }
    if let Some((true, url)) = git(path, &["remote", "get-url", "origin"]) {
        s.github = parse_github_remote(url.trim());
    }
    if let (Some(repo), false) = (&s.github, s.detached) {
        *CURRENT.lock().unwrap() = Some((repo.clone(), s.branch.clone()));
    }
    Ok(s)
}

/// Parses `git status --porcelain=v2 --branch`.
pub fn parse_status(text: &str) -> RepoStatus {
    let mut s = RepoStatus::default();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            if rest == "(detached)" {
                s.detached = true;
            } else {
                s.branch = rest.to_string();
            }
        } else if let Some(rest) = line.strip_prefix("# branch.oid ") {
            if s.branch.is_empty() && rest != "(initial)" {
                s.branch = rest.chars().take(7).collect();
            }
        } else if line.starts_with("# branch.upstream ") {
            s.has_upstream = true;
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // "+2 -1"
            let mut it = rest.split_whitespace();
            s.ahead = it.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
            s.behind = it.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if matches!(line.chars().next(), Some('1' | '2' | 'u' | '?')) && line.as_bytes().get(1) == Some(&b' ') {
            s.changed += 1;
        }
    }
    if s.detached && s.branch.is_empty() {
        s.branch = "detached".into();
    }
    s
}

/// `https://github.com/o/r(.git)`, `git@github.com:o/r.git`, `ssh://git@github.com/o/r`.
pub fn parse_github_remote(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = rest.split('/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    if parts.next().is_some() || owner.is_empty() || repo.is_empty() {
        return None;
    }
    let ok = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    (ok(owner) && ok(repo)).then(|| format!("{owner}/{repo}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_counts_changes_and_ahead_behind() {
        let text = "# branch.oid abc123def456\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/a.rs\n2 R. N... 100644 100644 100644 a b R100 new.rs\told.rs\n? untracked.txt\nu UU N... 1 2 3 4 a b c conflict.rs\n";
        let s = parse_status(text);
        assert_eq!((s.branch.as_str(), s.ahead, s.behind, s.changed), ("main", 2, 1, 4));
        assert!(s.has_upstream && !s.detached);
    }

    #[test]
    fn status_without_upstream_or_changes() {
        let s = parse_status("# branch.oid abc\n# branch.head feature/x\n");
        assert_eq!((s.branch.as_str(), s.changed, s.has_upstream), ("feature/x", 0, false));
    }

    #[test]
    fn detached_head_shows_the_short_commit() {
        // Real git prints the commit first; either order shows the short hash.
        for text in [
            "# branch.oid 1234567890abcdef\n# branch.head (detached)\n",
            "# branch.head (detached)\n# branch.oid 1234567890abcdef\n",
        ] {
            let s = parse_status(text);
            assert!(s.detached);
            assert_eq!(s.branch, "1234567");
        }
        // No commit line at all: say so rather than show nothing.
        assert_eq!(parse_status("# branch.head (detached)\n").branch, "detached");
    }

    #[test]
    fn real_git_on_this_repository() {
        // Skipped quietly where git isn't installed (a bare CI image).
        if platform::find_on_path("git").is_none() {
            return;
        }
        let here = env!("CARGO_MANIFEST_DIR");
        let s = status(here).expect("a folder inside a checkout");
        assert!(s.is_repo, "the crate lives inside a git checkout");
        assert!(!s.branch.is_empty());
        assert!(!s.last_commit.is_empty());
        // A folder that is not a repository is a normal answer, not an error.
        let tmp = std::env::temp_dir();
        assert!(status(tmp.to_str().unwrap()).is_ok());
        assert!(status("relative/path").is_err());
    }

    #[test]
    fn github_remotes_in_every_common_form() {
        for url in [
            "https://github.com/acme/api.git",
            "https://github.com/acme/api",
            "git@github.com:acme/api.git",
            "ssh://git@github.com/acme/api.git",
        ] {
            assert_eq!(parse_github_remote(url).as_deref(), Some("acme/api"), "{url}");
        }
        assert_eq!(parse_github_remote("https://gitlab.com/acme/api.git"), None);
        assert_eq!(parse_github_remote("https://github.com/acme"), None);
        assert_eq!(parse_github_remote("https://github.com/a b/c"), None);
    }
}
