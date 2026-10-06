// Settings window — the AI that teaches, the voice, how lessons look, and the
// general preferences. Keys go straight to the Credential Manager.

import "@fontsource-variable/inter/opsz.css";
import "./settings.css";
import { Bridge, onEvent, type SkinInfo, type Voice } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";
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

// ── AI section ────────────────────────────────────────────────────────────────

const CLAUDE_MODELS: [string, string][] = [
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-haiku-4-5-20251001", "Claude Haiku 4.5 (fastest)"],
];

interface ProviderDef {
  id: Settings["provider"];
  name: string;
  keyName: string;
  placeholder: string;
  noKey: string;
  /** The model setting this provider reads and writes. */
  model: { get(): string; set(v: string): void };
  /** Live model list from the provider; none = the fixed list above. */
  live?: () => Promise<{ id: string; label: string }[]>;
  /** The empty-model choice, when the provider has one. */
  automatic?: string;
}

const PROVIDERS: ProviderDef[] = [
  {
    id: "claude",
    name: "Claude",
    keyName: "anthropic-api-key",
    placeholder: "sk-ant-...",
    noKey: "No key yet — get one at console.anthropic.com.",
    model: { get: () => settings.model, set: (v) => (settings.model = v) },
  },
  {
    id: "gemini",
    name: "Gemini",
    keyName: "gemini-api-key",
    placeholder: "Paste your Gemini API key",
    noKey: "No key yet — get one at aistudio.google.com.",
    model: { get: () => settings.geminiModel, set: (v) => (settings.geminiModel = v) },
    live: () => Bridge.geminiModels(),
    automatic: "Automatic (latest Flash)",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    keyName: "deepseek-api-key",
    placeholder: "sk-...",
    noKey: "No key yet — get one at platform.deepseek.com.",
    model: { get: () => settings.deepseekModel, set: (v) => (settings.deepseekModel = v) },
    live: () => Bridge.deepseekModels(),
    automatic: "Automatic (Flash, cheapest)",
  },
];

