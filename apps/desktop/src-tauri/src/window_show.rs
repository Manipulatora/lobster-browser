//! Make sure a freshly launched browser is actually ON SCREEN.
//!
//! ## Why this exists
//!
//! The launcher spawns the engine from Node. On Windows, libuv always sets `STARTF_USESHOWWINDOW`
//! and picks `wShowWindow` from the `windowsHide` option: `SW_HIDE` when true, `SW_SHOWDEFAULT`
//! when false. Neither value is "show this window".
//!
//! `windowsHide: true` was an outright bug — Chromium's first `ShowWindow` call is overridden by
//! `STARTF_USESHOWWINDOW`, so the browser window was created, laid out, and never shown. That is
//! fixed at the spawn site (see `lobium-launcher.ts`), and it was the cause of "the profile says
//! running but no browser appears".
//!
//! `SW_SHOWDEFAULT`, the value we now pass, is better but still not a guarantee: it means "use the
//! `STARTUPINFO` of the process that started the caller". For a desktop app the user launched from
//! Explorer that resolves to a normal, visible window — but it is INHERITED STATE, and it resolves
//! to hidden whenever some ancestor was started hidden (a scheduled task, a service, a CI harness,
//! an app auto-started minimised at login). The user then gets exactly the original symptom back,
//! for a reason that has nothing to do with their profile.
//!
//! So after a launch is confirmed we stop inheriting and assert: any top-level browser window
//! belonging to the new process that is still not visible gets an explicit `SW_SHOWNORMAL`.
//!
//! Deliberately a NO-OP in the healthy case — it only ever touches a window that is already
//! invisible, so it cannot fight Chromium for control of a window that is behaving.

/// Poll for this long after launch before giving up. The DevTools endpoint answers before the
/// browser window exists, so checking once immediately would usually find nothing at all.
const WINDOW_WAIT: std::time::Duration = std::time::Duration::from_secs(12);
const POLL_EVERY: std::time::Duration = std::time::Duration::from_millis(300);

/// Watch a freshly launched browser process and show its window if Windows left it hidden.
///
/// Fire-and-forget: the launch response must not wait on a window, and a failure here is never a
/// reason to fail a launch that otherwise succeeded.
pub fn ensure_visible_soon(pid: u32, profile_id: &str) {
    if pid == 0 {
        return;
    }
    let profile_id = profile_id.to_string();
    tokio::spawn(async move {
        let deadline = std::time::Instant::now() + WINDOW_WAIT;
        loop {
            let shown = imp::show_hidden_windows_of(pid);
            if shown > 0 {
                tracing::warn!(
                    target: "launch",
                    "{profile_id}: browser window for pid {pid} was created hidden; showed {shown} \
                     window(s) explicitly. Something in the process chain was started hidden."
                );
                return;
            }
            if imp::has_visible_window(pid) || std::time::Instant::now() >= deadline {
                return;
            }
            tokio::time::sleep(POLL_EVERY).await;
        }
    });
}

