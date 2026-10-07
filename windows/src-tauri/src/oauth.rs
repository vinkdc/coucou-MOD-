// One sign-in flow for every service the learner may connect (Google, Spotify…):
// the system browser, a loopback redirect on 127.0.0.1 and PKCE. A provider is a
// table row (`Provider`); refresh tokens live in the Credential Manager / Secret
// Service and access tokens only in memory.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::claude::base64_for;
use crate::secrets;

pub struct Provider {
    pub name: &'static str,
    pub auth_url: &'static str,
    pub token_url: &'static str,
    /// Space-separated.
    pub scopes: &'static str,
    /// Extra query parameters on the consent URL (Google: offline access).
    pub extra: &'static [(&'static str, &'static str)],
    /// Keychain key of the refresh token.
    pub refresh_key: &'static str,
    /// Some services (Spotify) only accept a redirect URI registered exactly, port included.
    pub fixed_port: Option<u16>,
    /// The client id (and secret, where the service wants one), baked in or from the keychain.
    pub credentials: fn() -> Option<(String, Option<String>)>,
}

/// An access token kept in memory until it expires.
pub type Cache = Mutex<Option<(String, Instant)>>;

pub fn connected(p: &Provider) -> bool {
    secrets::present(p.refresh_key)
}

pub fn disconnect(p: &Provider, cache: &Cache) -> Result<(), String> {
    *cache.lock().unwrap() = None;
    secrets::clear(p.refresh_key)
}

// ── Small helpers ─────────────────────────────────────────────────────────────

pub fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn url_safe(bytes: &[u8]) -> String {
    base64_for(bytes).replace('+', "-").replace('/', "_").trim_end_matches('=').to_string()
}

fn random_token(len: usize) -> Result<String, String> {
    let mut buf = vec![0u8; len];
    getrandom::getrandom(&mut buf).map_err(|e| format!("No randomness available: {e}"))?;
    Ok(url_safe(&buf))
}

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

/// A JSON answer, or an explained error.
pub async fn body_json(name: &str, response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status.is_success() || status.as_u16() == 204 {
        return Ok(v);
    }
    // The service's own words, never a token: what a failed sign-in needs to be diagnosed.
    let compact: String = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(400).collect();
    crate::log::line(format!("oauth {name}: HTTP {} {compact}", status.as_u16()));
    let reason = v
        .pointer("/error/message")
        .or_else(|| v.get("error_description"))
        .or_else(|| v.get("error"))
        .and_then(Value::as_str)
        .unwrap_or("");
    Err(match status.as_u16() {
        400 if reason.contains("invalid_grant") => format!("{name} sign-in expired. Connect {name} again."),
        401 => format!("{name} sign-in expired. Connect {name} again."),
        403 if reason.to_lowercase().contains("scope") || reason.to_lowercase().contains("permission") => {
            format!("{name} needs a new permission. Disconnect and connect {name} again.")
        }
        403 => format!("{name} refused: {reason}"),
        429 => format!("{name} is rate-limiting. Try again in a moment."),
        s => format!("{name} error {s}: {reason}"),
    })
}

// ── Sign-in ───────────────────────────────────────────────────────────────────

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Kotoba</title>\
<body style=\"font:16px system-ui;background:#323232;color:#ddd;display:grid;place-items:center;height:100vh;margin:0\">\
<div>Connected to Kotoba. You can close this tab.</div>";

