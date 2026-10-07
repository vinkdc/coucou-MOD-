// AI coding agents running on this PC (Claude Code, Codex), as the Today tab's Work page
// shows them: which are working, which are waiting on you, what each last did. Status
// only: nothing here approves, denies or sends anything. Read from the agents' own
// session files by Rust (agents.rs), and only once the learner turns it on.

import { Bridge } from "./bridge";
import { State } from "./state";

export type AgentKind = "claude" | "codex";
export type AgentState = "working" | "waiting" | "idle";

export interface AgentSession {
  id: string;
  agent: AgentKind;
  /** Folder name of the project the agent is in. */
  project: string;
  state: AgentState;
  /** What it is doing or last did, in a few words. */
  detail: string;
  /** Epoch ms of the last line. */
  at: number;
  /** The task: the learner's last prompt. */
  prompt: string;
  /** The last tool and what it was aimed at. */
  tool: string;
  target: string;
  /** Lines added and removed by the last file edit. */
  added: number;
  removed: number;
  /** Short model name, git branch, and the size of the last turn in tokens. */
  model: string;
  branch: string;
  tokensIn: number;
  tokensOut: number;
}

const KEY = "kotoba.agents.on";

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export const Agents: { enabled: boolean; sessions: AgentSession[] } = { enabled: stored(), sessions: [] };

/** The learner's opt-in: nothing is read until they press the button on the Work page. */
export function setAgents(on: boolean) {
  Agents.enabled = on;
  if (!on) Agents.sessions = [];
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* kept for this run only */
  }
  State.notify();
}

let lastSig = "";

export async function refreshAgents() {
  if (!Agents.enabled) return;
  const next = (await Bridge.agentsScan()) ?? [];
  // Only a real change repaints the island.
  const sig = JSON.stringify(next.map((s) => [s.id, s.state, s.detail]));
  Agents.sessions = next;
  if (sig !== lastSig) {
    lastSig = sig;
    State.notify();
  }
}

let started = false;

/** Polls while Today is on screen (and never while the island is hidden). */
export function startAgents() {
  if (started) return;
  started = true;
  void refreshAgents();
  window.setInterval(() => {
    if (State.mode === "expanded" && State.view === "home") void refreshAgents();
  }, 4000);
}
