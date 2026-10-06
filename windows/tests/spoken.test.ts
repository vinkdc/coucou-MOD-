import { test } from "node:test";
import assert from "node:assert/strict";
import { spokenLines } from "../src/study/markup.ts";

const reply = "FIX: わたしわ => 私{わたし}は | particle\nJP: 猫{ねこ}が好{す}きです。\nEN: I like cats.\nNEW: 猫|ねこ|cat\nJP: あなたは？";

test("spoken lines keep their keys as a reply streams in", () => {
  const all = spokenLines(reply, "q1");
  assert.deepEqual(all, [
    { text: "猫が好きです。", key: "q1:1" },
    { text: "あなたは？", key: "q1:4" },
  ]);
  // Every complete-lines prefix of the stream gives a prefix of the final lines.
  for (let i = 0; i <= reply.length; i++) {
    const done = reply.slice(0, i).slice(0, reply.slice(0, i).lastIndexOf("\n") + 1);
    const part = spokenLines(done, "q1");
    assert.deepEqual(part, all.slice(0, part.length));
  }
});
