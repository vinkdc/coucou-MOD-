// Skin editor window — make a character skin from your own pictures without
// writing anything by hand. Drop a picture, drag the face points into place,
// say which parts swing, optionally draw a face per mood, watch it live, save.
// What it saves is an ordinary skin bundle (docs/SKINS.md), checked by Rust
// exactly like an imported one.

import "@fontsource-variable/inter/opsz.css";
import "./editor.css";
import { Bridge, onEvent, type SkinInfo } from "../core/bridge";
import { Sound } from "../core/sound";
import { binding, comboFromEvent } from "../core/keys";
import { h, clear } from "../views/dom";
import { BUNDLE_PREFIX, listBundles } from "../mochi/bundles";
import {
  MOODS, addToPool, bake, build, emptyDoc, opaqueBox, fromManifest, guessFromFirst, placeMotion, pool, problems,
  hasPlainBackground, removeBackground, skinId, skinNearEyes, slug, MAX_SIDE,
  type Doc, type Feel, type Mood, type Motion, type Part, type PartRole, type Placed,
} from "./doc";
import { Stage, type Focus } from "./stage";
import { Preview, PREVIEW_MOODS } from "./preview";

Sound.setEnabled(false);

// ── State ─────────────────────────────────────────────────────────────────────

let doc: Doc = emptyDoc();
let focus: Focus = { kind: "face" };
let past: Doc[] = [];
let future: Doc[] = [];
/** True once something changed since the last save or load. */
let dirty = false;

const clone = (d: Doc): Doc => structuredClone(d);

/** An undo point, taken just before a change. */
function checkpoint() {
  past.push(clone(doc));
  if (past.length > 80) past.shift();
  future = [];
  dirty = true;
}

function undo() {
  const prev = past.pop();
  if (!prev) return;
  future.push(clone(doc));
  doc = prev;
  fixFocus();
  refresh(true);
}

function redo() {
  const next = future.pop();
  if (!next) return;
  past.push(clone(doc));
  doc = next;
  fixFocus();
  refresh(true);
}

function fixFocus() {
  if (focus.kind === "part" && !doc.parts[focus.index]) focus = doc.parts.length ? { kind: "part", index: 0 } : { kind: "face" };
  if (focus.kind === "expr" && !doc.expressions[focus.mood]) focus = { kind: "face" };
}

// ── Pieces of the page ────────────────────────────────────────────────────────

const root = document.getElementById("editor-root")!;
const stage = new Stage(() => ({ doc, focus }), checkpoint, () => refresh(false));
const preview = new Preview();
const status = h("div", { class: "status" });
const nameInput = h("input", { class: "name", placeholder: "Name your skin", maxlength: "40" }) as HTMLInputElement;
const undoBtn = h("button", { text: "Undo", title: "Undo (Ctrl+Z)", onclick: undo }) as HTMLButtonElement;
const redoBtn = h("button", { text: "Redo", title: "Redo (Ctrl+Y)", onclick: redo }) as HTMLButtonElement;
const openSelect = h("select", { title: "Edit a skin you installed" }) as HTMLSelectElement;
const picturesBox = h("div", { class: "panel-body" });
const partBox = h("div", { class: "panel-body" });
const faceBox = h("div", { class: "panel-body" });
const exprBox = h("div", { class: "panel-body" });
const aboutBox = h("div", { class: "panel-body" });
const zoomLabel = h("span", { class: "hint" });
const stageHint = h("div", { class: "stage-hint" });
const dropNote = h("div", { class: "drop-note" },
  h("div", { class: "drop-title", text: "Drop a picture of your character here" }),
  h("div", { class: "hint", text: "A PNG with a transparent background works best (a plain background can be removed). One picture is enough to start: you can split hair, arms or a bow into their own pictures later." }),
  h("button", { class: "primary", text: "Choose pictures…", onclick: () => pickFiles((files) => void addPictures(files)) }),
);

function say(text: string, kind: "ok" | "err" | "" = "") {
  status.textContent = text;
  status.className = `status ${kind}`;
}

// ── Files in ──────────────────────────────────────────────────────────────────

