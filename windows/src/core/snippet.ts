// What a Claude Code tool call is doing to a file, turned into a few lines of
// code the Home view can draw. Pure functions only (no DOM, no Tauri) so the
// diff and the tokenizer can be checked on their own.

export type LineKind = "add" | "del" | "ctx";

export interface CodeLine {
  kind: LineKind;
  /** Line number in the file; null while the file hasn't been read. */
  no: number | null;
  text: string;
}

export type Lang = "ts" | "js" | "rs" | "py" | "json" | "css" | "html" | "md" | "go" | "c" | "sh" | "txt";
export type ToolVerb = "Read" | "Edit" | "Write";

export interface FileActivity {
  /** Bumped per tool call, so a late file read can't overwrite a newer call. */
  seq: number;
  verb: ToolVerb;
  /** Absolute path as Claude Code sent it. */
  path: string;
  /** Path relative to the session folder when it is inside it. */
  rel: string;
  name: string;
  lang: Lang;
  lines: CodeLine[];
  /** True once the lines carry real file line numbers. */
  numbered: boolean;
}

/** The file around an edit, read by the Rust side (`read_snippet`). */
export interface FileContext {
  /** 1-based line of the first match (or of the requested offset). */
  line: number;
  before: string[];
  body: string[];
  after: string[];
}

/** Most lines the editor view keeps; the compact card shows MINI_LINES. */
export const MAX_LINES = 14;
export const MINI_LINES = 3;

const BASH_LIKE = new Set(["Bash", "PowerShell"]);
export const isFileTool = (tool: string) =>
  tool === "Read" || tool === "Edit" || tool === "MultiEdit" || tool === "Write" || tool === "NotebookEdit";
export const isShellTool = (tool: string) => BASH_LIKE.has(tool);

// ── Paths ─────────────────────────────────────────────────────────────────────

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/** `C:\work\korus\src\invoice.ts` → `src/invoice.ts` when `cwd` is `C:\work\korus`. */
export function relativePath(path: string, cwd: string): string {
  const norm = (s: string) => s.replace(/\\/g, "/");
  const p = norm(path);
  const c = norm(cwd).replace(/\/+$/, "");
  if (c && p.toLowerCase().startsWith(`${c.toLowerCase()}/`)) return p.slice(c.length + 1);
  return p;
}

const EXT: Record<string, Lang> = {
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  js: "js", jsx: "js", mjs: "js", cjs: "js",
  rs: "rs", py: "py", json: "json", css: "css", scss: "css",
  html: "html", htm: "html", md: "md", go: "go",
  c: "c", h: "c", cpp: "c", cc: "c", hpp: "c", java: "c", cs: "c", swift: "c", kt: "c",
  sh: "sh", bash: "sh", zsh: "sh", ps1: "sh", toml: "sh", yml: "sh", yaml: "sh",
};

export function langFromPath(path: string): Lang {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m && EXT[m[1].toLowerCase()]) || "txt";
}

/** The short badge on the file tab: "TS", "RS", "PY"… */
export function badgeFor(path: string): { label: string; color: string } {
  const lang = langFromPath(path);
  const ext = (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? "").toUpperCase();
  const colors: Partial<Record<Lang, string>> = {
    ts: "#3178c6", js: "#c9a60a", rs: "#c2693b", py: "#3a76a8", json: "#6b7079",
    css: "#6a5acd", html: "#d0572f", md: "#6b7079", go: "#2aa1c0", sh: "#4f8a5b",
  };
  return { label: (ext || "TXT").slice(0, 3), color: colors[lang] ?? "#5f646d" };
}

// ── Diff ──────────────────────────────────────────────────────────────────────

function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.replace(/\r\n/g, "\n").split("\n");
  // A trailing newline isn't a line of its own.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Old text → new text as red/green lines. The lines both texts start and end
 * with are not changes: one of each is kept as context, the rest is dropped.
 * `ctx` (from the file) numbers the lines and adds real surrounding code.
 */
export function diffLines(oldText: string, newText: string, ctx?: FileContext | null): CodeLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const dels = a.slice(pre, a.length - suf);
  const adds = b.slice(pre, b.length - suf);
  const first = ctx ? ctx.line + pre : null;
  const num = (offset: number) => (first == null ? null : first + offset);

  const out: CodeLine[] = [];
  // Context above: what the file has right before the changed lines.
  const above = [...(ctx?.before ?? []), ...a.slice(0, pre)];
  const aboveStart = first == null ? null : first - above.length;
  above.slice(-2).forEach((text, i, arr) => {
    out.push({ kind: "ctx", no: aboveStart == null ? null : aboveStart + above.length - arr.length + i, text });
  });
  dels.forEach((text, i) => out.push({ kind: "del", no: num(i), text }));
  adds.forEach((text, i) => out.push({ kind: "add", no: num(i), text }));
  // Context below: the matching tail first, then whatever the file continues with.
  const below = [...a.slice(a.length - suf), ...(ctx?.after ?? [])];
  below.slice(0, 2).forEach((text, i) => out.push({ kind: "ctx", no: num(adds.length + i), text }));
  return out.slice(0, MAX_LINES);
}

/** A plain run of lines (a Read window, or the start of a written file). */
export function plainLines(text: string[], kind: LineKind, start: number | null): CodeLine[] {
  return text.slice(0, MAX_LINES).map((t, i) => ({ kind, no: start == null ? null : start + i, text: t }));
}

// ── Tool call → activity ──────────────────────────────────────────────────────

