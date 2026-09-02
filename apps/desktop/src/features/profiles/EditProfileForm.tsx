import { lazy, Suspense } from 'react';

import type {
  CreateStoredProxyInput,
  Profile,
  ProfileOsTarget,
  ProfileTemplate,
  ProxyConfig,
  ProxyTestResult,
  StoredProxy,
} from '@lobster/shared-types';

import type { ProfilePatch } from '../../api/tauri';

const UnifiedProfileEditor = lazy(() =>
  import('./NewProfileForm').then((module) => ({ default: module.NewProfileForm })),
);

interface EditProfileFormProps {
  profile: Profile;
  saving: boolean;
  onSave: (patch: ProfilePatch, options?: { password?: string | null }) => Promise<void>;
  onCancel: () => void;
  onCreateProxy?: (input: CreateStoredProxyInput) => Promise<StoredProxy>;
  onTestProxy?: (config: ProxyConfig) => Promise<ProxyTestResult>;
  proxies?: StoredProxy[];
  templates?: ProfileTemplate[];
  /** Existing folder names, forwarded to the editor's Folder-field suggestions. */
  folders?: string[];
  loadFontFamilies?: (os: ProfileOsTarget) => Promise<string[]>;
}

/** Edit mode intentionally renders the same draft-backed, tabbed editor as create mode. */
export function EditProfileForm({
  profile,
  saving: _saving,
  onSave,
  onCancel,
  onCreateProxy,
  onTestProxy,
  proxies,
  templates,
  folders,
  loadFontFamilies,
}: EditProfileFormProps): JSX.Element {
  return (
    <Suspense fallback={<p className="notice">Loading profile settings…</p>}>
      <UnifiedProfileEditor
        profile={profile}
        onSave={onSave}
        onCancel={onCancel}
        onCreateProxy={onCreateProxy}
        onTestProxy={onTestProxy}
        proxies={proxies}
        templates={templates}
        folders={folders}
        loadFontFamilies={loadFontFamilies}
      />
    </Suspense>
  );
}
