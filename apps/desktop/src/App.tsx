import {
  BellIcon,
  CreditCardIcon,
  DocumentDuplicateIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  ServerStackIcon,
  SunIcon,
  UserCircleIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { isDesktopRuntime, profilesClient } from './api/tauri';
import { PricingView } from './features/pricing/PricingView';
import { ProfilesView } from './features/profiles/ProfilesView';
import { ProxiesView } from './features/proxies/ProxiesView';
import { TemplatesView } from './features/templates/TemplatesView';
import lobsterIcon from './assets/brand/lobster-icon.png';
import { CommandPalette, Kbd, useTheme, type Command } from './ui';
import type { Profile } from '@lobster/shared-types';

const NAV_ITEMS = [
  { key: 'profiles', label: 'Profiles', icon: UserGroupIcon },
  { key: 'proxies', label: 'Proxies', icon: ServerStackIcon },
  { key: 'templates', label: 'Templates', icon: DocumentDuplicateIcon },
  { key: 'pricing', label: 'Pricing', icon: CreditCardIcon },
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
    case 'proxies':
      return <ProxiesView />;
    case 'templates':
      return <TemplatesView />;
    case 'pricing':
      return <PricingView />;
  }
}

export function App(): JSX.Element {
  const { theme, toggle } = useTheme();
  const [active, setActive] = useState<NavKey>('profiles');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [createProfileSignal, setCreateProfileSignal] = useState(0);

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
      {
        id: 'action-toggle-theme',
        title: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        group: 'Actions',
        keywords: 'theme dark light',
        run: toggle,
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
        void (async () => {
          try {
            if (p.status === 'running') {
              await profilesClient.stop_profile(p.id);
            } else {
              let password: string | undefined;
              if (p.passwordProtected) {
                const value = window.prompt('Enter this profile password to launch.');
                if (value === null) return;
                password = value;
              }
              await profilesClient.launch_profile(p.id, password);
            }
            const list = await profilesClient.list_profiles();
            setProfiles(list);
          } catch (e: unknown) {
            window.alert(e instanceof Error ? e.message : String(e));
          }
        })();
      },
    }));

    return [...nav, ...actions, ...profileCmds];
  }, [profiles, requestCreateProfile, theme, toggle]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__brand">
          <img className="topbar__logo" src={lobsterIcon} alt="Lobster Browser" />
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
            <Kbd>⌘K</Kbd>
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={toggle}
            title="Toggle theme"
          >
            {theme === 'dark' ? <SunIcon aria-hidden /> : <MoonIcon aria-hidden />}
          </button>
          <button type="button" className="icon-button" aria-label="Notifications">
            <BellIcon aria-hidden />
          </button>
          <button type="button" className="icon-button" aria-label="Profile">
            <UserCircleIcon aria-hidden />
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

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  );
}
