// Entry point: boot the bridge, wire the island, start the greeting.

// Inter, bundled (never fetched): the closest free match to Apple's SF Pro,
// whose licence keeps it on Apple platforms. Optical sizes, like SF Text/Display.
import "@fontsource-variable/inter/opsz.css";
import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerAssistantHandlers } from "./island/assistant";
import { registerHookHandlers } from "./island/hooks";
import { refreshIde } from "./core/ide";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";

/** One line for the tray: the most urgent thing an agent is doing. */
function trayStatus(): string {
  if (State.paused) return "Paused";
  const agents = State.tasks.filter((t) => !t.isIntegration);
  const find = (...states: string[]) => agents.find((t) => states.includes(t.state));
  let t = find("approval");
  if (t) return `${t.name} needs your approval`;
  if ((t = find("question"))) return `${t.name} has a question`;
  if ((t = find("error"))) return `${t.name} hit an error`;
  if ((t = find("ratelimit"))) return `${t.name} is rate-limited`;
  if ((t = find("working", "thinking", "searching"))) return `${t.name} is working`;
  if ((t = find("finished"))) return `${t.name} finished`;
  return "Nothing running";
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);
  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  island.applySettings();
  State.loadIntegrationTasks();
  void refreshIde();
  if (boot && !boot.cursorPoll) island.followPageCursor();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
    State.notify();
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "toggle":
        if (State.mode !== "hidden") {
          island.fsm.forceHidden();
        } else {
          setPaused(false);
          island.alert(State.defaultView());
        }
        break;
      case "pick":
        setPaused(false);
        void island.openPicker();
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  // Global hotkey: a toggle. Summoned by hand, so it opens even over a
  // full-screen app; pressed again (or Escape) it goes away.
  await onEvent<null>("hotkey", () => {
    if (State.mode === "expanded" && !State.isPinned) {
      island.fsm.forceHidden();
      return;
    }
    setPaused(false);
    island.alert(State.isPinned ? State.view : State.defaultView());
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  // A skin bundle was imported or removed: the one being worn is drawn again.
  await onEvent<null>("skins-changed", () => island.reloadSkin());

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
  });

  // The tray is the ambient channel while the island is hidden. Pushed only when
  // the text actually changes, so State updates stay free.
  let lastTray = "";
  State.subscribe(() => {
    const status = trayStatus();
    const visible = State.mode !== "hidden";
    const key = `${status}|${visible}|${State.paused}`;
    if (key === lastTray) return;
    lastTray = key;
    void Bridge.traySync(status, visible, State.paused);
  });

  registerHookHandlers(island);
  registerAssistantHandlers(island, setPaused);
  registerIntegrationHandlers(island);

  island.launch();

  // In a plain browser, unlock audio on the first click so the visuals and
  // sounds can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
