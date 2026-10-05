// Developer tools that need no AI: which dev servers are listening (and
// stopping one), and the scripts a project defines (and running one in a
// visible terminal). Everything is read from the machine or the project's own
// files; the page never supplies a command line.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::platform;

// ── Ports ────────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Port {
    pub port: u16,
    pub addr: String,
    pub pid: u32,
    pub process: String,
    /// A known development runtime (node, python, cargo …): listed first.
    pub dev: bool,
}

/// Programs that serve development builds; the rest of the list is shown after them.
const DEV_PROCS: &[&str] = &[
    "node", "bun", "deno", "python", "python3", "pythonw", "uvicorn", "flask", "cargo", "trunk",
    "dotnet", "java", "javaw", "php", "ruby", "go", "vite", "next-server", "hugo", "jekyll",
];

/// Windows services and system processes that listen but are never the user's to stop.
const SYSTEM_PROCS: &[&str] = &[
    "system", "svchost", "lsass", "wininit", "services", "spoolsv", "smss", "csrss", "winlogon",
    "registry", "idle", "system idle process", "wudfhost", "sihost", "dwm", "fontdrvhost",
    "searchindexer", "msmpeng", "nissrv", "mdnsresponder", "coucou",
];

fn base_name(process: &str) -> String {
    let lower = process.trim().to_ascii_lowercase();
    lower.strip_suffix(".exe").map(str::to_string).unwrap_or(lower)
}

/// `netstat -ano -p TCP` rows: `  TCP    0.0.0.0:5173    0.0.0.0:0    LISTENING    1234`.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_netstat(text: &str) -> Vec<(u16, String, u32)> {
    text.lines()
        .filter_map(|line| {
            let mut cols = line.split_whitespace();
            if !cols.next()?.eq_ignore_ascii_case("tcp") {
                return None;
            }
            let local = cols.next()?;
            let _remote = cols.next()?;
            if !cols.next()?.eq_ignore_ascii_case("listening") {
                return None;
            }
            let pid = cols.next()?.parse().ok()?;
            let (addr, port) = local.rsplit_once(':')?;
            Some((port.parse().ok()?, addr.trim_matches(['[', ']']).to_string(), pid))
        })
        .collect()
}

/// `ss -ltnpH` rows: `LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=1234,fd=20))`.
#[cfg_attr(windows, allow(dead_code))]
fn parse_ss(text: &str) -> Vec<(u16, String, u32)> {
    text.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            let local = cols.get(3)?;
            let (addr, port) = local.rsplit_once(':')?;
            let pid = line.split("pid=").nth(1)?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
            Some((port.parse().ok()?, addr.trim_matches(['[', ']']).to_string(), pid))
        })
        .collect()
}

/// What is listening right now, development servers first. One row per port.
pub fn listening_ports() -> Vec<Port> {
    #[cfg(windows)]
    let raw = {
        let mut cmd = Command::new("netstat");
        cmd.args(["-ano", "-p", "TCP"]);
        platform::no_console(&mut cmd)
            .output()
            .map(|o| parse_netstat(&String::from_utf8_lossy(&o.stdout)))
    };
    #[cfg(not(windows))]
    let raw = {
        let mut cmd = Command::new("ss");
        cmd.args(["-ltnpH"]);
        platform::no_console(&mut cmd)
            .output()
            .map(|o| parse_ss(&String::from_utf8_lossy(&o.stdout)))
    };
    let Ok(raw) = raw else { return Vec::new() };
    let names = crate::ide::processes();
    build_ports(raw, &names)
}

fn build_ports(raw: Vec<(u16, String, u32)>, names: &[(u32, String)]) -> Vec<Port> {
    let mut out: Vec<Port> = Vec::new();
    for (port, addr, pid) in raw {
        if pid <= 4 || out.iter().any(|p| p.port == port) {
            continue;
        }
        let process = names.iter().find(|(p, _)| *p == pid).map(|(_, n)| base_name(n)).unwrap_or_default();
        if process.is_empty() || SYSTEM_PROCS.contains(&process.as_str()) {
            continue;
        }
        let dev = DEV_PROCS.contains(&process.as_str());
        out.push(Port { port, addr, pid, process, dev });
    }
    out.sort_by(|a, b| b.dev.cmp(&a.dev).then(a.port.cmp(&b.port)));
    out
}

