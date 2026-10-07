// What the AI agents are asking the learner: a permission request (Allow / Deny / Always)
// and a multiple-choice question (shown, not answerable from here). Both arrive through
// Claude Code's hooks via the relay (hooks.rs, pipe.rs) and only exist while the agent is
// waiting: a request ends when answered, when the agent gives up (~110 s), or when it is
// answered in the terminal. Nothing is ever approved without a click.

import { Bridge, onEvent } from "./bridge";
import { State } from "./state";

export interface Approval {
  id: string;
  /** The agent session this belongs to (matches the session file name). */
  session: string;
  project: string;
  tool: string;
  /** The exact thing being asked: the command, the file, the pattern. */
  summary: string;
  /** For Always: the first word of a Bash command. */
  prefix: string;
  at: number;
}

export interface Question {
  session: string;
  project: string;
  question: string;
  options: { label: string; description?: string }[];
  at: number;
}

export const Approvals: { pending: Approval[]; questions: Question[] } = { pending: [], questions: [] };

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** The agent stops waiting after about this long and asks in the terminal. */
const REQUEST_LIFE = 110_000;
const QUESTION_LIFE = 15 * 60_000;

function lastPart(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  return cleaned.slice(Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/")) + 1) || p;
}

function summarize(input: Record<string, unknown> = {}): string {
  const pick = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const text = pick("command") || pick("file_path") || pick("path") || pick("pattern") || pick("url") || JSON.stringify(input);
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

function drop(id: string) {
  const before = Approvals.pending.length;
  Approvals.pending = Approvals.pending.filter((a) => a.id !== id);
  if (Approvals.pending.length !== before) {
    State.notify();
    if (!Approvals.pending.length) window.dispatchEvent(new Event("kotoba-approvals-idle"));
  }
}

let started = false;

/**
 * Listens to the relay. `wantsAttention` is asked for every new permission request:
 * true when the island will show it (it peeks open), false when it cannot (a meeting,
 * a full-screen app), in which case the agent asks in the terminal right away.
 */
export function startApprovals(wantsAttention: () => Promise<boolean>) {
  if (started) return;
  started = true;

  void onEvent<HookPayload>("hook", async (p) => {
    const tool = p.tool_name ?? "";
    const project = lastPart(p.cwd ?? "");
    if (p.hook_event_name === "PermissionRequest" && p.request_id) {
      const id = p.request_id;
      if (!(await wantsAttention())) return void Bridge.approvalDecline(id);
      const input = p.tool_input ?? {};
      const command = typeof input.command === "string" ? input.command.trim().split(/\s+/)[0] : "";
      Approvals.pending = [
        ...Approvals.pending.filter((a) => a.id !== id),
        { id, session: p.session_id ?? "", project, tool, summary: summarize(input), prefix: tool === "Bash" ? command : "", at: Date.now() },
      ];
      void Bridge.approvalAck(id);
      State.notify();
      window.setTimeout(() => drop(id), REQUEST_LIFE);
    } else if (p.hook_event_name === "PreToolUse" && tool === "AskUserQuestion") {
      const asked = (p.tool_input?.questions as { question?: string; options?: { label?: string; description?: string }[] }[] | undefined) ?? [];
      const now = Date.now();
      Approvals.questions = [
        ...Approvals.questions.filter((q) => q.session !== (p.session_id ?? "")),
        ...asked
          .filter((q) => q.question)
          .map((q) => ({
            session: p.session_id ?? "",
            project,
            question: q.question as string,
            options: (q.options ?? []).filter((o) => o.label).map((o) => ({ label: o.label as string, description: o.description })),
            at: now,
          })),
      ];
      State.notify();
    }
  });
  // Answered in the terminal: the relay hung up, so the request is no longer ours.
  void onEvent<string>("approval-gone", (id) => drop(id));
  // Old questions fade away (the session file shows when the agent moved on).
  window.setInterval(() => {
    const keep = Approvals.questions.filter((q) => Date.now() - q.at < QUESTION_LIFE);
    if (keep.length !== Approvals.questions.length) {
      Approvals.questions = keep;
      State.notify();
    }
  }, 30_000);
}

/** The learner's click. Always also remembers the rule (this tool, this project, this first word). */
export async function decide(a: Approval, decision: "allow" | "deny" | "always") {
  drop(a.id);
  if (decision === "always") {
    try {
      await Bridge.alwaysAdd(a.tool, a.project, a.prefix);
    } catch {
      /* the rule is not kept; this request is still allowed */
    }
  }
  void Bridge.approvalDecision(a.id, decision === "deny" ? "deny" : "allow");
}

/** A question goes away once its session has moved on. */
export function clearQuestions(session: string) {
  const keep = Approvals.questions.filter((q) => q.session !== session);
  if (keep.length !== Approvals.questions.length) {
    Approvals.questions = keep;
    State.notify();
  }
}
