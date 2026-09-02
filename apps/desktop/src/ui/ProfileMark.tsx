import appIcon from '../assets/brand/icon.png';

/** The five states `profile_store` accepts; each one colours the ring in `components.css`. */
export type ProfileMarkStatus = 'idle' | 'launching' | 'running' | 'stopping' | 'error';

/**
 * A profile's row avatar: the live-state ring, and inside it the product icon itself — the raw
 * full-colour shield from `assets/brand/icon.png`, exactly as shipped, not masked and not tinted.
 *
 * This replaced a per-profile tinted square carrying a white lobster silhouette (owner decision):
 * the row shows the PRODUCT, and the ring alone carries the row's meaningful colour. The icon is
 * full-colour art, so no background sits behind it — a tint would fight the artwork's own palette.
 * The per-profile tint rule itself (`profile-mark.ts`) is deliberately untouched: the engine-side
 * window icon still renders from its byte-identical twin in packages/engine-runner, and
 * profile-mark.test.ts fails the build if the two files drift. `assets/brand/lobster-mark.png` is
 * unused now that nothing masks it, but stays on disk for the engine-side lobster work.
 */
export function ProfileMark({
  status,
  statusLabel,
}: {
  status: ProfileMarkStatus;
  statusLabel: string;
}): JSX.Element {
  return (
    <span
      className="lb-tooltip lb-tooltip--right profile-mark"
      data-status={status}
      role="img"
      aria-label={`Status: ${statusLabel}`}
      tabIndex={0}
    >
      <img className="profile-mark__icon" src={appIcon} alt="" aria-hidden />
      <span className="lb-tooltip__bubble" aria-hidden>
        {statusLabel}
      </span>
    </span>
  );
}
