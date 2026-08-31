import { profileMark } from './profile-mark';

/** The five states `profile_store` accepts; each one colours the ring in `components.css`. */
export type ProfileMarkStatus = 'idle' | 'launching' | 'running' | 'stopping' | 'error';

/**
 * A profile's row avatar: the live-state ring, and inside it a tinted rounded square carrying the
 * lobster silhouette (painted in CSS — `.profile-mark__square::after` masks one shared PNG).
 *
 * The square is not decoration — it is how an operator matches a row in this list to one of a dozen
 * identical-looking windows on the taskbar, so its tint comes from `profileMark`, the same rule the
 * engine renders from. NOTE: the taskbar/engine icon still shows INITIALS until the engine-side
 * lobster change ships, so for now the TINT is the cue that matches the two surfaces — which is why
 * the ramp in profile-mark.ts spreads across eight distinguishable hues rather than four violets.
 */
export function ProfileMark({
  name,
  profileId,
  status,
  statusLabel,
}: {
  name: string;
  profileId: string;
  status: ProfileMarkStatus;
  statusLabel: string;
}): JSX.Element {
  const mark = profileMark(name, profileId);
  return (
    <span
      className="lb-tooltip lb-tooltip--right profile-mark"
      data-status={status}
      role="img"
      aria-label={`Status: ${statusLabel}`}
      tabIndex={0}
    >
      <span className="profile-mark__square" style={{ background: mark.tint }} aria-hidden />
      <span className="lb-tooltip__bubble" aria-hidden>
        {statusLabel}
      </span>
    </span>
  );
}
