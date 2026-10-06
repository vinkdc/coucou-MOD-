import { test, mock } from "node:test";
import assert from "node:assert/strict";

// fsm.ts schedules with window.setTimeout; under node the global timers stand in.
(globalThis as { window?: unknown }).window ??= globalThis;
const { IslandStateMachine } = await import("../src/island/fsm.ts");

test("the compact island waits for Mochi to finish speaking before hiding", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const fsm = new IslandStateMachine();
    let speaking = true;
    fsm.holdOpen = () => speaking;
    fsm.reveal();
    assert.equal(fsm.state, "petit");

    mock.timers.tick(fsm.petitToHiddenDelay * 1000);
    assert.equal(fsm.state, "petit", "still speaking: stays open");
    mock.timers.tick(2000);
    assert.equal(fsm.state, "petit");

    speaking = false;
    mock.timers.tick(500);
    assert.equal(fsm.state, "hidden", "hides soon after the voice ends");
  } finally {
    mock.timers.reset();
  }
});

test("without a voice it hides on time", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const fsm = new IslandStateMachine();
    fsm.reveal();
    mock.timers.tick(fsm.petitToHiddenDelay * 1000);
    assert.equal(fsm.state, "hidden");
  } finally {
    mock.timers.reset();
  }
});