const fileInput = h("input", { type: "file", accept: "image/png,image/webp,image/jpeg,image/gif", multiple: true, style: "display:none" }) as HTMLInputElement;
let onFiles: ((files: File[]) => void) | null = null;
fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files ?? []);
  fileInput.value = "";
  if (files.length && onFiles) onFiles(files);
});
function pickFiles(cb: (files: File[]) => void, multiple = true) {
  onFiles = cb;
  fileInput.multiple = multiple;
  fileInput.click();
}

async function readImage(file: File): Promise<ImageBitmap | null> {
  try {
    const img = await createImageBitmap(file);
    if (img.width > 8192 || img.height > 8192) {
      say(`${file.name} is too big (at most 8192 pixels each way).`, "err");
      return null;
    }
    return img;
  } catch {
    say(`${file.name} isn't a picture this editor can read.`, "err");
    return null;
  }
}

function uniqueId(base: string): string {
  const b = slug(base) || "part";
  let id = b, n = 2;
  while (doc.parts.some((p) => p.id === id) || id === "iris") id = `${b}-${n++}`;
  return id;
}

async function addPictures(files: File[]) {
  const loaded: [File, ImageBitmap, string | undefined][] = [];
  let cleared = 0;
  for (const f of files) {
    let img = await readImage(f);
    if (!img) continue;
    // A white (or any plain) backdrop would be drawn as part of the character.
    let original: string | undefined;
    if (hasPlainBackground(img)) {
      original = addToPool(img);
      img = await removeBackground(img);
      cleared++;
    }
    loaded.push([f, img, original]);
  }
  if (!loaded.length) return;
  checkpoint();
  for (const [file, img, original] of loaded) {
    const name = file.name.replace(/\.[a-z0-9]+$/i, "");
    const first = doc.parts.length === 0;
    const part: Part = {
      img: addToPool(img), x: 0, y: 0, scale: 1,
      id: uniqueId(name), name,
      role: first ? "head" : "front",
      motion: "still", feel: "floppy", mirrored: false, pivot: [0, 0], tipY: 0, original,
    };
    if (first) {
      guessFromFirst(doc, part);
      if (!doc.name) doc.name = name.slice(0, 40);
    } else {
      // Same size as the first picture: drawn on the same canvas, it lines up as is.
      const fit = Math.min(1, doc.w / img.width, doc.h / img.height);
      part.scale = fit;
      part.x = Math.round((doc.w - img.width * fit) / 2);
      part.y = Math.round((doc.h - img.height * fit) / 2);
    }
    placeMotion(doc, part);
    doc.parts.push(part);
    focus = { kind: "part", index: doc.parts.length - 1 };
  }
  stage.invalidate();
  if (loaded.length && doc.parts.length === loaded.length) stage.fit();
  const bg = cleared ? " The plain background was removed (Restore original if it took too much)." : "";
  say((doc.parts.length === loaded.length
    ? "Now check the face: drag the eyes, cheeks and head circle onto your picture."
    : `${loaded.length === 1 ? "Picture" : "Pictures"} added. Drag to move, use the corner to resize.`) + bg, "ok");
  if (doc.parts.length === loaded.length) focus = { kind: "face" };
  refresh(true);
}

async function addExpression(mood: Mood, file: File) {
  const img = await readImage(file);
  if (!img) return;
  checkpoint();
  const placed: Placed = { img: addToPool(img), x: 0, y: 0, scale: 1 };
  if (img.width >= doc.w * 0.8 || img.height >= doc.h * 0.8) {
    // Drawn on the full canvas, like the other pictures: lines up as is.
    placed.scale = Math.min(doc.w / img.width, doc.h / img.height);
  } else {
    // Just a face: fit it into the face area.
    const b = doc.cover;
    placed.scale = Math.min((b.x1 - b.x0) / img.width, (b.y1 - b.y0) / img.height);
    placed.x = Math.round((b.x0 + b.x1) / 2 - (img.width * placed.scale) / 2);
    placed.y = Math.round((b.y0 + b.y1) / 2 - (img.height * placed.scale) / 2);
  }
  // The first face sets the face area: around what it draws, a little wider.
  if (!Object.keys(doc.expressions).length) {
    const b = opaqueBox(bake(doc, [placed]));
    if (b) {
      const pad = doc.head.r * 0.1;
      doc.cover = { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad };
    }
  }
  doc.expressions[mood] = placed;
  focus = { kind: "expr", mood };
  stage.invalidate();
  say("Move the face over the purple face area; that area is painted with the skin colour first.", "ok");
  refresh(true);
}

