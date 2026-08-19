import { profileMark } from './profile-mark';

/** The five states `profile_store` accepts; each one colours the ring in `components.css`. */
export type ProfileMarkStatus = 'idle' | 'launching' | 'running' | 'stopping' | 'error';

/**
 * A profile's row avatar: the live-state ring, and inside it the same rounded violet square with the
 * same initials the launched browser window puts in the taskbar.
 *
 * The square is not decoration — it is how an operator matches a row in this list to one of a dozen
 * identical-looking windows on the taskbar, so both ends derive it from `profileMark` rather than
 * each picking something that looks about right.
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
      <span className="profile-mark__square" style={{ background: mark.tint }} aria-hidden>
        {mark.initials}
      </span>
      <span className="lb-tooltip__bubble" aria-hidden>
        {statusLabel}
      </span>
    </span>
  );
}
