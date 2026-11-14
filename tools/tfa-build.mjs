#!/usr/bin/env node
/**
 * Fetches, builds and installs "Tools for Autodarts" into the WebView wrapper.
 *
 *   node tools/tfa-build.mjs [--tag 2.4.0] [--skip-fetch] [--skip-build]
 *
 * The upstream extension is NEVER copied into this repository. It is cloned
 * (shallow, pinned to a tag) into third_party/, which is gitignored.
 *
 * Pipeline:
 *   1. clone/update creazy231/tools-for-autodarts at the pinned tag
 *   2. yarn install --frozen-lockfile && yarn build   -> .output/chrome-mv3/
 *   3. copy into app/src/main/assets/tfa/, excluding images/ (~30 MB of
 *      feature screenshots) and background.js (replaced by TfaBridge.kt)
 *   4. drop a stub __noop.js next to it (see tfa-shim.js, MAIN-world section)
 *   5. check the build against what the wrapper actually implements, and
 *      fail loudly on anything new upstream. Three things can grow without
 *      the code noticing, and all three fail SILENTLY at runtime:
 *        - extension APIs the content scripts call
 *        - message types the (replaced) service worker answers
 *        - scripts injected into the page's main world
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM = "https://github.com/creazy231/tools-for-autodarts.git";

/** Pinned upstream release. Bump this, re-run, and read the API report. */
const DEFAULT_TAG = "3.4.0";

const SRC_DIR = path.join(ROOT, "third_party", "tools-for-autodarts");
const BUILD_DIR = path.join(SRC_DIR, ".output", "chrome-mv3");
const DEST_DIR = path.join(ROOT, "app", "src", "main", "assets", "tfa");

/** Not shipped: 30 MB of settings-UI screenshots, and the MV3 service worker. */
const EXCLUDE_DIRS = new Set(["images"]);
const EXCLUDE_FILES = new Set(["background.js"]);
const EXCLUDE_EXT = new Set([".map"]);

/**
 * Extension API surface the shim (app/src/main/assets/tfa-shim.js) implements.
 *
 * Anything outside this list means a content script would silently no-op at
 * runtime — MV3 APIs return undefined rather than throwing when absent.
 */
const SHIMMED_APIS = new Set([
  "runtime.id",
  "runtime.getURL",
  "runtime.getManifest",
  "runtime.sendMessage",
  "runtime.onMessage",
  "runtime.lastError",
  "storage.local.get",
  "storage.local.set",
  "storage.local.remove",
  "storage.local.clear",
  "storage.local.onChanged",
  "scripting.executeScript",
]);

/**
 * Message types upstream's service worker answers, each of which tfa-shim.js
 * (sendMessage) has to answer in its place. An unknown type resolves to
 * undefined there — the caller's promise settles, the feature does nothing.
 */
const SHIMMED_MESSAGES = new Set([
  "fetch",
  "teams:reorder-lease",
  "teams:undo-visit",
  "wled:upload",
]);

/**
 * Scripts the extension injects into the page's own JS world. Each one needs
 * a decision recorded here, because the WebView has no isolated world:
 *
 *   inline  MainActivity runs it itself at the right moment and tfa-shim.js
 *           redirects its <script src> to __noop.js (NOOP_SCRIPTS), so it
 *           cannot run twice.
 *   load    it is injected on demand and guards itself; its <script src> is
 *           served by the asset loader as-is.
 */
const MAIN_WORLD_SCRIPTS = new Map([
  ["websocket-capture.js", "inline"],
  ["auth-cookie.js", "inline"],
  ["quiet-own-darts.js", "load"],
]);

// ---------------------------------------------------------------- helpers

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const TAG = opt("--tag", DEFAULT_TAG);

const log = (...m) => console.log("[tfa]", ...m);
const die = (m) => {
  console.error("[tfa] ERROR: " + m);
  process.exit(1);
};

