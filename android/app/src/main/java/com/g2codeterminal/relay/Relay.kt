package com.g2codeterminal.relay

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.File
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSession.NavigationDelegate
import org.mozilla.geckoview.GeckoSession.PermissionDelegate
import org.mozilla.geckoview.GeckoSession.PermissionDelegate.ContentPermission
import org.mozilla.geckoview.GeckoSessionSettings

const val TAG = "G2Relay"
const val BROKER_PORT = 8777
const val START_URL = "https://chatgpt.com/"

// The relay scripts from the Firefox prototype, installed as a built-in
// extension. Its background script opens ws://127.0.0.1:8777/?role=page.
private const val EXT_URL = "resource://android/assets/relay/"
private const val EXT_ID = "g2-chatgpt-relay@local"

// Read by Gecko at startup (honoured for debuggable builds). The synthetic mic
// plays through an AudioContext, which Gecko keeps suspended until a user
// gesture, and on Android also while the page is in the background.
private const val GECKO_CONFIG = """
prefs:
  media.autoplay.default: 0
  media.autoplay.blocking_policy: 0
  media.block-autoplay-until-in-foreground: false
"""

/**
 * Process-wide browser state. The session belongs to the app, not to the
 * activity: RelayService keeps it open and active while the activity is
 * stopped (Even app in front, screen locked), and MainActivity only attaches
 * a GeckoView to it while visible.
 */
object Relay {
    data class Status(val glasses: Boolean = false, val page: Boolean = false, val phase: String = "-")

    private val main = Handler(Looper.getMainLooper())
    private lateinit var app: Context
    private var runtime: GeckoRuntime? = null

    var session: GeckoSession? = null
        private set
    var canGoBack = false
        private set
    var status = Status()
        private set

    /** moz-extension://<uuid> of the built-in extension, once installed. */
    @Volatile
    var extensionOrigin: String? = null
        private set

    /** Called on the main thread when status or the session changes. */
    val listeners = mutableSetOf<() -> Unit>()

    fun update(change: (Status) -> Status) = main.post {
        status = change(status)
        listeners.toList().forEach { it() }
    }

    fun session(ctx: Context): GeckoSession = session ?: open(ctx)

    /** Reloads chatgpt.com, e.g. when the glasses find the page script unresponsive. */
    fun reloadPage() = main.post {
        Log.i(TAG, "reloading the page")
        session?.reload()
    }

    /** Undoes whatever GeckoView does when its window goes away. */
    fun keepActive() {
        session?.apply {
            setActive(true)
            setFocused(true)
        }
    }

    private fun runtime(): GeckoRuntime = runtime ?: run {
        val config = File(app.filesDir, "geckoview-config.yaml").apply { writeText(GECKO_CONFIG.trimIndent()) }
        val settings = GeckoRuntimeSettings.Builder()
            .configFilePath(config.absolutePath)
            .consoleOutput(true)
            .aboutConfigEnabled(true)
            .build()
        GeckoRuntime.create(app, settings).also { rt ->
            runtime = rt
            rt.webExtensionController.ensureBuiltIn(EXT_URL, EXT_ID).accept(
                {
                    extensionOrigin = it?.metaData?.baseUrl?.trimEnd('/')
                    Log.i(TAG, "extension ${it?.id} ${it?.metaData?.version} ready at $extensionOrigin")
                },
                { Log.e(TAG, "extension failed to install", it) },
            )
        }
    }

    private fun open(ctx: Context): GeckoSession {
        app = ctx.applicationContext
        val settings = GeckoSessionSettings.Builder()
            .userAgentMode(GeckoSessionSettings.USER_AGENT_MODE_MOBILE)
            .viewportMode(GeckoSessionSettings.VIEWPORT_MODE_MOBILE)
            .build()
        val s = GeckoSession(settings)
        s.permissionDelegate = permissions
        s.navigationDelegate = navigation
        s.contentDelegate = content
        s.progressDelegate = progress
        s.setPriorityHint(GeckoSession.PRIORITY_HIGH)
        s.open(runtime())
        s.setActive(true)
        s.loadUri(START_URL)
        session = s
        Log.i(TAG, "session opened")
        return s
    }

    // A crashed or killed content process takes the session with it; open a
    // new one and let MainActivity rebind its view.
    private fun replace(old: GeckoSession, why: String) {
        Log.w(TAG, "content process $why, reopening the session")
        if (session !== old) return
        old.close()
        session = null
        open(app)
        update { it.copy(page = false, phase = "page $why") }
    }

    private val content = object : GeckoSession.ContentDelegate {
        override fun onCrash(session: GeckoSession) = replace(session, "crashed")
        override fun onKill(session: GeckoSession) = replace(session, "killed")
    }

    private val progress = object : GeckoSession.ProgressDelegate {
        override fun onPageStop(session: GeckoSession, success: Boolean) {
            Log.i(TAG, "page stop, success=$success")
        }
    }

    private val navigation = object : NavigationDelegate {
        override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) {
            this@Relay.canGoBack = canGoBack
        }

        override fun onLoadRequest(session: GeckoSession, request: NavigationDelegate.LoadRequest): GeckoResult<AllowOrDeny>? {
            val scheme = Uri.parse(request.uri).scheme
            if (scheme !in setOf("https", "http", "about", "blob", "data")) {
                Log.i(TAG, "blocked load of ${request.uri}")
                return GeckoResult.deny()
            }
            // One tab only: links that want a new window open here instead.
            if (request.target == NavigationDelegate.TARGET_WINDOW_NEW) {
                session.loadUri(request.uri)
                return GeckoResult.deny()
            }
            return GeckoResult.allow()
        }

        override fun onNewSession(session: GeckoSession, uri: String): GeckoResult<GeckoSession>? {
            session.loadUri(uri)
            return null
        }
    }

    private val allowed = setOf(
        PermissionDelegate.PERMISSION_AUTOPLAY_AUDIBLE,
        PermissionDelegate.PERMISSION_AUTOPLAY_INAUDIBLE,
        PermissionDelegate.PERMISSION_PERSISTENT_STORAGE,
    )

    private val permissions = object : PermissionDelegate {
        override fun onContentPermissionRequest(session: GeckoSession, perm: ContentPermission): GeckoResult<Int>? {
            val allow = perm.permission in allowed
            Log.i(TAG, "content permission ${perm.permission} for ${perm.uri}: ${if (allow) "allow" else "deny"}")
            return GeckoResult.fromValue(if (allow) ContentPermission.VALUE_ALLOW else ContentPermission.VALUE_DENY)
        }

        // The page only ever gets the synthetic mic from the extension; the
        // phone's real microphone stays off.
        override fun onMediaPermissionRequest(
            session: GeckoSession,
            uri: String,
            video: Array<PermissionDelegate.MediaSource>?,
            audio: Array<PermissionDelegate.MediaSource>?,
            callback: PermissionDelegate.MediaCallback,
        ) {
            Log.i(TAG, "media permission for $uri: deny")
            callback.reject()
        }

        override fun onAndroidPermissionsRequest(
            session: GeckoSession,
            permissions: Array<String>?,
            callback: PermissionDelegate.Callback,
        ) {
            callback.reject()
        }
    }
}
