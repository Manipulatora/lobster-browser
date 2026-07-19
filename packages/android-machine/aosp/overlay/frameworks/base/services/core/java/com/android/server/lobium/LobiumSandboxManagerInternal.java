/*
 * Copyright (C) 2026 Lobium. Part of the Lobium Android platform fork.
 *
 * In-process (system_server) contract for the OS-embedded app sandbox. Other platform components
 * obtain it via LocalServices.getService(LobiumSandboxManagerInternal.class). This is NOT a Binder /
 * app-facing API — sandboxing is a property of the OS, not something an app can request or opt out of.
 */
package com.android.server.lobium;

public abstract class LobiumSandboxManagerInternal {

    /**
     * Called by the platform when a package finishes installing in a space. If policy says the package
     * should be sandboxed and it is not already, the manager moves it into an isolated Android profile.
     * Idempotent; safe to call for system packages and sandbox users (they are ignored).
     */
    public abstract void onPackageInstalled(String packageName, int userId);

    /** @return true if {@code packageName} currently lives in a sandbox profile. */
    public abstract boolean isSandboxed(String packageName);

    /** @return the sandbox profile user id hosting {@code packageName}, or -1 if not sandboxed. */
    public abstract int getSandboxUserId(String packageName);
}