#[cfg(windows)]
mod imp {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowThreadProcessId, IsWindowVisible, ShowWindow,
        SW_SHOWNORMAL,
    };

    /// Chromium's top-level browser frame. `Chrome_WidgetWin_0` is used for menus, tooltips and
    /// other transient surfaces, which must stay hidden until Chromium wants them.
    const BROWSER_CLASS: &str = "Chrome_WidgetWin_1";

    struct Scan {
        pid: u32,
        /// Show hidden windows rather than only counting visible ones.
        act: bool,
        hit: usize,
    }

    fn class_of(hwnd: HWND) -> String {
        let mut buf = [0u16; 256];
        // SAFETY: `buf` is a valid, correctly sized buffer for the length we pass.
        let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        if n <= 0 {
            return String::new();
        }
        OsString::from_wide(&buf[..n as usize])
            .to_string_lossy()
            .into_owned()
    }

    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the `&mut Scan` we passed to EnumWindows, valid for the whole call.
        let scan = unsafe { &mut *(lparam as *mut Scan) };
        let mut owner: u32 = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut owner) };
        if owner != scan.pid || class_of(hwnd) != BROWSER_CLASS {
            return TRUE;
        }
        let visible = unsafe { IsWindowVisible(hwnd) } != 0;
        if scan.act {
            if !visible {
                unsafe { ShowWindow(hwnd, SW_SHOWNORMAL) };
                scan.hit += 1;
            }
        } else if visible {
            scan.hit += 1;
        }
        TRUE
    }

    fn scan(pid: u32, act: bool) -> usize {
        let mut state = Scan { pid, act, hit: 0 };
        // SAFETY: the callback matches WNDENUMPROC and `state` outlives the enumeration.
        unsafe { EnumWindows(Some(enum_cb), &mut state as *mut Scan as LPARAM) };
        state.hit
    }

    /// Show every hidden top-level browser window owned by `pid`; returns how many were shown.
    pub fn show_hidden_windows_of(pid: u32) -> usize {
        scan(pid, true)
    }

    /// Does this process already have a visible browser window? Then there is nothing to fix.
    pub fn has_visible_window(pid: u32) -> bool {
        scan(pid, false) > 0
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::imp;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, IsWindowVisible, RegisterClassW,
        CW_USEDEFAULT, WNDCLASSW, WS_OVERLAPPEDWINDOW,
    };

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// A real top-level window of the class the browser uses, created and left HIDDEN — the exact
    /// state Windows left the engine in when the launcher spawned it with `windowsHide: true`.
    fn hidden_browser_window(class: &str) -> HWND {
        let name = wide(class);
        let mut wc: WNDCLASSW = unsafe { std::mem::zeroed() };
        wc.lpfnWndProc = Some(DefWindowProcW);
        wc.lpszClassName = name.as_ptr();
        unsafe { RegisterClassW(&wc) };
        let title = wide("test window");
        // No WS_VISIBLE: created hidden, like the real defect.
        unsafe {
            CreateWindowExW(
                0,
                name.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPEDWINDOW,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                400,
                300,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        }
    }

    #[test]
    fn a_hidden_browser_window_is_found_and_shown() {
        let pid = std::process::id();
        let hwnd = hidden_browser_window("Chrome_WidgetWin_1");
        assert!(!hwnd.is_null(), "could not create the test window");
        assert_eq!(unsafe { IsWindowVisible(hwnd) }, 0, "fixture must start hidden");
        assert!(!imp::has_visible_window(pid));

        let shown = imp::show_hidden_windows_of(pid);
        assert!(shown >= 1, "expected the hidden window to be shown, showed {shown}");
        assert_ne!(unsafe { IsWindowVisible(hwnd) }, 0, "window should now be visible");
        assert!(imp::has_visible_window(pid));

        // Idempotent: a second pass must not touch an already-visible window, or every launch would
        // yank focus back to a browser the user has since moved behind something else.
        assert_eq!(imp::show_hidden_windows_of(pid), 0);

        unsafe { DestroyWindow(hwnd) };
    }

    #[test]
    fn windows_of_other_classes_are_left_alone() {
        // Chrome_WidgetWin_0 is menus, tooltips and drag images. Showing those would paint stray
        // chrome on the user's desktop.
        let pid = std::process::id();
        let hwnd = hidden_browser_window("Chrome_WidgetWin_0");
        assert!(!hwnd.is_null());

        imp::show_hidden_windows_of(pid);

        // Asserts on THIS window, not on the scan's total. Rust runs unit tests as threads of one
        // process, so the total also counts windows belonging to whatever else is running
        // concurrently — including the sibling test's Chrome_WidgetWin_1 fixture.
        assert_eq!(unsafe { IsWindowVisible(hwnd) }, 0, "must still be hidden");
        unsafe { DestroyWindow(hwnd) };
    }
}

#[cfg(not(windows))]
mod imp {
    // The defect is a Windows `STARTUPINFO` behaviour and has no analogue elsewhere: on macOS and
    // Linux the launcher's spawn options carry no show-state at all.
    pub fn show_hidden_windows_of(_pid: u32) -> usize {
        0
    }
    pub fn has_visible_window(_pid: u32) -> bool {
        true
    }
}
