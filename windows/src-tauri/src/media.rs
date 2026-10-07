// What is playing on this PC, for the Today tab: read from Windows' system media
// controls (the same source as the volume flyout), so it works for the Spotify app,
// a browser tab with YouTube, or any other player, with no account and no sign-in.
// Only the title and artist the player already shows there are read.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// The player's app id, e.g. "Spotify.exe" or "chrome.exe".
    pub app: String,
    pub title: String,
    pub artist: String,
    pub playing: bool,
}

/// The track that is playing now (or, failing that, the last one shown), or None.
#[cfg(windows)]
pub fn now_playing() -> Option<Track> {
    use ::windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use ::windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    // Harmless when this thread is already set up.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let manager = Manager::RequestAsync().ok()?.get().ok()?;
    let mut paused: Option<Track> = None;
    for session in manager.GetSessions().ok()? {
        let Some(props) = session.TryGetMediaPropertiesAsync().ok().and_then(|p| p.get().ok()) else { continue };
        let title = props.Title().map(|t| t.to_string()).unwrap_or_default();
        if title.trim().is_empty() {
            continue;
        }
        let playing = session
            .GetPlaybackInfo()
            .ok()
            .and_then(|i| i.PlaybackStatus().ok())
            .is_some_and(|s| s == Status::Playing);
        let track = Track {
            app: session.SourceAppUserModelId().map(|a| a.to_string()).unwrap_or_default(),
            title,
            artist: props.Artist().map(|a| a.to_string()).unwrap_or_default(),
            playing,
        };
        if playing {
            return Some(track);
        }
        paused.get_or_insert(track);
    }
    paused
}

#[cfg(not(windows))]
pub fn now_playing() -> Option<Track> {
    None
}

#[cfg(test)]
mod tests {
    /// Run by hand with something playing: `cargo test --lib media -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn shows_what_is_playing() {
        match super::now_playing() {
            Some(t) => println!("{} | {} — {} | playing={}", t.app, t.title, t.artist, t.playing),
            None => println!("nothing"),
        }
    }
}