// Pictures dropped anywhere on the window.
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dragging");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  // Dropped on an expression tile: that mood's face.
  const tile = (e.target as HTMLElement).closest?.("[data-mood]") as HTMLElement | null;
  if (tile?.dataset.mood) void addExpression(tile.dataset.mood as Mood, files[0]);
  else void addPictures(files);
});

// ── Small UI helpers ──────────────────────────────────────────────────────────

function field(label: string, ...children: (Node | null)[]): HTMLElement {
  return h("div", { class: "field" }, h("label", { text: label }), ...children);
}

function segmented<T extends string>(value: T, options: [T, string][], onPick: (v: T) => void): HTMLElement {
  return h(
    "div",
    { class: "seg" },
    ...options.map(([v, label]) =>
      h("button", { class: v === value ? "on" : "", text: label, onclick: () => onPick(v) }),
    ),
  );
}

function colourField(label: string, value: string, set: (v: string) => void, pickable = false): HTMLElement {
  const input = h("input", { type: "color", value }) as HTMLInputElement;
  input.addEventListener("input", () => {
    set(input.value);
    refresh(false);
  });
  input.addEventListener("change", () => refresh(true));
  input.addEventListener("pointerdown", () => checkpoint());
  const picker = pickable
    ? h("button", {
        class: "small",
        text: "Pick from picture",
        onclick: () => {
          say("Click on your picture to take its colour.");
          stage.pickColour = (hex) => {
            if (!hex) return say("There's nothing there to take a colour from.", "err");
            checkpoint();
            set(hex);
            say("");
            refresh(true);
          };
        },
      })
    : null;
  return field(label, h("div", { class: "row" }, input, picker));
}

function thumb(placed: Placed, size = 34): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = size * 2;
  c.height = size * 2;
  c.style.width = `${size}px`;
  c.style.height = `${size}px`;
  const img = pool.get(placed.img);
  if (img) {
    const x = c.getContext("2d")!;
    const k = Math.min(c.width / img.width, c.height / img.height);
    x.drawImage(img, (c.width - img.width * k) / 2, (c.height - img.height * k) / 2, img.width * k, img.height * k);
  }
  return c;
}

// ── Panels ────────────────────────────────────────────────────────────────────

const ROLES: [PartRole, string][] = [
  ["head", "Head"],
  ["back", "Behind the head"],
  ["front", "In front"],
  ["iris", "Irises (follow the pointer)"],
];

function renderPictures() {
  clear(picturesBox);
  if (!doc.parts.length) {
    picturesBox.append(h("div", { class: "hint", text: "No pictures yet. Drop one on the canvas, or choose some." }));
  }
  doc.parts.forEach((part, i) => {
    const on = focus.kind === "part" && focus.index === i;
    const move = (d: number) => {
      const j = i + d;
      if (j < 0 || j >= doc.parts.length) return;
      checkpoint();
      [doc.parts[i], doc.parts[j]] = [doc.parts[j], doc.parts[i]];
      focus = { kind: "part", index: j };
      stage.invalidate();
      refresh(true);
    };
    picturesBox.append(
      h(
        "div",
        { class: on ? "item on" : "item", onclick: () => { focus = { kind: "part", index: i }; refresh(true); } },
        thumb(part),
        h("div", { class: "item-text" },
          h("div", { class: "item-name", text: part.name }),
          h("div", { class: "hint", text: ROLES.find(([r]) => r === part.role)?.[1] ?? "" }),
        ),
        h("button", { class: "icon", title: "Draw earlier (further back)", text: "↑", onclick: (e: Event) => { e.stopPropagation(); move(-1); } }),
        h("button", { class: "icon", title: "Draw later (further forward)", text: "↓", onclick: (e: Event) => { e.stopPropagation(); move(1); } }),
        h("button", {
          class: "icon", title: "Remove this picture", text: "✕",
          onclick: (e: Event) => {
            e.stopPropagation();
            checkpoint();
            doc.parts.splice(i, 1);
            fixFocus();
            stage.invalidate();
            refresh(true);
          },
        }),
      ),
    );
  });
  picturesBox.append(h("button", { text: "Add pictures…", onclick: () => pickFiles((f) => void addPictures(f)) }));
}

