// Google Calendar, Tasks and YouTube, for the learner's own day: phrases from
// their events and tasks, new uploads from channels they follow, reminders that
// stay quiet during meetings, and a study block or review task added on an
// explicit click. Sign-in is the shared flow in oauth.rs.
//
// Nothing here talks to anyone but Google (and YouTube's public upload feeds);
// event details go to the AI only when the learner presses one item.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};

use crate::oauth::{self, Cache, Provider};
use crate::secrets;

const CALENDAR: &str = "https://www.googleapis.com/calendar/v3";
const TASKS: &str = "https://tasks.googleapis.com/tasks/v1";
const YOUTUBE: &str = "https://www.googleapis.com/youtube/v3";

const CLIENT_ID: &str = "google-client-id";
const CLIENT_SECRET: &str = "google-client-secret";

/// The app's own Google client, baked in at build time (KOTOBA_GOOGLE_CLIENT_ID / _SECRET), so a
/// learner only presses Connect. A desktop client's "secret" is not confidential (Google's own
/// words), and PKCE protects the exchange. Without it, the pasted-in pair in the keychain is used.
const BUILT_IN_ID: Option<&str> = option_env!("KOTOBA_GOOGLE_CLIENT_ID");
const BUILT_IN_SECRET: Option<&str> = option_env!("KOTOBA_GOOGLE_CLIENT_SECRET");

fn credentials() -> Option<(String, Option<String>)> {
    match (BUILT_IN_ID, BUILT_IN_SECRET) {
        (Some(id), Some(secret)) if !id.is_empty() => Some((id.to_string(), Some(secret.to_string()))),
        _ => Some((secrets::get(CLIENT_ID)?, Some(secrets::get(CLIENT_SECRET)?))),
    }
}

/// Events (view and edit), free/busy, Tasks and a read-only look at YouTube subscriptions: no mail, no Drive.
static PROVIDER: Provider = Provider {
    name: "Google",
    auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    scopes: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy \
https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/youtube.readonly",
    extra: &[("access_type", "offline"), ("prompt", "consent")],
    refresh_key: "google-refresh-token",
    fixed_port: None,
    credentials,
};

static ACCESS: Cache = std::sync::Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// A client id and secret are available.
    pub configured: bool,
    /// The app ships its own Google client: the learner has nothing to set up.
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

pub fn disconnect() -> Result<(), String> {
    oauth::disconnect(&PROVIDER, &ACCESS)
}

pub async fn connect(open: impl Fn(&str)) -> Result<(), String> {
    oauth::connect(&PROVIDER, &ACCESS, open).await
}

async fn get(url: &str, query: &[(&str, &str)]) -> Result<Value, String> {
    oauth::get_json(&PROVIDER, &ACCESS, url, query).await
}

async fn post(url: &str, body: &Value) -> Result<Value, String> {
    oauth::post_json(&PROVIDER, &ACCESS, url, body).await
}

// ── Dates (no date crate) ─────────────────────────────────────────────────────

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian.
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Epoch seconds → "2026-10-07T14:30:00Z".
fn rfc3339(secs: i64) -> String {
    let (y, m, d) = civil(secs.div_euclid(86_400));
    let s = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", s / 3600, (s / 60) % 60, s % 60)
}

/// "2026-10-07T14:30:00+02:00" (or Z, or with fractions) → epoch seconds.
fn parse_rfc3339(text: &str) -> Option<i64> {
    let (date, time) = text.split_once('T')?;
    let mut d = date.split('-');
    let (y, m, day): (i64, i64, i64) = (d.next()?.parse().ok()?, d.next()?.parse().ok()?, d.next()?.parse().ok()?);
    let clock: String = time.chars().take(8).collect();
    let mut t = clock.split(':');
    let (h, mi, s): (i64, i64, i64) = (t.next()?.parse().ok()?, t.next()?.parse().ok()?, t.next()?.parse().ok()?);
    let rest = &time[8.min(time.len())..];
    let zone = rest.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    let offset = if zone.starts_with('Z') || zone.is_empty() {
        0
    } else {
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let (oh, om) = zone[1..].split_once(':')?;
        sign * (oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60)
    };
    Some(days_from_civil(y, m, day) * 86_400 + h * 3600 + mi * 60 + s - offset)
}


