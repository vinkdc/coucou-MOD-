// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Every field falls back to its default, so a settings.json written by an
/// older build (or by hand) still loads.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    /// The edge Mochi's island springs from on that display: "top" or "bottom", centred.
    pub position: String,
    pub autostart: bool,
    /// Claude model used by the tutor.
    pub model: String,
    /// Global shortcut that summons or dismisses Mochi.
    pub hotkey_enabled: bool,
    pub hotkey_accelerator: String,
    /// Look up the selected text, from any app.
    pub hotkey_lookup: String,
    /// Which AI teaches: "claude", "gemini" or "deepseek".
    pub provider: String,
    /// Gemini model id; empty = the first "flash" model the key can use.
    pub gemini_model: String,
    /// DeepSeek model id; empty = the first "flash" model the key can use.
    pub deepseek_model: String,
    /// The island's look: "dark" (default), "light" or "auto" (follows Windows).
    pub theme: String,
    /// The character's look: "mochi" (default) or an imported skin.
    pub skin: String,
    /// What the tutor calls the learner. Empty = never named.
    pub user_name: String,
    /// Keyboard controls the user rebound, by action id; the page checks each one.
    pub keys: std::collections::HashMap<String, String>,

    // ── Learning ──────────────────────────────────────────────────────────
    /// How much English the tutor gives: "auto" (follows the level), "more", "less".
    pub english_support: String,
    /// Show a romaji line under Japanese.
    pub romaji: bool,
    /// Furigana over kanji: "always", "unknown" (words not yet solid) or "off".
    pub furigana: String,
    /// Show English translations straight away (otherwise tap to reveal).
    pub show_english: bool,
    /// Minutes a day the learner aims for; drives the daily nudge and the ring.
    pub daily_goal_minutes: u32,

    // ── Reminders ─────────────────────────────────────────────────────────
    /// Mochi offers a short moment (a review, a word, a question) at natural breaks.
    #[serde(alias = "dailyNudge")]
    pub reminders: bool,
    /// At most this many reminders a day.
    pub reminder_max_per_day: u32,
    /// No reminders from `quiet_start` to `quiet_end` (HH:MM, local; may span midnight).
    pub quiet_start: String,
    pub quiet_end: String,
    pub reminder_review: bool,
    pub reminder_word: bool,
    pub reminder_quiz: bool,

    // ── Voice (Fish Audio) ────────────────────────────────────────────────
    /// Fish Audio voice model id; empty = Fish Audio's default voice.
    pub tts_voice: String,
    /// Its name, for display only.
    pub tts_voice_name: String,
    pub tts_model: String,
    /// 0.5..2.0; slightly slow by default, for learners.
    pub tts_speed: f64,
    /// Read each new Japanese line aloud as it arrives.
    pub auto_play: bool,

    // ── Assistant ─────────────────────────────────────────────────────────
    /// Let Mochi open links, search the web, control music and read basic PC facts.
    pub pc_tools: bool,
    /// A popup (Explain / Ask… / Listen) when text is selected in any app (Windows).
    pub selection_popup: bool,
    /// Extra apps that never get that popup, by exe name (terminals and password managers are built in).
    pub selection_ignore: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            screen: "primary".into(),
            position: "top".into(),
            autostart: false,
            model: crate::claude::DEFAULT_MODEL.to_string(),
            hotkey_enabled: true,
            hotkey_accelerator: crate::hotkey::DEFAULT_ACCELERATOR.to_string(),
            hotkey_lookup: crate::hotkey::DEFAULT_LOOKUP.to_string(),
            provider: "claude".into(),
            gemini_model: String::new(),
            deepseek_model: String::new(),
            theme: "dark".into(),
            skin: "mochi".into(),
            user_name: String::new(),
            keys: std::collections::HashMap::new(),
            english_support: "auto".into(),
            romaji: true,
            furigana: "always".into(),
            show_english: true,
            daily_goal_minutes: 10,
            reminders: true,
            reminder_max_per_day: 4,
            quiet_start: "22:00".into(),
            quiet_end: "08:00".into(),
            reminder_review: true,
            reminder_word: true,
            reminder_quiz: true,
            tts_voice: "869c71ba122e4d938860eade28f88fc3".into(),
            tts_voice_name: "My voice".into(),
            tts_model: crate::fishaudio::MODELS[0].to_string(),
            tts_speed: 0.9,
            auto_play: true,
            pc_tools: true,
            selection_popup: true,
            selection_ignore: String::new(),
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

/// Where the Claude Code relay lives once installed: a fixed path settings.json can point at.
pub fn hook_exe_path() -> std::path::PathBuf {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_settings_fill_in_defaults() {
        let s: Settings = serde_json::from_str(r#"{"userName":"Bin","ttsSpeed":1.2,"hooksInstalled":true}"#).unwrap();
        assert_eq!(s.user_name, "Bin");
        assert_eq!(s.tts_speed, 1.2);
        assert_eq!(s.furigana, "always");
        assert!(s.auto_play);
        assert_eq!(s.hotkey_lookup, "Ctrl+Alt+J");
    }

    #[test]
    fn the_old_nudge_setting_carries_over() {
        let s: Settings = serde_json::from_str(r#"{"dailyNudge":false}"#).unwrap();
        assert!(!s.reminders);
        assert_eq!(s.reminder_max_per_day, 4);
    }
}
