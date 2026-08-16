

import { Button, Modal } from '../../ui';
import { Icon } from '../../ui/Icon';

export const ONBOARD_KEY = 'lobster.onboarded';

/** Persist that the user finished or skipped first-run onboarding. */
export function markOnboarded(): void {
  try {
    window.localStorage.setItem(ONBOARD_KEY, '1');
  } catch {
    /* storage unavailable */
  }
}

export function isOnboarded(): boolean {
  try {
    return window.localStorage.getItem(ONBOARD_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * First-run welcome (UI-5). Shown when the workspace has zero profiles and the user has not
 * completed/skipped onboarding. Explains host calibration and offers a create-profile CTA.
 */
export function OnboardingModal({
  open,
  onSkip,
  onGetStarted,
}: {
  open: boolean;
  onSkip: () => void;
  onGetStarted: () => void;
}): JSX.Element | null {
  return (
    <Modal
      open={open}
      onClose={onSkip}
      size="md"
      title="Welcome to Lobster Browser"
      footer={
        <>
          <Button variant="ghost" onClick={onSkip}>
            Skip
          </Button>
          <Button variant="primary" onClick={onGetStarted}>
            Get started
          </Button>
        </>
      }
    >
      <div className="onboarding-body">
        <div className="onboarding-hero-icon" aria-hidden>
          <Icon name="SparklesIcon" />
        </div>
        <p>
          Lobster Browser builds a coherent browser identity per profile — OS, locale, WebGL, and
          noise surfaces stay consistent so detectors see one real device, not a patchwork.
        </p>
        <ol className="onboarding-steps">
          <li>
            <strong>Host calibration</strong> — Lobium reads your GPU/CPU baseline so renderer
            spoofing stays plausible on this machine.
          </li>
          <li>
            <strong>Create a profile</strong> — pick engine, OS, and optional proxy; a seed derives
            the full fingerprint.
          </li>
          <li>
            <strong>Launch &amp; automate</strong> — open the profile, then use ⋮ → Connection
            details for CDP endpoints when you need Playwright, Puppeteer, or Selenium.
          </li>
        </ol>
      </div>
    </Modal>
  );
}
