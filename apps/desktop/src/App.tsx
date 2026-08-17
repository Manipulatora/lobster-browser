
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authClient, type CloudUser } from './api/auth';
import { isDesktopRuntime, profilesClient } from './api/tauri';
import { AuthScreen } from './features/auth/AuthScreen';
import { ProfilesView } from './features/profiles/ProfilesView';
import { ProxiesView } from './features/proxies/ProxiesView';
import { TemplatesView } from './features/templates/TemplatesView';
import siteLogo from './assets/brand/site-logo.png';
import { ActionDialog, CommandPalette, ErrorDialog, Kbd, type Command } from './ui';
import type { Profile } from '@lobster/shared-types';
import { Icon, type IconName } from './ui/Icon';

// Icon NAMES rather than components: <Icon> resolves the path itself, so the nav table stays plain
// data and nothing here has to shadow the component to render it.
const NAV_ITEMS = [
  { key: 'profiles', label: 'Profiles', icon: 'UserGroupIcon' },
  { key: 'proxies', label: 'Proxies', icon: 'ServerStackIcon' },
  { key: 'templates', label: 'Templates', icon: 'DocumentDuplicateIcon' },
] as const satisfies ReadonlyArray<{ key: string; label: string; icon: IconName }>;

export type NavKey = (typeof NAV_ITEMS)[number]['key'];

function ActiveView({
  active,
  createProfileSignal,
}: {
  active: NavKey;
  createProfileSignal: number;
}): JSX.Element {
  switch (active) {
    case 'profiles':
      return <ProfilesView createProfileSignal={createProfileSignal} />;
    case 'proxies':
      return <ProxiesView />;
    case 'templates':
      return <TemplatesView />;
  }
}

/**
 * Root: the authentication gate, then the launcher dashboard.
 *
 * WHAT COUNTS AS "LET THEM IN". A verified cloud session does, obviously. So does a held-but-
 * unverifiable one — `offline` — and that case is the reason this is a three-state check rather
 * than `if (user)`. Profiles, proxies and launches are entirely local; locking someone out of them
 * because the API was briefly unreachable would break the product's core function over something
 * unrelated to it. The gate exists to establish an account, not to police day-to-day use.
 */
