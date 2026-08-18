import { planLabel } from '../api/account';

interface PlanUsageProps {
  tier: string;
  used: number;
  cap: number;
  onUpgrade: () => void;
}

/** Below this fraction of the cap the bar is neutral; above it, it starts warning. */
const WARN_AT = 0.8;
const FULL_AT = 1;

/**
 * Plan and profile allowance, at the foot of the sidebar.
 *
 * WHY A BAR AND NOT JUST "12/200". The server refuses profile N+1, and the moment of creating one is
 * the worst possible time to discover the cap. A proportion is readable at a glance in a way two
 * numbers are not, and it turns amber before the wall rather than at it.
 *
 * Upgrade is only offered when it would change anything: on the top plan, or with room to spare, it
 * is an advert rather than a control.
 */
export function PlanUsage({ tier, used, cap, onUpgrade }: PlanUsageProps): JSX.Element {
  // A zero or unknown cap must not render a full bar — that would tell an unlimited or
  // not-yet-loaded account it is out of room.
  const ratio = cap > 0 ? Math.min(used / cap, 1) : 0;
  const state = ratio >= FULL_AT ? 'full' : ratio >= WARN_AT ? 'warn' : 'ok';
  const atCap = cap > 0 && used >= cap;

  return (
    <div className="plan-usage">
      <div className="plan-usage__head">
        <span className="plan-usage__plan">{planLabel(tier)}</span>
        {tier !== 'max' ? (
          <button type="button" className="plan-usage__upgrade" onClick={onUpgrade}>
            {atCap ? 'Get more' : 'Upgrade'}
          </button>
        ) : null}
      </div>

      <div
        className={`plan-usage__bar plan-usage__bar--${state}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={cap > 0 ? cap : undefined}
        aria-valuenow={used}
        aria-label={`${used} of ${cap} profiles used`}
      >
        <span className="plan-usage__fill" style={{ width: `${ratio * 100}%` }} />
      </div>

      <div className="plan-usage__meta">
        {/* The count is the fact; "profiles" is the unit. Split so the numbers carry the emphasis
            and the label stays quiet. */}
        <span className="plan-usage__count">
          {used}
          <span className="plan-usage__cap">/{cap > 0 ? cap : '—'}</span>
        </span>
        <span className="plan-usage__unit">profiles</span>
      </div>
    </div>
  );
}
