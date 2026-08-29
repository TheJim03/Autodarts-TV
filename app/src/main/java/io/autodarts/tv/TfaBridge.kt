package io.autodarts.tv

import android.util.Base64
import android.util.Log
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Replaces the MV3 service worker of "Tools for Autodarts".
 *
 * The upstream background script exists for exactly two reasons: it proxies
 * fetches to dodge CORS, and it serves packed extension assets. Neither problem
 * exists here — OkHttp has no CORS, and the assets sit in the APK — so the whole
 * worker collapses into these two methods.
 *
 * Exposed to JS as `TfaBridge`. Every method is called from the WebView's JS
 * thread and must return immediately, so anything with I/O takes a callback id
 * and answers later through window.__tfaResolve(id, json). See tfa-shim.js.
 */
class TfaBridge(private val webView: WebView, private val allowedHost: String) {

    private val io = Executors.newFixedThreadPool(4)

    /**
     * Host of the document currently loaded, tracked so the bridge can refuse
     * to serve anything else.
     *
     * addJavascriptInterface() attaches to every page the WebView loads, not
     * just ours — and fetchProxy is a CORS-free proxy that will attach the
     * user's cookies. Handing that to the Keycloak page, or to whatever an
     * outbound link leads to, would let it read cross-origin responses no
     * browser would allow. Written on the UI thread from the WebViewClient,
     * read from the binder thread @JavascriptInterface calls arrive on.
     */
    @Volatile
    private var currentHost: String? = null

    /** Call from onPageStarted/onPageFinished with the document's URL. */
    fun setCurrentUrl(url: String?) {
        currentHost = url?.let { runCatching { android.net.Uri.parse(it).host }.getOrNull() }
    }

    private fun allowed(): Boolean {
        val host = currentHost
        if (host == allowedHost) return true
        Log.w(TAG, "bridge call refused from host=$host")
        return false
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    // ---------------------------------------------------------------- fetch

    /**
     * Proxies `browser.runtime.sendMessage({ type: "fetch", url, options })`.
     *
     * Resolves with the contract from upstream entrypoints/background.ts:
     *
     *     { ok, status?, statusText?, data?, error? }
     *
     * `data` is a data: URL — `data:<mime>;base64,...` — matching what
     * FileReader.readAsDataURL() produces on the extension side. It is NOT bare
     * base64; the callers feed it straight into Audio/img/IndexedDB.
     *
     * The chunked-transfer protocol upstream supports (tooLarge / suggestChunked
     * / action:"getChunk") is never triggered because we never set tooLarge.
     */
    @JavascriptInterface
    fun fetchProxy(callbackId: String, url: String, optionsJson: String) {
        if (!allowed()) {
            resolve(callbackId, JSONObject().put("ok", false).put("error", "refused").toString())
            return
        }
        io.execute {
            val result = try {
                doFetch(url, optionsJson)
            } catch (e: Exception) {
                Log.w(TAG, "fetchProxy failed for $url", e)
                JSONObject()
                    .put("ok", false)
                    .put("error", e.message ?: e.javaClass.simpleName)
            }
            resolve(callbackId, result.toString())
        }
    }

    private fun doFetch(url: String, optionsJson: String): JSONObject {
        val options = try {
            JSONObject(optionsJson)
        } catch (e: Exception) {
            JSONObject()
        }

        val method = options.optString("method", "GET").uppercase()
        val bodyText = if (options.isNull("body")) null else options.optString("body")

        val builder = Request.Builder().url(url)

        var contentType: String? = null
        options.optJSONObject("headers")?.let { headers ->
            for (name in headers.keys()) {
                val value = headers.optString(name)
                builder.header(name, value)
                if (name.equals("content-type", ignoreCase = true)) contentType = value
            }
        }

        // The service worker ran with host permissions, so its fetches carried
        // the site cookies. Reproduce that only when the caller opts in, the
        // same way a real cross-origin fetch would.
        if (options.optString("credentials") == "include") {
            CookieManager.getInstance().getCookie(url)?.takeIf { it.isNotBlank() }?.let {
                builder.header("Cookie", it)
            }
        }

        val requestBody = when {
            bodyText != null -> bodyText.toRequestBody(contentType?.toMediaTypeOrNull())
            method in METHODS_REQUIRING_BODY -> ByteArray(0).toRequestBody(null)
            else -> null
        }
        builder.method(method, requestBody)

        http.newCall(builder.build()).execute().use { response ->
            val bytes = response.body?.bytes() ?: ByteArray(0)
            val mime = response.body?.contentType()?.toString()
                ?: response.header("Content-Type")
                ?: "application/octet-stream"

            val out = JSONObject()
                .put("ok", response.isSuccessful)
                .put("status", response.code)
                .put("statusText", response.message)

            if (response.isSuccessful) {
                val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                out.put("data", "data:$mime;base64,$b64")
            } else {
                out.put("error", "HTTP ${response.code} ${response.message}")
            }
            return out
        }
    }

    // ---------------------------------------------------------------- assets

    /**
     * Reads a file out of the APK's assets/ and returns it base64-encoded.
     *
     * Used by tfa-shim.js for the 'blob' asset strategy, and — regardless of
     * strategy — by its fetch() interceptor, so the extension's stylesheet
     * fetch never depends on CORS or CSP. Synchronous on purpose: getURL() is
     * synchronous and cannot await. Assets are local reads of at most a few
     * hundred KB, so this does not stall the JS thread meaningfully.
     *
     * Returns "" on any failure; the shim treats that as "fall back".
     */
    @JavascriptInterface
    fun readAsset(path: String): String {
        if (!allowed()) return ""
        val clean = path.trimStart('/')
        // Confine reads to the extension payload — this method is reachable
        // from any script running in the page.
        if (!clean.startsWith("tfa/") || clean.contains("..")) {
            Log.w(TAG, "readAsset refused: $path")
            return ""
        }
        return try {
            webView.context.assets.open(clean).use { input ->
                val buffer = ByteArrayOutputStream()
                input.copyTo(buffer)
                Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP)
            }
        } catch (e: Exception) {
            Log.w(TAG, "readAsset missing: $clean")
            ""
        }
    }

    // ------------------------------------------------------------- plumbing

    /** Hands a JSON payload back to the promise parked under [callbackId]. */
    private fun resolve(callbackId: String, json: String) {
        val js = "window.__tfaResolve(${quote(callbackId)}, ${quote(json)});"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    /** JSON-quotes a string so it survives being embedded in a JS source line. */
    private fun quote(s: String): String = JSONObject.quote(s)

    fun shutdown() {
        io.shutdownNow()
    }

    companion object {
        const val NAME = "TfaBridge"
        private const val TAG = "TfaBridge"
        private val METHODS_REQUIRING_BODY = setOf("POST", "PUT", "PATCH")
    }
}