function renderPart() {
  clear(partBox);
  const part = focus.kind === "part" ? doc.parts[focus.index] : null;
  partBox.parentElement!.style.display = part ? "" : "none";
  if (!part) return;
  const set = (fn: () => void) => {
    checkpoint();
    fn();
    stage.invalidate();
    refresh(true);
  };
  const name = h("input", { value: part.name, maxlength: "32" }) as HTMLInputElement;
  name.addEventListener("change", () => set(() => (part.name = name.value.trim() || part.name)));
  partBox.append(
    field("Name", name),
    field("What is it", segmented(part.role, ROLES, (v) => set(() => (part.role = v)))),
  );
  if (part.role !== "iris") {
    partBox.append(field("Movement", segmented<Motion>(part.motion, [
      ["still", "Still"], ["swing", "Swings"], ["bend", "Bends like hair"],
    ], (v) => set(() => {
      part.motion = v;
      if (v !== "still") placeMotion(doc, part);
    }))));
    if (part.motion !== "still") {
      const mirrored = h("input", { type: "checkbox" }) as HTMLInputElement;
      mirrored.checked = part.mirrored;
      mirrored.addEventListener("change", () => set(() => (part.mirrored = mirrored.checked)));
      partBox.append(
        field("Feel", segmented<Feel>(part.feel, [["floppy", "Floppy"], ["bouncy", "Bouncy"], ["subtle", "Subtle"]], (v) => set(() => (part.feel = v)))),
        h("label", { class: "check" }, mirrored, h("span", { text: "Swing the other way (for the right one of a pair)" })),
        h("div", { class: "hint", text: part.motion === "bend"
          ? "Drag the orange dots: the root stays put, the tip whips the most."
          : "Drag the orange dot to where it hangs from (a shoulder, a hair tie)." }),
      );
    }
  } else {
    partBox.append(h("div", { class: "hint", text: "Just the coloured part of the eyes. It slides inside the eye outlines to look at the pointer." }));
  }
  partBox.append(
    h("div", { class: "row" },
      h("button", {
        class: "small",
        text: "Remove background",
        title: "Clear the plain colour around the picture",
        onclick: async () => {
          const img = pool.get(part.img);
          if (!img) return;
          const cleared = await removeBackground(img);
          set(() => {
            part.original ??= part.img;
            part.img = addToPool(cleared);
          });
          say("Background removed. Undo if it took too much.", "ok");
        },
      }),
      part.original
        ? h("button", {
            class: "small",
            text: "Restore original",
            title: "Bring back the background",
            onclick: () => set(() => {
              part.img = part.original!;
              part.original = undefined;
            }),
          })
        : null,
      h("button", {
        class: "small",
        text: "Fit to canvas",
        onclick: () => set(() => {
          const img = pool.get(part.img)!;
          part.scale = Math.min(doc.w / img.width, doc.h / img.height);
          part.x = Math.round((doc.w - img.width * part.scale) / 2);
          part.y = Math.round((doc.h - img.height * part.scale) / 2);
          placeMotion(doc, part);
        }),
      }),
    ),
  );
}

function renderFace() {
  clear(faceBox);
  const on = focus.kind === "face";
  const pixel = h("input", { type: "checkbox" }) as HTMLInputElement;
  pixel.checked = doc.pixel;
  pixel.addEventListener("change", () => {
    checkpoint();
    doc.pixel = pixel.checked;
    stage.invalidate();
    refresh(true);
  });
  faceBox.append(
    h("button", {
      class: on ? "primary" : "",
      text: on ? "Adjusting the face" : "Adjust the face",
      onclick: () => { focus = { kind: "face" }; refresh(true); },
    }),
    h("div", { class: "hint", text: "Blue: the head circle and its size. Green: the eyes (they blink there). Orange: the chin, where it squashes and tilts from. Pink: the cheeks." }),
    colourField("Skin around the eyes (for blinking)", doc.lid, (v) => {
      doc.lid = v;
      doc.lidAuto = false;
    }, true),
    h("div", { class: "hint", text: doc.lidAuto ? "Taken from under the eyes; it follows them as you move them." : "Picked by you." }),
    colourField("Eyelashes and drawn eyes", doc.lash, (v) => (doc.lash = v), true),
    colourField("Blush", doc.blush, (v) => (doc.blush = v)),
    h("label", { class: "check" }, pixel, h("span", { text: "Pixel art (keep edges sharp)" })),
  );
}