/// Opens the browser for consent, catches the redirect, and keeps the refresh token.
pub async fn connect(p: &Provider, cache: &Cache, open: impl Fn(&str)) -> Result<(), String> {
    let (id, secret) = (p.credentials)().ok_or_else(|| format!("{} sign-in isn't set up in this build.", p.name))?;

    let listener = TcpListener::bind(("127.0.0.1", p.fixed_port.unwrap_or(0)))
        .await
        .map_err(|e| format!("Could not listen for {}: {e}", p.name))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    crate::log::line(format!("oauth {}: opening the browser (client {}…, redirect port {port})", p.name, id.chars().take(14).collect::<String>()));
    let redirect = format!("http://127.0.0.1:{port}");
    let verifier = random_token(48)?;
    let challenge = url_safe(&Sha256::digest(verifier.as_bytes()));
    let state = random_token(16)?;

    let mut url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={challenge}&code_challenge_method=S256&state={state}",
        p.auth_url,
        encode(&id),
        encode(&redirect),
        encode(p.scopes),
    );
    for (k, v) in p.extra {
        url.push_str(&format!("&{k}={v}"));
    }
    open(&url);

    let code = tokio::time::timeout(Duration::from_secs(240), async {
        loop {
            let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 4096];
            let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            let target = head.lines().next().unwrap_or("").split_whitespace().nth(1).unwrap_or("").to_string();
            let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
            let param = |name: &str| {
                query.split('&').find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == name).map(|(_, v)| decode(v)))
            };
            if let Some(err) = param("error") {
                crate::log::line(format!("oauth {}: the browser came back with error {err}", p.name));
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nNot connected. You can close this tab.").await;
                return Err(format!("{} said: {err}", p.name));
            }
            if let (Some(code), Some(got)) = (param("code"), param("state")) {
                let ok = got == state;
                crate::log::line(format!("oauth {}: redirect received (state ok: {ok})", p.name));
                let body = if ok { DONE_PAGE } else { "State mismatch." };
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes()).await;
                return if ok { Ok(code) } else { Err(format!("{}'s answer did not match this sign-in.", p.name)) };
            }
            // A favicon or a stray request: answer and keep waiting.
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").await;
        }
    })
    .await
    .map_err(|_| {
        crate::log::line(format!("oauth {}: timed out waiting for the browser", p.name));
        format!("{} sign-in timed out. Try again.", p.name)
    })??;

    let mut form = vec![
        ("client_id", id),
        ("code", code),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code".to_string()),
        ("redirect_uri", redirect),
    ];
    if let Some(secret) = secret {
        form.push(("client_secret", secret));
    }
    let response = client()?
        .post(p.token_url)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("{} is unreachable: {e}", p.name))?;
    let v = body_json(p.name, response).await?;
    let refresh = v
        .get("refresh_token")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{} gave no refresh token. Remove Kotoba from your {} account's connected apps and try again.", p.name, p.name))?;
    secrets::set(p.refresh_key, refresh)?;
    crate::log::line(format!("oauth {}: connected, refresh token saved", p.name));
    cache_access(cache, &v);
    Ok(())
}

fn cache_access(cache: &Cache, v: &Value) {
    if let Some(token) = v.get("access_token").and_then(Value::as_str) {
        let life = v.get("expires_in").and_then(Value::as_u64).unwrap_or(3000).saturating_sub(60);
        *cache.lock().unwrap() = Some((token.to_string(), Instant::now() + Duration::from_secs(life)));
    }
}

/// A valid access token, refreshed when it has expired.
pub async fn access_token(p: &Provider, cache: &Cache) -> Result<String, String> {
    if let Some((token, until)) = cache.lock().unwrap().clone() {
        if Instant::now() < until {
            return Ok(token);
        }
    }
    let refresh = secrets::get(p.refresh_key).ok_or_else(|| format!("{} isn't connected.", p.name))?;
    let (id, secret) = (p.credentials)().ok_or_else(|| format!("{} sign-in isn't set up in this build.", p.name))?;
    let mut form = vec![("client_id", id), ("refresh_token", refresh), ("grant_type", "refresh_token".to_string())];
    if let Some(secret) = secret {
        form.push(("client_secret", secret));
    }
    let response = client()?
        .post(p.token_url)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("{} is unreachable: {e}", p.name))?;
    let v = body_json(p.name, response).await?;
    // Spotify sometimes sends a rotated refresh token; keep the newest.
    if let Some(next) = v.get("refresh_token").and_then(Value::as_str) {
        let _ = secrets::set(p.refresh_key, next);
    }
    cache_access(cache, &v);
    v.get("access_token")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("{} gave no access token.", p.name))
}

pub async fn get_json(p: &Provider, cache: &Cache, url: &str, query: &[(&str, &str)]) -> Result<Value, String> {
    let token = access_token(p, cache).await?;
    let response = client()?
        .get(url)
        .bearer_auth(token)
        .query(query)
        .send()
        .await
        .map_err(|e| format!("{} is unreachable: {e}", p.name))?;
    body_json(p.name, response).await
}

pub async fn post_json(p: &Provider, cache: &Cache, url: &str, body: &Value) -> Result<Value, String> {
    let token = access_token(p, cache).await?;
    let response = client()?
        .post(url)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("{} is unreachable: {e}", p.name))?;
    body_json(p.name, response).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_codec() {
        assert_eq!(encode("a b/c"), "a%20b%2Fc");
        assert_eq!(decode("a%20b+c"), "a b c");
        assert_eq!(decode("100%"), "100%");
    }
}
