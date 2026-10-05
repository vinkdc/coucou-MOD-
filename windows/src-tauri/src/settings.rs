// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    /// The edge the island springs from on that display: "top" or "bottom", centred.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_position")]
    pub position: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
    /// Global shortcut that summons or dismisses the island.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_true")]
    pub hotkey_enabled: bool,
    #[serde(default = "default_hotkey")]
    pub hotkey_accelerator: String,
    /// Which AI answers in the chat: "claude" or "gemini".
    #[serde(default = "default_provider")]
    pub provider: String,
    /// Gemini model id; empty = the first "flash" model the key can use.
    #[serde(default)]
    pub gemini_model: String,
    /// The character's look: "mochi" (default) or "ribbon".
    #[serde(default = "default_skin")]
    pub skin: String,
    /// What the chat calls the user (a character's `{{user}}`). Empty = never named.
    #[serde(default)]
    pub user_name: String,
    /// Keyboard controls the user rebound, by action id; the page checks each one.
    #[serde(default)]
    pub keys: std::collections::HashMap<String, String>,
    /// Which workspace preset shapes Home and the Tools tab: "developer" for now.
    #[serde(default = "default_role")]
    pub role: String,
    /// Project folders pinned in the Scripts tool, besides the ones sessions work in.
    #[serde(default)]
    pub projects: Vec<String>,
}

fn default_role() -> String {
    "developer".to_string()
}

fn default_skin() -> String {
    "mochi".to_string()
}

fn default_provider() -> String {
    "claude".to_string()
}

fn default_true() -> bool {
    true
}

fn default_hotkey() -> String {
    crate::hotkey::DEFAULT_ACCELERATOR.to_string()
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

fn default_position() -> String {
    "top".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
            screen: "primary".into(),
            position: default_position(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            hotkey_enabled: true,
            hotkey_accelerator: default_hotkey(),
            provider: default_provider(),
            gemini_model: String::new(),
            skin: default_skin(),
            user_name: String::new(),
            keys: std::collections::HashMap::new(),
            role: default_role(),
            projects: Vec::new(),
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::platform::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}
