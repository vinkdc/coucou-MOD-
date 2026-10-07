// "Always allow" for agent permission requests. A rule exists only because the learner
// pressed Always on a request, and it is as narrow as the request was: this tool, in this
// project, and for Bash only this first word of the command (so allowing `npm` does not
// allow `rm`). The list lives on this PC, is shown in Settings and can be emptied there.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Rule {
    pub tool: String,
    pub project: String,
    /// First word of a Bash command; empty for other tools.
    pub prefix: String,
}

fn path() -> PathBuf {
    crate::platform::config_dir().join("always-allow.json")
}

pub fn list() -> Vec<Rule> {
    std::fs::read(path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(rules: &[Rule]) -> Result<(), String> {
    let p = path();
    if let Some(dir) = p.parent() {
        crate::platform::ensure_private_dir(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, serde_json::to_vec_pretty(rules).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

pub fn add(rule: Rule) -> Result<(), String> {
    let mut rules = list();
    if !rules.contains(&rule) {
        rules.push(rule);
    }
    save(&rules)
}

pub fn remove(index: usize) -> Result<(), String> {
    let mut rules = list();
    if index < rules.len() {
        rules.remove(index);
    }
    save(&rules)
}

fn last_component(path: &str) -> String {
    path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

/// The rule a permission request would be covered by.
pub fn key_of(payload: &Value) -> Option<Rule> {
    let tool = payload.get("tool_name")?.as_str()?.to_string();
    let project = last_component(payload.get("cwd").and_then(Value::as_str).unwrap_or(""));
    let prefix = if tool == "Bash" {
        payload
            .pointer("/tool_input/command")
            .and_then(Value::as_str)
            .and_then(|c| c.split_whitespace().next())
            .map(str::to_string)?
    } else {
        String::new()
    };
    Some(Rule { tool, project, prefix })
}

/// Already allowed for good by an earlier click.
pub fn matches(payload: &Value) -> bool {
    key_of(payload).is_some_and(|k| list().contains(&k))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bash_rules_are_per_first_word() {
        let a = key_of(&json!({"tool_name":"Bash","cwd":"C:\\x\\app","tool_input":{"command":"npm run build"}})).unwrap();
        let b = key_of(&json!({"tool_name":"Bash","cwd":"C:\\x\\app","tool_input":{"command":"rm -rf dist"}})).unwrap();
        assert_eq!(a.prefix, "npm");
        assert_ne!(a, b);
        assert_eq!(a.project, "app");
    }

    #[test]
    fn other_tools_have_no_prefix() {
        let k = key_of(&json!({"tool_name":"Edit","cwd":"/home/me/app","tool_input":{"file_path":"a.ts"}})).unwrap();
        assert_eq!((k.tool.as_str(), k.prefix.as_str()), ("Edit", ""));
    }
}
