import { invoke } from '@tauri-apps/api/core';
import {
  BellIcon,
  CreditCardIcon,
  DocumentDuplicateIcon,
  ServerStackIcon,
  UserCircleIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline';
import { useEffect, useState } from 'react';

import { isDesktopRuntime } from './api/tauri';
import { PricingView } from './features/pricing/PricingView';
import { ProfilesView } from './features/profiles/ProfilesView';
import { ProxiesView } from './features/proxies/ProxiesView';
import { TemplatesView } from './features/templates/TemplatesView';
import octiumMainIcon from './assets/brand/octium-main-icon.png';

const NAV_ITEMS = [
  { key: 'profiles', label: 'Profiles', icon: UserGroupIcon },
  { key: 'proxies', label: 'Proxies', icon: ServerStackIcon },
  { key: 'templates', label: 'Templates', icon: DocumentDuplicateIcon },
  { key: 'pricing', label: 'Pricing', icon: CreditCardIcon },
] as const;

type NavKey = (typeof NAV_ITEMS)[number]['key'];

function ActiveView({ active }: { active: NavKey }): JSX.Element {
  switch (active) {
    case 'profiles':
      return <ProfilesView />;
    case 'proxies':
      return <ProxiesView />;
    case 'templates':
      return <TemplatesView />;
    case 'pricing':
      return <PricingView />;
  }
}

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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__brand">
          <img className="topbar__logo" src={octiumMainIcon} alt="" aria-hidden />
          <span>Lobster</span>
        </div>
        <div className="topbar__spacer" />
        <div className="topbar__actions">
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
          <div className="account-switcher">
            <img className="account-avatar" src={octiumMainIcon} alt="" aria-hidden />
            <span className="account-name">Lobster</span>
            <span className="account-version">{version}</span>
          </div>
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
          <ActiveView active={active} />
        </main>
      </div>
    </div>
  );
}
