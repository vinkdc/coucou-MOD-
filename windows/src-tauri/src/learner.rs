// What Kotoba knows about the learner: an estimated level, every word met in
// conversation with how solid it is, grammar points, recent mistakes and a
// per-day activity log. The tutor writes to it through its tools; the Stats
// view and the tutor's own prompt read from it.
//
// Stored as plain JSON (learner.json) next to settings.json. Dates are the
// learner's local calendar days ("YYYY-MM-DD"), handed in by the page, which
// knows the local time zone; nothing here reads a clock.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Mistakes kept for the stats and the prompt; older ones drop off.
const MAX_MISTAKES: usize = 200;
/// Level estimates kept for the trend line.
const MAX_HISTORY: usize = 365;
/// A word at or above this strength counts as solid, below WEAK as weak.
pub const SOLID: f64 = 0.7;
pub const WEAK: f64 = 0.4;
/// A newly met word starts here.
const NEW_STRENGTH: f64 = 0.2;
/// One assessment may move the level by at most this much: the tutor's
/// estimate from a single exchange is noisy.
const MAX_LEVEL_STEP: f64 = 8.0;
/// How much of a new estimate is taken in.
const LEVEL_BLEND: f64 = 0.35;
/// Days of activity the Stats view gets (12 weeks).
const ACTIVITY_DAYS: i64 = 84;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Learner {
    pub level: Level,
    pub words: BTreeMap<String, Word>,
    pub grammar: BTreeMap<String, Point>,
    pub mistakes: Vec<Mistake>,
    pub days: BTreeMap<String, Day>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Level {
    /// 0 = never seen Japanese, 100 = fluent. Rough JLPT bands in `label_for`.
    pub score: f64,
    pub label: String,
    /// The tutor's latest one-line reason, shown on the level card.
    pub reason: String,
    pub history: Vec<LevelPoint>,
}

impl Default for Level {
    fn default() -> Self {
        Self { score: 0.0, label: label_for(0.0).into(), reason: String::new(), history: Vec::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LevelPoint {
    pub date: String,
    pub score: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Word {
    pub reading: String,
    pub meaning: String,
    pub seen: u32,
    pub correct: u32,
    pub wrong: u32,
    pub first_seen: String,
    pub last_seen: String,
    /// 0..1, how well the learner knows it.
    pub strength: f64,
    /// Spaced repetition: the next review day (YYYY-MM-DD); empty = not scheduled yet.
    pub due: String,
    pub interval_days: u32,
    /// SM-2 ease; 0 = never set (treated as 2.5).
    pub ease: f64,
    pub reps: u32,
    pub lapses: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Point {
    pub seen: u32,
    pub correct: u32,
    pub wrong: u32,
    pub last_seen: String,
    pub strength: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Mistake {
    pub date: String,
    pub said: String,
    pub correct: String,
    /// vocab | grammar | particle | conjugation | kana | other
    pub kind: String,
    pub note: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Day {
    pub messages: u32,
    pub minutes: f64,
    pub new_words: u32,
    pub correct: u32,
    pub wrong: u32,
    /// Cards reviewed.
    pub reviews: u32,
    /// Speaking practice: attempts, and the sum of their scores (0..1).
    pub speaking: u32,
    pub speaking_score: f64,
}

pub const MISTAKE_KINDS: &[&str] = &["vocab", "grammar", "particle", "conjugation", "kana", "other"];

/// Rough bands, so the tutor and the learner share a vocabulary.
pub fn label_for(score: f64) -> &'static str {
    match score {
        s if s < 5.0 => "Absolute beginner",
        s if s < 15.0 => "Kana learner",
        s if s < 30.0 => "Beginner (N5)",
        s if s < 45.0 => "Elementary (N4)",
        s if s < 60.0 => "Intermediate (N3)",
        s if s < 80.0 => "Upper intermediate (N2)",
        _ => "Advanced (N1)",
    }
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

/// Strength after one more use: a right use closes 30 % of the gap to 1, a
/// wrong one halves it. Simple, monotone, and never leaves 0..1.
pub fn next_strength(s: f64, correct: bool) -> f64 {
    if correct { clamp01(s + (1.0 - s) * 0.3) } else { clamp01(s * 0.5) }
}

/// The level after a new estimate: blended in and capped per step.
pub fn blend_level(current: f64, estimate: f64) -> f64 {
    let estimate = estimate.clamp(0.0, 100.0);
    let step = ((estimate - current) * LEVEL_BLEND).clamp(-MAX_LEVEL_STEP, MAX_LEVEL_STEP);
    (current + step).clamp(0.0, 100.0)
}

// ── Calendar days (no time zone: the page hands in local dates) ───────────────

/// Days since 1970-01-01 for a "YYYY-MM-DD" date (Howard Hinnant's algorithm).
pub fn day_number(date: &str) -> Option<i64> {
    let mut it = date.splitn(3, '-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    let d: i64 = it.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

pub fn date_of(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grade {
    Again,
    Hard,
    Good,
    Easy,
}

impl Grade {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "again" => Some(Self::Again),
            "hard" => Some(Self::Hard),
            "good" => Some(Self::Good),
            "easy" => Some(Self::Easy),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub surface: String,
    pub reading: String,
    pub meaning: String,
    pub strength: f64,
    pub reps: u32,
}

const DEFAULT_EASE: f64 = 2.5;
const MIN_EASE: f64 = 1.3;

/// A word is due once its day has come; one never scheduled (older data) is due
/// the day after it was first met.
fn is_due(w: &Word, today: &str) -> bool {
    if w.due.is_empty() {
        !w.first_seen.is_empty() && w.first_seen.as_str() < today
    } else {
        w.due.as_str() <= today
    }
}

/// The day a word came due: its due date, or the day after it was first met.
fn due_key(w: &Word) -> String {
    if w.due.is_empty() {
        day_number(&w.first_seen).map(|n| date_of(n + 1)).unwrap_or_default()
    } else {
        w.due.clone()
    }
}

/// SM-2, trimmed: a miss restarts the ladder (1 day) and lowers the ease; a
/// pass climbs it (1 day, 3 days, then interval × ease); Hard climbs slowly and
/// Easy faster. Strength follows, so Progress and reviews tell the same story.
pub fn schedule(w: &mut Word, grade: Grade, today: &str) {
    let ease = if w.ease < MIN_EASE { DEFAULT_EASE } else { w.ease };
    let interval = w.interval_days.max(1) as f64;
    let (next_interval, next_ease) = match grade {
        Grade::Again => {
            w.lapses += 1;
            w.reps = 0;
            (1.0, (ease - 0.2).max(MIN_EASE))
        }
        Grade::Hard => {
            w.reps += 1;
            ((interval * 1.2).round().max(1.0), (ease - 0.15).max(MIN_EASE))
        }
        Grade::Good => {
            let n = match w.reps {
                0 => 1.0,
                1 => 3.0,
                _ => (interval * ease).round(),
            };
            w.reps += 1;
            (n, ease)
        }
        Grade::Easy => {
            let n = if w.reps == 0 { 3.0 } else { (interval * ease * 1.3).round() };
            w.reps += 1;
            (n, ease + 0.15)
        }
    };
    w.interval_days = next_interval as u32;
    w.ease = next_ease;
    w.strength = match grade {
        Grade::Again => next_strength(w.strength, false),
        Grade::Hard => clamp01(w.strength + (1.0 - w.strength) * 0.1),
        Grade::Good | Grade::Easy => next_strength(w.strength, true),
    };
    w.due = day_number(today).map(|n| date_of(n + w.interval_days as i64)).unwrap_or_default();
}

// ── Updates ───────────────────────────────────────────────────────────────────

impl Learner {
    fn day(&mut self, today: &str) -> &mut Day {
        self.days.entry(today.to_string()).or_default()
    }

    /// The tutor taught a word. Known words are only refreshed.
    pub fn introduce(&mut self, surface: &str, reading: &str, meaning: &str, today: &str) {
        let surface = surface.trim();
        if surface.is_empty() {
            return;
        }
        let is_new = !self.words.contains_key(surface);
        let w = self.words.entry(surface.to_string()).or_insert_with(|| Word {
            first_seen: today.to_string(),
            strength: NEW_STRENGTH,
            // First review the next day, so it has time to be forgotten a little.
            due: day_number(today).map(|n| date_of(n + 1)).unwrap_or_default(),
            ..Word::default()
        });
        if !reading.trim().is_empty() {
            w.reading = reading.trim().to_string();
        }
        if !meaning.trim().is_empty() {
            w.meaning = meaning.trim().to_string();
        }
        w.seen += 1;
        w.last_seen = today.to_string();
        if is_new {
            self.day(today).new_words += 1;
        }
    }

    /// The learner used a word, rightly or not. An unknown word is added.
    pub fn used(&mut self, surface: &str, correct: bool, today: &str) {
        let surface = surface.trim();
        if surface.is_empty() {
            return;
        }
        if !self.words.contains_key(surface) {
            // Produced by the learner unprompted: they already know it a bit.
            self.introduce(surface, "", "", today);
        }
        let w = self.words.get_mut(surface).expect("just inserted");
        w.seen += 1;
        w.last_seen = today.to_string();
        if correct { w.correct += 1 } else { w.wrong += 1 }
        w.strength = next_strength(w.strength, correct);
        let d = self.day(today);
        if correct { d.correct += 1 } else { d.wrong += 1 }
    }

    pub fn grammar_used(&mut self, point: &str, correct: bool, today: &str) {
        let point = point.trim();
        if point.is_empty() {
            return;
        }
        let p = self.grammar.entry(point.to_string()).or_insert_with(|| Point {
            strength: NEW_STRENGTH,
            ..Point::default()
        });
        p.seen += 1;
        p.last_seen = today.to_string();
        if correct { p.correct += 1 } else { p.wrong += 1 }
        p.strength = next_strength(p.strength, correct);
    }

    pub fn mistake(&mut self, said: &str, correct: &str, kind: &str, note: &str, today: &str) {
        let kind = if MISTAKE_KINDS.contains(&kind) { kind } else { "other" };
        self.mistakes.push(Mistake {
            date: today.to_string(),
            said: said.trim().to_string(),
            correct: correct.trim().to_string(),
            kind: kind.to_string(),
            note: note.trim().to_string(),
        });
        if self.mistakes.len() > MAX_MISTAKES {
            let extra = self.mistakes.len() - MAX_MISTAKES;
            self.mistakes.drain(..extra);
        }
        self.day(today).wrong += 1;
    }

    pub fn assess(&mut self, estimate: f64, reason: &str, today: &str) {
        let score = if self.level.history.is_empty() && self.level.score == 0.0 {
            // First reading: take the estimate within the beginner range only,
            // so one lucky sentence can't place someone at N3.
            estimate.clamp(0.0, 20.0)
        } else {
            blend_level(self.level.score, estimate)
        };
        self.level.score = (score * 10.0).round() / 10.0;
        self.level.label = label_for(self.level.score).to_string();
        self.level.reason = reason.trim().to_string();
        match self.level.history.last_mut() {
            Some(p) if p.date == today => p.score = self.level.score,
            _ => self.level.history.push(LevelPoint { date: today.to_string(), score: self.level.score }),
        }
        if self.level.history.len() > MAX_HISTORY {
            let extra = self.level.history.len() - MAX_HISTORY;
            self.level.history.drain(..extra);
        }
    }

    /// One message from the learner, and how long since the previous one
    /// (capped by the caller, so a lunch break isn't counted as study).
    pub fn message(&mut self, minutes: f64, today: &str) {
        let d = self.day(today);
        d.messages += 1;
        d.minutes += minutes.max(0.0);
    }

    /// A shadowing attempt and how close it was (0..1).
    pub fn log_speaking(&mut self, score: f64, today: &str) {
        let d = self.day(today);
        d.speaking += 1;
        d.speaking_score += score.clamp(0.0, 1.0);
    }

    // ── Reviews (spaced repetition) ────────────────────────────────────────

    /// A word met in a lookup: kept like a taught one, with its first review tomorrow.
    /// False when it was already known (then only refreshed).
    pub fn add_word(&mut self, surface: &str, reading: &str, meaning: &str, today: &str) -> bool {
        let known = self.words.contains_key(surface.trim());
        self.introduce(surface, reading, meaning, today);
        !known
    }

    /// Words to review on `today`, most overdue first, then the weakest.
    pub fn due_words(&self, today: &str, limit: usize) -> Vec<Card> {
        let mut due: Vec<(&String, &Word)> = self.words.iter().filter(|(_, w)| is_due(w, today)).collect();
        due.sort_by(|a, b| due_key(a.1).cmp(&due_key(b.1)).then(a.1.strength.total_cmp(&b.1.strength)));
        due.into_iter()
            .take(limit)
            .map(|(s, w)| Card {
                surface: s.clone(),
                reading: w.reading.clone(),
                meaning: w.meaning.clone(),
                strength: w.strength,
                reps: w.reps,
            })
            .collect()
    }

    pub fn due_count(&self, today: &str) -> u32 {
        self.words.values().filter(|w| is_due(w, today)).count() as u32
    }

    /// The learner graded a card. False for an unknown word or grade.
    pub fn review(&mut self, surface: &str, grade: &str, today: &str) -> bool {
        let Some(g) = Grade::parse(grade) else { return false };
        let Some(w) = self.words.get_mut(surface.trim()) else { return false };
        schedule(w, g, today);
        w.seen += 1;
        w.last_seen = today.to_string();
        let right = g != Grade::Again;
        if right { w.correct += 1 } else { w.wrong += 1 }
        let d = self.day(today);
        d.reviews += 1;
        if right { d.correct += 1 } else { d.wrong += 1 }
        true
    }

    // ── Reading ───────────────────────────────────────────────────────────

    /// Days in a row with at least one message, ending today — or yesterday,
    /// so the streak doesn't read 0 before the first message of the day.
    pub fn streak(&self, today: &str) -> u32 {
        let Some(t) = day_number(today) else { return 0 };
        let active = |n: i64| self.days.get(&date_of(n)).is_some_and(|d| d.messages > 0);
        let mut n = if active(t) { t } else { t - 1 };
        let mut count = 0;
        while active(n) {
            count += 1;
            n -= 1;
        }
        count
    }

    fn weak_words(&self, limit: usize) -> Vec<(&String, &Word)> {
        let mut weak: Vec<_> = self.words.iter().filter(|(_, w)| w.strength < WEAK).collect();
        weak.sort_by(|a, b| {
            b.1.wrong.cmp(&a.1.wrong).then(a.1.strength.total_cmp(&b.1.strength)).then(b.1.last_seen.cmp(&a.1.last_seen))
        });
        weak.truncate(limit);
        weak
    }

    /// What the tutor is told about the learner before every reply. Short:
    /// it rides along with every request.
    pub fn summary(&self) -> String {
        let solid = self.words.values().filter(|w| w.strength >= SOLID).count();
        let mut out = format!(
            "Level: {} ({:.0}/100). Words met: {}, solid: {}.",
            self.level.label,
            self.level.score,
            self.words.len(),
            solid
        );
        if self.words.is_empty() {
            out.push_str(" This is a brand-new learner: assume no Japanese at all yet.");
        }
        let weak = self.weak_words(8);
        if !weak.is_empty() {
            let list: Vec<String> = weak
                .iter()
                .map(|(s, w)| if w.reading.is_empty() || &w.reading == *s { s.to_string() } else { format!("{s} ({})", w.reading) })
                .collect();
            out.push_str(&format!("\nWeak words to recycle: {}.", list.join(", ")));
        }
        let mut recent: Vec<_> = self.words.iter().filter(|(_, w)| w.strength >= WEAK).collect();
        recent.sort_by(|a, b| b.1.last_seen.cmp(&a.1.last_seen).then(b.1.seen.cmp(&a.1.seen)));
        if !recent.is_empty() {
            let list: Vec<&str> = recent.iter().take(15).map(|(s, _)| s.as_str()).collect();
            out.push_str(&format!("\nKnown words (recent): {}.", list.join(", ")));
        }
        let weak_grammar: Vec<&str> =
            self.grammar.iter().filter(|(_, p)| p.strength < WEAK && p.wrong > 0).map(|(k, _)| k.as_str()).take(5).collect();
        if !weak_grammar.is_empty() {
            out.push_str(&format!("\nGrammar to reinforce: {}.", weak_grammar.join(", ")));
        }
        let last: Vec<String> = self
            .mistakes
            .iter()
            .rev()
            .take(4)
            .map(|m| format!("\"{}\" → \"{}\" ({})", m.said, m.correct, m.kind))
            .collect();
        if !last.is_empty() {
            out.push_str(&format!("\nRecent mistakes: {}.", last.join("; ")));
        }
        out
    }

    pub fn stats(&self, today: &str) -> Stats {
        let t = day_number(today).unwrap_or(0);
        let activity: Vec<DayStat> = (0..ACTIVITY_DAYS)
            .rev()
            .map(|back| {
                let date = date_of(t - back);
                let d = self.days.get(&date).cloned().unwrap_or_default();
                DayStat { date, messages: d.messages, minutes: d.minutes, new_words: d.new_words, correct: d.correct, wrong: d.wrong, reviews: d.reviews }
            })
            .collect();
        let (c30, w30) = activity.iter().rev().take(30).fold((0, 0), |(c, w), d| (c + d.correct, w + d.wrong));
        let (speaking30, speaking_sum30) = (0..30)
            .filter_map(|back| self.days.get(&date_of(t - back)))
            .fold((0u32, 0.0f64), |(n, sum), d| (n + d.speaking, sum + d.speaking_score));
        let mut by_kind: Vec<KindCount> = MISTAKE_KINDS
            .iter()
            .map(|k| KindCount { kind: k.to_string(), count: self.mistakes.iter().filter(|m| m.kind == *k).count() as u32 })
            .collect();
        by_kind.retain(|k| k.count > 0);
        by_kind.sort_by(|a, b| b.count.cmp(&a.count));
        let total_minutes: f64 = self.days.values().map(|d| d.minutes).sum();
        Stats {
            level: self.level.clone(),
            streak: self.streak(today),
            best_streak: self.best_streak(),
            words: self.words.len() as u32,
            solid: self.words.values().filter(|w| w.strength >= SOLID).count() as u32,
            weak: self.words.values().filter(|w| w.strength < WEAK).count() as u32,
            accuracy30: if c30 + w30 == 0 { None } else { Some(c30 as f64 / (c30 + w30) as f64) },
            total_minutes,
            today_minutes: self.days.get(today).map(|d| d.minutes).unwrap_or(0.0),
            today_messages: self.days.get(today).map(|d| d.messages).unwrap_or(0),
            activity,
            mistakes_by_kind: by_kind,
            weak_words: self
                .weak_words(12)
                .into_iter()
                .map(|(s, w)| WordStat { surface: s.clone(), reading: w.reading.clone(), meaning: w.meaning.clone(), strength: w.strength })
                .collect(),
            recent_mistakes: self.mistakes.iter().rev().take(8).cloned().collect(),
            known: self.words.iter().filter(|(_, w)| w.strength >= SOLID).map(|(s, _)| s.clone()).collect(),
            due_today: self.due_count(today),
            speaking30,
            speaking_avg30: if speaking30 == 0 { None } else { Some(speaking_sum30 / speaking30 as f64) },
        }
    }

    fn best_streak(&self) -> u32 {
        let mut days: Vec<i64> =
            self.days.iter().filter(|(_, d)| d.messages > 0).filter_map(|(k, _)| day_number(k)).collect();
        days.sort_unstable();
        let (mut best, mut run, mut prev) = (0u32, 0u32, None::<i64>);
        for n in days {
            run = if prev == Some(n - 1) { run + 1 } else { 1 };
            best = best.max(run);
            prev = Some(n);
        }
        best
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub level: Level,
    pub streak: u32,
    pub best_streak: u32,
    pub words: u32,
    pub solid: u32,
    pub weak: u32,
    pub accuracy30: Option<f64>,
    pub total_minutes: f64,
    pub today_minutes: f64,
    pub today_messages: u32,
    pub activity: Vec<DayStat>,
    pub mistakes_by_kind: Vec<KindCount>,
    pub weak_words: Vec<WordStat>,
    pub recent_mistakes: Vec<Mistake>,
    /// Words the learner knows well: their furigana can be hidden.
    pub known: Vec<String>,
    /// Cards waiting for review today.
    pub due_today: u32,
    /// Speaking practice over the last 30 days: attempts and the mean score.
    pub speaking30: u32,
    pub speaking_avg30: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayStat {
    pub date: String,
    pub messages: u32,
    pub reviews: u32,
    pub minutes: f64,
    pub new_words: u32,
    pub correct: u32,
    pub wrong: u32,
}

#[derive(Debug, Serialize)]
pub struct KindCount {
    pub kind: String,
    pub count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordStat {
    pub surface: String,
    pub reading: String,
    pub meaning: String,
    pub strength: f64,
}

// ── Storage ───────────────────────────────────────────────────────────────────

fn path() -> PathBuf {
    crate::platform::config_dir().join("learner.json")
}

pub fn load() -> Learner {
    std::fs::read(path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Written to a temporary file and renamed over the old one, so a crash
/// mid-write never leaves a half-written learner.json.
pub fn save(learner: &Learner) -> std::io::Result<()> {
    let dir = crate::platform::config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(learner).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = dir.join("learner.json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(tmp, path())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_round_trip_and_count_days() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(date_of(0), "1970-01-01");
        for d in ["2024-02-29", "2026-10-06", "2000-03-01", "1999-12-31"] {
            assert_eq!(date_of(day_number(d).unwrap()), d);
        }
        assert_eq!(day_number("2026-03-01").unwrap() - day_number("2026-02-28").unwrap(), 1);
        assert_eq!(day_number("nope"), None);
        assert_eq!(day_number("2026-13-01"), None);
    }

    #[test]
    fn strength_rises_on_right_use_and_halves_on_wrong() {
        let up = next_strength(0.2, true);
        assert!((up - 0.44).abs() < 1e-9);
        assert!((next_strength(0.6, false) - 0.3).abs() < 1e-9);
        let mut s = 0.0;
        for _ in 0..100 {
            s = next_strength(s, true);
        }
        assert!(s <= 1.0 && s > 0.99);
    }

    #[test]
    fn level_moves_gradually() {
        assert!((blend_level(10.0, 20.0) - 13.5).abs() < 1e-9);
        assert_eq!(blend_level(10.0, 100.0), 18.0); // capped step
        assert!((blend_level(1.0, -50.0) - 0.65).abs() < 1e-9); // estimate clamped to 0 first
        assert!((blend_level(10.0, 0.0) - 6.5).abs() < 1e-9);
    }

    #[test]
    fn first_assessment_stays_in_beginner_range_then_blends() {
        let mut l = Learner::default();
        l.assess(55.0, "wrote a long sentence", "2026-10-06");
        assert_eq!(l.level.score, 20.0);
        assert_eq!(l.level.label, "Beginner (N5)");
        l.assess(30.0, "", "2026-10-06");
        assert_eq!(l.level.score, 23.5);
        // One point per day in the history.
        assert_eq!(l.level.history.len(), 1);
        l.assess(30.0, "", "2026-10-07");
        assert_eq!(l.level.history.len(), 2);
    }

    #[test]
    fn introducing_and_using_words_updates_counts_and_days() {
        let mut l = Learner::default();
        l.introduce("水", "みず", "water", "2026-10-06");
        l.introduce("水", "", "", "2026-10-06");
        assert_eq!(l.words["水"].reading, "みず");
        assert_eq!(l.days["2026-10-06"].new_words, 1);
        l.used("水", true, "2026-10-06");
        l.used("猫", false, "2026-10-06");
        assert_eq!(l.words["水"].correct, 1);
        assert_eq!(l.words["猫"].wrong, 1);
        assert!(l.words["猫"].strength < NEW_STRENGTH);
        let d = &l.days["2026-10-06"];
        assert_eq!((d.correct, d.wrong, d.new_words), (1, 1, 2));
        l.used("  ", true, "2026-10-06");
        assert_eq!(l.words.len(), 2);
    }

    #[test]
    fn mistakes_are_capped_and_kinds_normalised() {
        let mut l = Learner::default();
        for i in 0..(MAX_MISTAKES + 5) {
            l.mistake(&format!("x{i}"), "y", "weird", "", "2026-10-06");
        }
        assert_eq!(l.mistakes.len(), MAX_MISTAKES);
        assert_eq!(l.mistakes[0].said, "x5");
        assert_eq!(l.mistakes[0].kind, "other");
    }

    #[test]
    fn streak_counts_back_from_today_or_yesterday() {
        let mut l = Learner::default();
        assert_eq!(l.streak("2026-10-06"), 0);
        for d in ["2026-10-02", "2026-10-04", "2026-10-05"] {
            l.message(1.0, d);
        }
        // Nothing yet today: yesterday's run still counts.
        assert_eq!(l.streak("2026-10-06"), 2);
        l.message(1.0, "2026-10-06");
        assert_eq!(l.streak("2026-10-06"), 3);
        assert_eq!(l.streak("2026-10-08"), 0);
        assert_eq!(l.best_streak(), 3);
    }

    #[test]
    fn summary_mentions_weak_words_and_mistakes() {
        let mut l = Learner::default();
        assert!(l.summary().contains("brand-new learner"));
        l.introduce("猫", "ねこ", "cat", "2026-10-06");
        l.used("猫", false, "2026-10-06");
        l.introduce("水", "みず", "water", "2026-10-06");
        for _ in 0..4 {
            l.used("水", true, "2026-10-06");
        }
        l.mistake("わたしわ", "わたしは", "particle", "は is read wa", "2026-10-06");
        let s = l.summary();
        assert!(s.contains("Weak words to recycle: 猫 (ねこ)"), "{s}");
        assert!(s.contains("Known words (recent): 水"), "{s}");
        assert!(s.contains("\"わたしわ\" → \"わたしは\" (particle)"), "{s}");
        assert!(!s.contains("brand-new"));
    }

    #[test]
    fn stats_cover_twelve_weeks_and_thirty_day_accuracy() {
        let mut l = Learner::default();
        l.used("水", true, "2026-10-06");
        l.used("水", true, "2026-10-06");
        l.used("猫", false, "2026-08-01"); // outside 30 days
        l.message(3.0, "2026-10-06");
        let s = l.stats("2026-10-06");
        assert_eq!(s.activity.len(), ACTIVITY_DAYS as usize);
        assert_eq!(s.activity.last().unwrap().date, "2026-10-06");
        assert_eq!(s.accuracy30, Some(1.0));
        assert_eq!(s.today_minutes, 3.0);
        assert_eq!(s.streak, 1);
        assert_eq!(s.words, 2);
    }

    #[test]
    fn old_or_partial_json_still_loads() {
        let l: Learner = serde_json::from_str(r#"{"words":{"水":{"reading":"みず"}}}"#).unwrap();
        assert_eq!(l.words["水"].reading, "みず");
        assert_eq!(l.level.label, "Absolute beginner");
    }
    #[test]
    fn new_words_are_due_the_next_day() {
        let mut l = Learner::default();
        assert!(l.add_word("駅", "えき", "station", "2026-10-06"));
        assert!(!l.add_word("駅", "", "", "2026-10-06"));
        assert_eq!(l.words["駅"].due, "2026-10-07");
        assert!(l.due_words("2026-10-06", 10).is_empty());
        let due = l.due_words("2026-10-07", 10);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].reading, "えき");
        assert_eq!(l.due_count("2026-10-07"), 1);
    }

    #[test]
    fn the_ladder_climbs_on_good_and_resets_on_again() {
        let mut l = Learner::default();
        l.add_word("駅", "えき", "station", "2026-10-06");
        let mut day = "2026-10-07".to_string();
        let mut seen = vec![];
        for _ in 0..4 {
            assert!(l.review("駅", "good", &day));
            seen.push(l.words["駅"].interval_days);
            day = l.words["駅"].due.clone();
        }
        // 1 day, 3 days, then x ease (2.5): 8, 20.
        assert_eq!(seen, vec![1, 3, 8, 20]);
        assert!(l.review("駅", "again", &day));
        let w = &l.words["駅"];
        assert_eq!((w.interval_days, w.reps, w.lapses), (1, 0, 1));
        assert!(w.ease < 2.5 && w.ease >= MIN_EASE);
        assert_eq!(w.due, date_of(day_number(&day).unwrap() + 1));
    }

    #[test]
    fn hard_is_slow_easy_is_fast_and_strength_follows() {
        let mut hard = Word { interval_days: 10, reps: 3, strength: 0.5, ..Word::default() };
        let mut easy = hard.clone();
        schedule(&mut hard, Grade::Hard, "2026-10-06");
        schedule(&mut easy, Grade::Easy, "2026-10-06");
        assert_eq!(hard.interval_days, 12);
        assert_eq!(easy.interval_days, 33); // 10 x 2.5 x 1.3, rounded
        assert!(hard.strength > 0.5 && hard.strength < easy.strength);
        assert!(hard.ease < DEFAULT_EASE && easy.ease > DEFAULT_EASE);
        let mut miss = Word { strength: 0.8, ..Word::default() };
        schedule(&mut miss, Grade::Again, "2026-10-06");
        assert!((miss.strength - 0.4).abs() < 1e-9);
    }

    #[test]
    fn due_words_are_most_overdue_first_and_unscheduled_old_words_count() {
        let mut l = Learner::default();
        for (w, due) in [("a", "2026-10-05"), ("b", "2026-10-01"), ("c", "2026-10-09")] {
            l.words.insert(w.into(), Word { due: due.into(), first_seen: "2026-09-01".into(), strength: 0.5, ..Word::default() });
        }
        // Data from before scheduling existed: no due date, met yesterday.
        l.words.insert("old".into(), Word { first_seen: "2026-10-05".into(), strength: 0.5, ..Word::default() });
        let order: Vec<String> = l.due_words("2026-10-06", 10).into_iter().map(|c| c.surface).collect();
        assert_eq!(order, vec!["b", "a", "old"]);
        assert_eq!(l.due_words("2026-10-06", 2).len(), 2);
    }

    #[test]
    fn reviews_count_in_the_day_and_unknown_input_is_refused() {
        let mut l = Learner::default();
        l.add_word("駅", "", "", "2026-10-06");
        assert!(!l.review("猫", "good", "2026-10-07"));
        assert!(!l.review("駅", "perfect", "2026-10-07"));
        assert!(l.review("駅", "good", "2026-10-07"));
        assert!(l.review("駅", "again", "2026-10-07"));
        let d = &l.days["2026-10-07"];
        assert_eq!((d.reviews, d.correct, d.wrong), (2, 1, 1));
        assert_eq!(l.words["駅"].seen, 3);
    }

    #[test]
    fn speaking_attempts_average_over_thirty_days() {
        let mut l = Learner::default();
        assert_eq!(l.stats("2026-10-06").speaking_avg30, None);
        l.log_speaking(1.0, "2026-10-06");
        l.log_speaking(0.5, "2026-10-05");
        l.log_speaking(0.0, "2026-08-01"); // too old
        l.log_speaking(7.0, "2026-10-06"); // clamped to 1
        let s = l.stats("2026-10-06");
        assert_eq!(s.speaking30, 3);
        assert!((s.speaking_avg30.unwrap() - (2.5 / 3.0)).abs() < 1e-9);
    }

    #[test]
    fn learner_json_from_before_scheduling_still_loads() {
        let l: Learner = serde_json::from_str(r#"{"words":{"水":{"reading":"みず","firstSeen":"2026-10-01","strength":0.6}}}"#).unwrap();
        assert_eq!(l.words["水"].interval_days, 0);
        assert_eq!(l.due_count("2026-10-06"), 1);
    }
}
