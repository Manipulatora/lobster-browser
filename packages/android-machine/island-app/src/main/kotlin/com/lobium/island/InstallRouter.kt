package com.lobium.island

import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.UserHandle
import android.util.Log

/**
 * Secure install routing. When a FLAGGED app (mail/social/banking — see IslandPolicy) is installed into
 * the main space, route it into the isolated island user so the account it holds is sandboxed by
 * default. This is the "secure app install + account protection" behaviour, applied with no user setup.
 */
class InstallRouter : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_PACKAGE_ADDED) return
        // Ignore updates to already-installed packages.
        if (intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)) return
        val pkg = intent.data?.schemeSpecificPart ?: return

        val policy = IslandPolicy.load(context)
        if (!policy.shouldIsolate(pkg)) return

        val island = IslandProvisioner(context).existingIslandUser()
        if (island == null) {
            Log.w(TAG, "no island user yet; cannot route $pkg")
            return
        }
        moveToIsland(context, pkg, island)
    }

    companion object {
        private const val TAG = "LobiumIsland"

        /**
         * Install [pkg] into the [island] user and hide it in the main space, so the account-holding app
         * runs only inside the isolated container.
         */
        fun moveToIsland(context: Context, pkg: String, island: UserHandle) {
            val dpm =
                context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            val admin = LobiumIslandAdminReceiver.component(context)
            try {
                // installExistingPackage clones the already-downloaded APK into the target user without
                // re-downloading — the same trick Island uses to "clone" an app into its space.
                dpm.installExistingPackage(admin, pkg) // installs into the admin's target user (island)
                // Hide (freeze) the copy in the MAIN space so the account lives only in the island.
                dpm.setApplicationHidden(admin, pkg, true)
                Log.i(TAG, "routed $pkg into island $island")
            } catch (t: Throwable) {
                Log.e(TAG, "failed to route $pkg into island", t)
            }
        }
    }
}
