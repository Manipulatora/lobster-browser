package com.lobium.island

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * On every boot, make sure the isolated island user exists and the current per-machine policy is
 * applied. Idempotent — IslandProvisioner reuses the existing island if one is already present.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        IslandProvisioner(context).ensureProvisioned()
    }
}
