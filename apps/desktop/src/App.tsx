import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

import { isDesktopRuntime } from './api/tauri';
import { ProfilesView } from './features/profiles/ProfilesView';

/**
 * Dashboard shell. The sidebar switches between top-level sections; the Profiles section is
 * live (list + fingerprint editor, see src/features/profiles). The remaining sections are
 * scaffolding fleshed out on later days (see docs/MASTER_PLAN.md). In a plain dev browser the
 * UI runs against an in-memory mock (see src/api/tauri.ts); inside Tauri it uses the Rust core.
 */

// Sidebar sections. `key` doubles as the active-view discriminator.
const NAV_ITEMS = [
  { key: 'profiles', label: 'Profiles', icon: '🦞' },
  { key: 'proxies', label: 'Proxies', icon: '🌐' },
  { key: 'automation', label: 'Automation', icon: '🤖' },
  { key: 'team', label: 'Team', icon: '👥' },
  { key: 'settings', label: 'Settings', icon: '⚙️' },
] as const;

type NavKey = (typeof NAV_ITEMS)[number]['key'];

export function App(): JSX.Element {
  const [active, setActive] = useState<NavKey>('profiles');
  const [version, setVersion] = useState<string>(isDesktopRuntime() ? '…' : 'dev');

  useEffect(() => {
    // `app_version` is a Tauri command; it only exists inside the desktop webview.
    if (!isDesktopRuntime()) return;
    invoke<string>('app_version')
      .then(setVersion)
      .catch(() => setVersion('unknown'));
  }, []);

  const activeItem = NAV_ITEMS.find((item) => item.key === active);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">🦞</span>
          <span className="brand-name">Lobster</span>
        </div>
        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={item.key === active ? 'nav-item nav-item--active' : 'nav-item'}
              onClick={() => setActive(item.key)}
            >
              <span className="nav-item__icon" aria-hidden>
                {item.icon}
              </span>
              <span className="nav-item__label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">v{version}</div>
      </aside>

      <main className="main">
        <header className="main-header">
          <h1>{activeItem?.label}</h1>
          <span className="pill">{isDesktopRuntime() ? 'desktop' : 'dev · mock data'}</span>
        </header>

        <section className="content">
          {active === 'profiles' ? (
            <ProfilesView />
          ) : (
            <div className="placeholder-card">
              <h2>{activeItem?.label}</h2>
              <p>
                This section is scaffolding. Its real UI ships on a later day of the plan — see{' '}
                <code>docs/MASTER_PLAN.md</code>.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
