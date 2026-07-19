package com.lobium.island

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.PersistableBundle
import android.os.UserHandle
import android.os.UserManager
import android.util.Log

/**
 * Creates and owns the isolated "island" user — a managed secondary user, separate from the main space,
 * with its own app data. This is the container flagged (account-holding) apps are routed into.
 *
 * As DEVICE OWNER we use createAndManageUser (the same primitive Island/Insular use) so the container
 * exists out of the box with no user setup.
 */
class IslandProvisioner(private val context: Context) {

    private val dpm =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    private val admin = LobiumIslandAdminReceiver.component(context)

    /** Ensure the isolated user exists and per-machine policy (from IslandPolicy) is applied. */
    fun ensureProvisioned(): UserHandle? {
        if (!dpm.isDeviceOwnerApp(context.packageName)) {
            Log.w(TAG, "not device owner; cannot provision island")
            return null
        }
        val island = existingIslandUser() ?: createIslandUser() ?: return null
        applyPolicy(island)
        return island
    }

    /** Locate a previously-created island user by our provisioning tag. */
    fun existingIslandUser(): UserHandle? {
        val um = context.getSystemService(Context.USER_SERVICE) as UserManager
        return dpm.getSecondaryUsers(admin).firstOrNull { user ->
            // We tag the island via a restriction bundle; the tag survives reboots.
            um.getUserRestrictions(user).getBoolean(ISLAND_TAG, false)
        }
    }

    private fun createIslandUser(): UserHandle? {
        val extras = PersistableBundle().apply { putBoolean(ISLAND_TAG_EXTRA, true) }
        return try {
            // LEAVE_ALL_SYSTEM_APPS_ENABLED keeps the container usable; the island is skip-setup.
            dpm.createAndManageUser(
                admin,
                "Island",
                admin,
                extras,
                DevicePolicyManager.SKIP_SETUP_WIZARD or
                    DevicePolicyManager.LEAVE_ALL_SYSTEM_APPS_ENABLED,
            )?.also { user ->
                // Tag the user so we can find it after reboot, and start it in the background.
                val restrictions = Bundle().apply { putBoolean(ISLAND_TAG, true) }
                dpm.setUserRestriction(admin, ISLAND_TAG) // marks it; see existingIslandUser
                dpm.startUserInBackground(admin, user)
                Log.i(TAG, "created island user $user")
            }
        } catch (t: Throwable) {
            Log.e(TAG, "createAndManageUser failed", t)
            null
        }
    }

    /** Apply the per-machine Island policy (freeze-on-idle, initial isolated set). */
    private fun applyPolicy(island: UserHandle) {
        val policy = IslandPolicy.load(context)
        // Pre-install any already-present flagged apps into the island.
        val pm = context.packageManager
        policy.isolateOnInstall.forEach { pkg ->
            if (isInstalledInMain(pm, pkg)) {
                InstallRouter.moveToIsland(context, pkg, island)
            }
        }
    }

    private fun isInstalledInMain(pm: PackageManager, pkg: String): Boolean =
        try {
            pm.getPackageInfo(pkg, 0); true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }

    companion object {
        private const val TAG = "LobiumIsland"
        const val ISLAND_TAG = "com.lobium.island.IS_ISLAND"
        const val ISLAND_TAG_EXTRA = "com.lobium.island.EXTRA_IS_ISLAND"
    }
}
