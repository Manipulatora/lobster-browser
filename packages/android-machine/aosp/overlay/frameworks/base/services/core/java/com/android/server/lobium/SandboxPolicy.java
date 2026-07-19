/*
 * Copyright (C) 2026 Lobium. Part of the Lobium Android platform fork.
 *
 * Per-machine sandbox policy. The capability itself is always on and compiled into the OS; this only
 * shapes it. Loaded from /data/system/lobium/sandbox-policy.json (staged per machine at boot). When no
 * file is present the compiled-in default applies: sandbox every third-party app, one profile per app.
 */
package com.android.server.lobium;

import android.util.ArraySet;
import android.util.Slog;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.file.Files;
import java.util.Set;

final class SandboxPolicy {
    private static final String TAG = "LobiumSandbox";
    private static final File POLICY_FILE = new File("/data/system/lobium/sandbox-policy.json");

    enum Mode { ALL, SELECTED }
    enum Isolation { PER_APP, SHARED }

    /** ALL = sandbox every third-party install (OS default); SELECTED = only {@link #apps}. */
    final Mode mode;
    /** Packages always sandboxed when {@link #mode} is SELECTED. */
    final Set<String> apps;
    /** PER_APP = a dedicated isolated profile per app (strongest); SHARED = one sandbox profile. */
    final Isolation isolation;
    /** Force-stop sandboxed apps when idle so they cannot run or phone home in the background. */
    final boolean freezeIdle;

    private SandboxPolicy(Mode mode, Set<String> apps, Isolation isolation, boolean freezeIdle) {
        this.mode = mode;
        this.apps = apps;
        this.isolation = isolation;
        this.freezeIdle = freezeIdle;
    }

    /** The compiled-in default when no per-machine file exists: sandbox everything, one profile per app. */
    static SandboxPolicy defaults() {
        return new SandboxPolicy(Mode.ALL, new ArraySet<>(), Isolation.PER_APP, true);
    }

    boolean shouldSandbox(String packageName) {
        return mode == Mode.ALL || apps.contains(packageName);
    }

    static SandboxPolicy load() {
        if (!POLICY_FILE.exists()) {
            return defaults();
        }
        try {
            final String raw = new String(Files.readAllBytes(POLICY_FILE.toPath()));
            final JSONObject o = new JSONObject(raw);
            final Mode mode = "selected".equalsIgnoreCase(o.optString("mode", "all"))
                    ? Mode.SELECTED : Mode.ALL;
            final Set<String> apps = new ArraySet<>();
            final JSONArray arr = o.optJSONArray("sandboxedApps");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    apps.add(arr.getString(i));
                }
            }
            final Isolation isolation = "shared".equalsIgnoreCase(o.optString("isolation", "per-app"))
                    ? Isolation.SHARED : Isolation.PER_APP;
            final boolean freezeIdle = o.optBoolean("freezeIdleApps", true);
            return new SandboxPolicy(mode, apps, isolation, freezeIdle);
        } catch (Exception e) {
            Slog.e(TAG, "failed to parse " + POLICY_FILE + "; using defaults", e);
            return defaults();
        }
    }

    @Override
    public String toString() {
        return "SandboxPolicy{mode=" + mode + ", isolation=" + isolation
                + ", freezeIdle=" + freezeIdle + ", apps=" + apps.size() + "}";
    }
}
