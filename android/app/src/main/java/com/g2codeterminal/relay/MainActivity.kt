package com.g2codeterminal.relay

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.window.OnBackInvokedDispatcher
import org.mozilla.geckoview.GeckoView

/**
 * chatgpt.com plus a one-line status bar. The page itself lives in Relay and
 * keeps running after this activity stops; this only shows it.
 */
class MainActivity : Activity() {
    private lateinit var view: GeckoView
    private lateinit var statusText: TextView
    private lateinit var battery: Button
    private val onStatus: () -> Unit = { render() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startForegroundService(Intent(this, RelayService::class.java))
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        statusText = TextView(this).apply {
            textSize = 13f
            setPadding(24, 0, 8, 0)
        }
        battery = button("后台运行") { askBatteryExemption() }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(statusText, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(battery)
            addView(button("重载") { Relay.session?.reload() })
            addView(button("退出") {
                stopService(Intent(this@MainActivity, RelayService::class.java))
                finishAndRemoveTask()
            })
        }
        view = GeckoView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(bar, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            addView(view, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener { v, insets ->
                val b = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                v.setPadding(b.left, b.top, b.right, b.bottom)
                WindowInsets.CONSUMED
            }
        }
        setContentView(root)
        view.setSession(Relay.session(this))

        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { back() }
        }
    }

    override fun onStart() {
        super.onStart()
        Relay.listeners += onStatus
        render()
    }

    override fun onStop() {
        super.onStop()
        Relay.listeners -= onStatus
        // The page must keep dictating with the Even app in front or the screen
        // locked; reassert after GeckoView has handled losing its window.
        Relay.keepActive()
        view.postDelayed({ Relay.keepActive() }, 500)
    }

    override fun onDestroy() {
        view.releaseSession()
        super.onDestroy()
    }

    @Deprecated("Back on API < 33")
    override fun onBackPressed() = back()

    private fun back() {
        if (Relay.canGoBack) Relay.session?.goBack() else moveTaskToBack(true)
    }

    private fun render() {
        statusText.text = statusLine(Relay.status)
        val exempt = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
        battery.visibility = if (exempt) View.GONE else View.VISIBLE
        val current = Relay.session
        if (current != null && view.session !== current) {
            view.releaseSession()
            view.setSession(current)
        }
    }

    // Opens the system dialog; the user decides.
    private fun askBatteryExemption() {
        @Suppress("BatteryLife")
        startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onClick() }
    }
}
