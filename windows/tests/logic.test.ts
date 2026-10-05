import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, normalize } from "../src/study/pronounce.ts";
import {
  decide, emptyState, inQuietHours, shown,
  type Facts, type ReminderSettings, type ReminderState,
} from "../src/island/reminders.ts";

test("normalising folds katakana and drops punctuation", () => {
  assert.equal(normalize("コーヒー、 ください。"), normalize("こーひー ください"));
  assert.equal(normalize("ＡＢＣ"), "abc");
});

test("a line said right scores high and a different one low", () => {
  const same = compare("私は学生です。", "私は学生です");
  assert.equal(same.score, 1);
  assert.equal(same.verdict, "great");
  assert.ok(same.target.every((p) => p.kind === "ok"));

  const off = compare("私は学生です", "今日は天気がいいです");
  assert.equal(off.verdict, "again");
});

test("missed and extra characters are marked", () => {
  const c = compare("おはようございます", "おはようござます");
  assert.equal(c.verdict, "great");
  assert.deepEqual(c.target.map((p) => [p.text, p.kind]), [["おはようござ", "ok"], ["い", "miss"], ["ます", "ok"]]);
  const extra = compare("ありがとう", "ありがとうございます");
  assert.ok(extra.heard.some((p) => p.kind === "extra" && p.text === "ございます"));
  assert.equal(compare("", "はい").verdict, "again");
});

const settings: ReminderSettings = {
  reminders: true, reminderMaxPerDay: 4, quietStart: "22:00", quietEnd: "08:00",
  reminderReview: true, reminderWord: true, reminderQuiz: true, dailyGoalMinutes: 10,
};
const at = (h: number, m = 0) => new Date(2026, 9, 6, h, m);
const facts = (over: Partial<Facts> = {}): Facts => ({
  now: at(14), idleMs: 20_000, prevIdleMs: 20 * 60_000, canShow: true,
  dueCount: 3, words: 12, todayMessages: 5, todayMinutes: 6, ...over,
});
const fresh = (over: Partial<ReminderState> = {}): ReminderState => ({ ...emptyState("2026-10-06"), ...over });

test("quiet hours can span midnight", () => {
  assert.equal(inQuietHours(at(23), "22:00", "08:00"), true);
  assert.equal(inQuietHours(at(3), "22:00", "08:00"), true);
  assert.equal(inQuietHours(at(8), "22:00", "08:00"), false);
  assert.equal(inQuietHours(at(14), "22:00", "08:00"), false);
  assert.equal(inQuietHours(at(12), "13:00", "15:00"), false);
  assert.equal(inQuietHours(at(14), "13:00", "15:00"), true);
  assert.equal(inQuietHours(at(3), "00:00", "00:00"), false);
});

test("after a break with cards due, a review is offered", () => {
  assert.equal(decide(settings, fresh(), facts()), "review");
});

test("guards: off, snoozed, full screen, typing, quiet, cap and gap all stay silent", () => {
  assert.equal(decide({ ...settings, reminders: false }, fresh(), facts()), null);
  assert.equal(decide(settings, fresh({ snoozed: true }), facts()), null);
  assert.equal(decide(settings, fresh(), facts({ canShow: false })), null);
  assert.equal(decide(settings, fresh(), facts({ idleMs: 1_000 })), null);
  assert.equal(decide(settings, fresh(), facts({ now: at(23, 30) })), null);
  assert.equal(decide(settings, fresh({ shown: 4 }), facts()), null);
  const justNow = at(14).getTime() - 30 * 60_000;
  assert.equal(decide(settings, fresh({ shown: 1, lastAt: justNow }), facts()), null);
  assert.equal(decide(settings, fresh({ shown: 1, lastAt: at(14).getTime() - 100 * 60_000 }), facts()), "review");
});

test("no break and no backlog means no reminder", () => {
  assert.equal(decide(settings, fresh(), facts({ prevIdleMs: 30_000 })), null);
  assert.equal(decide(settings, fresh(), facts({ prevIdleMs: 30_000, dueCount: 12 })), "review");
});

test("the first reminder of an idle day is a gentle hello, once", () => {
  const quietDay = facts({ now: at(10), todayMessages: 0, todayMinutes: 0, prevIdleMs: 0 });
  assert.equal(decide(settings, fresh(), quietDay), "nudge");
  assert.equal(decide(settings, fresh({ declined: true, shown: 1, lastAt: 0, lastType: "nudge" }), quietDay), null);
  // Not before 9.
  assert.equal(decide(settings, fresh(), { ...quietDay, now: at(7, 30) }), null);
});

test("a waved-away moment is not repeated, and kinds rotate", () => {
  const declined = fresh({ shown: 1, lastAt: 0, lastType: "review", declined: true });
  assert.equal(decide(settings, declined, facts()), "quiz");
  const rotated = fresh({ shown: 1, lastAt: 0, lastType: "review" });
  assert.equal(decide(settings, rotated, facts()), "quiz");
  assert.equal(decide({ ...settings, reminderQuiz: false }, rotated, facts()), "word");
  // Nothing to offer: no cards, quiz and word off.
  assert.equal(decide({ ...settings, reminderQuiz: false, reminderWord: false }, fresh(), facts({ dueCount: 0 })), null);
  // A quiz needs a few words to ask about.
  assert.equal(decide({ ...settings, reminderWord: false }, fresh(), facts({ dueCount: 0, words: 2 })), null);
});

test("showing a moment counts it and records its kind", () => {
  const st = shown(fresh({ declined: true }), "quiz", at(14));
  assert.deepEqual([st.shown, st.lastType, st.declined, st.lastAt], [1, "quiz", false, at(14).getTime()]);
});
