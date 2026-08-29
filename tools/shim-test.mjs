// Exercises app/src/main/assets/tfa-shim.js against the WXT storage driver
// lifted verbatim out of the built content.js, plus getURL / sendMessage.
import fs from "node:fs";

// ---- minimal WebView-ish globals -----------------------------------------
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
};

// Fake Kotlin bridge: fetchProxy answers via __tfaResolve, readAsset serves files.
const bridgeCalls = [];
globalThis.TfaBridge = {
  fetchProxy(callbackId, url, optionsJson) {
    bridgeCalls.push({ callbackId, url, options: JSON.parse(optionsJson) });
    setTimeout(() => {
      globalThis.__tfaResolve(
        callbackId,
        JSON.stringify({ ok: true, status: 200, statusText: "OK", data: "data:audio/mpeg;base64,QUJD" })
      );
    }, 0);
  },
  readAsset(path) {
    const f = "app/src/main/assets/" + path;
    return fs.existsSync(f) ? fs.readFileSync(f).toString("base64") : "";
  },
};

const logs = [];
const realLog = console.log;
console.log = (...a) => { if (String(a[0]).startsWith("[tfa-shim]")) logs.push(a.join(" ")); else realLog(...a); };

// ---- load the shim exactly as the WebView would ---------------------------
new Function(fs.readFileSync("app/src/main/assets/tfa-shim.js", "utf8"))();

let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) realLog("  PASS  " + name);
  else { realLog("  FAIL  " + name + (extra ? "  -> " + extra : "")); failures++; }
};

// ==========================================================================
realLog("\n-- bootstrap (what the bundles actually test) --");
check("globalThis.browser?.runtime?.id is truthy",
  !!(globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome));
check("polyfill guard passes",
  !!(globalThis.browser && globalThis.browser.runtime && globalThis.browser.runtime.id));
check("browser and chrome are the same object", globalThis.browser === globalThis.chrome);
check("storage namespace present (WXT throws otherwise)", globalThis.browser.storage != null);
check("getManifest().manifest_version === 3 (picks the script-src path)",
  globalThis.browser.runtime.getManifest().manifest_version === 3);

realLog("\n-- runtime.getURL --");
const g = globalThis.browser.runtime.getURL;
check("css -> asset loader URL",
  g("/content-scripts/content.css") === "https://appassets.androidplatform.net/assets/tfa/content-scripts/content.css",
  g("/content-scripts/content.css"));
check("auth-cookie.js -> __noop.js", g("/auth-cookie.js").endsWith("/__noop.js"), g("/auth-cookie.js"));
check("websocket-capture.js -> __noop.js", g("/websocket-capture.js").endsWith("/__noop.js"));
check("image -> blank pixel (images are not bundled)", g("/images/caller.png").startsWith("data:image/gif;base64,"));
check("image without leading slash also handled", g("images/auto-start.png").startsWith("data:image/gif;base64,"));

realLog("\n-- fetch interception (the silent-CSS failure mode) --");
const cssText = await (await fetch(g("/content-scripts/content.css"))).text();
check("CSS fetch resolves from the bridge, not the network", cssText.length > 1000, `${cssText.length} bytes`);
check("CSS content-type is text/css",
  (await fetch(g("/content-scripts/content.css"))).headers.get("content-type") === "text/css");

realLog("\n-- runtime.sendMessage --");
const res = await globalThis.browser.runtime.sendMessage({
  type: "fetch",
  url: "https://api.autodarts.com/x",
  options: { method: "POST", credentials: "include", headers: { Authorization: "Bearer t" }, body: "{}" },
});
check("resolves with ok:true", res.ok === true);
check("data is a data: URL, not bare base64", String(res.data).startsWith("data:"));
check("bridge saw the url", bridgeCalls[0]?.url === "https://api.autodarts.com/x");
check("bridge saw method+credentials", bridgeCalls[0]?.options.method === "POST" && bridgeCalls[0]?.options.credentials === "include");
const unknown = await globalThis.browser.runtime.sendMessage({ type: "somethingElse" });
check("unknown message resolves undefined (upstream checks n === void 0)", unknown === undefined);

