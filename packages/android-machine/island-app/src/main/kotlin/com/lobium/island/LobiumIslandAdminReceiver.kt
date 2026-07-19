package com.lobium.island

import android.app.admin.DeviceAdminReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent

/**
 * Device-admin entry point for the built-in Lobium Island isolation service.
 *
 * This app is provisioned as DEVICE OWNER at first boot (see image/first-boot-provision.sh). As device
 * owner it can create/manage an isolated user (the "island") and install apps into it — the mechanism
 * behind "secure app install + account protection". No user interaction is required.
 */
class LobiumIslandAdminReceiver : DeviceAdminReceiver() {

    override fun onEnabled(context: Context, intent: Intent) {
        // Device-owner just granted. Ensure the isolated user + policy exist immediately.
        IslandProvisioner(context).ensureProvisioned()
    }

    companion object {
        fun component(context: Context): ComponentName =
            ComponentName(context, LobiumIslandAdminReceiver::class.java)
    }
}
