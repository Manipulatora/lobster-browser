import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { accountClient, type AccountState } from './api/account';
import { authClient, type CloudUser } from './api/auth';
import { profilesClient } from './api/tauri';
import { useRefreshOnFocus } from './api/useRefreshOnFocus';
import { AuthScreen } from './features/auth/AuthScreen';
import { AuthBootstrapGate } from './features/auth/authBootstrap';
import { ProfilesView } from './features/profiles/ProfilesView';
import { ProxiesView } from './features/proxies/ProxiesView';
import { TemplatesView } from './features/templates/TemplatesView';
import siteLogo from './assets/brand/site-logo.png';
import { AccountPanel } from './ui/AccountPanel';
import { ActionDialog, CommandPalette, ErrorDialog, type Command } from './ui';
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

/**
 * The palette's own shortcut, spelled the way the platform spells it. Windows is the primary target,
 * so anything that is not recognisably a Mac gets Ctrl — a hint that names the wrong key is worse
 * than none.
 */
const PALETTE_SHORTCUT = /mac/i.test(navigator.userAgent) ? '⌘K' : 'Ctrl K';

function ActiveView({
  active,
  createProfileSignal,
  onProfileCountChange,
  onAccountChanged,
}: {
  active: NavKey;
  createProfileSignal: number;
  onProfileCountChange: (count: number) => void;
  /** The view did something billing must answer for again (created a profile, refreshed the cap). */
  onAccountChanged: () => void;
}): JSX.Element {
  switch (active) {
    case 'profiles':
      return (
        <ProfilesView
          createProfileSignal={createProfileSignal}
          onProfileCountChange={onProfileCountChange}
          onAccountChanged={onAccountChanged}
        />
      );
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
  const [authRefresh, setAuthRefresh] = useState(0);
  const authBootstrap = useRef(new AuthBootstrapGate()).current;

  useEffect(() => {
    let cancelled = false;
    const generation = authBootstrap.begin();
    const apply = (state: { user: CloudUser | null; offline: boolean } | undefined): void => {
      if (cancelled || !state) return;
      setUser(state.user);
      setOffline(state.offline);
    };

    // PAINT FROM LOCAL STATE FIRST. This resolves without touching the network, so a cold start is
    // not held behind `/auth/me` and its 15-second timeout — which used to mean a slow connection
    // looked like a hung app, while the profile list the user wanted was already readable locally in
    // about 2 ms.
    void authClient
      .statusCached()
      .then((cached) => {
        apply(authBootstrap.acceptCached(generation, cached));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled && authBootstrap.markCachedSettled(generation)) setAuthChecked(true);
      });

    // ...then confirm with the server behind the already-painted UI, and correct it if the token has
    // been revoked. Only this answer may sign someone OUT: the cached one is a memory, not proof.
    void authClient
      .status()
      .then((state) => {
        apply(authBootstrap.acceptNetwork(generation, state));
      })
      .catch(() => {
        // Unreachable keychain or IPC failure. The cached answer above already decided what to
        // show; an error dialog here would just be a dead end.
      });

    return () => {
      cancelled = true;
    };
  }, [authBootstrap, authRefresh]);

  // Only the local read is awaited, so this is a frame or two rather than a network round trip.
  // Flashing the sign-in screen at an already signed-in user still has to be avoided — that reads as
  // having been logged out — which is exactly what the cached identity prevents.
  if (!authChecked) return <div className="app-boot" aria-busy="true" />;

  if (!user && !offline) {
    return (
      <AuthScreen
        onAttemptStarted={() => authBootstrap.supersede()}
        onUnauthenticatedAttemptFinished={() => setAuthRefresh((value) => value + 1)}
        onAuthenticated={(authenticatedUser) => {
          authBootstrap.supersede();
          setOffline(false);
          setUser(authenticatedUser);
        }}
      />
    );
  }

  return (
    <Dashboard
      user={user}
      onSignedOut={() => {
        authBootstrap.supersede();
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
  const [account, setAccount] = useState<AccountState>({ kind: 'loading' });
  /**
   * Bumped for EVERY reason to ask billing again — the panel's Retry, the window regaining focus
   * after a purchase on the website, a profile create that repainted the allowance. One owner, so
   * no path can forget to refresh and none can invent its own competing fetch.
   */
  const [accountAttempt, setAccountAttempt] = useState(0);
  const refreshAccount = useCallback(() => setAccountAttempt((n) => n + 1), []);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  // Balance, plan and cap.
  //
  // EVERY OUTCOME IS A STATE, and the panel renders all of them. This used to store
  // `AccountSummary | null` and render nothing for null — which was simultaneously "loading",
  // "offline", "signed out", "401" and "billing is down". The user saw an empty sidebar and no way
  // to know why or to try again.
  //
  // Keyed on the user's ID rather than the object: the auth bootstrap hands out a fresh object for
  // the same person on every verify, and an effect keyed on identity refired for no informational
  // change — while never firing for the changes that mattered (paying on the website). Those all
  // arrive through `accountAttempt` now.
  //
  // A FAILED REFRESH NEVER DESTROYS A GOOD ANSWER. Focus-driven refreshes run far more often than
  // the boot fetch did, including moments the network is flaky; flashing a working panel to
  // "error" because one background re-ask timed out would make the reactivity feel like a
  // regression. Stale-but-real beats fresh-but-empty; `error` is only for when there is nothing
  // real to show.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) {
      // Admitted by the auth gate as `offline`: a session is held but could not be verified, so
      // there is no identity to bill against and no point calling.
      setAccount({ kind: 'offline' });
      return;
    }
    let cancelled = false;
    void accountClient
      .summary()
      .then((summary) => {
        if (cancelled) return;
        // The Rust side collapses every transport and HTTP failure to null; treat that as an error
        // the user can retry rather than as an absence of information.
        if (summary) setAccount({ kind: 'ready', summary });
        else setAccount((prev) => (prev.kind === 'ready' ? prev : { kind: 'error' }));
      })
      .catch(() => {
        if (!cancelled) setAccount((prev) => (prev.kind === 'ready' ? prev : { kind: 'error' }));
      });
    return () => {
      cancelled = true;
    };
  }, [userId, accountAttempt]);

  // Money changes on the WEBSITE (top-ups, upgrades — hosted flows in the system browser), so the
  // moment this window regains focus is the moment the answer changed. See the hook for why.
  useRefreshOnFocus(refreshAccount);

  // Keep a lightweight profile list for command-palette search / quick-launch.
  const refreshProfiles = useCallback(() => {
    void profilesClient
      .list_profiles()
      .then(setProfiles)
      .catch(() => undefined);
  }, []);

  // The reported count is the trigger, not the state: the shell refetches the list, because the
  // palette and quick-launch read it too and a bare number would leave those stale. No dedupe on
  // the count — "delete one, create one" lands on the same number with different rows, and the
  // callback only fires when the child's list actually changed, so re-asking is already cheap.
  const handleProfileCountChange = useCallback(
    (_count: number) => refreshProfiles(),
    [refreshProfiles],
  );

  // One fetch when the view or the create signal changes; after that the list only refreshes while
  // someone is actually looking at the window (see useRefreshOnFocus below). The previous version
  // ran a bare 8s setInterval forever, so a launcher minimised for a day kept polling into the
  // void.
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
    return () => {
      cancelled = true;
    };
  }, [active, createProfileSignal]);
  useRefreshOnFocus(refreshProfiles, 8000);

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
        icon: <Icon name="PlusIcon" aria-hidden />,
        run: requestCreateProfile,
      },
    ];

    const profileCmds: Command[] = profiles.map((p) => ({
      id: `profile-${p.id}`,
      title: p.name,
      group: 'Profiles',
      icon: <Icon name="PlayIcon" aria-hidden />,
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
          {/* THE PALETTE NEEDS A DOOR. Ctrl/Cmd-K is the fast way in, not the discoverable one: a
              shortcut nobody is told about is a feature nobody has. Credit is deliberately NOT
              mirrored here — the balance, the plan it pays for and the allowance it buys are one
              subject, and they are read together in the sidebar account panel. */}
          <button
            type="button"
            className="palette-trigger"
            onClick={() => setPaletteOpen(true)}
            aria-haspopup="dialog"
            // Named here rather than by its own text: below 900px the label and the shortcut hint
            // are display:none and the icon is aria-hidden, which would leave the button with no
            // accessible name at all — an unlabelled button to a screen reader.
            aria-label="Search"
          >
            <Icon name="MagnifyingGlassIcon" className="palette-trigger__icon" aria-hidden />
            <span className="palette-trigger__label">Search</span>
            <kbd className="palette-trigger__key">{PALETTE_SHORTCUT}</kbd>
          </button>
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
          {/* ONE PANEL, ALWAYS PRESENT: plan, allowance, Credit and identity in the place the user
              looks for their account. Its states are handled inside; it never renders nothing,
              which is what the previous two separately-gated blocks did whenever the billing call
              did not succeed. */}
          <div className="sidebar__foot">
            <AccountPanel
              state={account}
              used={profiles.length}
              accountLabel={accountLabel}
              menuOpen={accountMenuOpen}
              onToggleMenu={() => setAccountMenuOpen((open) => !open)}
              onSignOut={() => void handleSignOut()}
              onOpenBilling={() => void accountClient.openBilling()}
              onRetry={refreshAccount}
              menuRef={accountMenuRef}
            />
            {/* Buying happens on the website, never in the app: the purchase debits Credit and the
                top-up rail is a hosted payment flow, so the app would only be re-drawing a page it
                cannot complete. Hidden on Max, where there is nothing above to move to — an Upgrade
                button that leads to your own plan is an advert, not a control. */}
            {account.kind === 'ready' && account.summary.tier !== 'max' ? (
              <button
                type="button"
                className="lb-btn lb-btn--primary lb-btn--block sidebar__upgrade"
                onClick={() => void accountClient.openPricing()}
              >
                Upgrade
              </button>
            ) : null}
          </div>
        </aside>

        <main className="main">
          <ActiveView
            active={active}
            createProfileSignal={createProfileSignal}
            onProfileCountChange={handleProfileCountChange}
            onAccountChanged={refreshAccount}
          />
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
        description={`Enter the password for “${quickLaunchProfile?.name ?? 'this profile'}” to launch it in Lobium.`}
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
