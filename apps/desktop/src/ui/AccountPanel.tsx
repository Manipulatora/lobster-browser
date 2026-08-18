import type { ReactNode } from 'react';

import { formatCredit, planLabel, type AccountState } from '../api/account';
import { Icon } from './Icon';

/** Below this fraction of the cap the bar is neutral; above it, it starts warning. */
const WARN_AT = 0.8;
const FULL_AT = 1;

interface AccountPanelProps {
  state: AccountState;
  /** Profiles that exist right now, counted from the list the user is looking at. */
  used: number;
  /** Display name or email; falls back to a generic label when the identity is unknown. */
  accountLabel: string;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onSignOut: () => void;
  onOpenBilling: () => void;
  onRetry: () => void;
  menuRef: React.RefObject<HTMLDivElement>;
}

/**
 * The account footer: plan, profile allowance, Credit, and who is signed in.
 *
 * ONE BLOCK, ALWAYS RENDERED. Previously the plan meter and the Credit chip were separate,
 * each gated on a successfully-fetched summary, and the account row was a third thing with no
 * styling of its own. When the billing call failed — offline, a 401, a slow first start — all of it
 * silently rendered nothing, which is what the user saw and reported as the feature being absent.
 * Every state below renders; none of them is blank.
 *
 * CREDIT LIVES HERE TOO, not only in the topbar. The balance, the plan it pays for and the
 * allowance it buys are one subject, and reading them in one place is the point of the panel.
 */
export function AccountPanel({
  state,
  used,
  accountLabel,
  menuOpen,
  onToggleMenu,
  onSignOut,
  onOpenBilling,
  onRetry,
  menuRef,
}: AccountPanelProps): JSX.Element {
  return (
    <div className="account-panel">
      <div className="account-panel__body">{renderBody(state, used, onOpenBilling, onRetry)}</div>

      <div className="sidebar-account" ref={menuRef}>
        <button
          type="button"
          className="sidebar-account__button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={onToggleMenu}
          title={accountLabel}
        >
          <span className="sidebar-account__name">{accountLabel}</span>
          <Icon name="ChevronUpIcon" aria-hidden />
        </button>
        {menuOpen ? (
          <div className="action-menu sidebar-account__menu" role="menu">
            <button type="button" className="menu-item" role="menuitem" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function renderBody(
  state: AccountState,
  used: number,
  onOpenBilling: () => void,
  onRetry: () => void,
): ReactNode {
  if (state.kind === 'loading') {
    // A skeleton of the same height as the real panel, so the sidebar does not collapse and then
    // jump once the fetch lands.
    return (
      <div className="account-panel__skeleton" aria-hidden>
        <span className="account-panel__skeleton-line" />
        <span className="account-panel__skeleton-bar" />
      </div>
    );
  }

  if (state.kind === 'offline' || state.kind === 'error') {
    const offline = state.kind === 'offline';
    return (
      <div className="account-panel__unavailable">
        <div className="account-panel__row">
          <span className="account-panel__plan">{offline ? 'Offline' : 'Plan unavailable'}</span>
          <button type="button" className="account-panel__link" onClick={onRetry}>
            Retry
          </button>
        </div>
        {/* Says which of the two it is. "Plan unavailable" alone leaves the user unable to tell a
            dropped connection from a billing problem, and those need different responses. */}
        <p className="account-panel__hint">
          {offline ? 'Plan and Credit will appear when you reconnect.' : "Couldn't reach billing."}
        </p>
      </div>
    );
  }

  const { summary } = state;
  const cap = summary.profileLimit;
  // A zero or unknown cap must not render a full bar — that would tell an unlimited or
  // not-yet-known account it is out of room.
  const ratio = cap > 0 ? Math.min(used / cap, 1) : 0;
  const level = ratio >= FULL_AT ? 'full' : ratio >= WARN_AT ? 'warn' : 'ok';
  const atCap = cap > 0 && used >= cap;

  return (
    <>
      <div className="account-panel__row">
        <span className="account-panel__plan">{planLabel(summary.tier)}</span>
        {/* Upgrade is offered only when it would change something: on the top plan it is an advert. */}
        {summary.tier !== 'max' ? (
          <button type="button" className="account-panel__link" onClick={onOpenBilling}>
            {atCap ? 'Get more' : 'Upgrade'}
          </button>
        ) : null}
      </div>

      <div
        className={`account-panel__bar account-panel__bar--${level}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={cap > 0 ? cap : undefined}
        aria-valuenow={used}
        aria-label={`${used} of ${cap} profiles used`}
      >
        <span className="account-panel__fill" style={{ width: `${ratio * 100}%` }} />
      </div>

      <div className="account-panel__row account-panel__row--meta">
        <span className="account-panel__count">
          {used}
          <span className="account-panel__cap">/{cap > 0 ? cap : '—'}</span>
          <span className="account-panel__unit"> profiles</span>
        </span>
      </div>

      {/* Credit, clickable straight through to where it is topped up. */}
      <button type="button" className="account-panel__credit" onClick={onOpenBilling}>
        <Icon name="WalletIcon" className="account-panel__credit-icon" aria-hidden />
        <span className="account-panel__credit-value">{formatCredit(summary.balanceCents)}</span>
        <span className="account-panel__credit-add">Top up</span>
      </button>
    </>
  );
}
