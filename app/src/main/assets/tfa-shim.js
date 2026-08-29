// ---------------------------------------------------------------------------
// tfa-shim.js — MV3 extension runtime for "Tools for Autodarts" in a WebView.
//
// Android System WebView has no extension subsystem. This file provides the
// small slice of it that the upstream build actually touches, so the UNMODIFIED
// release bundle runs unchanged.
//
// Why a shim is enough: both bootstraps in the build only test truthiness of
// runtime.id and then adopt the object as-is, promise-based, with no callback
// wrapping:
//     globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome
// So an object that looks like `browser` and returns promises is accepted.
//
// Must run at document_start, before every extension bundle.
// Injected by MainActivity.kt (onPageStarted). See INJECTION ORDER there.
// ---------------------------------------------------------------------------
(function () {
  'use strict';
  if (globalThis.__tfaShim) return;

  // =========================================================================
  // CONFIG
  // =========================================================================

  /**
   * Asset delivery strategy. THIS IS THE SINGLE SWITCH.
   *
   *  'assetloader' — WebViewAssetLoader on https://appassets.androidplatform.net/.
   *                  Cacheable, debuggable, real URLs in DevTools. Cross-origin
   *                  to the page, so MainActivity adds Access-Control-Allow-Origin
   *                  in shouldInterceptRequest.
   *  'blob'        — Kotlin readAsset() -> base64 -> blob: URL. Same-origin to
   *                  the page, so no CORS at all. Use if a CSP ever appears and
   *                  blocks appassets.androidplatform.net.
   *
   * Verified 2026-08-29: play.autodarts.com sends no Content-Security-Policy
   * header and carries no CSP meta tag, so 'assetloader' is safe today.
   */
  var STRATEGY = 'assetloader';

  var ASSET_BASE = 'https://appassets.androidplatform.net/assets/tfa/';

  /**
   * Serve TFA asset fetch()es from the bridge instead of the network.
   *
   * This exists for exactly one failure mode: content.js does
   *     fetch(getURL('/content-scripts/content.css'))
   * and if that response lacks CORS headers the fetch rejects, the extension
   * swallows it, and you get a fully functional but COMPLETELY UNSTYLED
   * settings panel with no error anywhere. Intercepting fetch means the CSS
   * never depends on CORS, CSP or the asset loader being wired correctly.
   * Belt and braces — leave it on.
   */
  var INTERCEPT_FETCH = true;

  /** runtime.id only has to be truthy. Nothing compares it to anything. */
  var EXTENSION_ID = 'tools-for-autodarts-webview-shim';

  /**
   * These two are MAIN-world injection helpers: upstream appends them as
   * <script src=getURL(...)> to escape the isolated world. We are ALREADY in
   * the main world and MainActivity runs both inline, so the script tag must
   * do nothing — websocket-capture.js overwrites window.WebSocket and would
   * double-patch it. Redirect them to an empty file.
   *
   * Failure here is harmless by design: content.js only uses onload to call
   * script.remove(), and websocket-monitor.js catches and logs onerror.
   */
  var NOOP_SCRIPTS = ['/auth-cookie.js', '/websocket-capture.js'];
  var NOOP_TARGET = '__noop.js';

  /**
   * tools/tfa-build.mjs leaves images/ out of the APK — 25 feature screenshots,
   * ~30 MB, decoration in the settings UI only. They would otherwise resolve to
   * 404s and render as broken-image icons, so hand back a transparent pixel.
   * Set to true if you ever decide to ship them.
   */
  var IMAGES_BUNDLED = false;
  var BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  var bridge = globalThis.TfaBridge || null;
  var log = function () {
    var a = ['[tfa-shim]'].concat([].slice.call(arguments));
    console.log.apply(console, a);
  };

  // =========================================================================
  // Kotlin bridge — async over a synchronous @JavascriptInterface
  // =========================================================================
  // @JavascriptInterface methods are synchronous and must not block. So JS
  // parks a resolver under a callback id, Kotlin does the work off-thread and
  // calls back in via evaluateJavascript("window.__tfaResolve(id, json)").

  var pending = Object.create(null);
  var seq = 0;

  globalThis.__tfaResolve = function (id, payload) {
    var entry = pending[id];
    if (!entry) return;
    delete pending[id];
    try {
      entry.resolve(typeof payload === 'string' ? JSON.parse(payload) : payload);
    } catch (e) {
      entry.reject(e);
    }
  };

  function callBridge(method, args) {
    return new Promise(function (resolve, reject) {
      if (!bridge || typeof bridge[method] !== 'function') {
        reject(new Error('TfaBridge.' + method + ' unavailable'));
        return;
      }
      var id = 'cb' + (++seq);
      pending[id] = { resolve: resolve, reject: reject };
      try {
        bridge[method].apply(bridge, [id].concat(args));
      } catch (e) {
        delete pending[id];
        reject(e);
      }
    });
  }

  // =========================================================================
  // runtime.getURL
  // =========================================================================

  function normalize(p) {
    return String(p == null ? '' : p).replace(/^\/+/, '');
  }

  function mimeFor(p) {
    if (/\.css$/i.test(p)) return 'text/css';
    if (/\.js$/i.test(p)) return 'text/javascript';
    if (/\.json$/i.test(p)) return 'application/json';
    if (/\.svg$/i.test(p)) return 'image/svg+xml';
    if (/\.png$/i.test(p)) return 'image/png';
    if (/\.jpe?g$/i.test(p)) return 'image/jpeg';
    if (/\.gif$/i.test(p)) return 'image/gif';
    if (/\.webp$/i.test(p)) return 'image/webp';
    if (/\.woff2$/i.test(p)) return 'font/woff2';
    return 'application/octet-stream';
  }

  function assetBytes(rel) {
    var b64 = '';
    try {
      b64 = bridge && bridge.readAsset ? bridge.readAsset('tfa/' + rel) : '';
    } catch (e) {
      return null;
    }
    if (!b64) return null;
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  var blobCache = Object.create(null);

  function blobUrlFor(rel) {
    if (blobCache[rel]) return blobCache[rel];
    var bytes = assetBytes(rel);
    if (!bytes) {
      log('readAsset failed for', rel, '- falling back to the asset loader');
      return ASSET_BASE + rel;
    }
    var url = URL.createObjectURL(new Blob([bytes], { type: mimeFor(rel) }));
    blobCache[rel] = url;
    return url;
  }

  function getURL(p) {
    var raw = String(p == null ? '' : p);
    var withSlash = raw.charAt(0) === '/' ? raw : '/' + raw;
    if (NOOP_SCRIPTS.indexOf(withSlash) >= 0) {
      return STRATEGY === 'blob' ? blobUrlFor(NOOP_TARGET) : ASSET_BASE + NOOP_TARGET;
    }
    if (!IMAGES_BUNDLED && withSlash.indexOf('/images/') === 0) return BLANK_PIXEL;
    var rel = normalize(raw);
    return STRATEGY === 'blob' ? blobUrlFor(rel) : ASSET_BASE + rel;
  }

  // fetch() interception for asset URLs — see INTERCEPT_FETCH above.
  if (INTERCEPT_FETCH && typeof globalThis.fetch === 'function') {
    var nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = function (input, init) {
      var url = typeof input === 'string' ? input
        : (input && input.url) ? input.url : '';
      if (url.indexOf(ASSET_BASE) === 0) {
        var rel = url.slice(ASSET_BASE.length).split(/[?#]/)[0];
        var bytes = assetBytes(rel);
        if (bytes) {
          return Promise.resolve(new Response(bytes, {
            status: 200,
            statusText: 'OK',
            headers: { 'Content-Type': mimeFor(rel) }
          }));
        }
        log('asset fetch fell through to the network:', rel);
      }
      return nativeFetch(input, init);
    };
  }

  // =========================================================================
  // runtime.sendMessage
  // =========================================================================
  // Every one of the 8 upstream call sites sends { type: "fetch", url, options }.
  // The MV3 service worker existed only to dodge CORS; OkHttp has no CORS.
  //
  // Response contract, verbatim from upstream entrypoints/background.ts:
  //   { ok, status?, statusText?, data?, error? }
  // where `data` is a data: URL (data:<mime>;base64,...) exactly as
  // FileReader.readAsDataURL produces — NOT bare base64.
  //
  // The chunking protocol (tooLarge / suggestChunked / action:"getChunk") is
  // deliberately not implemented: it only engages when the response itself
  // sets tooLarge:true. We never do, so the simple path always runs.

  function sendMessage(message) {
    var msg = message || {};
    if (msg.type === 'fetch') {
      return callBridge('fetchProxy', [
        String(msg.url || ''),
        JSON.stringify(msg.options || {})
      ]);
    }
    log('unhandled sendMessage type:', msg.type, msg);
    return Promise.resolve(undefined);
  }

  // =========================================================================
  // storage.local  ->  localStorage
  // =========================================================================
  // WXT strips its "local:" prefix before hitting the driver, so the keys on
  // the wire are plain: config-2-0-0, globalstatus, boardstatus, urlstatus,
  // streamingmodestatus, plus the legacy keys Migration.vue reads (config,
  // soundsconfig, callerconfig, matchstatus, soundstartstatus).
  //
  // NOT shimmed, on purpose: sounds live in IndexedDB (via idb) and animations
  // in OPFS (navigator.storage.getDirectory). WebView does both natively.

  var PREFIX = '__tfa_storage__';
  var listeners = [];

  function readKey(key) {
    var raw = null;
    try { raw = localStorage.getItem(PREFIX + key); } catch (e) { return undefined; }
    if (raw === null) return undefined;
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }

  function allKeys() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) out.push(k.slice(PREFIX.length));
      }
    } catch (e) { /* storage disabled */ }
    return out;
  }

  // Everything runs in one JS context, so there is no other writer to wait for:
  // fire change notifications synchronously out of our own set/remove.
  function emit(changes) {
    if (!Object.keys(changes).length) return;
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](changes);
      } catch (e) {
        console.error('[tfa-shim] onChanged listener threw', e);
      }
    }
  }

  var storageLocal = {
    get: function (keys) {
      var result = {};
      var list;
      if (keys == null) {
        list = allKeys();
      } else if (typeof keys === 'string') {
        list = [keys];
      } else if (Array.isArray(keys)) {
        list = keys;
      } else {
        // object form: keys mapped to default values
        list = Object.keys(keys);
        for (var d = 0; d < list.length; d++) result[list[d]] = keys[list[d]];
      }
      for (var i = 0; i < list.length; i++) {
        var v = readKey(list[i]);
        if (v !== undefined) result[list[i]] = v;
      }
      return Promise.resolve(result);
    },

    set: function (items) {
      var changes = {};
      try {
        for (var k in items) {
          if (!Object.prototype.hasOwnProperty.call(items, k)) continue;
          var oldValue = readKey(k);
          localStorage.setItem(PREFIX + k, JSON.stringify(items[k]));
          changes[k] = { newValue: items[k], oldValue: oldValue };
        }
      } catch (e) {
        return Promise.reject(e);
      }
      emit(changes);
      return Promise.resolve();
    },

    remove: function (keys) {
      var list = typeof keys === 'string' ? [keys] : (keys || []);
      var changes = {};
      try {
        for (var i = 0; i < list.length; i++) {
          var oldValue = readKey(list[i]);
          if (oldValue === undefined) continue;
          localStorage.removeItem(PREFIX + list[i]);
          changes[list[i]] = { newValue: undefined, oldValue: oldValue };
        }
      } catch (e) {
        return Promise.reject(e);
      }
      emit(changes);
      return Promise.resolve();
    },

    clear: function () {
      var keys = allKeys();
      var changes = {};
      for (var i = 0; i < keys.length; i++) {
        changes[keys[i]] = { newValue: undefined, oldValue: readKey(keys[i]) };
        try { localStorage.removeItem(PREFIX + keys[i]); } catch (e) { /* ignore */ }
      }
      emit(changes);
      return Promise.resolve();
    },

    // NOTE: the per-area variant (storage.local.onChanged), which is what the
    // WXT storage driver subscribes to — not storage.onChanged.
    onChanged: {
      addListener: function (cb) { if (listeners.indexOf(cb) < 0) listeners.push(cb); },
      removeListener: function (cb) {
        var i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
      hasListener: function (cb) { return listeners.indexOf(cb) >= 0; }
    }
  };

  // =========================================================================
  // Assemble the namespace
  // =========================================================================

  function noopEvent() {
    return {
      addListener: function () {},
      removeListener: function () {},
      hasListener: function () { return false; }
    };
  }

  var api = {
    runtime: {
      id: EXTENSION_ID,
      getURL: getURL,
      sendMessage: sendMessage,
      // Nothing in the build registers a receiver; present so feature-detects pass.
      onMessage: noopEvent(),
      onInstalled: noopEvent(),
      onConnect: noopEvent(),
      lastError: null,
      getManifest: function () {
        return { manifest_version: 3, version: '0.0.0-webview' };
      }
    },
    storage: {
      local: storageLocal,
      // Upstream only uses .local; aliasing sync means a future upstream switch
      // degrades to "settings still persist" instead of "settings vanish".
      sync: storageLocal,
      onChanged: {
        addListener: function (cb) {
          storageLocal.onChanged.addListener(function (c) { cb(c, 'local'); });
        },
        removeListener: function () {},
        hasListener: function () { return false; }
      }
    },
    // Dead code path in the build (the manifest has no "scripting" permission).
    scripting: {
      executeScript: function () {
        log('scripting.executeScript called — ignored (already in the main world)');
        return Promise.resolve([]);
      }
    }
  };

  globalThis.browser = api;
  globalThis.chrome = api;   // same object: both bootstraps must see runtime.id
  globalThis.__tfaShim = api;

  log('ready — strategy=' + STRATEGY + ' bridge=' + (bridge ? 'up' : 'MISSING'));
})();
