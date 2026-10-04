// The assistant's side of the island: Allow/Deny cards for risky actions, and
// the tools that are Coucou's own features (they live here, in the page).
// The loop itself runs in Rust — see src-tauri/src/assistant.rs.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { nextChatId } from "../views/chat";
import { openIntegrationTarget, type Island } from "./island";

interface ConfirmRequest {
  id: string;
  title: string;
  detail: string;
}

interface ToolRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

type Result = { ok: boolean; text: string };

export function registerAssistantHandlers(island: Island, setPaused: (on: boolean) => void) {
  // A risky action wants a click. The card goes into the chat, and the island
  // holds itself open on the chat until it is answered (or expires in Rust).
  void onEvent<ConfirmRequest>("assistant-confirm", (req) => {
    State.chatHistory.push({
      id: nextChatId(),
      role: "confirm",
      content: req.title,
      detail: req.detail,
      confirmId: req.id,
      status: "pending",
    });
    State.isPinned = true;
    Sound.play("approval");
    if (State.mode === "expanded" && State.view === "prompt") {
      island.fsm.pinned = true;
      State.notify();
    } else {
      island.alert("prompt");
    }
  });

  void onEvent<string>("assistant-confirm-expired", (id) => {
    const card = State.chatHistory.find((m) => m.confirmId === id);
    if (card && card.status === "pending") card.status = "expired";
    if (!State.chatHistory.some((m) => m.status === "pending")) {
      State.isPinned = false;
      island.dropPin();
    }
    State.notify();
  });

  void onEvent<ToolRequest>("assistant-tool", (req) => {
    let result: Result;
    try {
      result = runTool(island, setPaused, req.name, req.args ?? {});
    } catch (err) {
      result = { ok: false, text: String(err) };
    }
    void Bridge.assistantToolResult(req.id, result);
  });
}

function saveSettings(island: Island) {
  void Bridge.saveSettings(State.settings);
  island.applySettings();
}

function runTool(
  island: Island,
  setPaused: (on: boolean) => void,
  name: string,
  args: Record<string, unknown>,
): Result {
  switch (name) {
    case "coucou_status": {
      const lines = State.tasks
        .filter((t) => !t.isIntegration || t.state !== "idle")
        .map((t) => {
          const last = t.steps.at(-1);
          return `${t.name}: ${t.state}${last ? ` — ${last}` : ""}`;
        });
      if (State.pendingApproval) {
        lines.push(`Claude Code is waiting for permission: ${State.pendingApproval.command}`);
      }
      lines.push(`Coucou is ${State.paused ? "paused" : "running"}.`);
      lines.push(
        `Sound ${State.settings.soundEnabled ? "on" : "off"}, volume ${Math.round((State.settings.soundVolume / 0.2) * 100)}%.`,
      );
      lines.push(`Island appears from the ${State.settings.position} edge.`);
      return { ok: true, text: lines.join("\n") };
    }

    case "set_sound": {
      if (typeof args.enabled === "boolean") State.settings.soundEnabled = args.enabled;
      if (typeof args.volume === "number") {
        // The settings slider runs 0–0.2; the assistant speaks in percent.
        State.settings.soundVolume = Math.max(0, Math.min(100, args.volume)) * 0.002;
      }
      Sound.setEnabled(State.settings.soundEnabled);
      Sound.setVolume(State.settings.soundVolume);
      saveSettings(island);
      return { ok: true, text: `Sound ${State.settings.soundEnabled ? "on" : "off"}.` };
    }

    case "set_island_edge": {
      if (args.edge !== "top" && args.edge !== "bottom") return { ok: false, text: "edge must be top or bottom" };
      State.settings.position = args.edge;
      saveSettings(island);
      return { ok: true, text: `The island now appears from the ${args.edge} edge.` };
    }

    case "set_paused": {
      const paused = args.paused === true;
      setPaused(paused);
      return { ok: true, text: paused ? "Coucou is paused." : "Coucou is running." };
    }

    case "start_guide": {
      const steps = String(args.steps ?? "")
        .split("\n")
        .map((s) => s.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, "").trim())
        .filter(Boolean)
        .slice(0, 8)
        .map((s) => s.slice(0, 160));
      if (!steps.length) return { ok: false, text: "No steps given." };
      const page = typeof args.page === "string" && args.page ? args.page : null;
      State.guide = {
        title: String(args.title ?? "Guide").slice(0, 40) || "Guide",
        steps,
        index: 0,
        page,
        check: null,
      };
      if (page) void Bridge.openWindowsSettings(page);
      // Bridge.openUrl itself refuses anything that is not http(s).
      if (typeof args.url === "string" && /^https?:\/\//i.test(args.url)) void Bridge.openUrl(args.url);
      State.isPinned = true;
      Sound.play("approval");
      island.alert("guide");
      return { ok: true, text: `Guide started with ${steps.length} steps; the user is on step 1.` };
    }

    case "open_file_picker":
      void island.openPicker();
      return { ok: true, text: "The file dialog is open; the user is choosing a file." };

    case "open_settings":
      void Bridge.openSettingsWindow();
      return { ok: true, text: "Settings window opened." };

    case "open_integration": {
      const id = `integration_${String(args.integration ?? "")}`;
      return openIntegrationTarget(id)
        ? { ok: true, text: "Opened." }
        : { ok: false, text: `Unknown integration ${String(args.integration)}` };
    }

    default:
      return { ok: false, text: `Unknown tool ${name}` };
  }
}
