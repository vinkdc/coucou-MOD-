// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "@fontsource-variable/inter/opsz.css";
import "./settings.css";
import { Bridge, onEvent, type HookStatus, type SkinInfo } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";
import { localSkinNames } from "../mochi/localSkins";
import { BUNDLE_PREFIX, bundleId, listBundles } from "../mochi/bundles";
import { KEY_ACTIONS, SCOPE_TITLES, binding, capsOf, comboFromEvent, usable } from "../core/keys";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there."
          : "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "coucou-hook.exe is not in place yet. Restart Coucou; if it still fails, build it with `cargo build -p coucou-hook`.",
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstall hooks…" : "Install hooks…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "The relay isn't installed yet.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Uninstall hooks…",
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(install);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: "Back",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "This is exactly what will change in your settings.json. Your own hooks are left untouched."
          : "This removes Coucou's entries only. Your own hooks are left untouched.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: `Done. Previous settings saved as ${backup}. Open a new Claude Code session to pick the hooks up.`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Cancel",
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

// ── Claude API section ────────────────────────────────────────────────────────

const MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

function apiSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("span", { class: "hint", text: hasKey ? "Key saved in the Windows Credential Manager." : "No key yet — the chat needs one." });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (stored)" : "sk-ant-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = present
      ? "Key saved in the Windows Credential Manager."
      : "No key yet — the chat needs one.";
    field.placeholder = present ? "••••••••••••  (stored)" : "sk-ant-...";
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  const model = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of MODELS) model.append(h("option", { value: id, text: label }));
  if (!MODELS.some(([id]) => id === settings.model)) {
    model.append(h("option", { value: settings.model, text: settings.model }));
  }
  model.value = settings.model;
  model.addEventListener("change", () => {
    settings.model = model.value;
    void save();
  });

  clearBtn.style.display = hasKey ? "" : "none";

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Claude" })),
    state,
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Model" }), model),
    feedback,
  );
}

// ── Gemini section ────────────────────────────────────────────────────────────