/** The key and model of one provider. */
function providerPanel(def: ProviderDef, hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const keyText = (present: boolean) =>
    present ? "Key saved in the Windows Credential Manager." : def.noKey;
  const state = h("span", { class: "hint", text: keyText(hasKey) });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (stored)" : def.placeholder,
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  const model = h("select", {}) as HTMLSelectElement;
  async function loadModels(present: boolean) {
    clear(model);
    const current = def.model.get();
    const known = new Set<string>();
    const add = (id: string, label: string) => {
      if (known.has(id)) return;
      known.add(id);
      model.append(h("option", { value: id, text: label }));
    };
    if (def.automatic) add("", def.automatic);
    if (!def.live) CLAUDE_MODELS.forEach(([id, label]) => add(id, label));
    if (current) add(current, current);
    model.value = current;
    if (!def.live || !present) return;
    try {
      for (const m of await def.live()) add(m.id, m.label === m.id ? m.id : `${m.label} (${m.id})`);
      model.value = current;
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not list models: ${String(err)}` }));
    }
  }
  model.addEventListener("change", () => {
    def.model.set(model.value);
    void save();
  });

  async function refresh() {
    const present = (await Bridge.secretPresent(def.keyName)) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = keyText(present);
    field.placeholder = present ? "••••••••••••  (stored)" : def.placeholder;
    clearBtn.style.display = present ? "" : "none";
    await loadModels(present);
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet(def.keyName, value);
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
      await Bridge.secretClear(def.keyName);
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  clearBtn.style.display = hasKey ? "" : "none";
  void loadModels(hasKey);

  return h(
    "div",
    {},
    h("div", { class: "row" }, dot, state),
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Model" }), model),
    feedback,
  );
}

/** Every AI Mochi can teach with, in one place: pick the provider, then its key and model. */
function aiSection(): HTMLElement {
  const provider = h("select", {}) as HTMLSelectElement;
  for (const p of PROVIDERS) provider.append(h("option", { value: p.id, text: p.name }));
  provider.value = settings.provider;

  const panel = h("div", {});
  let shown = 0;
  async function render() {
    const mine = ++shown;
    const def = PROVIDERS.find((p) => p.id === settings.provider) ?? PROVIDERS[0];
    const present = (await Bridge.secretPresent(def.keyName)) ?? false;
    if (mine !== shown) return;
    clear(panel);
    panel.append(providerPanel(def, present));
  }
  provider.addEventListener("change", () => {
    settings.provider = provider.value as Settings["provider"];
    void save();
    void render();
  });
  void render();

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "AI" })),
    h("div", { class: "row" },
      h("label", { text: "Mochi uses" }),
      provider,
      h("span", { class: "hint", text: "the AI that teaches you" }),
    ),
    panel,
  );
}

// ── Learning section ──────────────────────────────────────────────────────────

function select<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void): HTMLSelectElement {
  const el = h("select", {}) as HTMLSelectElement;
  for (const [v, label] of options) el.append(h("option", { value: v, text: label }));
  el.value = value;
  el.addEventListener("change", () => onChange(el.value as T));
  return el;
}

function learningSection(): HTMLElement {
  const goal = h("input", {
    type: "number", min: "1", max: "180", step: "1",
    value: String(settings.dailyGoalMinutes),
    style: "width:72px",
  }) as HTMLInputElement;
  goal.addEventListener("change", () => {
    settings.dailyGoalMinutes = Math.max(1, Math.min(180, Math.round(Number(goal.value) || 10)));
    goal.value = String(settings.dailyGoalMinutes);
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Learning" })),
    h("span", { class: "hint", text: "Mochi starts you as a beginner and adjusts as it learns your level. These change how lessons look." }),
    h("div", { class: "row" },
      h("label", { text: "English support" }),
      select(settings.englishSupport, [["auto", "Follow my level"], ["more", "More English"], ["less", "Less English"]], (v) => {
        settings.englishSupport = v;
        void save();
      }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Furigana" }),
      select(settings.furigana, [["always", "Over every kanji"], ["unknown", "Only words I don't know well"], ["off", "Off (tap a word to see it)"]], (v) => {
        settings.furigana = v;
        void save();
      }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Romaji" }),
      toggle(settings.romaji, (v) => { settings.romaji = v; void save(); }),
      h("span", { class: "hint", text: "a romaji line under Japanese" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Translations" }),
      toggle(settings.showEnglish, (v) => { settings.showEnglish = v; void save(); }),
      h("span", { class: "hint", text: "off: blurred until you tap them" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Daily goal" }),
      goal,
      h("span", { class: "hint", text: "minutes" }),
    ),
  );
}

// ── Reminders section ─────────────────────────────────────────────────────────

function timeField(value: string, onChange: (v: string) => void): HTMLInputElement {
  const el = h("input", { type: "time", value, style: "width:110px" }) as HTMLInputElement;
  el.addEventListener("change", () => {
    if (el.value) onChange(el.value);
  });
  return el;
}

function remindersSection(): HTMLElement {
  const max = h("input", {
    type: "number", min: "1", max: "12", step: "1",
    value: String(settings.reminderMaxPerDay),
    style: "width:72px",
  }) as HTMLInputElement;
  max.addEventListener("change", () => {
    settings.reminderMaxPerDay = Math.max(1, Math.min(12, Math.round(Number(max.value) || 4)));
    max.value = String(settings.reminderMaxPerDay);
    void save();
  });
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Reminders" })),
    h("span", { class: "hint", text: "Mochi pops up for a minute at natural breaks (when you come back from a pause, or cards pile up). Never in full-screen apps, quiet hours, or while you type." }),
    h("div", { class: "row" },
      h("label", { text: "Remind me" }),
      toggle(settings.reminders, (v) => { settings.reminders = v; void save(); }),
    ),
    h("div", { class: "row" },
      h("label", { text: "At most" }),
      max,
      h("span", { class: "hint", text: "a day, at least 90 minutes apart" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Quiet hours" }),
      timeField(settings.quietStart, (v) => { settings.quietStart = v; void save(); }),
      h("span", { class: "hint", text: "to" }),
      timeField(settings.quietEnd, (v) => { settings.quietEnd = v; void save(); }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Review cards" }),
      toggle(settings.reminderReview, (v) => { settings.reminderReview = v; void save(); }),
      h("span", { class: "hint", text: "a 2-minute review of words that are due" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Word of the day" }),
      toggle(settings.reminderWord, (v) => { settings.reminderWord = v; void save(); }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Quick questions" }),
      toggle(settings.reminderQuiz, (v) => { settings.reminderQuiz = v; void save(); }),
    ),
  );
}

// ── Voice section (Fish Audio) ────────────────────────────────────────────────

const TTS_MODELS: [string, string][] = [
  ["s2.1-pro-free", "S2.1 Pro (free tier)"],
  ["s2.1-pro", "S2.1 Pro"],
  ["s2-pro", "S2 Pro"],
  ["s1", "S1"],
];

function voiceSection(hasKey: boolean): HTMLElement {
  const KEY = "fish-audio-api-key";
  const dot = statusDot(hasKey);
  const keyText = (present: boolean) =>
    present ? "Key saved in the Credential Manager." : "No key yet: get one at fish.audio (API keys). Without it Mochi can't speak.";
  const state = h("span", { class: "hint", text: keyText(hasKey) });
  const field = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (stored)" : "Paste your Fish Audio API key",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  const voice = h("select", { style: "flex:1 1 auto;min-width:0" }) as HTMLSelectElement;
  const preview = h("button", { text: "▶ Preview" });
  const mine = h("button", { text: "My voices", title: "Voices you created on fish.audio" });
  const voiceMsg = h("div", { class: "hint" });

  function fillVoices(list: Voice[]) {
    clear(voice);
    voice.append(h("option", { value: "", text: "Fish Audio default" }));
    if (settings.ttsVoice && !list.some((v) => v.id === settings.ttsVoice)) {
      voice.append(h("option", { value: settings.ttsVoice, text: settings.ttsVoiceName || settings.ttsVoice }));
    }
    for (const v of list) voice.append(h("option", { value: v.id, text: v.title, title: v.description }));
    voice.value = settings.ttsVoice;
  }

  async function loadVoices(own: boolean) {
    voiceMsg.textContent = own ? "Loading your voices…" : "Loading Japanese voices…";
    try {
      const list = await Bridge.fishVoices(own);
      fillVoices(list);
      voiceMsg.textContent = list.length ? "" : own ? "You have no voices of your own yet." : "No voices found.";
    } catch (err) {
      voiceMsg.textContent = String(err);
    }
  }

  voice.addEventListener("change", () => {
    settings.ttsVoice = voice.value;
    settings.ttsVoiceName = voice.value ? voice.selectedOptions[0]?.text ?? "" : "";
    void save();
  });
  preview.addEventListener("click", async () => {
    voiceMsg.textContent = "";
    try {
      const bytes = await Bridge.ttsSpeak("こんにちは！一緒に日本語を勉強しましょう。", voice.value);
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
    } catch (err) {
      voiceMsg.textContent = String(err).replace(/^Error:\s*/, "");
    }
  });
  mine.addEventListener("click", () => void loadVoices(true));

  async function refresh() {
    const present = (await Bridge.secretPresent(KEY)) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = keyText(present);
    field.placeholder = present ? "••••••••••••  (stored)" : "Paste your Fish Audio API key";
    clearBtn.style.display = present ? "" : "none";
    if (present) await loadVoices(false);
    else fillVoices([]);
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet(KEY, value);
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
      await Bridge.secretClear(KEY);
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  const speed = h("input", { type: "range", min: "0.6", max: "1.3", step: "0.05", value: String(settings.ttsSpeed) }) as HTMLInputElement;
  const speedLabel = h("span", { class: "hint", text: `${settings.ttsSpeed.toFixed(2)}×` });
  speed.addEventListener("input", () => {
    settings.ttsSpeed = Number(speed.value);
    speedLabel.textContent = `${settings.ttsSpeed.toFixed(2)}×`;
  });
  speed.addEventListener("change", () => void save());

  clearBtn.style.display = hasKey ? "" : "none";
  fillVoices([]);
  if (hasKey) void loadVoices(false);

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Voice (Fish Audio)" })),
    state,
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Voice" }), voice, preview, mine),
    voiceMsg,
    h("div", { class: "row" },
      h("label", { text: "Model" }),
      select(settings.ttsModel, TTS_MODELS, (v) => { settings.ttsModel = v; void save(); }),
    ),
    h("div", { class: "row" }, h("label", { text: "Speed" }), speed, speedLabel),
    h("div", { class: "row" },
      h("label", { text: "Read replies aloud" }),
      toggle(settings.autoPlay, (v) => { settings.autoPlay = v; void save(); }),
    ),
    h("span", { class: "hint", text: "Only Mochi's Japanese lines are sent to Fish Audio. Clips are cached on this PC, so replays are free." }),
    feedback,
  );
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
      // Imported hair skins.
      ...bundles.map((b) =>
        h("option", { value: BUNDLE_PREFIX + b.id, text: b.author ? `${b.name} — ${b.author}` : b.name }),
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
    title: "Make a hair skin from your own pictures",
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
      h("span", { class: "hint", text: "what Mochi calls you" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Mochi appears from the" }),
      position,
    ),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Let Mochi use this PC" }),
      toggle(settings.pcTools, (v) => { settings.pcTools = v; void save(); }),
      h("span", { class: "hint", text: "when you ask in chat: open links, search the web, control music (Spotify), read basic PC info" }),
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
const LOOKUP_DEFAULT = "Ctrl+Alt+J";

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

  async function setGlobal(enabled: boolean, accelerator: string, lookup = settings.hotkeyLookup): Promise<string | null> {
    try {
      const updated = await Bridge.setHotkey(enabled, accelerator, lookup);
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
          id: "global", label: "Ask Mochi", global: true, lead: toggleEl,
          combo: settings.hotkeyAccelerator, custom: settings.hotkeyAccelerator !== GLOBAL_DEFAULT,
          set: (combo) => setGlobal(true, combo),
          reset: () => setGlobal(settings.hotkeyEnabled, GLOBAL_DEFAULT),
        }),
        ...row({
          id: "lookup", label: "Look up selected text", global: true,
          combo: settings.hotkeyLookup, custom: settings.hotkeyLookup !== LOOKUP_DEFAULT,
          note: "Select Japanese in any app and press it. The text is sent to your AI only when you press it.",
          set: (combo) => setGlobal(true, settings.hotkeyAccelerator, combo),
          reset: () => setGlobal(settings.hotkeyEnabled, settings.hotkeyAccelerator, LOOKUP_DEFAULT),
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
          void save().then(() => setGlobal(settings.hotkeyEnabled, GLOBAL_DEFAULT, LOOKUP_DEFAULT)).then(() => { say(""); render(); });
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
  const hasFishKey = (await Bridge.secretPresent("fish-audio-api-key")) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Kotoba" }), h("span", { class: "version", text: version })),
    learningSection(),
    remindersSection(),
    voiceSection(hasFishKey),
    aiSection(),
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
