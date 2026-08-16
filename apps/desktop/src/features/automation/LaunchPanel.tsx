import { useState } from 'react';

import type { LaunchInfo } from '../../api/tauri';
import { Badge, CodeBlock, Modal } from '../../ui';
import { SNIPPETS } from './snippets';
import { Icon } from '../../ui/Icon';

/**
 * Post-launch automation panel (UI-6). Shows the profile's live CDP endpoints and copy-paste
 * connection snippets for Playwright/Puppeteer/Selenium so a user can drive the launched browser.
 */
export function LaunchPanel({
  open,
  onClose,
  profileName,
  info,
}: {
  open: boolean;
  onClose: () => void;
  profileName: string;
  info: LaunchInfo | null;
}): JSX.Element | null {
  const [active, setActive] = useState(SNIPPETS[0]!.id);
  if (!info) return null;
  const snippet = SNIPPETS.find((s) => s.id === active) ?? SNIPPETS[0]!;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Icon name="CheckCircleIcon" style={{ width: 20, height: 20, color: 'var(--green)' }} aria-hidden />
          {profileName} is running
        </span>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Badge tone="success" dot>
              Connected
            </Badge>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)' }}>
              Connect any automation tool to this profile using the endpoints below.
            </span>
          </div>
          <CodeBlock label="CDP WebSocket endpoint" code={info.ws} />
          <CodeBlock label="Selenium debuggerAddress" code={info.debuggerAddress} />
        </div>

        <div>
          <div className="lb-tabs" role="tablist" aria-label="Automation snippet language">
            {SNIPPETS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={s.id === active}
                className={`lb-tab ${s.id === active ? 'lb-tab--active' : ''}`}
                onClick={() => setActive(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 'var(--space-3)' }}>
            <CodeBlock label={`${snippet.label} snippet`} code={snippet.code(info)} />
          </div>
        </div>
      </div>
    </Modal>
  );
}
