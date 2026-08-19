import { useMemo, useState } from 'react';

import { parseProxyList } from '@lobster/proxy/parse';
import type { ProxyConfig } from '@lobster/shared-types';

import { Button, Modal } from '../../ui';

const PLACEHOLDER = [
  '1.2.3.4:8080:user:pass',
  'socks5://user:pass@gate.provider.example:1080',
  '5.6.7.8:3128',
].join('\n');

/**
 * Paste a provider's export and get every line of it.
 *
 * Adding proxies one dialog at a time is the whole reason a list of forty arrives as a text file and
 * stays there. Lines are parsed by `@lobster/proxy`, so every format the single-proxy paste accepts
 * is accepted here too, and the ones that cannot be read are named by line number instead of
 * failing the paste.
 */
export function ImportProxiesDialog({
  onImport,
  onClose,
}: {
  /** Returns the lines that could not be stored, paired with the reason. */
  onImport: (configs: ProxyConfig[]) => Promise<Array<{ label: string; error: string }>>;
  onClose: () => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [rejected, setRejected] = useState<Array<{ label: string; error: string }>>([]);

  const parsed = useMemo(() => parseProxyList(text), [text]);
  const configs = parsed.flatMap((line) => (line.ok ? [line.config] : []));
  const unreadable = parsed.flatMap((line) => (line.ok ? [] : [line]));

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (configs.length === 0) return;
    setSubmitting(true);
    setRejected([]);
    try {
      const failures = await onImport(configs);
      if (failures.length === 0) {
        onClose();
        return;
      }
      setRejected(failures);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={submitting ? () => undefined : onClose}
      title="Import proxies"
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="import-proxies-form"
            variant="primary"
            disabled={configs.length === 0 || submitting}
          >
            {submitting ? 'Importing…' : `Import ${configs.length}`}
          </Button>
        </>
      }
    >
      <form
        id="import-proxies-form"
        className="proxy-form-body"
        onSubmit={handleSubmit}
        aria-label="Proxy list"
      >
        <label className="lb-field lb-field--wide">
          <span className="lb-field__label">One proxy per line</span>
          <textarea
            className="lb-input proxy-import-box"
            value={text}
            rows={8}
            spellCheck={false}
            placeholder={PLACEHOLDER}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          <span className="lb-field__hint">
            host:port, host:port:user:pass, or a full URL. Blank lines and # comments are skipped.
          </span>
        </label>

        {parsed.length > 0 ? (
          <p className="notice" role="status">
            {configs.length} ready to import
            {unreadable.length > 0 ? ` · ${unreadable.length} could not be read` : ''}
          </p>
        ) : null}

        {unreadable.length > 0 ? (
          <ul className="proxy-import-errors">
            {unreadable.map((line) => (
              <li key={line.line}>
                <strong>Line {line.line}</strong> {line.raw} — {line.error}
              </li>
            ))}
          </ul>
        ) : null}

        {rejected.length > 0 ? (
          <ul className="proxy-import-errors" role="alert">
            {rejected.map((failure, index) => (
              // Two pasted lines can name the same endpoint, so position is the only identity here.
              <li key={`${failure.label}-${index}`}>
                <strong>{failure.label}</strong> — {failure.error}
              </li>
            ))}
          </ul>
        ) : null}
      </form>
    </Modal>
  );
}
