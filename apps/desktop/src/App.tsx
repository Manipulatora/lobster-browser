import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

import type { Profile } from '@lobster/shared-types';

/**
 * Day 0 dashboard shell. This is the structural skeleton only — each section (Profiles grid,
 * Proxy manager, Automation/local-API panel, Team sharing, Settings) is fleshed out on later
 * days (see docs/MASTER_PLAN.md). For now the main pane proves the React <-> Rust bridge works
 * by reading the app version through a Tauri command.
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
  const [version, setVersion] = useState<string>('…');
  // Typed against the shared domain model so the UI never drifts from the wire contract.
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // `app_version` and `list_profiles` are Tauri commands registered in src-tauri/src/lib.rs.
    invoke<string>('app_version')
      .then(setVersion)
      .catch((e: unknown) => setError(String(e)));

    invoke<Profile[]>('list_profiles')
      .then(setProfiles)
      .catch((e: unknown) => setError(String(e)));
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
          <span className="pill">Day 0 · scaffold</span>
        </header>

        <section className="content">
          {error ? (
            <p className="notice notice--error">
              Tauri bridge unavailable: {error}. Run inside <code>npm run tauri dev</code>.
            </p>
          ) : (
            <p className="notice">
              Connected to the Lobster desktop core (v{version}). {profiles.length} profile(s)
              loaded.
            </p>
          )}

          <div className="placeholder-card">
            <h2>{activeItem?.label}</h2>
            <p>
              This section is scaffolding. Its real UI ships on a later day of the plan — see{' '}
              <code>docs/MASTER_PLAN.md</code>.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
