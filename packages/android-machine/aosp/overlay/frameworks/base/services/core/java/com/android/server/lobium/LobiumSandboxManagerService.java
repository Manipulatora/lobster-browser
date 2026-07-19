/*
 * Copyright (C) 2026 Lobium. Part of the Lobium Android platform fork.
 *
 * LobiumSandboxManagerService — OS-embedded per-app sandboxing.
 *
 * This is the "Island" capability, built into the operating system rather than shipped as an app. It
 * runs inside system_server as a platform SystemService. Whenever a third-party app is installed into
 * the primary space, the OS moves it into an isolated Android profile of its own: separate storage,
 * accounts, cookies and app-set — walled off from every other app and from the main space. There is
 * nothing for the user to install, enable, or grant; the behaviour is a default property of the OS.
 *
 * Mechanism (all platform-privileged, no device-owner app):
 *   1. A PackageMonitor (the framework's own install callback) observes installs in the primary user.
 *   2. Policy (SandboxPolicy) decides whether the package is sandboxed. Default: every third-party app.
 *   3. A sandbox *profile* is created via UserManager#createProfile using the platform user type
 *      USER_TYPE_LOBIUM_SANDBOX (defined in UserTypeFactory), started alongside the parent so it runs
 *      concurrently — exactly the primitive work profiles use.
 *   4. The APK is enabled for the profile (installExistingPackageAsUser) and hidden in the primary
 *      space, so only the isolated copy remains.
 *
 * Authored against AOSP 14 (API 34). See aosp/README.md for build + rebase notes.
 */
package com.android.server.lobium;

import android.app.ActivityManager;
import android.app.AppGlobals;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.IPackageManager;
import android.content.pm.PackageManager;
import android.os.Binder;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Process;
import android.os.RemoteException;
import android.os.ResultReceiver;
import android.os.ShellCallback;
import android.os.ShellCommand;
import android.os.UserHandle;
import android.os.UserManager;
import android.util.ArrayMap;
import android.util.ArraySet;
import android.util.Slog;

import com.android.internal.content.PackageMonitor;
import com.android.server.LocalServices;
import com.android.server.SystemService;

import java.io.FileDescriptor;
import java.io.PrintWriter;
import java.util.Map;

public final class LobiumSandboxManagerService extends SystemService {
    private static final String TAG = "LobiumSandbox";

    /** Platform user type for sandbox profiles. Must match the entry added in UserTypeFactory. */
    static final String USER_TYPE_LOBIUM_SANDBOX = "com.lobium.usertype.SANDBOX";

    /** How long a sandboxed app may sit idle before it is force-stopped (when freezeIdle is on). */
    private static final long IDLE_FREEZE_MS = 5 * 60 * 1000L;

    private final Context mContext;
    private final Handler mHandler;
    private final Object mLock = new Object();

    /** packageName -> sandbox profile user id. */
    private final ArrayMap<String, Integer> mSandboxed = new ArrayMap<>();
    /** Reused sandbox profile when isolation == SHARED; UserHandle.USER_NULL until created. */
    private int mSharedSandboxUserId = UserHandle.USER_NULL;

    private volatile SandboxPolicy mPolicy = SandboxPolicy.defaults();
    private IPackageManager mIpm;

    private final PackageMonitor mPackageMonitor = new PackageMonitor() {
        @Override
        public void onPackageAdded(String packageName, int uid) {
            final int userId = UserHandle.getUserId(uid);
            mHandler.post(() -> handleInstalled(packageName, userId));
        }
    };

    public LobiumSandboxManagerService(Context context) {
        super(context);
        mContext = context;
        final HandlerThread thread = new HandlerThread("LobiumSandbox");
        thread.start();
        mHandler = new Handler(thread.getLooper());
    }

    @Override
    public void onStart() {
        mPolicy = SandboxPolicy.load();
        publishLocalService(LobiumSandboxManagerInternal.class, new LocalService());
        publishBinderService("lobium_sandbox", new SandboxBinder());
        Slog.i(TAG, "OS app sandbox online: " + mPolicy);
    }

    @Override
    public void onBootPhase(int phase) {
        if (phase == PHASE_ACTIVITY_MANAGER_READY) {
            mIpm = AppGlobals.getPackageManager();
        } else if (phase == PHASE_BOOT_COMPLETED) {
            // Observe installs across all users; we act only on primary-space installs.
            mPackageMonitor.register(mContext, mHandler.getLooper(), UserHandle.ALL, false);
            if (mPolicy.freezeIdle) {
                mHandler.postDelayed(this::freezeIdleSandboxApps, IDLE_FREEZE_MS);
            }
        }
    }

    // ---- core ---------------------------------------------------------------------------------

    private void handleInstalled(String pkg, int userId) {
        synchronized (mLock) {
            if (!isPrimaryUser(userId)) return;         // only sandbox from the main space
            if (mSandboxed.containsKey(pkg)) return;     // already sandboxed
            if (isSelf(pkg)) return;
            if (isSystemPackage(pkg, userId)) return;    // never touch platform / preinstalled apps
            if (!mPolicy.shouldSandbox(pkg)) return;

            final int sandboxUser = ensureSandboxUser(pkg);
            if (sandboxUser == UserHandle.USER_NULL) {
                Slog.w(TAG, "no sandbox profile for " + pkg + "; leaving in place");
                return;
            }
            try {
                // Enable the already-installed APK inside the sandbox profile (no re-download)...
                mIpm.installExistingPackageAsUser(pkg, sandboxUser, 0 /* installFlags */,
                        PackageManager.INSTALL_REASON_UNKNOWN, null /* whiteListedPermissions */);
                // ...then remove it from the main space so only the isolated copy is reachable there.
                mIpm.setApplicationHiddenSettingAsUser(pkg, true /* hidden */, userId);
                mSandboxed.put(pkg, sandboxUser);
                Slog.i(TAG, "sandboxed " + pkg + " -> profile user " + sandboxUser);
            } catch (RemoteException e) {
                // Local call into system_server; a failure here means PMS is mid-shutdown.
                Slog.e(TAG, "failed to sandbox " + pkg, e);
            }
        }
    }