function renderExpressions() {
  clear(exprBox);
  exprBox.append(h("div", { class: "hint", text: "Optional: a drawn face for each mood. Moods without one use Mochi's eyes in your eyelash colour. Click a mood, or drop a picture on it." }));
  const grid = h("div", { class: "moods" });
  for (const [mood, label] of MOODS) {
    const placed = doc.expressions[mood];
    const on = focus.kind === "expr" && focus.mood === mood;
    grid.append(
      h(
        "div",
        {
          class: `mood${on ? " on" : ""}${placed ? " has" : ""}`,
          "data-mood": mood,
          title: placed ? "Click to place it" : "Click to add a picture",
          onclick: () => {
            if (placed) {
              focus = { kind: "expr", mood };
              stage.invalidate();
              refresh(true);
            } else {
              pickFiles((f) => void addExpression(mood, f[0]), false);
            }
          },
        },
        placed ? thumb(placed, 30) : h("div", { class: "plus", text: "+" }),
        h("span", { text: label }),
        placed
          ? h("button", {
              class: "icon", title: "Remove this face", text: "✕",
              onclick: (e: Event) => {
                e.stopPropagation();
                checkpoint();
                delete doc.expressions[mood];
                fixFocus();
                stage.invalidate();
                refresh(true);
              },
            })
          : null,
      ),
    );
  }
  exprBox.append(grid);
}

function renderAbout() {
  clear(aboutBox);
  const author = h("input", { value: doc.author, maxlength: "60", placeholder: "Your name (optional)" }) as HTMLInputElement;
  const note = h("input", { value: doc.note, maxlength: "300", placeholder: "Shown when someone imports it (optional)" }) as HTMLInputElement;
  const persona = h("textarea", { rows: "5", maxlength: "2000", placeholder: "How it talks in the island's chat (optional). E.g. “You are a sleepy cat who answers in short, warm sentences.”" }) as HTMLTextAreaElement;
  persona.value = doc.persona;
  const count = h("div", { class: "hint", text: `${doc.persona.length} / 2000` });
  const bind = (el: HTMLInputElement | HTMLTextAreaElement, set: (v: string) => void) => {
    el.addEventListener("focus", () => checkpoint());
    el.addEventListener("input", () => {
      set(el.value);
      count.textContent = `${doc.persona.length} / 2000`;
      dirty = true;
    });
  };
  bind(author, (v) => (doc.author = v));
  bind(note, (v) => (doc.note = v));
  bind(persona, (v) => (doc.persona = v));
  aboutBox.append(
    field("Author", author),
    field("Note", note),
    field("Chat personality", persona),
    count,
    h("div", { class: "hint", text: "Write {{user}} where the person's name goes and {{char}} for the character's own name; they're filled in when you chat (the name comes from Settings → Your name)." }),
  );
}

function panel(title: string, body: HTMLElement, open = true): HTMLElement {
  const el = h("details", { class: "panel" }, h("summary", { text: title }), body) as HTMLDetailsElement;
  el.open = open;
  return el;
}

function renderStageHint() {
  const hints: Record<Focus["kind"], string> = {
    part: "Drag the picture to move it, the blue square to resize it. Drag empty space to pan, scroll to zoom.",
    face: "Drag the dots onto your picture. Scroll to zoom in for the eyes.",
    expr: "Drag the face picture into place over the purple face area.",
  };
  stageHint.textContent = doc.parts.length ? hints[focus.kind] : "";
  dropNote.style.display = doc.parts.length ? "none" : "";
  zoomLabel.textContent = `${stage.zoomPercent}%`;
}

// ── Refresh and preview ───────────────────────────────────────────────────────

