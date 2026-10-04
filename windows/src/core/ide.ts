// Which editor the user works in, for the Home pill and its "Open …" link.
// Asked of Rust (ide.rs) at launch, when a Claude Code session shows up in
// another process chain, and each time the island opens — so an editor
// started or closed later is picked up without a restart.

import { Bridge } from "./bridge";
import { State } from "./state";

let pending = false;

/** `pids`: a session's process chain; defaults to the current Claude Code session's. */
export async function refreshIde(pids?: number[]) {
  if (pending) return;
  pending = true;
  try {
    const chain = pids ?? State.tasks.find((t) => t.id === "integration_claude")?.sessionPids ?? [];
    // Outside Tauri (plain `npm run dev`) there is nothing to ask: keep what we have.
    const ide = await Bridge.detectIde(chain);
    if (ide !== undefined) State.setIde(ide);
  } finally {
    pending = false;
  }
}