// ==========================================================================
// WXT storage driver, copied out of the built content.js.
realLog("\n-- storage.local via the real WXT driver --");
const t = () => {
  if (globalThis.browser.storage == null) throw Error("no storage permission");
  const i = globalThis.browser.storage["local"];
  if (i == null) throw Error(`"browser.storage.local" is undefined`);
  return i;
};
const driver = {
  getItem: async (i) => (await t().get(i))[i],
  getItems: async (i) => { const o = await t().get(i); return i.map((l) => ({ key: l, value: o[l] ?? null })); },
  setItem: async (i, o) => { o == null ? await t().remove(i) : await t().set({ [i]: o }); },
  setItems: async (i) => { const o = i.reduce((l, { key: u, value: a }) => ((l[u] = a), l), {}); await t().set(o); },
  removeItem: async (i) => { await t().remove(i); },
  clear: async () => { await t().clear(); },
  snapshot: async () => await t().get(),
  restoreSnapshot: async (i) => { await t().set(i); },
  watch(i, o) {
    const l = (u) => { const a = u[i]; if (a == null) return; o(a.newValue ?? null, a.oldValue ?? null); };
    t().onChanged.addListener(l);
    return () => t().onChanged.removeListener(l);
  },
};

const config = { version: 22, caller: { enabled: true }, discord: { url: "" } };
await driver.setItem("config-2-0-0", config);
check("round-trips a nested config object",
  JSON.stringify(await driver.getItem("config-2-0-0")) === JSON.stringify(config));

await driver.setItems([{ key: "globalstatus", value: "on" }, { key: "boardstatus", value: 1 }]);
check("setItems + getItems", JSON.stringify(await driver.getItems(["globalstatus", "boardstatus"]))
  === JSON.stringify([{ key: "globalstatus", value: "on" }, { key: "boardstatus", value: 1 }]));

check("missing key reads as undefined", (await driver.getItem("nope")) === undefined);

const snap = await driver.snapshot(); // get() with NO argument
check("snapshot() returns every key", Object.keys(snap).sort().join(",") === "boardstatus,config-2-0-0,globalstatus",
  Object.keys(snap).join(","));

// watch() is what makes settings changes reach the live UI
const seen = [];
const unwatch = driver.watch("urlstatus", (nv, ov) => seen.push([nv, ov]));
await driver.setItem("urlstatus", "a");
await driver.setItem("urlstatus", "b");
await driver.setItem("urlstatus", null); // upstream maps null -> remove
unwatch();
await driver.setItem("urlstatus", "after-unwatch");
check("watch() fires per change with newValue/oldValue",
  JSON.stringify(seen) === JSON.stringify([["a", null], ["b", "a"], [null, "b"]]), JSON.stringify(seen));
check("unwatch() stops delivery", seen.length === 3);

// Legacy migration path (Migration.vue) — the only direct storage.local use
await globalThis.browser.storage.local.set({ config: { old: 1 }, soundsconfig: [], callerconfig: {} });
const legacy = await globalThis.browser.storage.local.get("config");
check("legacy get('config') returns { config: ... }", JSON.stringify(legacy) === '{"config":{"old":1}}');
await globalThis.browser.storage.local.remove(["config", "soundsconfig", "callerconfig", "matchstatus", "soundstartstatus"]);
check("legacy remove([...]) clears them",
  Object.keys(await driver.snapshot()).includes("config") === false);

realLog("\n-- persistence across a 'restart' --");
const before = JSON.stringify(await driver.snapshot());
delete globalThis.__tfaShim; delete globalThis.browser; delete globalThis.chrome;
new Function(fs.readFileSync("app/src/main/assets/tfa-shim.js", "utf8"))(); // reload shim, same localStorage
check("settings survive a shim reload", JSON.stringify(await driver.snapshot()) === before);

realLog(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}\n`);
process.exit(failures ? 1 : 0);