function run(cmd, cmdArgs, cwd) {
  log("$", cmd, cmdArgs.join(" "));
  execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

// ------------------------------------------------------- 1. fetch upstream

function fetchUpstream() {
  if (!fs.existsSync(SRC_DIR)) {
    fs.mkdirSync(path.dirname(SRC_DIR), { recursive: true });
    log(`cloning ${UPSTREAM} @ ${TAG}`);
    run("git", ["clone", "--depth", "1", "--branch", TAG, UPSTREAM, SRC_DIR], ROOT);
  } else {
    log(`updating existing checkout to ${TAG}`);
    run("git", ["fetch", "--depth", "1", "origin", "tag", TAG, "--no-tags"], SRC_DIR);
    run("git", ["checkout", "--force", TAG], SRC_DIR);
  }
}

// -------------------------------------------------------------- 2. build

/**
 * Resolve how to invoke yarn. A bare `yarn` is not on PATH on a stock Node
 * install; `corepack yarn` works there without needing `corepack enable`
 * (which wants write access to the Node install directory).
 */
function yarnCommand() {
  for (const candidate of [["yarn"], ["corepack", "yarn"]]) {
    try {
      execFileSync(candidate[0], [...candidate.slice(1), "--version"], {
        stdio: "ignore",
        shell: process.platform === "win32",
      });
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  die("yarn not found — install it, or use a Node with corepack available");
}

function build() {
  const yarn = yarnCommand();
  log(`using yarn via: ${yarn.join(" ")}`);
  run(yarn[0], [...yarn.slice(1), "install", "--frozen-lockfile"], SRC_DIR);
  run(yarn[0], [...yarn.slice(1), "build"], SRC_DIR);
  if (!fs.existsSync(BUILD_DIR)) die(`build produced no ${BUILD_DIR}`);
}

// --------------------------------------------------------------- 3. copy

function copyTree(from, to, rel = "") {
  fs.mkdirSync(to, { recursive: true });
  let bytes = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const name = entry.name;
    const childRel = rel ? `${rel}/${name}` : name;
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) {
        log(`skip  ${childRel}/ (excluded)`);
        continue;
      }
      bytes += copyTree(path.join(from, name), path.join(to, name), childRel);
    } else {
      if (EXCLUDE_FILES.has(childRel) || EXCLUDE_EXT.has(path.extname(name))) {
        log(`skip  ${childRel} (excluded)`);
        continue;
      }
      fs.copyFileSync(path.join(from, name), path.join(to, name));
      bytes += fs.statSync(path.join(from, name)).size;
    }
  }
  return bytes;
}

function install() {
  fs.rmSync(DEST_DIR, { recursive: true, force: true });
  const bytes = copyTree(BUILD_DIR, DEST_DIR);

  // Target for getURL() of the two MAIN-world injection scripts. They are run
  // inline by MainActivity instead; the <script src> must resolve to something
  // harmless so the extension's onload/onerror paths stay happy.
  fs.writeFileSync(
    path.join(DEST_DIR, "__noop.js"),
    "// Intentionally empty. See app/src/main/assets/tfa-shim.js (NOOP_SCRIPTS).\n"
  );

  log(`installed ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${path.relative(ROOT, DEST_DIR)}`);
}

// ------------------------------------------------- 4. API surface check

function checkApiSurface() {
  const csDir = path.join(DEST_DIR, "content-scripts");
  if (!fs.existsSync(csDir)) die("no content-scripts/ in the installed build");

  // The naive grep — /(browser|chrome)\.[a-z]+\.[a-zA-Z]+/ — is blind here:
  // the bundler minifies the namespace binding, so real calls look like
  // `wt.default.runtime.getURL(...)` and only the bootstrap keeps a literal
  // `globalThis.chrome.runtime.id`. Anchoring on `.default.` instead matches
  // how webextension-polyfill is actually imported, and matching a plain
  // `.runtime.`/`.storage.` would drown in false positives (window.history,
  // navigator.storage, ...).
  const PATTERNS = [
    /\.default\.([a-zA-Z]+)\.([a-zA-Z]+)(?:\.([a-zA-Z]+))?/g,
    /\bglobalThis\.(?:browser|chrome)\.([a-zA-Z]+)\.([a-zA-Z]+)(?:\.([a-zA-Z]+))?/g,
  ];

  const found = new Map(); // "runtime.getURL" -> Set(files)
  for (const f of fs.readdirSync(csDir).filter((f) => f.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(csDir, f), "utf8");
    for (const re of PATTERNS) {
      for (const m of text.matchAll(re)) {
        // storage is the one namespace whose area matters (storage.local.get),
        // so keep three segments there and two everywhere else.
        const api = m[1] === "storage" && m[3]
          ? `${m[1]}.${m[2]}.${m[3]}`
          : `${m[1]}.${m[2]}`;
        if (!found.has(api)) found.set(api, new Set());
        found.get(api).add(f);
      }
    }
  }

  if (!found.size) {
    die("API scan matched nothing — the bundler output shape changed, fix PATTERNS");
  }

  const known = [...found.keys()].filter((a) => SHIMMED_APIS.has(a)).sort();
  const unknown = [...found.keys()].filter((a) => !SHIMMED_APIS.has(a)).sort();

  log("--- extension API surface in content-scripts/ ---");
  for (const a of known) log(`  ok       ${a}  (${[...found.get(a)].join(", ")})`);

  if (unknown.length) {
    console.error("");
    console.error("[tfa] ERROR: unshimmed extension APIs found in the upstream build:");
    for (const a of unknown) {
      console.error(`  MISSING  ${a}  (${[...found.get(a)].join(", ")})`);
    }
    console.error("");
    console.error("[tfa] These return undefined at runtime and fail SILENTLY.");
    console.error("[tfa] Implement them in app/src/main/assets/tfa-shim.js and add");
    console.error("[tfa] them to SHIMMED_APIS in this script, then re-run.");
    process.exit(2);
  }

  log("no unshimmed APIs — the shim covers the whole build.");
}