/// Only a process that is listening on a port right now, and is not this app or the system.
fn may_kill(pid: u32, listening: &[Port]) -> bool {
    pid > 4 && pid != std::process::id() && listening.iter().any(|p| p.pid == pid)
}

pub fn kill_port_process(pid: u32) -> Result<(), String> {
    if !may_kill(pid, &listening_ports()) {
        return Err("That process is not a listening server any more.".into());
    }
    platform::kill_tree(pid);
    Ok(())
}

// ── Scripts ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Script {
    /// "npm" (or pnpm, yarn, bun), "cargo" or "make".
    pub kind: String,
    pub name: String,
    /// What runs, for display and for the terminal: `npm run dev`.
    pub cmd: String,
}

const MAX_MANIFEST: u64 = 512 * 1024;
const MAX_SCRIPTS: usize = 40;

fn read_small(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_MANIFEST {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// A script or target name is a plain word: it never reaches a shell as anything else.
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '_' | '/' | '-'))
}

fn package_manager(dir: &Path) -> &'static str {
    if dir.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if dir.join("yarn.lock").exists() {
        "yarn"
    } else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
        "bun"
    } else {
        "npm"
    }
}

fn parse_package_json(text: &str, runner: &str) -> Vec<Script> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else { return Vec::new() };
    let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) else { return Vec::new() };
    scripts
        .keys()
        .filter(|k| safe_name(k))
        .map(|k| Script { kind: runner.into(), name: k.clone(), cmd: format!("{runner} run {k}") })
        .collect()
}

fn parse_makefile(text: &str) -> Vec<Script> {
    let mut out: Vec<Script> = Vec::new();
    for line in text.lines() {
        // A target starts in column 0: `build:` or `test: deps`. Variables (`A := 1`),
        // pattern rules (`%.o:`), special targets (`.PHONY:`) and recipes are skipped.
        if line.starts_with([' ', '\t', '.', '#']) {
            continue;
        }
        let Some((head, rest)) = line.split_once(':') else { continue };
        if rest.starts_with('=') || head.contains(['=', '%', '$', ' ']) || !safe_name(head) {
            continue;
        }
        if !out.iter().any(|s| s.name == head) {
            out.push(Script { kind: "make".into(), name: head.into(), cmd: format!("make {head}") });
        }
    }
    out
}

/// Everything the folder's own files define, nothing more.
pub fn project_scripts(dir: &str) -> Result<Vec<Script>, String> {
    let dir = Path::new(dir);
    if !dir.is_dir() {
        return Err("That folder does not exist.".into());
    }
    let mut out = Vec::new();
    if let Some(text) = read_small(&dir.join("package.json")) {
        out.extend(parse_package_json(&text, package_manager(dir)));
    }
    if dir.join("Cargo.toml").is_file() {
        for name in ["run", "build", "test", "check"] {
            out.push(Script { kind: "cargo".into(), name: name.into(), cmd: format!("cargo {name}") });
        }
    }
    if let Some(text) = read_small(&dir.join("Makefile")) {
        out.extend(parse_makefile(&text));
    }
    out.truncate(MAX_SCRIPTS);
    Ok(out)
}

/// Opens a visible terminal in `dir` running one of the project's own scripts.
/// The page names the script; the command line is rebuilt here from the files.
pub fn run_script(dir: &str, kind: &str, name: &str) -> Result<(), String> {
    if !safe_name(name) {
        return Err("Not a script name.".into());
    }
    let scripts = project_scripts(dir)?;
    let script = scripts
        .iter()
        .find(|s| s.kind == kind && s.name == name)
        .ok_or("This project does not define that script.")?;
    open_terminal(dir, &script.cmd)
}

