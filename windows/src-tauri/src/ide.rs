// Which editor the user is working in, so Home says "Cursor" or "WebStorm"
// instead of always "VS Code". Nothing is installed or changed: the running
// processes are read, and the session's own process chain (recorded by the
// relay) decides when several editors are open.

use std::process::Command;

use serde::Serialize;

use crate::platform;

struct Known {
    id: &'static str,
    label: &'static str,
    /// Process names, lowercase, without `.exe`.
    procs: &'static [&'static str],
    /// Command-line launcher that opens a folder, if the editor ships one.
    cli: Option<&'static str>,
}

/// Order matters when several are open and none runs the session: the first wins.
const KNOWN: &[Known] = &[
    Known { id: "cursor", label: "Cursor", procs: &["cursor"], cli: Some("cursor") },
    Known { id: "windsurf", label: "Windsurf", procs: &["windsurf"], cli: Some("windsurf") },
    Known { id: "antigravity", label: "Antigravity", procs: &["antigravity"], cli: Some("antigravity") },
    Known { id: "vscodium", label: "VSCodium", procs: &["vscodium"], cli: Some("codium") },
    Known { id: "code", label: "VS Code", procs: &["code"], cli: Some("code") },
    Known { id: "zed", label: "Zed", procs: &["zed"], cli: Some("zed") },
    Known { id: "idea", label: "IntelliJ IDEA", procs: &["idea64", "idea"], cli: Some("idea") },
    Known { id: "pycharm", label: "PyCharm", procs: &["pycharm64", "pycharm"], cli: Some("pycharm") },
    Known { id: "webstorm", label: "WebStorm", procs: &["webstorm64", "webstorm"], cli: Some("webstorm") },
    Known { id: "rustrover", label: "RustRover", procs: &["rustrover64", "rustrover"], cli: Some("rustrover") },
    Known { id: "clion", label: "CLion", procs: &["clion64", "clion"], cli: Some("clion") },
    Known { id: "goland", label: "GoLand", procs: &["goland64", "goland"], cli: Some("goland") },
    Known { id: "rider", label: "Rider", procs: &["rider64", "rider"], cli: Some("rider") },
    Known { id: "phpstorm", label: "PhpStorm", procs: &["phpstorm64", "phpstorm"], cli: Some("phpstorm") },
    Known { id: "studio", label: "Android Studio", procs: &["studio64", "studio"], cli: Some("studio") },
    Known { id: "vs", label: "Visual Studio", procs: &["devenv"], cli: None },
    Known { id: "sublime", label: "Sublime Text", procs: &["sublime_text"], cli: Some("subl") },
];

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Ide {
    pub id: &'static str,
    pub label: &'static str,
}

fn lookup(process: &str) -> Option<&'static Known> {
    let name = process.trim().to_ascii_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    KNOWN.iter().find(|k| k.procs.contains(&name))
}

/// `(pid, process name)` of everything running.
pub(crate) fn processes() -> Vec<(u32, String)> {
    #[cfg(windows)]
    let out = {
        let mut cmd = Command::new("tasklist");
        cmd.args(["/FO", "CSV", "/NH"]);
        platform::no_console(&mut cmd).output()
    };
    #[cfg(not(windows))]
    let out = {
        let mut cmd = Command::new("ps");
        cmd.args(["-eo", "pid=,comm="]);
        platform::no_console(&mut cmd).output()
    };
    let Ok(out) = out else { return Vec::new() };
    parse_processes(&String::from_utf8_lossy(&out.stdout))
}

/// Reads `tasklist /FO CSV` rows (`"Code.exe","1234",…`) and `ps` rows (`1234 code`).
fn parse_processes(text: &str) -> Vec<(u32, String)> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix('"') {
                let mut parts = rest.split("\",\"");
                let name = parts.next()?;
                let pid = parts.next()?.trim_matches('"').parse().ok()?;
                return Some((pid, name.to_string()));
            }
            let (pid, name) = line.split_once(char::is_whitespace)?;
            Some((pid.parse().ok()?, name.trim().to_string()))
        })
        .collect()
}

/// The editor running the session (found from its process chain), else the
/// first known editor that is open at all.
pub fn detect(session_pids: &[u32]) -> Option<Ide> {
    let running = processes();
    pick(&running, session_pids)
}

fn pick(running: &[(u32, String)], session_pids: &[u32]) -> Option<Ide> {
    let as_ide = |k: &Known| Ide { id: k.id, label: k.label };
    for pid in session_pids {
        if let Some(k) = running.iter().find(|(p, _)| p == pid).and_then(|(_, n)| lookup(n)) {
            return Some(as_ide(k));
        }
    }
    KNOWN
        .iter()
        .find(|k| running.iter().any(|(_, n)| lookup(n).is_some_and(|f| f.id == k.id)))
        .map(as_ide)
}

/// The launcher for an editor id, e.g. `cursor` → `cursor`. Only ids from the
/// table are accepted, so the page can never name an arbitrary program.
pub fn launcher(id: &str) -> Option<&'static str> {
    KNOWN.iter().find(|k| k.id == id).and_then(|k| k.cli)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_tasklist_and_ps_rows() {
        let rows = parse_processes("\"Code.exe\",\"4120\",\"Console\",\"1\",\"90,000 K\"\n  77 zed\n");
        assert_eq!(rows, vec![(4120, "Code.exe".to_string()), (77, "zed".to_string())]);
    }

    #[test]
    fn the_session_chain_beats_the_priority_order() {
        let running = vec![(10, "Code.exe".to_string()), (20, "cursor.exe".to_string()), (30, "pwsh.exe".to_string())];
        assert_eq!(pick(&running, &[30, 10]).unwrap().id, "code");
        // No chain: the first editor in the table that is open.
        assert_eq!(pick(&running, &[]).unwrap().id, "cursor");
        assert_eq!(pick(&[(1, "explorer.exe".to_string())], &[1]), None);
    }

    #[test]
    fn only_known_editors_have_a_launcher() {
        assert_eq!(launcher("cursor"), Some("cursor"));
        assert_eq!(launcher("vs"), None);
        assert_eq!(launcher("calc"), None);
    }
}