// ------------------------------------------------- 5. message types

function checkMessageTypes() {
  // background.js is not shipped, but it is the one place that lists every
  // message the content scripts may send: its onMessage listener is a chain
  // of `message.type === "..."` tests, which survive minification verbatim.
  const background = path.join(BUILD_DIR, "background.js");
  if (!fs.existsSync(background)) die(`no ${background} — cannot check message types`);

  const text = fs.readFileSync(background, "utf8");
  const found = new Set([...text.matchAll(/\.type\s*===?\s*"([^"]+)"/g)].map((m) => m[1]));
  if (!found.size) die("message scan matched nothing — background.js changed shape, fix the pattern");

  log("--- message types answered by the service worker ---");
  const unknown = [];
  for (const type of [...found].sort()) {
    if (SHIMMED_MESSAGES.has(type)) log(`  ok       ${type}`);
    else unknown.push(type);
  }
  if (unknown.length) {
    console.error("");
    console.error("[tfa] ERROR: message types the shim does not answer:");
    for (const type of unknown) console.error(`  MISSING  ${type}`);
    console.error("");
    console.error("[tfa] sendMessage() resolves these to undefined and the feature does nothing.");
    console.error("[tfa] Read entrypoints/background.ts upstream, answer them in tfa-shim.js");
    console.error("[tfa] (and TfaBridge.kt if they need native code), then add them to");
    console.error("[tfa] SHIMMED_MESSAGES in this script.");
    process.exit(2);
  }
}

// --------------------------------------------- 6. main-world scripts

function checkMainWorldScripts() {
  const manifest = JSON.parse(fs.readFileSync(path.join(DEST_DIR, "manifest.json"), "utf8"));
  const scripts = new Set();
  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const resource of entry.resources ?? []) {
      if (resource.endsWith(".js")) scripts.add(resource.replace(/^\//, ""));
    }
  }

  log("--- main-world scripts ---");
  const unknown = [];
  for (const script of [...scripts].sort()) {
    const mode = MAIN_WORLD_SCRIPTS.get(script);
    if (mode) log(`  ok       ${script}  (${mode})`);
    else unknown.push(script);
  }
  if (unknown.length) {
    console.error("");
    console.error("[tfa] ERROR: new main-world scripts in the upstream build:");
    for (const script of unknown) console.error(`  UNDECIDED  ${script}`);
    console.error("");
    console.error("[tfa] Decide for each whether MainActivity must run it inline (and");
    console.error("[tfa] tfa-shim.js redirect it via NOOP_SCRIPTS) or whether it can load");
    console.error("[tfa] through its own <script src>, then record that in");
    console.error("[tfa] MAIN_WORLD_SCRIPTS in this script.");
    process.exit(2);
  }
}

// ----------------------------------------------------------------- main

if (!flag("--skip-fetch")) fetchUpstream();
if (!flag("--skip-build")) build();
install();
checkApiSurface();
checkMessageTypes();
checkMainWorldScripts();

const version = JSON.parse(fs.readFileSync(path.join(DEST_DIR, "manifest.json"), "utf8")).version;
log(`done — Tools for Autodarts ${version} (tag ${TAG}) installed.`);