let previewTimer = 0;
function schedulePreview() {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    void preview.wear(doc.parts.some((p) => p.role === "head") ? build(doc) : null);
  }, 220);
}

/** `full`: the panels are rebuilt too (not during a drag, which only moves things). */
function refresh(full: boolean) {
  // Moving the eyes moves where the skin colour is read from (until one is picked).
  if (focus.kind === "face" && doc.lidAuto && doc.parts.length) {
    const lid = skinNearEyes(doc, stage.figure());
    if (lid && lid !== doc.lid) {
      doc.lid = lid;
      if (!full) renderFace();
    }
  }
  if (nameInput.value !== doc.name && document.activeElement !== nameInput) nameInput.value = doc.name;
  stage.draw();
  schedulePreview();
  undoBtn.disabled = !past.length;
  redoBtn.disabled = !future.length;
  renderStageHint();
  if (!full) return;
  renderPictures();
  renderPart();
  renderFace();
  renderExpressions();
}

stage.onZoom = () => (zoomLabel.textContent = `${stage.zoomPercent}%`);

nameInput.addEventListener("focus", () => checkpoint());
nameInput.addEventListener("input", () => {
  doc.name = nameInput.value;
  dirty = true;
});

// ── Save ──────────────────────────────────────────────────────────────────────

async function toBase64(blob: Blob): Promise<string> {
  const url: string = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(",") + 1);
}

async function bundleFiles(): Promise<[string, string][] | null> {
  const issues = problems(doc);
  if (issues.length) {
    say(issues.join(" "), "err");
    if (!doc.name.trim()) nameInput.focus();
    return null;
  }
  const built = build(doc);
  const files: [string, string][] = [];
  for (const [name, canvas] of built.pictures) {
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      say("A picture could not be saved.", "err");
      return null;
    }
    files.push([name, await toBase64(blob)]);
  }
  const json = new TextEncoder().encode(JSON.stringify(built.manifest, null, 2));
  files.push(["manifest.json", await toBase64(new Blob([json]))]);
  return files;
}

async function saveAndUse() {
  const files = await bundleFiles();
  if (!files) return;
  say("Saving…");
  try {
    const info = await Bridge.skinSave(files, null);
    doc.id = info.id;
    dirty = false;
    // Wear it straight away: the island and the settings window both follow.
    const boot = await Bridge.boot();
    if (boot) await Bridge.saveSettings({ ...boot.settings, skin: BUNDLE_PREFIX + info.id });
    say(`Saved. ${info.name} is on the island now.`, "ok");
    void fillOpen();
  } catch (err) {
    say(String(err), "err");
  }
}

async function exportZip() {
  const files = await bundleFiles();
  if (!files) return;
  const path = await Bridge.pickSkinZip(skinId(doc));
  if (!path) return;
  try {
    const info = await Bridge.skinSave(files, path);
    say(`Exported ${info.name}. Anyone can import that .zip in Settings → Character.`, "ok");
  } catch (err) {
    say(String(err), "err");
  }
}

// ── New and open ──────────────────────────────────────────────────────────────

function confirmDiscard(): boolean {
  return !dirty || window.confirm("Discard the changes to this skin?");
}

function startNew() {
  if (!confirmDiscard()) return;
  doc = emptyDoc();
  focus = { kind: "face" };
  past = [];
  future = [];
  dirty = false;
  stage.invalidate();
  stage.fit();
  preview.play(PREVIEW_MOODS[0]);
  say("");
  refresh(true);
  renderAbout();
}