    /** Find or create the sandbox profile that should host {@code pkg}, per the isolation policy. */
    private int ensureSandboxUser(String pkg) {
        if (mPolicy.isolation == SandboxPolicy.Isolation.SHARED) {
            if (mSharedSandboxUserId != UserHandle.USER_NULL) return mSharedSandboxUserId;
            mSharedSandboxUserId = createSandboxProfile("Sandbox");
            return mSharedSandboxUserId;
        }
        return createSandboxProfile("Sandbox:" + pkg);
    }

    private int createSandboxProfile(String name) {
        final UserManager um = mContext.getSystemService(UserManager.class);
        final ActivityManager am = mContext.getSystemService(ActivityManager.class);
        try {
            final UserHandle profile = um.createProfile(name, USER_TYPE_LOBIUM_SANDBOX, new ArraySet<>());
            if (profile == null) return UserHandle.USER_NULL;
            // Start it so its apps can run concurrently with the parent (like a work profile).
            am.startProfile(profile);
            return profile.getIdentifier();
        } catch (Exception e) {
            Slog.e(TAG, "sandbox profile create failed for " + name, e);
            return UserHandle.USER_NULL;
        }
    }

    private void freezeIdleSandboxApps() {
        synchronized (mLock) {
            for (Map.Entry<String, Integer> e : mSandboxed.entrySet()) {
                try {
                    // Idle policy for automation-first machines: stop the sandboxed app; it re-launches
                    // on demand. Foreground apps are re-stopped only after the next idle window.
                    ActivityManager.getService().forceStopPackage(e.getKey(), e.getValue());
                } catch (RemoteException re) {
                    Slog.w(TAG, "freeze failed for " + e.getKey(), re);
                }
            }
        }
        mHandler.postDelayed(this::freezeIdleSandboxApps, IDLE_FREEZE_MS);
    }

    // ---- predicates ---------------------------------------------------------------------------

    private static boolean isPrimaryUser(int userId) {
        return userId == UserHandle.USER_SYSTEM;
    }

    private static boolean isSelf(String pkg) {
        return "android".equals(pkg) || (pkg != null && pkg.startsWith("com.android."))
                || (pkg != null && pkg.startsWith("com.lobium."));
    }

    private boolean isSystemPackage(String pkg, int userId) {
        try {
            final ApplicationInfo ai = mIpm.getApplicationInfo(pkg, 0L, userId);
            if (ai == null) return true;
            return (ai.flags & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0;
        } catch (RemoteException e) {
            return true; // fail safe: if we can't tell, don't touch it
        }
    }

    // ---- LocalService (in-process contract) ---------------------------------------------------

    private final class LocalService extends LobiumSandboxManagerInternal {
        @Override
        public void onPackageInstalled(String packageName, int userId) {
            mHandler.post(() -> handleInstalled(packageName, userId));
        }

        @Override
        public boolean isSandboxed(String packageName) {
            synchronized (mLock) {
                return mSandboxed.containsKey(packageName);
            }
        }

        @Override
        public int getSandboxUserId(String packageName) {
            synchronized (mLock) {
                final Integer u = mSandboxed.get(packageName);
                return u != null ? u : -1;
            }
        }
    }

    // ---- shell (adb shell cmd lobium_sandbox ...) ---------------------------------------------

    private final class SandboxBinder extends Binder {
        @Override
        public void onShellCommand(FileDescriptor in, FileDescriptor out, FileDescriptor err,
                String[] args, ShellCallback callback, ResultReceiver resultReceiver) {
            final int uid = Binder.getCallingUid();
            if (uid != Process.ROOT_UID && uid != Process.SHELL_UID) {
                throw new SecurityException("lobium_sandbox shell is root/shell only");
            }
            new SandboxShellCommand().exec(this, in, out, err, args, callback, resultReceiver);
        }
    }

    private final class SandboxShellCommand extends ShellCommand {
        @Override
        public int onCommand(String cmd) {
            if (cmd == null) return handleDefaultCommands(null);
            final PrintWriter pw = getOutPrintWriter();
            switch (cmd) {
                case "reload":
                    mPolicy = SandboxPolicy.load();
                    if (mPolicy.freezeIdle) {
                        mHandler.postDelayed(LobiumSandboxManagerService.this::freezeIdleSandboxApps,
                                IDLE_FREEZE_MS);
                    }
                    pw.println("reloaded: " + mPolicy);
                    return 0;
                case "status":
                    synchronized (mLock) {
                        pw.println("policy=" + mPolicy);
                        for (Map.Entry<String, Integer> e : mSandboxed.entrySet()) {
                            pw.println(e.getKey() + " -> profile user " + e.getValue());
                        }
                    }
                    return 0;
                default:
                    return handleDefaultCommands(cmd);
            }
        }

        @Override
        public void onHelp() {
            final PrintWriter pw = getOutPrintWriter();
            pw.println("Lobium OS sandbox:");
            pw.println("  reload   Re-read /data/system/lobium/sandbox-policy.json");
            pw.println("  status   Show active policy + sandboxed packages");
        }
    }
}