// ── The learner's day ─────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    /// "event" or "task".
    pub kind: &'static str,
    pub title: String,
    /// Where it is and what its notes say (trimmed). Kept on this PC; the AI sees them only
    /// when the learner presses this one item. Attendees are never read.
    pub location: String,
    pub notes: String,
    /// RFC 3339 start/due (events with a time) or a plain date; empty for an undated task.
    pub when: String,
    pub all_day: bool,
}

/// Notes as plain text: tags dropped, whitespace folded, cut to a few hundred characters.
fn plain(s: &str) -> String {
    let mut out = String::new();
    let mut tag = false;
    for c in s.chars() {
        match c {
            '<' => tag = true,
            '>' => tag = false,
            _ if !tag => out.push(c),
            _ => {}
        }
    }
    let one: String = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > 400 {
        format!("{}…", one.chars().take(399).collect::<String>())
    } else {
        one
    }
}

/// Events in the next three days and open tasks: title, time, place and notes (no attendees).
pub async fn agenda() -> Result<Vec<Item>, String> {
    let now = now_secs();
    let min = rfc3339(now);
    let max = rfc3339(now + 3 * 86_400);
    let events = get(
        &format!("{CALENDAR}/calendars/primary/events"),
        &[("timeMin", &min), ("timeMax", &max), ("singleEvents", "true"), ("orderBy", "startTime"), ("maxResults", "20")],
    )
    .await?;
    let mut items = Vec::new();
    for e in events.get("items").and_then(Value::as_array).into_iter().flatten() {
        let title = e.get("summary").and_then(Value::as_str).unwrap_or("").trim();
        if title.is_empty() {
            continue;
        }
        let (when, all_day) = match (e.pointer("/start/dateTime"), e.pointer("/start/date")) {
            (Some(t), _) => (t.as_str().unwrap_or("").to_string(), false),
            (_, Some(d)) => (d.as_str().unwrap_or("").to_string(), true),
            _ => (String::new(), false),
        };
        items.push(Item { id: format!("e:{}", e.get("id").and_then(Value::as_str).unwrap_or(title)), kind: "event", title: title.to_string(), location: plain(e.get("location").and_then(Value::as_str).unwrap_or("")), notes: plain(e.get("description").and_then(Value::as_str).unwrap_or("")), when, all_day });
    }
    let tasks = get(&format!("{TASKS}/lists/@default/tasks"), &[("showCompleted", "false"), ("maxResults", "20")]).await;
    for t in tasks.ok().as_ref().and_then(|v| v.get("items")).and_then(Value::as_array).into_iter().flatten() {
        let title = t.get("title").and_then(Value::as_str).unwrap_or("").trim();
        if title.is_empty() {
            continue;
        }
        let due = t.get("due").and_then(Value::as_str).unwrap_or("").to_string();
        items.push(Item { id: format!("t:{}", t.get("id").and_then(Value::as_str).unwrap_or(title)), kind: "task", title: title.to_string(), location: String::new(), notes: plain(t.get("notes").and_then(Value::as_str).unwrap_or("")), when: due, all_day: true });
    }
    Ok(items)
}

/// Busy intervals (epoch seconds) in a window.
async fn busy(from: i64, to: i64) -> Result<Vec<(i64, i64)>, String> {
    let v = post(
        &format!("{CALENDAR}/freeBusy"),
        &json!({ "timeMin": rfc3339(from), "timeMax": rfc3339(to), "items": [{ "id": "primary" }] }),
    )
    .await?;
    Ok(v.pointer("/calendars/primary/busy")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|b| Some((parse_rfc3339(b.get("start")?.as_str()?)?, parse_rfc3339(b.get("end")?.as_str()?)?)))
        .collect())
}

/// In a meeting right now.
pub async fn busy_now() -> Result<bool, String> {
    let now = now_secs();
    Ok(!busy(now, now + 60).await?.is_empty())
}