#[cfg(windows)]
fn open_terminal(dir: &str, line: &str) -> Result<(), String> {
    // Windows Terminal when it is installed, else a plain PowerShell window.
    let mut wt = Command::new("wt");
    wt.args(["-d", dir, "powershell", "-NoExit", "-Command", line]);
    if platform::no_console(&mut wt).spawn().is_ok() {
        return Ok(());
    }
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", "start", "", "/D", dir, "powershell", "-NoExit", "-Command", line]);
    platform::no_console(&mut cmd).spawn().map(|_| ()).map_err(|e| format!("Could not open a terminal: {e}"))
}

#[cfg(not(windows))]
fn open_terminal(dir: &str, line: &str) -> Result<(), String> {
    let script = format!("{line}; exec \"${{SHELL:-sh}}\"");
    let mut cmd = Command::new("x-terminal-emulator");
    cmd.current_dir(dir).args(["-e", "sh", "-c", &script]);
    platform::no_console(&mut cmd).spawn().map(|_| ()).map_err(|e| format!("Could not open a terminal: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_netstat_listeners_only() {
        let text = "\
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       4321
  TCP    [::]:3000              [::]:0                 LISTENING       777
  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     4321
  UDP    0.0.0.0:5353           *:*                                    12";
        let rows = parse_netstat(text);
        assert_eq!(rows, vec![(5173, "0.0.0.0".into(), 4321), (3000, "::".into(), 777)]);
    }

    #[test]
    fn reads_ss_listeners() {
        let text = "LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:((\"node\",pid=1234,fd=20))";
        assert_eq!(parse_ss(text), vec![(5173, "127.0.0.1".into(), 1234)]);
    }

    #[test]
    fn lists_dev_servers_first_and_hides_the_system() {
        let raw = vec![
            (135, "0.0.0.0".into(), 900),
            (8080, "0.0.0.0".into(), 50),
            (5173, "0.0.0.0".into(), 100),
            (5173, "::".into(), 100),
            (445, "0.0.0.0".into(), 4),
        ];
        let names = vec![(900, "svchost.exe".into()), (50, "Spotify.exe".into()), (100, "node.exe".into())];
        let ports = build_ports(raw, &names);
        let seen: Vec<(u16, &str)> = ports.iter().map(|p| (p.port, p.process.as_str())).collect();
        assert_eq!(seen, vec![(5173, "node"), (8080, "spotify")]);
    }

    #[test]
    fn refuses_to_kill_what_is_not_listening_or_is_us() {
        let listening = vec![Port { port: 1, addr: "x".into(), pid: 100, process: "node".into(), dev: true }];
        assert!(may_kill(100, &listening));
        assert!(!may_kill(101, &listening));
        assert!(!may_kill(4, &[Port { pid: 4, ..listening[0].clone() }]));
        let me = std::process::id();
        assert!(!may_kill(me, &[Port { pid: me, ..listening[0].clone() }]));
    }

    #[test]
    fn script_names_are_plain_words() {
        assert!(safe_name("dev"));
        assert!(safe_name("build:prod"));
        assert!(!safe_name("dev && calc"));
        assert!(!safe_name("--version"));
        assert!(!safe_name(""));
        assert!(!safe_name("a b"));
    }

    #[test]
    fn reads_package_scripts_and_skips_odd_names() {
        let json = r#"{"scripts":{"dev":"vite","build":"tsc","x y":"nope","a;b":"nope"}}"#;
        let s = parse_package_json(json, "pnpm");
        let names: Vec<&str> = s.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["dev", "build"]);
        assert_eq!(s[0].cmd, "pnpm run dev");
    }

    #[test]
    fn reads_makefile_targets() {
        let text = ".PHONY: all\nCC := gcc\nall: build\nbuild:\n\tgcc x.c\n%.o: %.c\ntest: build\n";
        let names: Vec<String> = parse_makefile(text).into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["all", "build", "test"]);
    }

    #[test]
    fn an_unknown_script_is_refused() {
        let dir = std::env::temp_dir().join("coucou-devtools-test");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        let d = dir.to_string_lossy().to_string();
        assert!(run_script(&d, "npm", "rm-everything").is_err());
        assert!(run_script(&d, "npm", "dev && calc").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
