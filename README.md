# Autodarts TV

A minimal Android TV app for [Autodarts](https://autodarts.io) — launches [play.autodarts.com](https://play.autodarts.com) fullscreen straight from your TV's home screen, with **D-pad focus navigation like a native TV app**.

No more opening a browser on your TV, typing URLs and fighting a clunky cursor with the remote. Install once, log in once, done.

## Download

Grab the latest `autodarts-tv-vX.Y.Z.apk` from the [Releases page](../../releases/latest) — no build setup needed. Then jump to [Installing on your TV](#installing-on-your-tv).

## Why

Autodarts runs great on a Raspberry Pi at the board, and the web app is the natural way to display matches on a TV. But TV browsers are painful: you have to navigate to the site every time, and the web app isn't built for remote controls. This app wraps the web app in a WebView and injects a custom spatial navigation layer so the D-pad behaves the way you'd expect on a TV.

## Features

- **Leanback launcher entry** — appears directly on the Android TV home screen, one click to start
- **Persistent login** — cookies and localStorage (Keycloak tokens) survive restarts; log in once and never again
- **Focus navigation** — the D-pad jumps between clickable elements, the selected one is highlighted with a white glow, OK clicks it
- **Smart directional search** — pressing *up* really goes up: same-column/row elements are preferred, with a 45° cone as fallback
- **Auto-scroll** — if there's nothing further in the pressed direction, the page scrolls and the search continues, so the very top and bottom of long pages stay reachable (works with virtualized lists too)
- **Cursor fallback** — press MENU to toggle a free-moving virtual mouse cursor for anything the focus navigation can't reach
- **Fullscreen, landscape, no browser chrome**

## Controls

| Button | Action |
|---|---|
| D-pad | Move the highlight to the nearest element in that direction |
| OK / Enter | Click the highlighted element (focuses text fields → on-screen keyboard) |
| BACK | Navigate back in the web app (doesn't close the app) |
| MENU | Toggle between focus navigation and free cursor mode |

In text fields: left/right move the caret, up/down leave the field and resume navigation.

## Building

Only needed if you want to build from source — otherwise just grab the APK from the [Releases page](../../releases/latest).

Requirements: [Android Studio](https://developer.android.com/studio) (ships with JDK 17 and the Android SDK). The Gradle wrapper is included.

```bash
git clone https://github.com/TheJim03/Autodarts-TV.git
cd Autodarts-TV
./gradlew assembleDebug        # Windows: .\gradlew.bat assembleDebug
```

The APK ends up in `app/build/outputs/apk/debug/app-debug.apk`. Alternatively open the project in Android Studio and use *Build → Build APK(s)*.

The debug APK is fine for personal use. For a signed release build, set up a keystore and run `./gradlew assembleRelease`.

## Installing on your TV

1. On the TV: *Settings → Device Preferences → About* → click *Build* 7 times to enable developer options
2. *Developer options* → enable *USB debugging* (and *Network debugging* / *ADB over network* if your TV has it as a separate switch)
3. From your computer (same network):

```bash
adb connect <tv-ip>:5555
adb install app/build/outputs/apk/debug/app-debug.apk   # later updates: adb install -r
```

Accept the debugging prompt on the TV the first time. If `adb connect` fails, reboot the TV after enabling developer options.

No ADB? Copy the APK over with an app like *Send Files to TV*, then install it with a file manager (allow installs from unknown sources).

## First start

You'll land on the Autodarts (Keycloak) login. Select the fields with the D-pad — OK opens the on-screen keyboard. Tip: the *Google TV Remote* app on your phone has a proper keyboard, which makes this one-time login much more pleasant. After that the session persists indefinitely.

## Customizing

- **Start URL**: `START_URL` in [`MainActivity.kt`](app/src/main/java/io/autodarts/tv/MainActivity.kt) — point it directly at your board or match view, e.g. `https://play.autodarts.com/boards/<board-id>/follow`
- **Highlight style**: the CSS block at the top of [`spatialnav.js`](app/src/main/assets/spatialnav.js)
- **Clickable element detection**: the `SELECTOR` list in `spatialnav.js`, in case some element isn't picked up
- **Cursor speed** (fallback mode): constants in [`CursorLayout.kt`](app/src/main/java/io/autodarts/tv/CursorLayout.kt)

Quick iteration tip: paste the contents of `spatialnav.js` into the DevTools console on play.autodarts.com in a desktop browser — the arrow keys behave exactly like the D-pad on the TV, no rebuild needed.

## How it works

The app is a single Activity hosting a WebView. After each page load it injects `spatialnav.js`, which:

1. collects all clickable elements (`button`, `a[href]`, `[role="button"]`, inputs, …)
2. on every arrow key press, runs a three-pass geometric search (same column/row → 45° cone → half-plane) to find the nearest element in that direction
3. highlights it, scrolls it into view, and clicks it on Enter via `el.click()` (which triggers React handlers)

A `MutationObserver` re-picks a highlight when the current element disappears (route changes, dialogs), and the script survives SPA navigation since it's injected once per document.

## Troubleshooting

- **Logged out after restart** — make sure you didn't clear the app's data; the session lives in the WebView's cookies/localStorage
- **An element can't be reached** — toggle cursor mode with MENU as a workaround, then please open an issue with a screenshot so the selector/search can be improved
- **Gradle sync fails** — usually a proxy/VPN blocking `services.gradle.org` or `dl.google.com`, or an outdated Android Studio (AGP 8.5 needs a recent version)

## Tools for Autodarts

The community extension [**Tools for Autodarts**](https://github.com/creazy231/tools-for-autodarts)
(caller sounds, takeout detection, animations, board/lobby tweaks) can run inside
this WebView. Android System WebView has no extension subsystem, so the app
rebuilds the small part of the MV3 runtime the extension actually uses.

**The upstream extension is never forked, patched or committed here.** It is
cloned at a pinned tag, built, and the output is copied into `assets/tfa/`.

### Setup

Requires Node 20+ and Yarn (the extension is a WXT/Vue project).

```bash
node tools/tfa-build.mjs
```

That clones `creazy231/tools-for-autodarts` at the pinned tag into `third_party/`
(gitignored), runs `yarn build`, and installs `.output/chrome-mv3/` into
`app/src/main/assets/tfa/` — minus `images/` (~30 MB of settings screenshots)
and `background.js` (replaced by `TfaBridge.kt`). Then rebuild the APK as usual.

The app runs fine without this step; the injection just finds no assets and logs
a skip for each.

To move to a newer extension release, bump `DEFAULT_TAG` in
[`tools/tfa-build.mjs`](tools/tfa-build.mjs) (or pass `--tag`) and re-run.

### How it works

| Piece | Role |
|---|---|
| [`tfa-shim.js`](app/src/main/assets/tfa-shim.js) | Fake `browser`/`chrome` namespace: `runtime.id`, `getURL`, `sendMessage`, `storage.local` |
| [`TfaBridge.kt`](app/src/main/java/io/autodarts/tv/TfaBridge.kt) | Replaces the MV3 service worker — OkHttp fetch proxy + asset reads |
| `WebViewAssetLoader` | Serves `assets/tfa/**` at `https://appassets.androidplatform.net/assets/tfa/` |

A shim is sufficient because both bootstraps inside the built bundle only test
that `runtime.id` is truthy and then adopt the object as-is, promise-based, with
no callback wrapping. A promise-returning stand-in is accepted unchanged.

Four things had to be bridged:

- **`runtime.sendMessage`** — all 8 call sites send `{ type: "fetch", url, options }`.
  The service worker only ever existed to dodge CORS; OkHttp has no CORS. Answers
  use the upstream contract `{ ok, status, statusText, data, error }`, where `data`
  is a *data: URL*, not bare base64. `@JavascriptInterface` methods are synchronous,
  so calls carry a callback id and Kotlin answers via `window.__tfaResolve(id, json)`.
- **`runtime.getURL`** — 27 static paths. Strategy is switchable at one place
  (`STRATEGY` in `tfa-shim.js`): `assetloader` (default) or `blob`. `play.autodarts.com`
  sends **no CSP header and carries no CSP meta tag** (verified 2026-08-29), so the
  asset loader is safe; `blob` is the escape hatch if that ever changes.
- **`storage.local`** — mapped onto `localStorage` under a `__tfa_storage__` prefix,
  including the per-area `storage.local.onChanged` the WXT driver subscribes to.
  Sounds (IndexedDB) and animations (OPFS) are *not* shimmed — WebView does both
  natively.
- **Main-world injection** — upstream appends `auth-cookie.js` and
  `websocket-capture.js` as `<script src>` to escape the isolated world. We are
  already in the main world, so both are run inline by `MainActivity` and their
  `getURL()` is redirected to an empty `__noop.js`, otherwise `window.WebSocket`
  would get patched twice.

### Two things that fail silently

Worth knowing before debugging:

1. **Unstyled settings panel.** The extension loads its CSS with
   `fetch(getURL(...))`. If that response has no `Access-Control-Allow-Origin`,
   the fetch rejects, the extension swallows it, and the panel renders fully
   functional but with zero styling — nothing logged. `shouldInterceptRequest`
   adds the header, and `tfa-shim.js` additionally intercepts `fetch()` for asset
   URLs and serves them straight from the bridge, so the CSS does not depend on
   CORS at all.
2. **A new upstream API.** The shim covers four API points. If a future release
   reaches for a fifth, MV3 APIs return `undefined` rather than throwing, and the
   feature just quietly does nothing. `tools/tfa-build.mjs` therefore scans the
   built content scripts for `browser.*`/`chrome.*` usage after every build and
   **fails the build** on anything not in its `SHIMMED_APIS` list.

### Checking the shim without a TV

```bash
node tools/shim-test.mjs
```

Runs `tfa-shim.js` under Node against the WXT storage driver copied verbatim out
of the built `content.js`, plus `getURL`, the `fetch` interception and the
`sendMessage` bridge with a stubbed Kotlin side. Needs `node tools/tfa-build.mjs`
to have run first, since it reads the real CSS out of `assets/tfa/`.

### Injection order

Fixed in `MainActivity.kt` and load-bearing:

1. `tfa-shim.js` — document_start
2. `websocket-capture.js` inline — document_start
3. `content-scripts/websocket-monitor.js` — document_start
4. `auth-cookie.js` inline
5. `boards.js`, `content.js`, `lobby.js`, `lobbynew.js`, `match.js`
6. `spatialnav.js` **last**

Steps 1–3 hang off `onPageStarted`. `onPageFinished` is too late: by then the app
has already opened its WebSocket and takeout detection would never see a frame.
`onPageFinished` re-runs them as a guarded safety net in case `onPageStarted`
lost the race with the document swap.

### Bridge access is host-gated

`addJavascriptInterface` attaches to *every* page the WebView loads, and
`fetchProxy` is a CORS-free proxy that will attach the user's cookies. So
`TfaBridge` tracks the current document's host and refuses both of its methods
anywhere other than `play.autodarts.com` — the Keycloak login page and anything
reached through an outbound link get nothing.

### Remote control in the settings panel

The settings UI mounts into a shadow root (`createShadowRootUi`, host element
`<autodarts-tools-wxt>`). A plain `querySelectorAll` sees nothing inside it, so
`spatialnav.js` now descends into open shadow roots when collecting focusable
elements — and stamps its highlight CSS into each one, since styles do not cross
shadow boundaries.

### Verifying on device

Enable `WebView.setWebContentsDebuggingEnabled(true)` and attach `chrome://inspect`.
Each step depends on the previous one:

1. `browser.runtime.id` is truthy in the console → shim loaded
2. Settings panel appears **and is styled** → the CSS fetch got through
3. Change a setting, restart the app → it survives (storage shim)
4. Import a caller sound → bridge fetch + IndexedDB
5. Start a match → takeout detection fires (WebSocket patched in time)
6. Navigate the settings panel with the remote → shadow-root traversal

On (4)/(5): the caller needs a user interaction before audio plays.
`mediaPlaybackRequiresUserGesture = false` should cover this, and any D-pad press
counts — but if the app boots straight into a match and the *first* call is
missing, that is the cause, and a "press OK to start" splash is the fix.

### Licensing

Upstream's licensing is **contradictory**: its `LICENSE` file and README state
CC BY-NC 4.0, while its `package.json` states MIT. Because of that, the extension
is *not* bundled into the APKs built by the release workflow — the build script
only ever fetches it onto your own machine. **Clear redistribution with
[creazy231](https://github.com/creazy231) before publishing any APK with the
extension bundled in.**

## Disclaimer

This is an unofficial community project and is not affiliated with or endorsed by autodarts.io. It simply displays the official web app.

## License

MIT