async function openInstalled(id: string) {
  if (!confirmDiscard()) return;
  say("Opening…");
  const text = await Bridge.skinManifest(id);
  if (!text) return say("That skin isn't installed any more.", "err");
  let m: any;
  try {
    m = JSON.parse(text);
  } catch {
    return say("That skin's manifest can't be read.", "err");
  }
  const names = new Set<string>();
  for (const l of Array.isArray(m.layers) ? m.layers : []) if (typeof l?.src === "string") names.add(l.src);
  if (typeof m.iris?.src === "string") names.add(m.iris.src);
  for (const v of Object.values(m.expressions ?? {})) if (typeof v === "string") names.add(v);
  const images = new Map<string, ImageBitmap>();
  for (const n of names) {
    const bytes = await Bridge.skinLayer(id, n);
    if (bytes) images.set(n, await createImageBitmap(new Blob([bytes], { type: "image/png" })));
  }
  doc = fromManifest(id, m, images);
  if (Math.max(doc.w, doc.h) > MAX_SIDE) say("This skin is very large; saving may be slow.");
  focus = doc.parts.length ? { kind: "part", index: 0 } : { kind: "face" };
  past = [];
  future = [];
  dirty = false;
  stage.invalidate();
  stage.fit();
  say(`Editing ${doc.name}. Saving replaces it.`, "ok");
  refresh(true);
  renderAbout();
}

async function fillOpen() {
  const skins: SkinInfo[] = await listBundles();
  clear(openSelect);
  openSelect.append(
    h("option", { value: "", text: skins.length ? "Open an installed skin…" : "No installed skins yet" }),
    ...skins.map((s) => h("option", { value: s.id, text: s.name })),
  );
  openSelect.value = "";
}
openSelect.addEventListener("change", () => {
  const id = openSelect.value;
  openSelect.value = "";
  if (id) void openInstalled(id);
});

// ── Layout ────────────────────────────────────────────────────────────────────

const moodButtons = h("div", { class: "moods-play" },
  ...PREVIEW_MOODS.map((m) => h("button", { class: "small", text: m.label, onclick: () => preview.play(m) })),
);

root.replaceChildren(
  h("header", { class: "top" },
    h("div", { class: "title", text: "Skin editor" }),
    nameInput,
    h("button", { text: "New", onclick: startNew }),
    openSelect,
    undoBtn,
    redoBtn,
    h("div", { class: "spacer" }),
    h("button", { text: "Export .zip…", title: "A file to share; others import it in Settings", onclick: () => void exportZip() }),
    h("button", { class: "primary", text: "Save and use", onclick: () => void saveAndUse() }),
  ),
  h("main", { class: "body" },
    h("aside", { class: "side" },
      panel("1. Pictures", picturesBox),
      panel("Selected picture", partBox),
      panel("2. Face", faceBox),
      panel("3. Expressions", exprBox, false),
      panel("4. About", aboutBox, false),
    ),
    h("section", { class: "canvas-area" },
      stage.el,
      dropNote,
      h("div", { class: "stage-bar" },
        stageHint,
        h("div", { class: "spacer" }),
        zoomLabel,
        h("button", { class: "small", text: "Fit", onclick: () => { stage.fit(); renderStageHint(); } }),
      ),
    ),
    h("aside", { class: "right" },
      h("div", { class: "right-title", text: "Live preview" }),
      preview.el,
      preview.status,
      h("div", { class: "hint", text: "Move your pointer around: it looks at you. Try the moods:" }),
      moodButtons,
      h("div", { class: "spacer" }),
      status,
    ),
  ),
  fileInput,
);

// The keys are the user's (Settings → Keyboard); this window learns of changes.
let keys: Record<string, string> = {};
void Bridge.boot().then((b) => {
  if (b) keys = b.settings.keys ?? {};
});
void onEvent<{ keys?: Record<string, string> }>("settings-changed", (s) => {
  keys = s.keys ?? {};
});

window.addEventListener("keydown", (e) => {
  const typing = (e.target as HTMLElement).closest("input, textarea");
  if (typing) return;
  const combo = comboFromEvent(e);
  if (!combo) return;
  if (combo === binding(keys, "editor.undo")) {
    e.preventDefault();
    undo();
  } else if (combo === binding(keys, "editor.redo") || combo === "Ctrl+Shift+Z") {
    e.preventDefault();
    redo();
  } else if (combo === binding(keys, "editor.cancel") && stage.pickColour) {
    stage.pickColour = null;
    say("");
  }
});

// Opened from Settings: on a new skin, or on an installed one.
void onEvent<string | null>("skin-editor-open", (id) => {
  if (id) void openInstalled(id);
  else if (doc.parts.length && dirty) say("Still editing your last skin. Use New to start over.");
});

void fillOpen();
refresh(true);
renderAbout();
preview.play(PREVIEW_MOODS[0]);
