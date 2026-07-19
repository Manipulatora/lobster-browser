import {
  DevicePhoneMobileIcon,
  DocumentDuplicateIcon,
  MagnifyingGlassIcon,
  ServerStackIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { isDesktopRuntime, profilesClient } from './api/tauri';
import { MobileMachinesView } from './features/mobile/MobileMachinesView';
import { ProfilesView } from './features/profiles/ProfilesView';
import { ProxiesView } from './features/proxies/ProxiesView';
import { TemplatesView } from './features/templates/TemplatesView';
import siteLogo from './assets/brand/site-logo.png';
import { ActionDialog, CommandPalette, ErrorDialog, Kbd, type Command } from './ui';
import type { Profile } from '@lobster/shared-types';

const NAV_ITEMS = [
  { key: 'profiles', label: 'Profiles', icon: UserGroupIcon },
  { key: 'mobile', label: 'Mobile machines', icon: DevicePhoneMobileIcon },
  { key: 'proxies', label: 'Proxies', icon: ServerStackIcon },
  { key: 'templates', label: 'Templates', icon: DocumentDuplicateIcon },
] as const;

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
    case 'mobile':
      return <MobileMachinesView />;
    case 'proxies':
      return <ProxiesView />;
    case 'templates':
      return <TemplatesView />;
  }
}

export function App(): JSX.Element {
  const [active, setActive] = useState<NavKey>('profiles');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [createProfileSignal, setCreateProfileSignal] = useState(0);
  const [quickLaunchProfile, setQuickLaunchProfile] = useState<Profile | null>(null);
  const [quickLaunchPassword, setQuickLaunchPassword] = useState('');
  const [quickLaunchBusy, setQuickLaunchBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
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
      icon: <item.icon aria-hidden />,
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
            <MagnifyingGlassIcon aria-hidden />
            <Kbd>{isMac ? '⌘K' : 'Ctrl K'}</Kbd>
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar" aria-label="Primary navigation">
          <nav className="nav">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={item.key === active ? 'nav-item nav-item--active' : 'nav-item'}
                  onClick={() => setActive(item.key)}
                  aria-current={item.key === active ? 'page' : undefined}
                  title={item.label}
                >
                  <Icon className="nav-item__icon" aria-hidden />
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
