package com.g2codeterminal.relay

import android.os.SystemClock
import android.util.Log
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import org.java_websocket.WebSocket
import org.java_websocket.framing.CloseFrame
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import org.json.JSONException
import org.json.JSONObject

/**
 * WebSocket broker on 127.0.0.1, ported from the prototype's broker.py.
 *
 *   /?role=glasses  the Even plugin: binary = 16 kHz s16le PCM frames,
 *                   text = JSON commands ({"t": "start"}, {"t": "stop"}, ...)
 *   /?role=page     the built-in extension on chatgpt.com: JSON status,
 *                   transcript and reply updates
 *   /?role=ctl      debugging from the Mac through `adb forward tcp:8777
 *                   tcp:8777`: sends commands to the page, sees every message
 *
 * {"t": "reload"} from the glasses or ctl is handled here, not by the page:
 * it reloads chatgpt.com, so it works when the page script itself is stuck.
 *
 * Glasses messages go to the page and page messages to the glasses (and ctl);
 * the broker adds {"t": "peer"} notices when a side connects or leaves.
 */
class Broker(port: Int) : WebSocketServer(InetSocketAddress(LOOPBACK, port)) {
    private val roles = ConcurrentHashMap<WebSocket, String>()
    private val other = mapOf("glasses" to "page", "page" to "glasses", "ctl" to "page")

    // Audio of the current turn, from glasses "start" to "stop".
    private var turnStart = 0L
    private var turnFrames = 0
    private var turnBytes = 0L

    init {
        isReuseAddr = true
        connectionLostTimeout = 30
    }

    override fun onStart() {
        Log.i(TAG, "broker listening on 127.0.0.1:$port")
    }

    override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
        val role = Regex("[?&]role=(\\w+)").find(handshake.resourceDescriptor)?.groupValues?.get(1)
        if (role == null || role !in other) {
            Log.w(TAG, "rejected ${handshake.resourceDescriptor}")
            conn.close(CloseFrame.POLICY_VALIDATION, "unknown role")
            return
        }
        val origin = handshake.getFieldValue("Origin")
        // Only this app's own extension may act as the page: the Firefox
        // prototype's extension dials the same port and would start a second
        // dictation on every glasses command.
        if (role == "page" && origin != Relay.extensionOrigin) {
            Log.w(TAG, "rejected page from $origin (expected ${Relay.extensionOrigin})")
            conn.close(CloseFrame.POLICY_VALIDATION, "not this app's extension")
            return
        }
        roles[conn] = role
        Log.i(TAG, "$role connected, origin ${origin.ifEmpty { "-" }}")
        peers()
    }

    override fun onClose(conn: WebSocket, code: Int, reason: String, remote: Boolean) {
        val role = roles.remove(conn) ?: return
        Log.i(TAG, "$role disconnected ($code $reason)")
        if (role == "glasses") turnEnd()
        peers()
    }

    override fun onMessage(conn: WebSocket, message: ByteBuffer) {
        if (roles[conn] != "glasses") return
        val pcm = ByteArray(message.remaining()).also { message.get(it) }
        synchronized(this) {
            if (turnStart != 0L) {
                turnFrames++
                turnBytes += pcm.size
            }
        }
        sendTo("page") { it.send(pcm) }
    }

    override fun onMessage(conn: WebSocket, message: String) {
        val role = roles[conn] ?: return
        val obj = try {
            JSONObject(message)
        } catch (e: JSONException) {
            Log.w(TAG, "$role: non-JSON text ${message.take(80)}")
            return
        }
        val t = obj.optString("t")
        if (t == "ping") {
            conn.send(JSONObject().put("t", "pong").put("ts", obj.opt("ts")).toString())
            return
        }
        if (t == "reload" && role != "page") {
            Log.i(TAG, "$role asked for a page reload")
            Relay.reloadPage()
            return
        }
        if (role == "glasses" && t == "start") {
            turnEnd()
            synchronized(this) { turnStart = SystemClock.elapsedRealtime() }
        }
        if (role == "glasses" && (t == "stop" || t == "cancel")) turnEnd()
        if (role == "page" && t == "status") Relay.update { it.copy(phase = obj.optString("s")) }
        if (!(t == "reply" && !obj.optBoolean("done"))) Log.i(TAG, "$role → ${other[role]}: ${summarize(obj)}")
        sendTo(other.getValue(role)) { it.send(message) }
        if (role != "ctl") sendTo("ctl") { it.send(message) }
    }

    override fun onError(conn: WebSocket?, ex: Exception) {
        Log.e(TAG, "broker error (${conn?.let { roles[it] } ?: "server"})", ex)
        if (conn == null) Relay.update { it.copy(phase = "broker error: ${ex.message}") }
    }

    private fun sendTo(role: String, send: (WebSocket) -> Unit) {
        for ((conn, r) in roles) {
            if (r == role && conn.isOpen) runCatching { send(conn) }
        }
    }

    private fun peers() {
        val glasses = roles.containsValue("glasses")
        val page = roles.containsValue("page")
        val notice = JSONObject().put("t", "peer").put("glasses", glasses).put("page", page).toString()
        for (conn in roles.keys) if (conn.isOpen) runCatching { conn.send(notice) }
        Relay.update { it.copy(glasses = glasses, page = page) }
    }

    private fun turnEnd() {
        synchronized(this) {
            if (turnStart == 0L) return
            val wall = (SystemClock.elapsedRealtime() - turnStart) / 1000.0
            Log.i(TAG, "turn audio: $turnFrames frames, ${"%.2f".format(turnBytes / 32000.0)} s over ${"%.2f".format(wall)} s")
            turnStart = 0L
            turnFrames = 0
            turnBytes = 0L
        }
    }

    /** Short log line for a JSON message; long text fields are cut. */
    private fun summarize(obj: JSONObject): String {
        val out = JSONObject()
        for (key in obj.keys()) {
            val v = obj.get(key)
            out.put(key, if (v is String && v.length > 80) v.take(80).replace("\n", "⏎") + "…(${v.length})" else v)
        }
        return out.toString()
    }
}

// Android's InetAddress.getLoopbackAddress() is ::1; the plugin and the
// extension both dial 127.0.0.1.
private const val LOOPBACK = "127.0.0.1"
