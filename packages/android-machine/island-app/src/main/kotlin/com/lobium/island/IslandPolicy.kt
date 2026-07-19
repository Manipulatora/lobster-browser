package com.lobium.island

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * Per-machine Island policy. Written into the image by first-boot-provision.sh from the machine's
 * IslandConfig (the create form). Falls back to isolate-defaults.json bundled in the app assets.
 */
data class IslandPolicy(
    val isolateOnInstall: Set<String>,
    val freezeIdleApps: Boolean,
) {
    fun shouldIsolate(pkg: String): Boolean = isolateOnInstall.contains(pkg)

    companion object {
        // Written by first-boot-provision.sh (adb push) so the desktop app's per-machine config wins.
        private const val POLICY_PATH = "/data/system/lobium/island-policy.json"

        fun load(context: Context): IslandPolicy {
            val json = readFile(POLICY_PATH) ?: readAsset(context, "isolate-defaults.json")
            if (json == null) return IslandPolicy(emptySet(), true)
            return try {
                val obj = JSONObject(json)
                val arr = obj.optJSONArray("isolateOnInstall")
                val set = buildSet {
                    if (arr != null) for (i in 0 until arr.length()) add(arr.getString(i))
                }
                IslandPolicy(set, obj.optBoolean("freezeIdleApps", true))
            } catch (_: Throwable) {
                IslandPolicy(emptySet(), true)
            }
        }

        private fun readFile(path: String): String? =
            try { File(path).takeIf { it.exists() }?.readText() } catch (_: Throwable) { null }

        private fun readAsset(context: Context, name: String): String? =
            try { context.assets.open(name).bufferedReader().use { it.readText() } }
            catch (_: Throwable) { null }
    }
}