let seq = 0;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Everything the payload says about a file tool; `null` for any other tool. */
export function activityFromTool(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): FileActivity | null {
  if (!isFileTool(tool)) return null;
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  if (!path) return null;

  const base = { seq: ++seq, path, rel: relativePath(path, cwd), name: baseName(path), lang: langFromPath(path) };

  if (tool === "Edit") {
    const lines = diffLines(str(input.old_string) ?? "", str(input.new_string) ?? "");
    return { ...base, verb: "Edit", lines, numbered: false };
  }
  if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    const lines: CodeLine[] = [];
    for (const e of input.edits as Record<string, unknown>[]) {
      const part = diffLines(str(e?.old_string) ?? "", str(e?.new_string) ?? "").filter((l) => l.kind !== "ctx");
      lines.push(...part);
      if (lines.length >= MAX_LINES) break;
    }
    return { ...base, verb: "Edit", lines: lines.slice(0, MAX_LINES), numbered: false };
  }
  if (tool === "Write") {
    return { ...base, verb: "Write", lines: plainLines(splitLines(str(input.content) ?? ""), "add", 1), numbered: true };
  }
  if (tool === "NotebookEdit") {
    const lines = plainLines(splitLines(str(input.new_source) ?? ""), "add", null);
    return { ...base, verb: "Edit", lines, numbered: false };
  }
  // Read: the payload has no content, the file read fills it in.
  return { ...base, verb: "Read", lines: [], numbered: false };
}

/** What `read_snippet` should look for, for the Rust side. */
export function contextRequest(tool: string, input: Record<string, unknown>) {
  if (tool === "Edit") {
    const needle = str(input.old_string) ?? str(input.new_string);
    return needle ? { needle, offset: null, count: 0, before: 2, after: 2 } : null;
  }
  if (tool === "Read") {
    const offset = typeof input.offset === "number" && input.offset > 0 ? Math.floor(input.offset) : 1;
    return { needle: null, offset, count: MAX_LINES, before: 0, after: 0 };
  }
  return null;
}

/** Folds the file's own lines into the activity the payload gave. */
export function withContext(
  a: FileActivity,
  tool: string,
  input: Record<string, unknown>,
  ctx: FileContext,
): FileActivity {
  if (a.verb === "Read") {
    return { ...a, lines: plainLines(ctx.body, "ctx", ctx.line), numbered: true };
  }
  if (tool === "Edit") {
    return {
      ...a,
      lines: diffLines(str(input.old_string) ?? "", str(input.new_string) ?? "", ctx),
      numbered: true,
    };
  }
  return a;
}

// ── Tokenizer ─────────────────────────────────────────────────────────────────

export type TokKind = "kw" | "str" | "num" | "com" | "type" | "fn" | "plain";
export interface Tok {
  k: TokKind;
  s: string;
}

const KW_C = "if else for while do switch case break continue return new delete this super class extends implements interface enum struct union typedef static public private protected void int float double char bool long unsigned try catch finally throw null true false default const let var in of as import from export package namespace using";
const KEYWORDS: Record<Lang, Set<string>> = {
  ts: new Set(`${KW_C} function async await yield type declare readonly keyof typeof instanceof undefined satisfies abstract get set number string boolean any unknown never`.split(" ")),
  js: new Set(`${KW_C} function async await yield typeof instanceof undefined`.split(" ")),
  rs: new Set("fn let mut const static struct enum impl trait pub use mod crate self Self super match if else for while loop break continue return as in where async await move ref dyn type unsafe extern true false Some None Ok Err".split(" ")),
  py: new Set("def class return if elif else for while in not and or is import from as with try except finally raise pass break continue lambda yield None True False async await global nonlocal assert del".split(" ")),
  go: new Set("func package import var const type struct interface map chan go defer return if else for range switch case default break continue select fallthrough nil true false".split(" ")),
  c: new Set(KW_C.split(" ")),
  sh: new Set("if then else elif fi for do done while case esac function in export local return true false".split(" ")),
  json: new Set(["true", "false", "null"]),
  css: new Set(),
  html: new Set(),
  md: new Set(),
  txt: new Set(),
};

const HASH_COMMENT = new Set<Lang>(["py", "sh"]);
const NO_TOKENS = new Set<Lang>(["md", "txt"]);

/** Splits one line into coloured runs. Deliberately small: one line at a time, no multi-line state. */
export function tokenize(line: string, lang: Lang): Tok[] {
  if (NO_TOKENS.has(lang) || line === "") return [{ k: "plain", s: line }];
  const kws = KEYWORDS[lang];
  const out: Tok[] = [];
  const push = (k: TokKind, s: string) => {
    const last = out.at(-1);
    if (last && last.k === k) last.s += s;
    else out.push({ k, s });
  };
  const re = /(\/\/.*|\/\*.*?\*\/|#.*)|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([\s\S])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m[1]) {
      // `#` starts a comment only where the language says so (not CSS colours, not Rust attributes).
      if (m[1].startsWith("#") && !HASH_COMMENT.has(lang)) push("plain", m[1]);
      else push("com", m[1]);
    } else if (m[2]) push("str", m[2]);
    else if (m[3]) push("num", m[3]);
    else if (m[4]) {
      const word = m[4];
      const next = line[re.lastIndex] ?? "";
      if (kws.has(word)) push("kw", word);
      else if (next === "(") push("fn", word);
      else if (/^[A-Z]/.test(word)) push("type", word);
      else push("plain", word);
    } else push("plain", m[5]);
  }
  return out;
}
