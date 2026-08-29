package io.autodarts.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader

class MainActivity : Activity() {

    companion object {
        // Change this if you want to land directly on your board page,
        // e.g. "https://play.autodarts.com/boards/<your-board-id>/follow"
        //
        // NOTE: .com, not .io — the "Tools for Autodarts" content scripts are
        // built against play.autodarts.com. Both hosts serve the same app and
        // the same Keycloak realm, so the session survives the switch.
        const val START_URL = "https://play.autodarts.com"

        /** Only this host gets the extension injected. Keycloak pages do not. */
        private const val TFA_HOST = "play.autodarts.com"

        /** Must line up with ASSET_BASE in tfa-shim.js. */
        private const val ASSET_DOMAIN = "appassets.androidplatform.net"

        private const val TAG = "AutodartsTV"

        /**
         * INJECTION ORDER — do not reshuffle.
         *
         * document_start (onPageStarted), in this order:
         *   1. tfa-shim.js               provides browser.* before any bundle looks
         *   2. websocket-capture.js      inline; must patch window.WebSocket BEFORE
         *                                the app opens its socket
         *   3. websocket-monitor.js      upstream's own run_at:document_start script
         *
         * document_end (onPageFinished):
         *   4. auth-cookie.js            inline (main-world helper)
         *   5. the standard content scripts, order among them is irrelevant —
         *      each is a self-contained IIFE with no shared chunks
         *   6. spatialnav.js             LAST, so it can see everything else's DOM
         *
         * onPageFinished is far too late for 1-3: by then the app has already
         * opened its WebSocket and the takeout detection would never see a frame.
         */
        private val DOCUMENT_START_SCRIPTS = listOf(
            "tfa-shim.js",
            "tfa/websocket-capture.js",
            "tfa/content-scripts/websocket-monitor.js"
        )

        private val DOCUMENT_END_SCRIPTS = listOf(
            "tfa/auth-cookie.js",
            "tfa/content-scripts/boards.js",
            "tfa/content-scripts/content.js",
            "tfa/content-scripts/lobby.js",
            "tfa/content-scripts/lobbynew.js",
            "tfa/content-scripts/match.js",
            "spatialnav.js"
        )
    }

    private lateinit var cursorLayout: CursorLayout
    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private lateinit var bridge: TfaBridge

    /** Cache: asset path -> file contents. Avoids re-reading on every navigation. */
    private val scriptCache = HashMap<String, String>()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        cursorLayout = CursorLayout(this)
        cursorLayout.addView(webView)
        setContentView(cursorLayout)

        hideSystemUi()

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true          // REQUIRED: Keycloak tokens and the
                                              // extension's storage shim live here
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false  // caller sounds without extra click
            cacheMode = WebSettings.LOAD_DEFAULT
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
        }

        // Keep the login session across app restarts
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        // Replaces the extension's MV3 service worker (CORS proxy + asset reads)
        bridge = TfaBridge(webView, TFA_HOST)
        webView.addJavascriptInterface(bridge, TfaBridge.NAME)

        // Serves app/src/main/assets/tfa/** under
        // https://appassets.androidplatform.net/assets/tfa/... — this is what
        // runtime.getURL() hands the extension for CSS and <img src>.
        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(ASSET_DOMAIN)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClient() {

            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                val url = request.url
                if (url.host != ASSET_DOMAIN) return null

                val response = assetLoader.shouldInterceptRequest(url) ?: return null

                // The asset domain is a DIFFERENT origin from play.autodarts.com,
                // so the extension's fetch() of its own stylesheet is cross-origin.
                // Without this header that fetch rejects, the extension swallows
                // the error, and the settings panel renders fully functional but
                // completely unstyled — with nothing logged anywhere.
                val headers = response.responseHeaders?.toMutableMap() ?: HashMap()
                headers["Access-Control-Allow-Origin"] = "*"
                response.responseHeaders = headers
                return response
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                bridge.setCurrentUrl(url)
                if (!isTfaHost(url)) return
                DOCUMENT_START_SCRIPTS.forEach { inject(view, it) }
            }

            override fun onPageFinished(view: WebView, url: String) {
                bridge.setCurrentUrl(url)
                if (isTfaHost(url)) {
                    // Safety net: if onPageStarted lost the race with the document
                    // swap, the guarded re-injection below still gets the shim in.
                    DOCUMENT_START_SCRIPTS.forEach { inject(view, it) }
                    DOCUMENT_END_SCRIPTS.forEach { inject(view, it) }
                } else {
                    // Keycloak / other origins: navigation only, no extension.
                    inject(view, "spatialnav.js")
                }
            }
        }
        webView.webChromeClient = WebChromeClient()

        // Default mode: spatial navigation -> WebView must receive D-pad key events
        setCursorMode(false)

        if (savedInstanceState == null) {
            webView.loadUrl(START_URL)
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    private fun isTfaHost(url: String): Boolean =
        runCatching { Uri.parse(url).host == TFA_HOST }.getOrDefault(false)

    /**
     * Runs an asset script in the page, at most once per document.
     *
     * The guard matters: onPageFinished can fire more than once for a single
     * document, and re-running content.js would mount a second settings UI while
     * websocket-capture.js would wrap an already-wrapped window.WebSocket.
     */
    private fun inject(view: WebView, assetPath: String) {
        val source = scriptCache.getOrPut(assetPath) {
            try {
                assets.open(assetPath).bufferedReader().use { it.readText() }
            } catch (e: Exception) {
                Log.w(TAG, "asset missing, skipping: $assetPath (run tools/tfa-build.mjs?)")
                ""
            }
        }
        if (source.isEmpty()) return

        val flag = "__tfa_injected_" + assetPath.replace(Regex("[^A-Za-z0-9]"), "_")
        val guarded = buildString {
            append("(function(){if(window.").append(flag).append(")return;window.")
            append(flag).append("=true;try{\n")
            append(source)
            append("\n}catch(e){console.error('[tfa] ").append(assetPath).append(" threw',e);}})();")
        }
        view.evaluateJavascript(guarded, null)
    }

    /** Toggle between focus-jump navigation (default) and the free cursor fallback. */
    private fun setCursorMode(enabled: Boolean) {
        cursorLayout.cursorEnabled = enabled
        webView.isFocusable = !enabled
        webView.isFocusableInTouchMode = !enabled
        if (enabled) cursorLayout.requestFocus() else webView.requestFocus()
    }

    private fun hideSystemUi() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            )
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            // BACK navigates the WebView history instead of closing the app
            KeyEvent.KEYCODE_BACK -> if (webView.canGoBack()) {
                webView.goBack()
                return true
            }
            // MENU (or the "settings"/hamburger button on many remotes) toggles
            // the free-cursor fallback for elements spatial nav can't reach
            KeyEvent.KEYCODE_MENU -> {
                val enable = !cursorLayout.cursorEnabled
                setCursorMode(enable)
                Toast.makeText(
                    this,
                    if (enable) "Cursor-Modus" else "Fokus-Navigation",
                    Toast.LENGTH_SHORT
                ).show()
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()  // persist session to disk
    }

    override fun onDestroy() {
        bridge.shutdown()
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }
}
