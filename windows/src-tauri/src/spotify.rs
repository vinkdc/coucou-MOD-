// Spotify "now playing" for the Today tab. Sign-in is the shared flow in oauth.rs
// (no client secret: PKCE only). Spotify matches the redirect URI exactly, so the
// app uses one fixed loopback port; register `http://127.0.0.1:43189` for the client.

use serde::Serialize;

use crate::oauth::{self, Cache, Provider};
use crate::secrets;

const CLIENT_ID: &str = "spotify-client-id";
const BUILT_IN_ID: Option<&str> = option_env!("KOTOBA_SPOTIFY_CLIENT_ID");

fn credentials() -> Option<(String, Option<String>)> {
    match BUILT_IN_ID {
        Some(id) if !id.is_empty() => Some((id.to_string(), None)),
        _ => Some((secrets::get(CLIENT_ID)?, None)),
    }
}

static PROVIDER: Provider = Provider {
    name: "Spotify",
    auth_url: "https://accounts.spotify.com/authorize",
    token_url: "https://accounts.spotify.com/api/token",
    scopes: "user-read-currently-playing",
    extra: &[],
    refresh_key: "spotify-refresh-token",
    fixed_port: Some(43189),
    credentials,
};

static ACCESS: Cache = std::sync::Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub configured: bool,
    pub built_in: bool,
    pub connected: bool,
}

pub fn status() -> Status {
    Status {
        configured: credentials().is_some(),
        built_in: BUILT_IN_ID.is_some_and(|id| !id.is_empty()),
        connected: oauth::connected(&PROVIDER),
    }
}

pub async fn connect(open: impl Fn(&str)) -> Result<(), String> {
    oauth::connect(&PROVIDER, &ACCESS, open).await
}

pub fn disconnect() -> Result<(), String> {
    oauth::disconnect(&PROVIDER, &ACCESS)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub playing: bool,
}

/// What is playing right now, or None when nothing is (or it is a podcast or an ad).
pub async fn now_playing() -> Result<Option<Track>, String> {
    let v = oauth::get_json(&PROVIDER, &ACCESS, "https://api.spotify.com/v1/me/player/currently-playing", &[]).await?;
    let Some(item) = v.get("item").filter(|i| i.get("artists").is_some()) else {
        return Ok(None);
    };
    let artist = item
        .get("artists")
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|x| x.get("name").and_then(|n| n.as_str())).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    Ok(Some(Track {
        id: item.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string(),
        title: item.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
        artist,
        playing: v.get("is_playing").and_then(|p| p.as_bool()).unwrap_or(false),
    }))
}
