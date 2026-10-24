import { KeyRound, Play, RotateCcw, Square } from "lucide-react";
import type { ManagerState } from "../../shared/contracts";

/**
 * Full-screen mode while a Sign In relay is active: the manager owns the
 * primary data folder's single-instance window and forwards every browser
 * callback to the selected instance.
 */
export function SignInScreen({
  state,
  busy,
  onOpenInstance,
  onFinish,
}: {
  state: ManagerState;
  busy: boolean;
  onOpenInstance(): void;
  onFinish(): void;
}) {
  const profileName = state.pendingSignInProfileName ?? "selected instance";
  return (
    <section className="content sign-in-content">
      <div className="sign-in-card">
        <div className="sign-in-card-heading">
          <KeyRound size={25} />
          <span>Sign In</span>
        </div>
        <span className="selected-label">SELECTED PROFILE</span>
        <h1>{profileName}</h1>
        <p>
          Use <strong>Sign in</strong> inside the {profileName} window. The browser callback for email,
          code, Google or SSO sign-in is redirected to this instance while this screen is open.
        </p>
        <p className="sign-in-finish-note">
          The primary Claude stays closed until you finish. Other isolated instances keep running and
          nothing is moved on disk. Starting the primary Claude from its own shortcut also ends this mode.
          A sign-in started in any other instance will not complete while this one is active.
        </p>
        <div className="sign-in-actions">
          <button className="primary" onClick={onOpenInstance} disabled={busy}>
            <Play size={17} />
            Open {profileName}
          </button>
          <button className="sign-in-finish" onClick={onFinish} disabled={busy}>
            <RotateCcw size={16} />
            Finish Sign In
          </button>
        </div>
      </div>
    </section>
  );
}

export function SignInSidebarBadge() {
  return (
    <div className="sign-in-sidebar">
      <KeyRound size={18} />
      <span>Sign In in progress</span>
    </div>
  );
}

export function SignInHelpDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  return open ? (
    <div className="modal-backdrop" role="presentation">
      <section className="modal sign-in-help-modal" role="dialog" aria-modal="true" aria-labelledby="sign-in-help-title">
        <div className="modal-icon"><KeyRound size={22} /></div>
        <h2 id="sign-in-help-title">How Sign In works</h2>
        <ol>
          <li>Windows always hands a <code>claude://</code> login callback to the official Claude app, which would open the primary profile.</li>
          <li><strong>Start Sign In</strong> closes the primary Claude and lets the manager take over its single-instance window. The selected instance is started if needed.</li>
          <li>Click <strong>Sign in</strong> inside the selected instance and complete email, code, Google or SSO sign-in in the browser. The callback is forwarded to that instance.</li>
          <li>Click <strong>Finish Sign In</strong>. Nothing is copied or moved: the session was written by the instance itself. Launching the primary Claude also finishes the mode.</li>
        </ol>
        <div className="modal-actions"><button className="primary" onClick={onClose}>Got it</button></div>
      </section>
    </div>
  ) : null;
}

/** Recovery of the former profile-swap Sign In, offered until its state file is gone. */
export function LegacyRecoveryNotice({ busy, onRestore }: { busy: boolean; onRestore(): void }) {
  return (
    <div className="sso-notice">
      <KeyRound size={18} />
      <div>
        <strong>A Sign In from an earlier version is unfinished</strong>
        <span>
          The regular Claude profile is still in its temporary recovery location. Quit every Claude, then restore it.
        </span>
      </div>
      <button className="secondary" onClick={onRestore} disabled={busy}>
        <RotateCcw size={15} />
        Finish & Restore
      </button>
    </div>
  );
}

export function PrimaryRunningDialog({
  profileName,
  onCancel,
  onCloseAndContinue,
}: {
  profileName: string | null;
  onCancel(): void;
  onCloseAndContinue(): void;
}) {
  return profileName ? (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="primary-running-title">
        <div className="modal-icon"><Square size={22} /></div>
        <h2 id="primary-running-title">Close the primary Claude?</h2>
        <p>
          Sign In for <strong>{profileName}</strong> needs the primary Claude closed, because the browser callback is
          addressed to it. It will be asked to close normally first and forced only if it does not respond.
        </p>
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button className="danger" onClick={onCloseAndContinue}>Close and start Sign In</button>
        </div>
      </section>
    </div>
  ) : null;
}
