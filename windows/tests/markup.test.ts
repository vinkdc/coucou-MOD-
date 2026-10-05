// Run with `npm test` (Node's built-in runner; Node strips the types itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import { kanaOf, parseReply, plainJapanese, romajiOf, segments } from "../src/study/markup.ts";
import { kanaToRomaji, toHiragana } from "../src/study/romaji.ts";

test("reply lines become blocks", () => {
  const blocks = parseReply(
    [
      "FIX: わたしわ => わたし{}は | は is read \"wa\"",
      "JP: 今日{きょう}は何{なに}を食{た}べましたか。",
      "EN: What did you eat today?",
      "**NOTE:** ました is the polite past.",
      "NEW: 食べる|たべる|to eat",
      "",
      "Just a stray line",
    ].join("\n"),
  );
  assert.deepEqual(blocks.map((b) => b.kind), ["fix", "jp", "en", "note", "new", "note"]);
  assert.deepEqual(blocks[0], { kind: "fix", said: "わたしわ", correct: "わたし{}は", why: "は is read \"wa\"" });
  assert.deepEqual(blocks[4], { kind: "new", word: "食べる", reading: "たべる", meaning: "to eat" });
  assert.equal((blocks[3] as { text: string }).text, "ました is the polite past.");
});

test("full-width colon and lower-case tags are accepted", () => {
  assert.deepEqual(parseReply("jp：はい"), [{ kind: "jp", text: "はい" }]);
});

test("furigana attaches to the kanji run just before the braces", () => {
  assert.deepEqual(segments("食{た}べました"), [{ base: "食", reading: "た" }, { base: "べました" }]);
  assert.deepEqual(segments("今日{きょう}は"), [{ base: "今日", reading: "きょう" }, { base: "は" }]);
  // Braces after kana carry nothing.
  assert.deepEqual(segments("はい{はい}"), [{ base: "はい" }]);
  assert.equal(plainJapanese("何{なに}を食{た}べる"), "何を食べる");
  assert.equal(kanaOf("何{なに}を食{た}べる"), "なにをたべる");
});

test("romaji follows Hepburn with small tsu, long vowels and n'", () => {
  assert.equal(kanaToRomaji("こんにちは"), "konnichiha");
  assert.equal(kanaToRomaji("きって"), "kitte");
  assert.equal(kanaToRomaji("まっちゃ"), "matcha");
  assert.equal(kanaToRomaji("しゃしん"), "shashin");
  assert.equal(kanaToRomaji("きんえん"), "kin'en");
  assert.equal(kanaToRomaji("コーヒー"), "koohii");
  assert.equal(kanaToRomaji("ありがとう。"), "arigatou.");
  assert.equal(toHiragana("カタカナ"), "かたかな");
});

test("particles read wa / o / e in tutor lines", () => {
  assert.equal(romajiOf("今日{きょう}は何{なに}を食{た}べましたか。"), "kyou wa nani o tabemashitaka.");
  assert.equal(romajiOf("わたしは、学生{がくせい}です。"), "watashi wa, gakusei desu.");
  assert.equal(romajiOf("私{わたし}も学生{がくせい}です。"), "watashi mo gakusei desu.");
  assert.equal(romajiOf("日本{にほん}に行{い}きたい"), "nihon ni ikitai");
  // Okurigana stays with its kanji.
  assert.equal(romajiOf("食{た}べました"), "tabemashita");
  assert.equal(romajiOf("学校{がっこう}へ行{い}きます"), "gakkou e ikimasu");
  // は inside a word is left alone.
  assert.equal(romajiOf("はい"), "hai");
});
