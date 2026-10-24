import { useEffect, useState } from "react";
import { Archive, ChevronRight, CircleAlert, Copy, Eraser, FileDown, Link2, LoaderCircle, Trash2 } from "lucide-react";
import type { BackupTier, ClaudeProfile, CopyTier, DeepLinkRequest, ImportResult, ImportSelection, PortableCleanup, ProfileSizes, SourceContents, StorageItem, StorageItemKind } from "../../shared/contracts";
import { formatStorageSize, message, tierLabels } from "./format";

const tierDescriptions: Record<BackupTier, string> = {
  session: "Login, chats index, Code and Cowork session lists, extensions and settings, plus the Claude Code transcripts of the projects referenced by this profile.",
  full: "Everything in the profile except re-downloadable caches, bundles and logs.",
  settings: "Settings for another machine: no login, no device id, no oauth keys. The Windows-user-bound session cannot travel anyway.",
};

function useProfileSizes(profile: ClaudeProfile | null) {
  const [sizes, setSizes] = useState<ProfileSizes | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSizes(null);
    setError(null);
    if (!profile) return;
    let cancelled = false;
    window.manager
      .profileSizes(profile.id)
      .then((result) => {
        if (!cancelled) setSizes(result);
      })
      .catch((reason) => {
        if (!cancelled) setError(message(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [profile?.id]);
  return { sizes, error };
}

export function BackupTierDialog({
  profile,
  onClose,
  onConfirm,
}: {
  profile: ClaudeProfile | null;
  onClose(): void;
  onConfirm(tier: BackupTier): void;
}) {
  const [tier, setTier] = useState<BackupTier>("session");
  const { sizes, error } = useProfileSizes(profile);
  useEffect(() => setTier("session"), [profile?.id]);
  if (!profile) return null;
  const tierSize = (value: BackupTier) =>
    !sizes ? null : value === "session" ? sizes.sessionBytes : value === "full" ? sizes.fullBytes : sizes.sessionBytes;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal tier-modal" role="dialog" aria-modal="true" aria-labelledby="backup-tier-title">
        <div className="modal-icon"><Archive size={22} /></div>
        <h2 id="backup-tier-title">Back up {profile.name}</h2>
        <p>Claude will be closed before the copy is made. Choose what to include.</p>
        <div className="tier-options">
          {(["session", "full", "settings"] as BackupTier[]).map((value) => (
            <button
              key={value}
              type="button"
              className={`tier-option ${tier === value ? "selected" : ""}`}
              onClick={() => setTier(value)}
            >
              <span className="tier-option-title">
                <strong>{tierLabels[value]}</strong>
                <small>
                  {error ? "Size unavailable" : sizes ? `≈ ${formatStorageSize(tierSize(value))}` : <LoaderCircle className="spin" size={13} />}
                </small>
              </span>
              <span className="tier-option-text">{tierDescriptions[value]}</span>
            </button>
          ))}
        </div>
        <p className="tier-note">
          {tier === "settings"
            ? "The export is listed with the backups and can be imported on another machine without touching that instance's login."
            : "Backups contain an active Claude session. Keep them private."}
        </p>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => onConfirm(tier)}>
            {tier === "settings" ? "Export settings" : "Create backup"}
          </button>
        </div>
      </section>
    </div>
  );
}

export function CleanCachesDialog({
  profile,
  onClose,
  onConfirm,
}: {
  profile: ClaudeProfile | null;
  onClose(): void;
  onConfirm(names: string[]): void;
}) {
  const { sizes, error } = useProfileSizes(profile);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const caches = sizes?.entries.filter((entry) => entry.category === "cache") ?? [];
  useEffect(() => {
    setSelected(new Set(caches.map((entry) => entry.name)));
  }, [sizes]);
  if (!profile) return null;
  const toggle = (name: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const total = caches.filter((entry) => selected.has(entry.name)).reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal tier-modal" role="dialog" aria-modal="true" aria-labelledby="clean-caches-title">
        <div className="modal-icon"><Eraser size={22} /></div>
        <h2 id="clean-caches-title">Clean caches of {profile.name}</h2>
        <p>
          These folders are re-downloaded or rebuilt by Claude on demand. Removing them frees disk space; the first
          start afterwards is slower.
        </p>
        <div className="size-list">
          {error ? (
            <div className="import-source-empty">{error}</div>
          ) : !sizes ? (
            <div className="import-source-empty"><LoaderCircle className="spin" size={15} /> Measuring…</div>
          ) : caches.length === 0 ? (
            <div className="import-source-empty">No cache folders</div>
          ) : (
            caches.map((entry) => (
              <label className="checkbox-row size-row" key={entry.name}>
                <input type="checkbox" checked={selected.has(entry.name)} onChange={() => toggle(entry.name)} />
                <span className="size-row-name">{entry.name}</span>
                <span className="size-row-size">{formatStorageSize(entry.sizeBytes)}</span>
              </label>
            ))
          )}
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="danger" onClick={() => onConfirm([...selected])} disabled={!sizes || selected.size === 0}>
            <Trash2 size={15} />
            Delete {formatStorageSize(total)}
          </button>
        </div>
      </section>
    </div>
  );
}

export type ImportSource = StorageItem & { kind: StorageItemKind };
export type PendingImport = { target: ClaudeProfile; source: ImportSource };

/** Loads what a source would bring and keeps the user's project/Cowork choice. */
function useSourceSelection(load: (() => Promise<SourceContents>) | null, key: string | null) {
  const [contents, setContents] = useState<SourceContents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [cowork, setCowork] = useState(true);
  useEffect(() => {
    setContents(null);
    setError(null);
    setExcluded(new Set());
    setCowork(true);
    if (!load || key === null) return;
    let cancelled = false;
    load()
      .then((result) => {
        if (!cancelled) setContents(result);
      })
      .catch((reason) => {
        if (!cancelled) setError(message(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  const toggleProject = (cwd: string) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  // All projects selected is "no filter": a later Code session of a new project is not dropped.
  const selection: ImportSelection = {
    projects: contents && excluded.size > 0 ? contents.projects.filter((project) => !excluded.has(project.cwd)).map((project) => project.cwd) : null,
    cowork,
  };
  return { contents, error, excluded, toggleProject, cowork, setCowork, selection };
}

export function SourceSelectionPanel({
  contents,
  error,
  excluded,
  onToggleProject,
  cowork,
  onCoworkChange,
}: {
  contents: SourceContents | null;
  error: string | null;
  excluded: Set<string>;
  onToggleProject(cwd: string): void;
  cowork: boolean;
  onCoworkChange(value: boolean): void;
}) {
  if (error) return <div className="import-source-empty">{error}</div>;
  if (!contents) return <div className="import-source-empty"><LoaderCircle className="spin" size={15} /> Reading contents…</div>;
  if (contents.projects.length === 0 && contents.coworkSessions === 0) {
    return <div className="import-source-empty">No Code or Cowork sessions in this source</div>;
  }
  return (
    <div className="size-list selection-list">
      {contents.projects.map((project) => (
        <label className={`checkbox-row size-row ${project.exists ? "" : "missing"}`} key={project.cwd}>
          <input type="checkbox" checked={!excluded.has(project.cwd)} onChange={() => onToggleProject(project.cwd)} />
          <span className="size-row-name">
            <code>{project.cwd}</code>
            {!project.exists && <small>Folder not found on this machine</small>}
          </span>
          <span className="size-row-size">{project.sessions} {project.sessions === 1 ? "session" : "sessions"}</span>
        </label>
      ))}
      {contents.coworkSessions > 0 && (
        <label className="checkbox-row size-row">
          <input type="checkbox" checked={cowork} onChange={(event) => onCoworkChange(event.target.checked)} />
          <span className="size-row-name">Cowork tasks</span>
          <span className="size-row-size">{contents.coworkSessions}</span>
        </label>
      )}
    </div>
  );
}

const copyTierText: Record<CopyTier, { title: string; text: string }> = {
  settings: { title: "Settings only", text: "MCP servers, extensions, preferences and the Code/Cowork session lists. The login of the target stays as it is." },
  session: { title: "Session and login", text: "Everything above plus the login. The copy shares one token with the source: signing out there, or a token refresh, can end it." },
};

export function CloneSessionDialog({
  target,
  sources,
  onClose,
  onConfirm,
}: {
  target: ClaudeProfile | null;
  sources: ClaudeProfile[];
  onClose(): void;
  onConfirm(source: ClaudeProfile, createBackup: boolean, tier: CopyTier, selection: ImportSelection): void;
}) {
  const [source, setSource] = useState<ClaudeProfile | null>(null);
  const [tier, setTier] = useState<CopyTier>("settings");
  const [createBackup, setCreateBackup] = useState(true);
  useEffect(() => {
    setSource(null);
    setTier("settings");
    setCreateBackup(true);
  }, [target?.id]);
  const choice = useSourceSelection(source ? () => window.manager.profileContents(source.id) : null, source?.id ?? null);
  if (!target) return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal import-source-modal" role="dialog" aria-modal="true" aria-labelledby="copy-from-title">
        <div className="modal-icon"><Copy size={22} /></div>
        <h2 id="copy-from-title">{source ? `Copy from ${source.name} into ${target.name}` : `Copy into ${target.name} from…`}</h2>
        {!source ? (
          <>
            <p>Choose the instance to copy from. Both instances are closed while copying.</p>
            <div className="import-source-list">
              {sources.length === 0 ? (
                <div className="import-source-empty">No other instance to copy from</div>
              ) : (
                sources.map((candidate) => (
                  <button className="import-source-item" key={candidate.id} onClick={() => setSource(candidate)}>
                    <Copy size={17} />
                    <span>
                      <strong>{candidate.name}{candidate.isDefault ? " (Primary)" : ""}</strong>
                      <small>{candidate.running ? "Running — will be closed" : "Stopped"}</small>
                    </span>
                    <ChevronRight size={17} />
                  </button>
                ))
              )}
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={onClose}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <div className="tier-options">
              {(["settings", "session"] as CopyTier[]).map((value) => (
                <button key={value} type="button" className={`tier-option ${tier === value ? "selected" : ""}`} onClick={() => setTier(value)}>
                  <span className="tier-option-title"><strong>{copyTierText[value].title}</strong></span>
                  <span className="tier-option-text">{copyTierText[value].text}</span>
                </button>
              ))}
            </div>
            <p className="field-label selection-label">Code projects and Cowork tasks to bring along</p>
            <SourceSelectionPanel
              contents={choice.contents}
              error={choice.error}
              excluded={choice.excluded}
              onToggleProject={choice.toggleProject}
              cowork={choice.cowork}
              onCoworkChange={choice.setCowork}
            />
            <label className="checkbox-row import-skip-backup-option">
              <input type="checkbox" checked={createBackup} onChange={(event) => setCreateBackup(event.target.checked)} />
              <span>Back up the current session of {target.name} first</span>
            </label>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setSource(null)}>Back</button>
              <button className="primary" onClick={() => onConfirm(source, createBackup, tier, choice.selection)} disabled={!choice.contents && !choice.error}>
                Copy
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export function ImportProfileDialog({
  pending,
  skipBackup,
  onSkipBackupChange,
  onClose,
  onConfirm,
}: {
  pending: PendingImport | null;
  skipBackup: boolean;
  onSkipBackupChange(value: boolean): void;
  onClose(): void;
  onConfirm(selection: ImportSelection): void;
}) {
  const choice = useSourceSelection(
    pending ? () => window.manager.storageItemContents(pending.source.kind, pending.source.id) : null,
    pending ? `${pending.source.kind}/${pending.source.id}` : null,
  );
  if (!pending) return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal import-source-modal" role="dialog" aria-modal="true" aria-labelledby="import-profile-title">
        <div className="modal-icon"><FileDown size={22} /></div>
        <h2 id="import-profile-title">Import into {pending.target.name}?</h2>
        <p>
          {tierLabels[pending.source.tier]} of <strong>{pending.source.profileName}</strong> from{" "}
          {new Date(pending.source.createdAt).toLocaleString()}.
          {pending.source.tier === "settings" ? " The login of the target stays as it is." : " All current data of the target is replaced."}
        </p>
        <p className="field-label selection-label">Code projects and Cowork tasks to import</p>
        <SourceSelectionPanel
          contents={choice.contents}
          error={choice.error}
          excluded={choice.excluded}
          onToggleProject={choice.toggleProject}
          cowork={choice.cowork}
          onCoworkChange={choice.setCowork}
        />
        <label className="checkbox-row import-skip-backup-option">
          <input type="checkbox" checked={skipBackup} onChange={(event) => onSkipBackupChange(event.target.checked)} />
          <span>Skip automatic backup</span>
        </label>
        <p className="import-skip-backup-warning import-skip-backup-warning-slot">
          {skipBackup ? `Current data in ${pending.target.name} will be replaced without a backup.` : " "}
        </p>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => onConfirm(choice.selection)} disabled={!choice.contents && !choice.error}>
            Continue
          </button>
        </div>
      </section>
    </div>
  );
}

export function ImportResultDialog({ result, onClose }: { result: ImportResult | null; onClose(): void }) {
  return result && result.missingProjects.length > 0 ? (
    <div className="modal-backdrop" role="presentation">
      <section className="modal tier-modal" role="dialog" aria-modal="true" aria-labelledby="import-result-title">
        <div className="modal-icon"><CircleAlert size={22} /></div>
        <h2 id="import-result-title">Some Code sessions will not open</h2>
        <p>The profile data was imported, but these project folders do not exist on this machine:</p>
        <ul className="missing-projects">
          {result.missingProjects.map((project) => (
            <li key={project.cwd}>
              <code>{project.cwd}</code>
              {project.title && <span>{project.title}</span>}
            </li>
          ))}
        </ul>
        <div className="modal-actions"><button className="primary" onClick={onClose}>Got it</button></div>
      </section>
    </div>
  ) : null;
}

export function DeepLinkPickerDialog({
  request,
  onPick,
  onDismiss,
}: {
  request: DeepLinkRequest | null;
  onPick(profile: ClaudeProfile): void;
  onDismiss(): void;
}) {
  return request ? (
    <div className="modal-backdrop" role="presentation">
      <section className="modal import-source-modal" role="dialog" aria-modal="true" aria-labelledby="deep-link-title">
        <div className="modal-icon"><Link2 size={22} /></div>
        <h2 id="deep-link-title">Open link in…</h2>
        <p className="deep-link-url"><code>{request.url}</code></p>
        <div className="import-source-list">
          {request.candidates.map((profile) => (
            <button className="import-source-item" key={profile.id} onClick={() => onPick(profile)}>
              <i className={`deep-link-mark ${profile.color}`}>{profile.isDefault ? "◈" : "#"}</i>
              <span>
                <strong>{profile.isDefault ? "Claude (Primary)" : profile.name}</strong>
                <small>{profile.running ? "Running" : "Will be launched"}</small>
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onDismiss}>Ignore link</button>
        </div>
      </section>
    </div>
  ) : null;
}

export function PortableCleanupNotice({
  cleanup,
  busy,
  onRemove,
  onDismiss,
}: {
  cleanup: PortableCleanup | null;
  busy: boolean;
  onRemove(): void;
  onDismiss(): void;
}) {
  return cleanup ? (
    <div className="setup">
      <Trash2 size={21} />
      <div>
        <strong>The portable Claude copy is no longer used</strong>
        <p>
          Instances now start from the installed Claude Desktop. Remove the old copy at <code>{cleanup.path}</code>
          {cleanup.sizeBytes !== null && ` (${formatStorageSize(cleanup.sizeBytes)})`}?
        </p>
      </div>
      <div className="setup-actions">
        <button className="secondary" onClick={onDismiss} disabled={busy}>Keep</button>
        <button className="primary" onClick={onRemove} disabled={busy}>Remove copy</button>
      </div>
    </div>
  ) : null;
}