export function App(): JSX.Element {
  const [user, setUser] = useState<CloudUser | null>(null);
  const [offline, setOffline] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // PAINT FROM LOCAL STATE FIRST. This resolves without touching the network, so a cold start is
    // not held behind `/auth/me` and its 15-second timeout — which used to mean a slow connection
    // looked like a hung app, while the profile list the user wanted was already readable locally in
    // about 2 ms.
    void authClient
      .statusCached()
      .then((cached) => {
        if (!cancelled) setUser(cached.user);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setAuthChecked(true);
      });

    // ...then confirm with the server behind the already-painted UI, and correct it if the token has
    // been revoked. Only this answer may sign someone OUT: the cached one is a memory, not proof.
    void authClient
      .status()
      .then((state) => {
        if (cancelled) return;
        setUser(state.user);
        setOffline(state.offline);
      })
      .catch(() => {
        // Unreachable keychain or IPC failure. The cached answer above already decided what to
        // show; an error dialog here would just be a dead end.
      })
      .finally(() => {
        if (!cancelled) setAuthChecked(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Only the local read is awaited, so this is a frame or two rather than a network round trip.
  // Flashing the sign-in screen at an already signed-in user still has to be avoided — that reads as
  // having been logged out — which is exactly what the cached identity prevents.
  if (!authChecked) return <div className="app-boot" aria-busy="true" />;

  if (!user && !offline) {
    return <AuthScreen onAuthenticated={setUser} />;
  }

  return (
    <Dashboard
      user={user}
      onSignedOut={() => {
        setUser(null);
        setOffline(false);
      }}
    />
  );
}

/**
 * The launcher dashboard, shown once the auth gate is satisfied.
 *
 * `user` is nullable on purpose: the gate also admits the `offline` case — a token is held but
 * could not be verified — so the shell knows an account exists without knowing whose.
 */
function Dashboard({
  user,
  onSignedOut,
}: {
  user: CloudUser | null;
  onSignedOut: () => void;
}): JSX.Element {
  const [active, setActive] = useState<NavKey>('profiles');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [createProfileSignal, setCreateProfileSignal] = useState(0);
  const [quickLaunchProfile, setQuickLaunchProfile] = useState<Profile | null>(null);
  const [quickLaunchPassword, setQuickLaunchPassword] = useState('');
  const [quickLaunchBusy, setQuickLaunchBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const isMac = useMemo(
    () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform),
    [],
  );

  // Keep a lightweight profile list for command-palette search / quick-launch.
  useEffect(() => {
    let cancelled = false;
    void profilesClient
      .list_profiles()
      .then((list) => {
        if (!cancelled) setProfiles(list);
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    const id = window.setInterval(() => {
      void profilesClient
        .list_profiles()
        .then((list) => {
          if (!cancelled) setProfiles(list);
        })
        .catch(() => undefined);
    }, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, createProfileSignal]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Same dismissal contract as the row menus in ProfileList: pointerdown outside, or Escape.
  useEffect(() => {
    if (!accountMenuOpen) return undefined;

    function closeIfOutside(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && accountMenuRef.current?.contains(target)) return;
      setAccountMenuOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setAccountMenuOpen(false);
    }

    document.addEventListener('pointerdown', closeIfOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [accountMenuOpen]);

  const accountLabel = user?.displayName ?? user?.email ?? 'Account';

  async function handleSignOut(): Promise<void> {
    setAccountMenuOpen(false);
    try {
      await authClient.signOut();
    } catch {
      // Nothing actionable to report: sign-out only drops the keychain token and returns no
      // result, so the one thing this window can still honour is the request itself. Leaving
      // someone inside a signed-in shell they just asked to leave is the worse outcome.
    }
    onSignedOut();
  }

  const requestCreateProfile = useCallback(() => {
    setActive('profiles');
    setCreateProfileSignal((n) => n + 1);
  }, []);

  const runQuickLaunch = useCallback(async (profile: Profile, password?: string) => {
    try {
      if (profile.status === 'running') {
        await profilesClient.stop_profile(profile.id);
      } else {
        await profilesClient.launch_profile(profile.id, password);
      }
      setProfiles(await profilesClient.list_profiles());
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  async function confirmQuickLaunch(): Promise<void> {
    if (!quickLaunchProfile) return;
    setQuickLaunchBusy(true);
    try {
      await profilesClient.launch_profile(quickLaunchProfile.id, quickLaunchPassword);
      setProfiles(await profilesClient.list_profiles());
      setQuickLaunchProfile(null);
      setQuickLaunchPassword('');
    } catch (error: unknown) {
      setQuickLaunchProfile(null);
      setQuickLaunchPassword('');
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setQuickLaunchBusy(false);
    }
  }

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = NAV_ITEMS.map((item) => ({
      id: `nav-${item.key}`,
      title: `Go to ${item.label}`,
      group: 'Navigation',
      keywords: item.label,
      icon: <Icon name={item.icon} aria-hidden />,
      run: () => setActive(item.key),
    }));

    const actions: Command[] = [
      {
        id: 'action-create-profile',
        title: 'Create Profile',
        group: 'Actions',
        keywords: 'new profile',
        run: requestCreateProfile,
      },
    ];

    const profileCmds: Command[] = profiles.map((p) => ({
      id: `profile-${p.id}`,
      title: p.name,
      group: 'Profiles',
      hint: p.status === 'running' ? 'Running' : 'Quick launch',
      keywords: `${p.tags.join(' ')} ${p.engine} ${p.os}`,
      run: () => {
        setActive('profiles');
        if (p.passwordProtected && p.status !== 'running') {
          setQuickLaunchPassword('');
          setQuickLaunchProfile(p);
          return;
        }
        void runQuickLaunch(p);
      },
    }));

    return [...nav, ...actions, ...profileCmds];
  }, [profiles, requestCreateProfile, runQuickLaunch]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__brand">
          <img className="topbar__logo" src={siteLogo} alt="Lobster Browser" />
        </div>
        <div className="topbar__spacer" />
        <div className="topbar__actions">
          <button
            type="button"
            className="icon-button topbar-search"
            aria-label="Open command palette"
            onClick={() => setPaletteOpen(true)}
            title="Command palette"
          >
            <Icon name="MagnifyingGlassIcon" aria-hidden />
            <Kbd>{isMac ? 'âŒ˜K' : 'Ctrl K'}</Kbd>
          </button>
          {/* The only place the signed-in account is visible, and the only way out of it: before
              this, auth_sign_out had no caller anywhere, so the sole escape from a wrong account
              was clearing the OS keychain by hand. It sits in the topbar rather than the sidebar
              footer because that footer is display:none below 900px wide. */}
          <div className="row-menu" ref={accountMenuRef}>
            <button
              type="button"
              className="btn"
              aria-haspopup="menu"
              aria-expanded={accountMenuOpen}
              onClick={() => setAccountMenuOpen((open) => !open)}
              title={accountLabel}
            >
              <span className="account-name">{accountLabel}</span>
              <Icon name="ChevronDownIcon" aria-hidden />
            </button>
            {accountMenuOpen ? (
              <div className="action-menu" role="menu">
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    void handleSignOut();
                  }}
                >
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar" aria-label="Primary navigation">
          <nav className="nav">
            {NAV_ITEMS.map((item) => {
              return (
                <button
                  key={item.key}
                  type="button"
                  className={item.key === active ? 'nav-item nav-item--active' : 'nav-item'}
                  onClick={() => setActive(item.key)}
                  aria-current={item.key === active ? 'page' : undefined}
                  title={item.label}
                >
                  <Icon name={item.icon} className="nav-item__icon" aria-hidden />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="sidebar-footer">
            <span>{isDesktopRuntime() ? 'Desktop runtime' : 'Dev mock runtime'}</span>
          </div>
        </aside>

        <main className="main">
          <ActiveView active={active} createProfileSignal={createProfileSignal} />
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
      <ActionDialog
        open={quickLaunchProfile !== null}
        title="Unlock profile"
        description={`Enter the password for â€œ${quickLaunchProfile?.name ?? 'this profile'}â€ to launch it in Lobium.`}
        confirmLabel="Launch profile"
        busy={quickLaunchBusy}
        input={{
          label: 'Profile password',
          value: quickLaunchPassword,
          onChange: setQuickLaunchPassword,
          type: 'password',
          required: true,
        }}
        onConfirm={() => {
          void confirmQuickLaunch();
        }}
        onClose={() => {
          setQuickLaunchProfile(null);
          setQuickLaunchPassword('');
        }}
      />
      <ErrorDialog
        open={errorMessage !== null}
        title="Profile action failed"
        message={errorMessage ?? ''}
        onClose={() => setErrorMessage(null)}
      />
    </div>
  );
}
