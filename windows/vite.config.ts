import { defineConfig, type Plugin } from "vite";
import { existsSync, mkdirSync, readdirSync, copyFileSync, createReadStream } from "node:fs";
import { resolve, join, extname } from "node:path";

// ───────────────────────────────────────────────────────────────────────────────
// THE one and only place the shared sound folder is declared.
// The 28 WAVs live in the macOS app and are NOT duplicated in the repo; when they
// move to `shared/sounds/`, change this single line.
export const SOUNDS_DIR = resolve(__dirname, "../NotchBuddy/Resources/sounds");
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Serves SOUNDS_DIR at /sounds/*.wav in dev, and copies it into dist/sounds on build.
 * Keeps the WAVs out of windows/ while still shipping them inside the installer.
 */
function sharedSounds(): Plugin {
  const prefix = "/sounds/";
  return {
    name: "coucou-shared-sounds",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next();
        const name = decodeURIComponent(req.url.slice(prefix.length).split("?")[0]);
        if (name.includes("/") || name.includes("\\") || extname(name) !== ".wav") return next();
        const file = join(SOUNDS_DIR, name);
        if (!existsSync(file)) return next();
        res.setHeader("Content-Type", "audio/wav");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const out = resolve(__dirname, "dist/sounds");
      if (!existsSync(SOUNDS_DIR)) {
        this.warn(`sounds not found at ${SOUNDS_DIR} — the build will ship without audio`);
        return;
      }
      mkdirSync(out, { recursive: true });
      for (const f of readdirSync(SOUNDS_DIR)) {
        if (extname(f) === ".wav") copyFileSync(join(SOUNDS_DIR, f), join(out, f));
      }
    },
  };
}

/**
 * src/mochi/local/ holds a developer's own, never-shipped character skins (see
 * src/mochi/localSkins.ts). Dev builds load them; release builds must not carry
 * a byte of them. The code is already dead in a release build, but Vite still
 * emits any asset a local module imports as soon as it reads the file, so in
 * builds every module there is replaced by an empty one before it is read.
 */
function noLocalSkinsInBuilds(): Plugin {
  // The trailing slash matters: src/mochi/localSkins.ts must not match.
  const local = resolve(__dirname, "src/mochi/local").replace(/\\/g, "/") + "/";
  return {
    name: "coucou-no-local-skins",
    apply: "build",
    enforce: "pre",
    load(id) {
      if (id.replace(/\\/g, "/").startsWith(local)) return "export default null;";
    },
  };
}

export default defineConfig({
  plugins: [sharedSounds(), noLocalSkinsInBuilds()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      // Cargo locks files under target/ while it builds them; if Vite watches
      // them, Node throws EBUSY and takes `tauri dev` down with it. `target/` is
      // at the workspace root here (this folder), not inside src-tauri/, so both
      // trees have to be ignored. The Tauri CLI watches src-tauri itself.
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        island: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
        skinEditor: resolve(__dirname, "skin-editor.html"),
        highlight: resolve(__dirname, "highlight.html"),
      },
    },
  },
});