/// Puts a study block in the first free slot of the next 24 hours, 8:00–22:00 local time.
/// Returns the start (RFC 3339, UTC). Only ever called from a button.
pub async fn add_study_block(tz_offset_min: i64, minutes: i64) -> Result<String, String> {
    let step = 15 * 60;
    let len = minutes.clamp(5, 60) * 60;
    let now = now_secs();
    let from = (now + 5 * 60 + step - 1) / step * step;
    let to = now + 24 * 3600;
    let busy = busy(from, to + len).await?;
    let mut t = from;
    while t + len <= to + step {
        let sod = (t + tz_offset_min * 60).rem_euclid(86_400); // local time of day = UTC + offset
        let free = !busy.iter().any(|(s, e)| t < *e && t + len > *s);
        if free && sod >= 8 * 3600 && sod + len <= 22 * 3600 {
            let start = rfc3339(t);
            post(
                &format!("{CALENDAR}/calendars/primary/events"),
                &json!({
                    "summary": "Japanese review (Kotoba)",
                    "description": "A short study block added by Kotoba.",
                    "start": { "dateTime": start },
                    "end": { "dateTime": rfc3339(t + len) },
                    "reminders": { "useDefault": false, "overrides": [{ "method": "popup", "minutes": 5 }] },
                }),
            )
            .await?;
            return Ok(start);
        }
        t += step;
    }
    Err("No free slot in the next 24 hours.".to_string())
}

/// A review task in Google Tasks. Only ever called from a button.
pub async fn add_task(title: &str) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("The task is empty.".into());
    }
    post(&format!("{TASKS}/lists/@default/tasks"), &json!({ "title": title })).await?;
    Ok(())
}


// ── YouTube: new uploads from the channels they follow ────────────────────────
// There is no YouTube notifications API. The subscription list (read-only) gives
// the channels; each channel's public upload feed gives its newest videos.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    pub id: String,
    pub title: String,
    pub channel: String,
    /// RFC 3339.
    pub published: String,
    pub url: String,
}

fn between<'a>(s: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = s.find(open)? + open.len();
    let end = s[start..].find(close)? + start;
    Some(&s[start..end])
}

fn unescape(s: &str) -> String {
    s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
}

/// The newest entries of one channel's feed.
fn parse_feed(xml: &str) -> Vec<Upload> {
    xml.split("<entry>")
        .skip(1)
        .take(3)
        .filter_map(|e| {
            let id = between(e, "<yt:videoId>", "</yt:videoId>")?.to_string();
            Some(Upload {
                url: format!("https://www.youtube.com/watch?v={id}"),
                id,
                title: unescape(between(e, "<title>", "</title>")?),
                channel: unescape(between(e, "<name>", "</name>").unwrap_or("")),
                published: between(e, "<published>", "</published>")?.to_string(),
            })
        })
        .collect()
}

/// Videos from the last week, newest first.
pub async fn youtube_uploads() -> Result<Vec<Upload>, String> {
    let subs = get(
        &format!("{YOUTUBE}/subscriptions"),
        &[("part", "snippet"), ("mine", "true"), ("maxResults", "25"), ("order", "relevance")],
    )
    .await?;
    let channels: Vec<String> = subs
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| s.pointer("/snippet/resourceId/channelId").and_then(Value::as_str).map(str::to_string))
        .collect();
    let http = oauth::client()?;
    let jobs: Vec<_> = channels
        .into_iter()
        .map(|id| {
            let http = http.clone();
            tokio::spawn(async move {
                let text = http
                    .get(format!("https://www.youtube.com/feeds/videos.xml?channel_id={id}"))
                    .send()
                    .await
                    .ok()?
                    .text()
                    .await
                    .ok()?;
                Some(parse_feed(&text))
            })
        })
        .collect();
    let week_ago = now_secs() - 7 * 86_400;
    let mut all = Vec::new();
    for job in jobs {
        if let Ok(Some(list)) = job.await {
            all.extend(list.into_iter().filter(|u| parse_rfc3339(&u.published).is_some_and(|t| t >= week_ago)));
        }
    }
    all.sort_by(|a, b| b.published.cmp(&a.published));
    all.truncate(8);
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_round_trip() {
        let t = parse_rfc3339("2026-10-07T14:30:00+02:00").unwrap();
        assert_eq!(rfc3339(t), "2026-10-07T12:30:00Z");
        assert_eq!(parse_rfc3339("2026-10-07T12:30:00.123Z"), Some(t));
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn feed_entries() {
        let xml = "<feed><title>Channel</title><entry><yt:videoId>abc123</yt:videoId><title>Tom &amp; Jerry</title>\
<author><name>NHK</name></author><published>2026-10-06T10:00:00+00:00</published></entry></feed>";
        let list = parse_feed(xml);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "Tom & Jerry");
        assert_eq!(list[0].channel, "NHK");
        assert_eq!(list[0].url, "https://www.youtube.com/watch?v=abc123");
    }
}