/** Which AI answers in the chat, plus the Gemini key and model. */
function geminiSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const keyText = (present: boolean) =>
    present ? "Key saved in the Windows Credential Manager." : "No key yet — get one at aistudio.google.com.";
  const state = h("span", { class: "hint", text: keyText(hasKey) });

  const provider = h("select", {}) as HTMLSelectElement;
  provider.append(
    h("option", { value: "claude", text: "Claude" }),
    h("option", { value: "gemini", text: "Gemini" }),
  );
  provider.value = settings.provider;
  provider.addEventListener("change", () => {
    settings.provider = provider.value as Settings["provider"];
    void save();
  });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (stored)" : "Paste your Gemini API key",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  // Filled from the live model list, so it never goes stale.
  const model = h("select", {}) as HTMLSelectElement;
  async function loadModels(present: boolean) {
    clear(model);
    model.append(h("option", { value: "", text: "Automatic (latest Flash)" }));
    if (settings.geminiModel) {
      model.append(h("option", { value: settings.geminiModel, text: settings.geminiModel }));
    }
    model.value = settings.geminiModel;
    if (!present) return;
    try {
      const list = await Bridge.geminiModels();
      for (const m of list) {
        if (m.id === settings.geminiModel) continue;
        model.append(h("option", { value: m.id, text: `${m.label} (${m.id})` }));
      }
      model.value = settings.geminiModel;
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not list models: ${String(err)}` }));
    }
  }
  model.addEventListener("change", () => {
    settings.geminiModel = model.value;
    void save();
  });

  async function refresh() {
    const present = (await Bridge.secretPresent("gemini-api-key")) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = keyText(present);
    field.placeholder = present ? "••••••••••••  (stored)" : "Paste your Gemini API key";
    clearBtn.style.display = present ? "" : "none";
    await loadModels(present);
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("gemini-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("gemini-api-key");
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  clearBtn.style.display = hasKey ? "" : "none";
  void loadModels(hasKey);

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Gemini" })),
    state,
    h("div", { class: "row" },
      h("label", { text: "Chat uses" }),
      provider,
      h("span", { class: "hint", text: "opening apps, files, the screen and commands always ask first" }),
    ),
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Model" }), model),
    feedback,
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Pick up to ${MAX_ACTIVE} pills to show next to Mochi — ${used}/${MAX_ACTIVE} in use. Keys are stored in the Windows Credential Manager, never on disk.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  const character = h("select", {}) as HTMLSelectElement;
  let bundles: SkinInfo[] = [];
  const fillCharacters = () => {
    clear(character);
    character.append(
      h("option", { value: "mochi", text: "Mochi" }),
      h("option", { value: "ribbon", text: "Ribbon — bangs, ponytail and bow" }),
      // Imported skin bundles (any build).
      ...bundles.map((b) =>
        h("option", { value: BUNDLE_PREFIX + b.id, text: b.author ? `${b.name} — ${b.author}` : b.name }),
      ),
      // Dev builds only: skins kept outside git in src/mochi/local/.
      ...localSkinNames().map((name) =>
        h("option", { value: name, text: `${name[0].toUpperCase()}${name.slice(1)} (local)` }),
      ),
    );
    // A worn skin that was removed (or never existed) is Mochi again.
    if (!Array.from(character.options).some((o) => o.value === settings.skin)) {
      settings.skin = "mochi";
      void save();
    }
    character.value = settings.skin;
    const imported = bundleId(character.value) ? "" : "none";
    removeSkin.style.display = imported;
    editSkin.style.display = imported;
  };
  const skinMsg = h("div", { class: "hint" });
  const skinConfirm = h("div", { class: "skin-confirm" });
  const removeSkin = h("button", { text: "Remove", title: "Delete this imported skin" });
  const editSkin = h("button", {
    text: "Edit…",
    title: "Change this skin in the skin editor",
    onclick: () => void Bridge.openSkinEditor(bundleId(character.value)),
  });
  const createSkin = h("button", {
    text: "Create…",
    title: "Make a skin from your own pictures",
    onclick: () => void Bridge.openSkinEditor(null),
  });
  const importSkin = h("button", { text: "Import skin…" });
  const importFolder = h("button", { text: "Folder…", title: "Import a skin from a folder" });
  character.addEventListener("change", () => {
    settings.skin = character.value as Settings["skin"];
    const imported = bundleId(character.value) ? "" : "none";
    removeSkin.style.display = imported;
    editSkin.style.display = imported;
    void save();
  });
  const reloadBundles = () =>
    void listBundles().then((list) => {
      bundles = list;
      fillCharacters();
    });
  reloadBundles();
  fillCharacters();
  // The skin editor saved (or something removed a skin): the menu catches up.
  void onEvent<null>("skins-changed", reloadBundles);
  void onEvent<Settings>("settings-changed", (s) => {
    if (s.skin !== character.value) {
      settings.skin = s.skin;
      reloadBundles();
    }
  });

  /** Picks a bundle, shows what is in it, and only then keeps it. */
  const startImport = async (folder: boolean) => {
    skinMsg.textContent = "";
    clear(skinConfirm);
    const path = await Bridge.pickSkin(folder);
    if (!path) return;
    try {
      const info = await Bridge.skinImport(path, false);
      skinConfirm.append(...([
        h("div", { class: "skin-title", text: info.author ? `${info.name} — ${info.author}` : info.name }),
        info.note ? h("div", { class: "hint", text: info.note }) : null,
        // The persona becomes part of what Mochi is told in chat: show it before it is kept.
        info.persona ? h("div", { class: "hint", text: `How it talks in chat: ${info.persona.slice(0, 400)}${info.persona.length > 400 ? "…" : ""}` }) : null,
        h("div", { class: "row" },
          h("button", {
            class: "primary",
            text: "Import",
            onclick: async () => {
              clear(skinConfirm);
              try {
                const kept = await Bridge.skinImport(path, true);
                bundles = await listBundles();
                settings.skin = BUNDLE_PREFIX + kept.id;
                fillCharacters();
                await save();
                skinMsg.textContent = `${kept.name} imported.`;
              } catch (err) {
                skinMsg.textContent = String(err);
              }
            },
          }),
          h("button", { text: "Cancel", onclick: () => clear(skinConfirm) }),
        ),
      ].filter(Boolean) as Node[]));
    } catch (err) {
      skinMsg.textContent = String(err);
    }
  };
  importSkin.addEventListener("click", () => void startImport(false));
  importFolder.addEventListener("click", () => void startImport(true));
  removeSkin.addEventListener("click", async () => {
    const id = bundleId(character.value);
    if (!id) return;
    try {
      await Bridge.skinRemove(id);
      bundles = await listBundles();
      settings.skin = "mochi";
      fillCharacters();
      await save();
      skinMsg.textContent = "Skin removed.";
    } catch (err) {
      skinMsg.textContent = String(err);
    }
  });

  // Sent with chat messages to the AI chosen above, nowhere else. Empty: never named.
  const userName = h("input", {
    type: "text",
    value: settings.userName ?? "",
    maxlength: "40",
    placeholder: "Not set",
    spellcheck: "false",
    style: "width:160px",
  }) as HTMLInputElement;
  userName.addEventListener("change", () => {
    settings.userName = userName.value.trim();
    userName.value = settings.userName;
    void save();
  });

  const position = h("select", {}) as HTMLSelectElement;
  position.append(
    h("option", { value: "top", text: "top edge" }),
    h("option", { value: "bottom", text: "bottom edge" }),
  );
  position.value = settings.position;
  position.addEventListener("change", () => {
    settings.position = position.value as Settings["position"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Character" }),
      character,
      editSkin,
      removeSkin,
    ),
    h("div", { class: "row" },
      h("label", { text: "" }),
      createSkin,
      importSkin,
      importFolder,
    ),
    skinConfirm,
    skinMsg,
    h("div", { class: "row" },
      h("label", { text: "Your name" }),
      userName,
      h("span", { class: "hint", text: "what characters call you" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island appears from the" }),
      position,
    ),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

/** Key caps for a combination such as "Ctrl+Shift+Z". */
function keyCaps(combo: string): HTMLElement {
  const caps = h("span", { class: "keys" });
  for (const part of capsOf(combo)) caps.append(h("kbd", { text: part }));
  return caps;
}

const GLOBAL_DEFAULT = "Ctrl+Alt+C";

function keyboardSection(): HTMLElement {
  const box = h("section", {});
  const feedback = h("div", {});
  /** The row being recorded, if any: its id, and how to stop. */
  let recording: { id: string; stop: () => void } | null = null;

  const say = (text: string, err = true) => {
    clear(feedback);
    if (text) feedback.append(h("div", { class: err ? "notice err" : "hint", text }));
  };

  /** Listens for the next key combination; Esc cancels (use Reset to bind Esc again). */
  function record(id: string, global: boolean, apply: (combo: string) => Promise<string | null>) {
    recording?.stop();
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        say("");
        return stop();
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // a modifier on its own: wait for the key
      if (!usable(combo, global)) {
        say(global
          ? "Hold Ctrl, Alt or Shift (or Win) and press a letter, number, F-key or Space."
          : "A plain letter would be typed into the chat. Use Ctrl, Alt or Win with it, or a key like an arrow, Enter, Esc or an F-key.");
        return;
      }
      stop();
      void apply(combo).then((error) => {
        say(error ?? "", true);
        render();
      });
    };
    const stop = () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", stop);
      recording = null;
      render();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", stop);
    recording = { id, stop };
    say("");
    render();
  }

  function row(opts: {
    id: string;
    label: string;
    global: boolean;
    combo: string;
    custom: boolean;
    set: (combo: string) => Promise<string | null>;
    reset: () => Promise<string | null>;
    lead?: HTMLElement;
    note?: string;
  }): HTMLElement[] {
    const rec = recording?.id === opts.id;
    const change = h("button", {
      text: rec ? "Cancel" : "Change…",
      onclick: () => (rec ? recording?.stop() : record(opts.id, opts.global, opts.set)),
    });
    const reset = opts.custom
      ? h("button", {
          class: "ghost", text: "Reset", title: "Back to the default",
          onclick: () => void opts.reset().then((error) => { say(error ?? ""); render(); }),
        })
      : null;
    const lines: (HTMLElement | null)[] = [
      h("div", { class: "key-line" },
        h("span", { class: "key-what", text: opts.label }),
        opts.lead ?? null,
        rec ? h("span", { class: "hint", text: "Press the new keys… (Esc to cancel)" }) : keyCaps(opts.combo),
        change,
        reset,
      ),
      opts.note ? h("div", { class: "hint key-note", text: opts.note }) : null,
    ];
    return lines.filter((n): n is HTMLElement => n != null);
  }

  /** Saves a change to one in-window key; returns why it can't be used, or null. */
  async function setKey(id: string, combo: string | null): Promise<string | null> {
    if (combo) {
      const mine = KEY_ACTIONS.find((k) => k.id === id)!;
      const clash = KEY_ACTIONS.find((k) => k.id !== id && k.scope === mine.scope && binding(settings.keys, k.id) === combo);
      if (clash) return `That is already used to ${clash.what.toLowerCase()}. Change that one first.`;
    }
    const next = { ...settings.keys };
    if (combo) next[id] = combo;
    else delete next[id];
    settings = { ...settings, keys: next };
    await save();
    return null;
  }

  async function setGlobal(enabled: boolean, accelerator: string): Promise<string | null> {
    try {
      const updated = await Bridge.setHotkey(enabled, accelerator);
      settings = { ...settings, ...updated };
      return null;
    } catch (err) {
      return String(err);
    }
  }

  function render() {
    clear(box);
    const toggleEl = toggle(settings.hotkeyEnabled, (v) => void setGlobal(v, settings.hotkeyAccelerator).then((e) => { say(e ?? ""); render(); }));
    box.append(
      h("h2", {}, h("span", { text: "Keyboard" })),
      h("div", { class: "hint", text: "Click Change… and press the keys you want." }),
      h("div", { class: "key-group" },
        h("div", { class: "key-group-title", text: "Anywhere in Windows" }),
        ...row({
          id: "global", label: "Show or hide the island", global: true, lead: toggleEl,
          combo: settings.hotkeyAccelerator, custom: settings.hotkeyAccelerator !== GLOBAL_DEFAULT,
          set: (combo) => setGlobal(true, combo),
          reset: () => setGlobal(settings.hotkeyEnabled, GLOBAL_DEFAULT),
        }),
      ),
      ...(["island", "editor"] as const).map((scope) =>
        h("div", { class: "key-group" },
          h("div", { class: "key-group-title", text: SCOPE_TITLES[scope] }),
          ...KEY_ACTIONS.filter((k) => k.scope === scope).flatMap((k) =>
            row({
              id: k.id, label: k.what, global: false, note: k.note,
              combo: binding(settings.keys, k.id), custom: binding(settings.keys, k.id) !== k.default,
              set: (combo) => setKey(k.id, combo),
              reset: () => setKey(k.id, null),
            }),
          ),
        ),
      ),
      feedback,
      h("div", {
        class: "key-foot",
      }, h("button", {
        class: "ghost", text: "Reset all keys",
        onclick: () => {
          settings = { ...settings, keys: {} };
          void save().then(() => setGlobal(settings.hotkeyEnabled, GLOBAL_DEFAULT)).then(() => { say(""); render(); });
        },
      })),
    );
  }

  render();
  return box;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  const hasGeminiKey = (await Bridge.secretPresent("gemini-api-key")) ?? false;

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    claudeSection(status),
    apiSection(hasKey),
    geminiSection(hasGeminiKey),
    integrationsSection(present),
    generalSection(),
    keyboardSection(),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
