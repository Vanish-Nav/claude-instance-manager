import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Archive,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Copy,
  Eraser,
  FileDown,
  FolderOpen,
  KeyRound,
  Layers,
  LoaderCircle,
  MonitorUp,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type {
  BackupTier,
  ClaudeInstallKind,
  ClaudeInstallSummary,
  ClaudeProfile,
  CopyTier,
  CreateProfileOptions,
  DeepLinkRequest,
  ImportResult,
  ImportSelection,
  ManagerSettings,
  ManagerState,
  ProfileColor,
  StorageItem,
  StorageItemKind,
  StartupSettings,
} from "../../shared/contracts";
import { formatStorageSize, message, tierLabels } from "./format";
import {
  LegacyRecoveryNotice,
  PrimaryRunningDialog,
  SignInHelpDialog,
  SignInScreen,
  SignInSidebarBadge,
} from "./SignInPanel";
import {
  BackupTierDialog,
  CleanCachesDialog,
  CloneSessionDialog,
  DeepLinkPickerDialog,
  ImportProfileDialog,
  ImportResultDialog,
  PortableCleanupNotice,
  type ImportSource,
  type PendingImport,
} from "./BackupDialogs";

const empty: ManagerState = {
  platform: "windows",
  installedVersion: null,
  install: null,
  profiles: [],
  pendingSignIn: false,
  pendingSignInProfileId: null,
  pendingSignInProfileName: null,
  legacySignInRecovery: false,
  portableCleanup: null,
  deepLinkRouter: { enabled: false, active: false },
};
type Confirmation = {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  dangerous?: boolean;
  completionToast?: Toast | ((result: unknown) => Toast);
  onCancel?(): void;
  task(): Promise<unknown>;
};
type Toast = { message: string; tone: "success" | "danger" };
type MainView = "instances" | "profile" | "backups" | "archives";
const installKindLabels: Record<ClaudeInstallKind, string> = {
  "msix-direct": "MSIX",
  "msix-store": "Microsoft Store",
  squirrel: "classic installer",
};
const profileColorOptions: Array<{ value: ProfileColor; label: string }> = [
  { value: "default", label: "Default" },
  { value: "green", label: "Green" },
  { value: "teal", label: "Teal" },
  { value: "blue", label: "Blue" },
  { value: "indigo", label: "Indigo" },
  { value: "violet", label: "Violet" },
  { value: "rose", label: "Rose" },
  { value: "red", label: "Red" },
  { value: "amber", label: "Amber" },
];
const profileNameError = (value: string): string | null => {
  const name = value.trim();
  if (!name) return "Enter an instance name";
  if (name.length > 20) return "Use 20 characters or fewer";
  if (!/^[A-Za-z0-9 ]+$/.test(name))
    return "Use English letters, digits, and spaces only";
  return null;
};

export default function App() {
  const [state, setState] = useState(empty),
    [selected, setSelected] = useState<string>("default"),
    [view, setView] = useState<MainView>("instances"),
    [busy, setBusy] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [successToast, setSuccessToast] = useState<Toast | null>(null),
    [refreshing, setRefreshing] = useState(true),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null),
    [signInHelpOpen, setSignInHelpOpen] = useState(false),
    [settingsOpen, setSettingsOpen] = useState(false),
    [settingsSection, setSettingsSection] = useState<"general" | "backups" | "archives">(
      "general",
    ),
    [startup, setStartup] = useState<StartupSettings | null>(null),
    [appVersion, setAppVersion] = useState<string | null>(null),
    [startupUpdating, setStartupUpdating] = useState(false),
    [createProfileOpen, setCreateProfileOpen] = useState(false),
    [selectCreatedProfile, setSelectCreatedProfile] = useState(false),
    [createProfileOptions, setCreateProfileOptions] =
      useState<CreateProfileOptions>({
        name: "",
        desktopShortcut: false,
        startMenuShortcut: false,
        color: "default",
      }),
    [renameProfile, setRenameProfile] = useState<ClaudeProfile | null>(null),
    [renameValue, setRenameValue] = useState(""),
    [renameColor, setRenameColor] = useState<ProfileColor>("default"),
    [renameDesktopShortcut, setRenameDesktopShortcut] = useState(false),
    [renameStartMenuShortcut, setRenameStartMenuShortcut] = useState(false),
    [archiveTarget, setArchiveTarget] = useState<ClaudeProfile | null>(null),
    [archivePermanently, setArchivePermanently] = useState(false),
    [storageItems, setStorageItems] = useState<StorageItem[]>([]),
    [storageLoading, setStorageLoading] = useState(false),
    [importTarget, setImportTarget] = useState<ClaudeProfile | null>(null),
    [importSources, setImportSources] = useState<ImportSource[]>([]),
    [importSourcesLoading, setImportSourcesLoading] = useState(false),
    [pendingImport, setPendingImport] = useState<PendingImport | null>(null),
    [skipImportBackup, setSkipImportBackup] = useState(false),
    [importResult, setImportResult] = useState<ImportResult | null>(null),
    [backupTarget, setBackupTarget] = useState<ClaudeProfile | null>(null),
    [cleanTarget, setCleanTarget] = useState<ClaudeProfile | null>(null),
    [cloneTarget, setCloneTarget] = useState<ClaudeProfile | null>(null),
    [primaryRunningFor, setPrimaryRunningFor] = useState<ClaudeProfile | null>(null),
    [deepLinkRequest, setDeepLinkRequest] = useState<DeepLinkRequest | null>(null),
    [managerSettings, setManagerSettings] = useState<ManagerSettings | null>(null),
    [routerUpdating, setRouterUpdating] = useState(false);
  const refresh = async (refreshInstall = false, quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      setState(await window.manager.state(refreshInstall));
    } catch (error) {
      setNotice(message(error));
    } finally {
      if (!quiet) setRefreshing(false);
    }
  };
  const refreshRunningStates = async () => {
    try {
      const runningStates = await window.manager.profileRunningStates();
      setState((current) => ({
        ...current,
        profiles: current.profiles.map((profile) => ({
          ...profile,
          running: runningStates[profile.id] ?? false,
        })),
      }));
    } catch {
      /* Status polling must not disrupt the dashboard. */
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!successToast) return;
    const timer = window.setTimeout(() => setSuccessToast(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [successToast]);
  useEffect(() => {
    const poll = () => void refreshRunningStates();
    const onVisibilityChange = () => {
      if (!document.hidden) poll();
    };
    const timer = window.setInterval(poll, 10_000);
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", poll);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
  // The main process reports changes it noticed itself (tray actions, a Sign
  // In that ended because the primary Claude was started): re-read the whole
  // state without flashing the skeleton.
  useEffect(() => window.manager.onStateChanged(() => void refresh(false, true)), []);
  useEffect(() => window.manager.onDeepLinkRequest((request) => setDeepLinkRequest(request)), []);
  const storageKind =
    view === "backups" ? "backup" : view === "archives" ? "archive" : null;
  const loadStorage = async (kind: StorageItemKind) => {
    setStorageLoading(true);
    try {
      setStorageItems(await window.manager.storageItems(kind));
    } catch (error) {
      setNotice(message(error));
    } finally {
      setStorageLoading(false);
    }
  };
  useEffect(() => {
    if (storageKind) void loadStorage(storageKind);
  }, [storageKind]);
  const openImportSources = async (target: ClaudeProfile) => {
    setImportTarget(target);
    setImportSources([]);
    setImportSourcesLoading(true);
    try {
      const [backups, archives] = await Promise.all([
        window.manager.storageItems("backup"),
        window.manager.storageItems("archive"),
      ]);
      setImportSources(
        [
          ...backups.map((item) => ({ ...item, kind: "backup" as const })),
          ...archives.map((item) => ({ ...item, kind: "archive" as const })),
        ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      );
    } catch (error) {
      setNotice(message(error));
      setImportTarget(null);
    } finally {
      setImportSourcesLoading(false);
    }
  };
  const selectImportSource = (source: ImportSource) => {
    const target = importTarget;
    setImportTarget(null);
    if (!target) return;
    setSkipImportBackup(false);
    setPendingImport({ target, source });
  };
  const confirmImport = (selection: ImportSelection) => {
    const pending = pendingImport;
    const createBackup = !skipImportBackup;
    setPendingImport(null);
    if (!pending) return;
    confirmAction({
      title: `Import ${pending.source.profileName}?`,
      description: createBackup
        ? `${pending.target.name} will be closed and backed up before all profile data, including the Claude session, is imported from this ${pending.source.kind}. The source will remain unchanged.`
        : `${pending.target.name} will be closed and all of its current profile data will be replaced without creating a backup. The source will remain unchanged.`,
      confirmLabel: "Import profile",
      busyLabel: "Importing profile data",
      dangerous: true,
      completionToast: { message: "Profile imported", tone: "success" },
      onCancel: () => setPendingImport(pending),
      task: async () => {
        const result = await window.manager.importStorageItem(pending.target.id, pending.source.kind, pending.source.id, createBackup, selection);
        setImportResult(result);
        return result;
      },
    });
  };
  const profile =
    state.profiles.find((item) => item.id === selected) ?? state.profiles[0];
  const action = async (
    label: string,
    task: () => Promise<unknown>,
    completionToast?: Toast | ((result: unknown) => Toast),
    refreshDashboard = true,
  ) => {
    setBusy(label);
    setNotice(null);
    // Let the busy overlay paint before a main-process operation starts.
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
    );
    try {
      const result = await task();
      if (typeof result === "string")
        setSuccessToast({ message: `Saved to ${result}`, tone: "success" });
      else if (completionToast)
        setSuccessToast(
          typeof completionToast === "function"
            ? completionToast(result)
            : completionToast,
        );
      if (refreshDashboard) await refresh();
      else await refreshRunningStates();
    } catch (error) {
      setSuccessToast({ message: actionFailureMessage(label, error), tone: "danger" });
      // A failure often means the dashboard was stale; show the real state.
      await refresh(false, true);
    } finally {
      setBusy(null);
    }
  };
  const confirmAction = (next: Confirmation) => setConfirmation(next);
  const runConfirmation = () => {
    const current = confirmation;
    setConfirmation(null);
    if (current) void action(current.busyLabel, current.task, current.completionToast);
  };
  const cancelConfirmation = () => {
    const current = confirmation;
    setConfirmation(null);
    current?.onCancel?.();
  };
  const openSettings = async (section: "general" | "backups" = "general") => {
    setSettingsSection(section);
    setSettingsOpen(true);
    setStartup(null);
    setAppVersion(null);
    setManagerSettings(null);
    try {
      const [startupState, version, settings] = await Promise.all([
        window.manager.getStartupSettings(),
        window.manager.getAppVersion(),
        window.manager.getManagerSettings(),
      ]);
      setStartup(startupState);
      setAppVersion(version);
      setManagerSettings(settings);
    } catch (error) {
      setNotice(message(error));
    }
  };
  const toggleDeepLinkRouter = async () => {
    if (!managerSettings) return;
    setRouterUpdating(true);
    try {
      setManagerSettings(await window.manager.setDeepLinkRouter(!managerSettings.deepLinkRouter));
      await refresh();
    } catch (error) {
      setNotice(message(error));
    } finally {
      setRouterUpdating(false);
    }
  };
  const toggleStartup = async () => {
    if (!startup?.supported) return;
    setStartupUpdating(true);
    try {
      setStartup(await window.manager.setStartupEnabled(!startup.enabled));
    } catch (error) {
      setNotice(message(error));
    } finally {
      setStartupUpdating(false);
    }
  };
  const openCreateProfile = (selectAfterCreate = false) => {
    setCreateProfileOptions({
      name: "",
      desktopShortcut: false,
      startMenuShortcut: false,
      color: "default",
    });
    setSelectCreatedProfile(selectAfterCreate);
    setCreateProfileOpen(true);
  };
  const createProfile = () => {
    const options = {
      ...createProfileOptions,
      name: createProfileOptions.name.trim(),
    };
    if (profileNameError(options.name)) return;
    setCreateProfileOpen(false);
    void action(
      "Creating instance",
      async () => {
        const profile = await window.manager.createProfile(options);
        if (selectCreatedProfile) {
          setSelected(profile.id);
          setView("profile");
        }
        return profile;
      },
      (result) => ({
        message: `Instance ${(result as ClaudeProfile).name} created`,
        tone: "success",
      }),
    );
  };
  const openRenameProfile = (nextProfile: ClaudeProfile) => {
    setRenameProfile(nextProfile);
    setRenameValue(nextProfile.name);
    setRenameColor(nextProfile.color);
    setRenameDesktopShortcut(nextProfile.desktopShortcut);
    setRenameStartMenuShortcut(nextProfile.startMenuShortcut);
  };
  const renameSelectedProfile = () => {
    const target = renameProfile;
    const name = renameValue.trim();
    if (!target || profileNameError(name)) return;
    if (
      state.profiles.some(
        (profile) =>
          profile.id !== target.id &&
          profile.name.localeCompare(name, undefined, {
            sensitivity: "accent",
          }) === 0,
      )
    )
      return;
    const nameChanged = target.name !== name;
    const colorChanged = target.color !== renameColor;
    const shortcutsChanged =
      target.desktopShortcut !== renameDesktopShortcut ||
      target.startMenuShortcut !== renameStartMenuShortcut;
    const hasChanges = nameChanged || colorChanged || shortcutsChanged;
    const save = async () => {
      if (nameChanged)
        await window.manager.renameProfile(target.id, name);
      if (colorChanged)
        await window.manager.setProfileColor(target.id, renameColor);
      if (nameChanged || colorChanged || shortcutsChanged)
        await window.manager.setProfileShortcuts(target.id, {
          desktopShortcut: renameDesktopShortcut,
          startMenuShortcut: renameStartMenuShortcut,
        });
    };
    if (hasChanges && target.running) {
      confirmAction({
        title: "Close instance to save changes?",
        description:
          "Claude will be closed before the changes are saved. You can launch it again when you are ready.",
        confirmLabel: "Close and save",
        busyLabel: "Closing instance and saving changes",
        dangerous: true,
        completionToast: { message: "Instance updated", tone: "success" },
        task: async () => {
          setRenameProfile(null);
          await window.manager.stopProfile(target.id);
          await save();
        },
      });
      return;
    }
    setRenameProfile(null);
    void action("Updating instance", save, {
      message: "Instance updated",
      tone: "success",
    });
  };
  const canUse = Boolean(state.install);
  const portableRuntimeRequired = "Install Claude Desktop first";
  const canLaunchProfile = (_candidate: ClaudeProfile) => canUse;
  const runningProfiles = state.profiles.filter((profile) => profile.running);
  const primaryProfile = state.profiles.find((item) => item.isDefault) ?? null;
  const startSignIn = (target: ClaudeProfile, closePrimary: boolean) =>
    void action(
      "Starting Sign In",
      () => window.manager.beginSignIn(target.id, closePrimary),
      { message: `Sign In started for ${target.name}`, tone: "success" },
    );
  const beginSignIn = (target: ClaudeProfile) => {
    if (primaryProfile?.running) {
      setPrimaryRunningFor(target);
      return;
    }
    confirmAction({
      title: `Start Sign In for ${target.name}?`,
      description:
        "The manager takes over the primary Claude's single-instance window so the browser callback of the sign-in reaches this instance. The primary Claude stays closed until you finish.",
      confirmLabel: "Start Sign In",
      busyLabel: "Starting Sign In",
      task: () => window.manager.beginSignIn(target.id, false),
    });
  };
  const finishSignIn = () =>
    confirmAction({
      title: "Finish Sign In?",
      description:
        "The relay stops and the primary Claude can be opened again. Make sure the sign-in inside the instance has completed.",
      confirmLabel: "Finish Sign In",
      busyLabel: "Finishing Sign In",
      completionToast: { message: "Sign In finished", tone: "success" },
      task: () => window.manager.finishSignIn(),
    });
  const confirmBackup = (target: ClaudeProfile, tier: BackupTier) => {
    setBackupTarget(null);
    confirmAction({
      title: tier === "settings" ? `Export settings of ${target.name}?` : `Create ${tierLabels[tier].toLowerCase()} backup for ${target.name}?`,
      description:
        tier === "settings"
          ? "Claude will be closed before the export is created. The export contains no login and no device id."
          : "Claude will be closed before the backup is created. This may take a little while, depending on the size of the profile. Backups include your Claude sign-in session. Keep them private.",
      confirmLabel: tier === "settings" ? "Export settings" : "Create backup",
      busyLabel: tier === "settings" ? "Exporting settings" : "Creating backup",
      completionToast: { message: tier === "settings" ? "Settings exported" : "Backup created", tone: "success" },
      task: () => window.manager.backupProfile(target.id, tier),
    });
  };
  const confirmCleanCaches = (target: ClaudeProfile, names: string[]) => {
    setCleanTarget(null);
    confirmAction({
      title: `Delete ${names.length} cache folder${names.length === 1 ? "" : "s"} of ${target.name}?`,
      description: `${names.join(", ")} will be removed. Claude re-creates them when needed.`,
      confirmLabel: "Delete caches",
      busyLabel: "Cleaning caches",
      dangerous: true,
      completionToast: { message: "Caches cleaned", tone: "success" },
      task: () => window.manager.cleanCaches(target.id, names),
    });
  };
  const confirmClone = (target: ClaudeProfile, source: ClaudeProfile, createBackup: boolean, tier: CopyTier, selection: ImportSelection) => {
    setCloneTarget(null);
    const what = tier === "settings" ? "settings, MCP servers and session lists" : "login, settings and session lists";
    confirmAction({
      title: `Copy ${tier === "settings" ? "settings" : "session"} from ${source.name} into ${target.name}?`,
      description: createBackup
        ? `${source.name} and ${target.name} will be closed. The current session of ${target.name} is backed up, then the ${what} of ${source.name} are copied in.`
        : `${source.name} and ${target.name} will be closed. The ${what} of ${source.name} are copied in without a backup.`,
      confirmLabel: "Copy",
      busyLabel: "Copying",
      dangerous: tier === "session",
      completionToast: { message: `Copied from ${source.name} into ${target.name}`, tone: "success" },
      task: () => window.manager.cloneSession(source.id, target.id, createBackup, tier, selection),
    });
  };
  const confirmCloseProfile = (target: ClaudeProfile) =>
    confirmAction({
      title: `Close ${target.name}?`,
      description: (
        <div className="close-all-description">
          <span>
            <strong>{target.name}</strong>
            {target.isDefault && <span className="close-all-primary-badge">PRIMARY</span>}
            {" will be closed"}
          </span>
          <span>Unsaved work may be lost</span>
        </div>
      ),
      confirmLabel: "Close",
      busyLabel: "Closing Claude",
      dangerous: true,
      completionToast: { message: `${target.name} closed`, tone: "success" },
      task: () => window.manager.stopProfile(target.id),
    });
  const confirmCloseAll = () =>
    confirmAction({
      title: "Close all Claude instances?",
      description: (
        <div className="close-all-description">
          <span>The following will be closed:</span>
          <ul>
            {runningProfiles.map((runningProfile) => (
              <li key={runningProfile.id}>
                <strong>{runningProfile.name}</strong>
                {runningProfile.isDefault && <span className="close-all-primary-badge">PRIMARY</span>}
              </li>
            ))}
          </ul>
          <span>Unsaved work may be lost</span>
        </div>
      ),
      confirmLabel: "Close all",
      busyLabel: "Closing all Claude instances",
      dangerous: true,
      completionToast: {
        message: "All Claude instances closed",
        tone: "success",
      },
      task: () => window.manager.stopAllClaude(),
    });
  const beginArchive = (target: ClaudeProfile) => {
    setArchivePermanently(false);
    setArchiveTarget(target);
  };
  const confirmArchive = () => {
    const target = archiveTarget;
    const permanently = archivePermanently;
    setArchiveTarget(null);
    if (!target) return;
    confirmAction({
      title: permanently ? `Delete ${target.name} permanently?` : `Archive ${target.name}?`,
      description: permanently
        ? "This permanently deletes the profile and all of its local Claude data. It cannot be undone."
        : "Claude will be closed before this profile is moved to Archives. This may take a little while, depending on the size of the profile. You can import it again later.",
      confirmLabel: permanently ? "Delete permanently" : "Archive instance",
      busyLabel: permanently ? "Deleting instance" : "Archiving profile",
      dangerous: true,
      completionToast: {
        message: permanently ? "Instance deleted permanently" : "Instance archived",
        tone: "success",
      },
      onCancel: () => {
        setArchivePermanently(permanently);
        setArchiveTarget(target);
      },
      task: async () => {
        if (permanently) await window.manager.deleteProfile(target.id);
        else await window.manager.archiveProfile(target.id);
        setView("instances");
      },
    });
  };
  useEffect(() => window.manager.onRequestCloseAll(confirmCloseAll), [
    state.profiles,
  ]);
  useEffect(
    () =>
      window.manager.onRequestCloseProfile((id) => {
        const target = state.profiles.find((candidate) => candidate.id === id);
        if (target?.running) confirmCloseProfile(target);
      }),
    [state.profiles],
  );
  if (state.pendingSignIn) {
    const signingInProfileId = state.pendingSignInProfileId;
    return (
      <main className="shell sign-in-mode">
        <aside className="sidebar">
          <div className="brand">
            <img className="brand-app-icon" src="./claude-instance-manager.png" alt="" />
            <span className="brand-text">Claude Manager</span>
          </div>
          <SignInSidebarBadge />
        </aside>
        <SignInScreen
          state={state}
          busy={!!busy}
          onOpenInstance={() => {
            if (signingInProfileId)
              void action("Opening Claude", () => window.manager.startProfile(signingInProfileId), undefined, false);
          }}
          onFinish={finishSignIn}
        />
        <BusyOverlay label={busy} />
        <SuccessToast toast={successToast} onClose={() => setSuccessToast(null)} />
        <ConfirmDialog
          confirmation={confirmation}
          onCancel={cancelConfirmation}
          onConfirm={runConfirmation}
        />
        <TooltipLayer />
      </main>
    );
  }
  return (
    <main
      className={`shell ${view === "profile" ? "profile-view" : "instances-view"}`}
    >
      <aside className="sidebar">
        <div className="section-label">MENU</div>
        <div className={`instances-menu ${view === "instances" ? "active" : ""}`}>
          <button
            className="instances-heading"
            onClick={() => {
              setView("instances");
            }}
          >
            <Layers size={17} />
            <span className="nav-label">Instances</span>
            {refreshing ? (
              <span className="sidebar-count-skeleton" aria-label="Loading instances" />
            ) : (
              <span className="count">{Math.max(0, state.profiles.length - 1)}</span>
            )}
          </button>
          <button
            className="instances-add"
            data-tooltip={!canUse ? portableRuntimeRequired : "New instance"}
            aria-label="New instance"
            onClick={() => openCreateProfile(true)}
            disabled={!canUse || !!busy || refreshing}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="sidebar-profiles">
          {refreshing
            ? Array.from({ length: 3 }, (_, index) => (
                <div className="sidebar-profile-skeleton" key={index}>
                  <i />
                  <span />
                </div>
              ))
            : state.profiles.map((item) => (
            <div
              className={`sidebar-profile ${view === "profile" && item.id === selected ? "selected" : ""}`}
              key={item.id}
            >
              <button
                className="sidebar-profile-select"
                onClick={() => {
                  setSelected(item.id);
                  setView("profile");
                }}
              >
                <span className={`sidebar-profile-mark ${item.color}`}>
                  <span className="sidebar-profile-symbol">
                    {item.isDefault ? "◈" : "#"}
                  </span>
                  <span className="sidebar-profile-initials">
                    {item.isDefault
                      ? "CLA"
                      : item.name.slice(0, 3).toUpperCase()}
                  </span>
                </span>
                <span className="sidebar-profile-name">{item.name}</span>
                {item.isDefault && <span className="sidebar-profile-badge">PRIMARY</span>}
              </button>
              {!item.isDefault && (
                <button
                  className="sidebar-profile-edit"
                  data-tooltip="Edit"
                  aria-label={`Edit ${item.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openRenameProfile(item);
                  }}
                  disabled={!!busy || refreshing}
                >
                  <Pencil size={14} />
                </button>
              )}
              <span
                className={`sidebar-profile-status ${item.running ? "running" : "stopped"}`}
                data-tooltip={item.running ? "Running" : "Stopped"}
                aria-label={item.running ? "Running" : "Stopped"}
              />
              <button
                className="sidebar-profile-run"
                data-tooltip={
                  !item.running && !canLaunchProfile(item)
                    ? portableRuntimeRequired
                    : item.running
                      ? "Open"
                      : "Launch"
                }
                aria-label={`${item.running ? "Open" : "Launch"} ${item.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void action(item.running ? "Opening Claude" : "Launching Claude", () =>
                    window.manager.startProfile(item.id),
                    undefined,
                    false,
                  );
                }}
                disabled={!!busy || refreshing || (!item.running && !canLaunchProfile(item))}
              >
                <Play size={13} fill="currentColor" />
              </button>
              <button
                className="sidebar-profile-stop"
                data-tooltip={item.running ? "Close" : undefined}
                aria-label={`Close ${item.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  confirmCloseProfile(item);
                }}
                disabled={!item.running || !!busy || refreshing}
              >
                <Square size={11} fill="currentColor" />
              </button>
            </div>
          ))}
        </div>
        <div className="sidebar-storage-divider" />
        <button
          className={`nav storage-nav ${view === "backups" ? "active" : ""}`}
          onClick={() => {
            setView("backups");
          }}
          disabled={refreshing}
        >
          <Archive size={16} />
          <span className="nav-label">Backups</span>
        </button>
        <button
          className={`nav storage-nav ${view === "archives" ? "active" : ""}`}
          onClick={() => {
            setView("archives");
          }}
          disabled={refreshing}
        >
          <FolderOpen size={16} />
          <span className="nav-label">Archives</span>
        </button>
        <button className={`sidebar-status ${state.install ? "" : "warn"}`} onClick={() => void openSettings()} disabled={refreshing}>
          <i />
          <span>
            <strong>{state.install ? "Claude Desktop" : "Claude Desktop not found"}</strong>
            <small>
              {state.install
                ? `${state.installedVersion ? `v${state.installedVersion}` : ""} · ${installKindLabels[state.install.kind]}${state.install.candidates > 1 ? ` · ${state.install.candidates} installs` : ""}${state.deepLinkRouter.enabled ? ` · router ${state.deepLinkRouter.active ? "on" : "idle"}` : ""}`
                : "Install and launch it, then re-detect"}
            </small>
          </span>
        </button>
        <div className="sidebar-footer">
          <button
            className="nav settings-nav-trigger"
            onClick={() => void openSettings()}
          >
            <Settings size={16} />
            <span className="nav-label">Settings</span>
          </button>
        </div>
      </aside>
      <section className="content">
        <header>
          <div>
            <h1 className="instances-title">
              {view === "backups" ? (
                <Archive size={26} />
              ) : view === "archives" ? (
                <FolderOpen size={26} />
              ) : (
                <Layers size={26} />
              )}
              {view === "backups"
                ? "Backups"
                : view === "archives"
                  ? "Archives"
                  : "Instances"}
            </h1>
            <p className="subhead">
              {view === "backups"
            ? "Copies of profile data, grouped by instance"
                : view === "archives"
                  ? "Archived profiles kept outside the active instance list"
                  : "Independent local profiles for Claude Desktop"}
            </p>
          </div>
          {view === "instances" && (
            <div className="header-actions">
              <button
                className="secondary"
                data-tooltip="Re-detect the Claude installation and refresh the list"
                onClick={() => void refresh(true)}
                disabled={!!busy || refreshing}
              >
                <RefreshCw className={refreshing ? "spin" : ""} size={16} />
                {refreshing ? "Refreshing" : "Refresh"}
              </button>
            </div>
          )}
        </header>
        {notice && (
          <div className="notice">
            <CircleAlert size={18} />
            <span>{notice}</span>
            <button onClick={() => setNotice(null)}>
              <X size={16} />
            </button>
          </div>
        )}
        {state.legacySignInRecovery && !storageKind && (
          <LegacyRecoveryNotice
            busy={!!busy || refreshing}
            onRestore={() =>
              confirmAction({
                title: "Finish the legacy Sign In and restore the regular profile?",
                description:
                  "Quit every Claude first. The signed-in data returns to the selected instance and the regular Claude profile is moved back to its original location.",
                confirmLabel: "Finish & Restore",
                busyLabel: "Restoring regular profile",
                completionToast: { message: "Regular profile restored", tone: "success" },
                task: () => window.manager.restoreSso(),
              })
            }
          />
        )}
        {storageKind && (
          <div className="storage-sensitive-notice">
            <CircleAlert size={17} />
            <span>
              {storageKind === "backup"
                ? "Sensitive data: backups include full profile data and may contain an active Claude session"
                : "Sensitive data: archives include full profile data and may contain an active Claude session"}
            </span>
          </div>
        )}
        {storageKind ? (
          <StoragePanel
            kind={storageKind}
            items={storageItems}
            loading={storageLoading}
            onDelete={(item) =>
              confirmAction({
                title: `Delete ${storageKind} permanently?`,
                description: `${item.profileName} created ${new Date(item.createdAt).toLocaleString()} will be permanently deleted. This cannot be undone.`,
                confirmLabel: "Delete permanently",
                busyLabel: `Deleting ${storageKind}`,
                dangerous: true,
                completionToast: {
                  message: `${storageKind === "backup" ? "Backup" : "Archive"} deleted permanently`,
                  tone: "success",
                },
                task: async () => {
                  await window.manager.deleteStorageItem(storageKind, item.id);
                  await loadStorage(storageKind);
                },
              })
            }
          />
        ) : refreshing ? (
          <DashboardSkeleton />
        ) : (
          <>
            <>
              {!state.install && (
                <div className="setup">
                  <MonitorUp size={21} />
                  <div>
                    <strong>Claude Desktop is not available</strong>
                    <p>
                      Install the official Claude Desktop app (MSIX, Microsoft Store or the classic installer),
                      launch it once, then refresh this page.
                    </p>
                  </div>
                </div>
              )}
              <PortableCleanupNotice
                cleanup={state.portableCleanup}
                busy={!!busy}
                onRemove={() =>
                  void action(
                    "Removing portable copy",
                    () => window.manager.removePortableRuntime(),
                    { message: "Portable copy removed", tone: "success" },
                  )
                }
                onDismiss={() => void action("Keeping portable copy", () => window.manager.dismissPortableCleanup())}
              />
            </>
            {view === "instances" && (
              <div className="instances-create-row">
                <button
                  className="primary"
                  onClick={() => openCreateProfile()}
                  disabled={!canUse || !!busy}
                >
                  <Plus size={17} />
                  New instance
                </button>
                <button
                  className="secondary"
                  onClick={confirmCloseAll}
                  disabled={!state.profiles.some((item) => item.running) || !!busy || refreshing}
                >
                  <Square size={15} />
                  Close all
                </button>
              </div>
            )}
            <div className="profiles">
              {state.profiles.map((item) => (
                <ProfileCard
                  key={item.id}
                  profile={item}
                  primary={item.isDefault}
                  disabled={!!busy || !canLaunchProfile(item)}
                  disabledTitle={!canLaunchProfile(item) ? portableRuntimeRequired : undefined}
                  onSelect={() => {
                    setSelected(item.id);
                    setView("profile");
                  }}
                  onStart={() =>
                    void action("Starting Claude", () =>
                      window.manager.startProfile(item.id),
                      undefined,
                      false,
                    )
                  }
                  onStop={() => confirmCloseProfile(item)}
                />
              ))}
            </div>
            {view === "profile" && profile && (
              <section className="selected-profile-section">
                <button
                  className="profile-back"
                  onClick={() => setView("instances")}
                >
                  <ArrowLeft size={16} />
                  Instances
                </button>
                <h1 className="profile-page-title">
                  <span className={`profile-page-icon ${profile.color}`}>
                    {profile.isDefault ? "◈" : "#"}
                  </span>
                  <span className="profile-page-title-text">
                    <span className="profile-page-name">{profile.name}</span>
                    {profile.isDefault && <span className="profile-primary-badge">PRIMARY</span>}
                  </span>
                  {!profile.isDefault && (
                    <button
                      className="profile-edit-button"
                      data-tooltip="Edit"
                      aria-label="Edit"
                      onClick={() => openRenameProfile(profile)}
                      disabled={!!busy}
                    >
                      <Pencil size={16} />
                    </button>
                  )}
                </h1>
                <div className="profile-panels">
                  <section className="panel wide">
                    <div className="panel-head">
                      <h3>Instance</h3>
                      <span className={`state ${profile.exists ? (profile.running ? "running" : "stopped") : "missing"}`}>
                        <i />
                        {profile.exists ? (profile.running ? "Running" : "Stopped") : "Folder missing"}
                      </span>
                    </div>
                    <code className="panel-path">{profile.path}</code>
                    <div className="panel-actions">
                      <button
                        className="profile-primary-action"
                        data-tooltip={!profile.running && !canLaunchProfile(profile) ? portableRuntimeRequired : undefined}
                        onClick={() =>
                          void action(profile.running ? "Opening Claude" : "Launching Claude", () =>
                            window.manager.startProfile(profile.id),
                            undefined,
                            false,
                          )
                        }
                        disabled={!!busy || !profile.exists || (!profile.running && !canLaunchProfile(profile))}
                      >
                        <Play size={16} />
                        {profile.running ? "Open" : "Launch"}
                      </button>
                      {profile.running && (
                        <button className="secondary" onClick={() => confirmCloseProfile(profile)} disabled={!!busy}>
                          <Square size={14} />
                          Close
                        </button>
                      )}
                    </div>
                    {!profile.isDefault && (
                      <p className="panel-hint">
                        To keep this instance on the taskbar, pin its running window, or add a Start menu shortcut in Edit and pin that.
                      </p>
                    )}
                  </section>
                  {!profile.isDefault && (
                    <section className="panel">
                      <div className="panel-head">
                        <h3>Account</h3>
                        <button
                          className="sign-in-help-button"
                          data-tooltip="How Sign In works"
                          aria-label="How Sign In works"
                          onClick={() => setSignInHelpOpen(true)}
                        >
                          <CircleHelp size={17} />
                        </button>
                      </div>
                      <p className="panel-text">
                        Always start here: signing in from inside the window without it opens the primary Claude
                        instead. The manager redirects the browser callback to this instance and keeps the primary
                        Claude closed until you finish.
                      </p>
                      <div className="panel-actions">
                        <button
                          className="profile-sign-in-action"
                          data-tooltip={!canUse ? portableRuntimeRequired : state.legacySignInRecovery ? "Finish the legacy Sign In recovery first" : undefined}
                          onClick={() => beginSignIn(profile)}
                          disabled={!!busy || state.pendingSignIn || state.legacySignInRecovery || !canUse}
                        >
                          <KeyRound size={16} />
                          Start Sign In
                        </button>
                      </div>
                    </section>
                  )}
                  <section className={`panel ${profile.isDefault ? "wide" : ""}`}>
                    <div className="panel-head">
                      <h3>Data</h3>
                    </div>
                    <p className="panel-text">
                      {profile.isDefault
                        ? "Back up the primary profile, or export its settings without the login for another machine or instance."
                        : "Backups, imports and copies from another instance. Caches can be cleaned while the instance is closed."}
                    </p>
                    <div className="panel-actions">
                      <button
                        className="secondary"
                        data-tooltip="Back up the session or the whole profile, or export settings"
                        onClick={() => setBackupTarget(profile)}
                        disabled={!!busy || !profile.exists}
                      >
                        <Archive size={16} />
                        Backup
                      </button>
                      {!profile.isDefault && (
                        <>
                          <button
                            className="secondary"
                            data-tooltip="Import a backup, export or archived profile"
                            onClick={() => void openImportSources(profile)}
                            disabled={!!busy || !profile.exists}
                          >
                            <FileDown size={16} />
                            Import
                          </button>
                          <button
                            className="secondary"
                            data-tooltip="Copy settings, or the whole session, from another instance"
                            onClick={() => setCloneTarget(profile)}
                            disabled={!!busy || !profile.exists}
                          >
                            <Copy size={16} />
                            Copy from…
                          </button>
                        </>
                      )}
                      <button
                        className="secondary"
                        data-tooltip={profile.running ? "Close the instance to clean its caches" : "Delete re-downloadable caches"}
                        onClick={() => setCleanTarget(profile)}
                        disabled={!!busy || !profile.exists || profile.running}
                      >
                        <Eraser size={16} />
                        Clean caches
                      </button>
                    </div>
                  </section>
                  {!profile.isDefault && (
                    <section className="panel wide danger-panel">
                      <div className="panel-head">
                        <h3>Archive</h3>
                      </div>
                      <div className="panel-actions panel-actions-row">
                        <p className="panel-text">Move this instance to Archives to import it again later, or delete it for good.</p>
                        <button className="danger" onClick={() => beginArchive(profile)} disabled={!!busy}>
                          <Archive size={16} />
                          Archive instance
                        </button>
                      </div>
                    </section>
                  )}
                </div>
              </section>
            )}
          </>
        )}
      </section>
      <BusyOverlay label={busy} />
      <SuccessToast toast={successToast} onClose={() => setSuccessToast(null)} />
      <ConfirmDialog
        confirmation={confirmation}
        onCancel={cancelConfirmation}
        onConfirm={runConfirmation}
      />
      <ArchiveProfileDialog
        profile={archiveTarget}
        permanently={archivePermanently}
        onPermanentlyChange={setArchivePermanently}
        onClose={() => setArchiveTarget(null)}
        onConfirm={confirmArchive}
      />
      <CreateProfileDialog
        open={createProfileOpen}
        options={createProfileOptions}
        onChange={setCreateProfileOptions}
        onClose={() => setCreateProfileOpen(false)}
        onCreate={createProfile}
      />
      <RenameProfileDialog
        profile={renameProfile}
        value={renameValue}
        duplicate={Boolean(
          renameProfile &&
          state.profiles.some(
            (profile) =>
              profile.id !== renameProfile.id &&
              profile.name.localeCompare(renameValue.trim(), undefined, {
                sensitivity: "accent",
              }) === 0,
          ),
        )}
        onChange={setRenameValue}
        color={renameColor}
        onColorChange={setRenameColor}
        desktopShortcut={renameDesktopShortcut}
        startMenuShortcut={renameStartMenuShortcut}
        onDesktopShortcutChange={setRenameDesktopShortcut}
        onStartMenuShortcutChange={setRenameStartMenuShortcut}
        onClose={() => setRenameProfile(null)}
        onSave={renameSelectedProfile}
      />
      <ImportSourceDialog
        target={importTarget}
        sources={importSources}
        loading={importSourcesLoading}
        onClose={() => setImportTarget(null)}
        onSelect={selectImportSource}
      />
      <ImportProfileDialog
        pending={pendingImport}
        skipBackup={skipImportBackup}
        onSkipBackupChange={setSkipImportBackup}
        onClose={() => setPendingImport(null)}
        onConfirm={confirmImport}
      />
      <SettingsDialog
        open={settingsOpen}
        section={settingsSection}
        startup={startup}
        version={appVersion}
        updating={startupUpdating}
        managerSettings={managerSettings}
        routerUpdating={routerUpdating}
        install={state.install}
        onRedetect={() => {
          setSettingsOpen(false);
          void refresh(true);
        }}
        onClose={() => setSettingsOpen(false)}
        onSectionChange={setSettingsSection}
        onOpenBackups={() =>
          void action("Opening backups", () => window.manager.openBackups())
        }
        onOpenArchives={() =>
          void action("Opening archives", () => window.manager.openArchives())
        }
        onToggle={() => void toggleStartup()}
        onToggleRouter={() => void toggleDeepLinkRouter()}
      />
      <SignInHelpDialog
        open={signInHelpOpen}
        onClose={() => setSignInHelpOpen(false)}
      />
      <PrimaryRunningDialog
        profileName={primaryRunningFor?.name ?? null}
        onCancel={() => setPrimaryRunningFor(null)}
        onCloseAndContinue={() => {
          const target = primaryRunningFor;
          setPrimaryRunningFor(null);
          if (target) startSignIn(target, true);
        }}
      />
      <BackupTierDialog
        profile={backupTarget}
        onClose={() => setBackupTarget(null)}
        onConfirm={(tier) => {
          if (backupTarget) confirmBackup(backupTarget, tier);
        }}
      />
      <CleanCachesDialog
        profile={cleanTarget}
        onClose={() => setCleanTarget(null)}
        onConfirm={(names) => {
          if (cleanTarget) confirmCleanCaches(cleanTarget, names);
        }}
      />
      <CloneSessionDialog
        target={cloneTarget}
        sources={state.profiles.filter((item) => item.id !== cloneTarget?.id && item.exists)}
        onClose={() => setCloneTarget(null)}
        onConfirm={(source, createBackup, tier, selection) => {
          if (cloneTarget) confirmClone(cloneTarget, source, createBackup, tier, selection);
        }}
      />
      <ImportResultDialog result={importResult} onClose={() => setImportResult(null)} />
      <DeepLinkPickerDialog
        request={deepLinkRequest}
        onDismiss={() => {
          const request = deepLinkRequest;
          setDeepLinkRequest(null);
          if (request) void window.manager.resolveDeepLink(request.url, null);
        }}
        onPick={(target) => {
          const request = deepLinkRequest;
          setDeepLinkRequest(null);
          if (request)
            void action(`Opening link in ${target.name}`, () => window.manager.resolveDeepLink(request.url, target.id), undefined, false);
        }}
      />
      <TooltipLayer />
    </main>
  );
}
function StoragePanel({
  kind,
  items,
  loading,
  onDelete,
}: {
  kind: StorageItemKind;
  items: StorageItem[];
  loading: boolean;
  onDelete(item: StorageItem): void;
}) {
  const groups = items.reduce<Record<string, StorageItem[]>>((result, item) => {
    (result[item.profileId] ??= []).push(item);
    return result;
  }, {});
  return (
    <section className="storage-page">
      {loading ? (
        <div className="storage-empty">Loading {kind}s…</div>
      ) : items.length === 0 ? (
        <div className="storage-empty">No {kind}s yet</div>
      ) : (
        Object.entries(groups).map(([profileId, group]) => (
          <section className="storage-group" key={profileId}>
            <div className="storage-group-title">
              <strong>{group[0].profileName}</strong>
              {profileId === "default" && <span className="storage-primary-badge">PRIMARY</span>}
              <span>{profileId}</span>
            </div>
            {group.map((item) => (
              <article className="storage-item" key={item.id}>
                <div>
                  <strong>{new Date(item.createdAt).toLocaleString()}</strong>
                  <span>
                    {tierLabels[item.tier]} · {formatStorageSize(item.sizeBytes)}
                  </span>
                </div>
                <button className="danger" onClick={() => onDelete(item)}>
                  <Trash2 size={15} />
                  Delete permanently
                </button>
              </article>
            ))}
          </section>
        ))
      )}
    </section>
  );
}
function ProfileCard({
  profile,
  primary,
  disabled,
  disabledTitle,
  onSelect,
  onStart,
  onStop,
}: {
  profile: ClaudeProfile;
  primary: boolean;
  disabled: boolean;
  disabledTitle?: string;
  onSelect(): void;
  onStart(): void;
  onStop(): void;
}) {
  return (
    <article
      className={`profile-card ${primary ? "is-primary" : ""}`}
      onClick={onSelect}
    >
      <div className={`profile-icon ${profile.color}`}>
        {profile.isDefault ? "◈" : profile.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="profile-info">
        <div className="profile-title">
          <h3>{profile.name}</h3>
          {profile.isDefault && <span className="badge">PRIMARY</span>}
        </div>
        <p>
          {profile.isDefault
            ? "Official Claude Desktop data"
            : "Isolated Claude Desktop profile"}
        </p>
        <span
          className={`state ${profile.exists ? (profile.running ? "running" : "stopped") : "missing"}`}
        >
          <i />
          {profile.exists
            ? profile.running
              ? "Running"
              : "Stopped"
            : "Folder missing"}
        </span>
      </div>
      <div className="profile-card-actions">
        <button
          className="launch"
          data-tooltip={disabled ? disabledTitle : undefined}
          onClick={(event) => {
            event.stopPropagation();
            onStart();
          }}
          disabled={disabled}
        >
          <Play size={16} />
          {profile.running ? "Open" : "Launch"}
        </button>
        {profile.running && (
          <button
            className="profile-card-stop"
            data-tooltip="Close"
            aria-label="Close"
            onClick={(event) => {
              event.stopPropagation();
              onStop();
            }}
            disabled={disabled}
          >
            <Square size={14} />
          </button>
        )}
      </div>
      <ChevronRight className="chevron" size={19} />
    </article>
  );
}
function BusyOverlay({ label }: { label: string | null }) {
  return label ? (
    <div className="busy">
      <div>
        <LoaderCircle className="spin" size={24} />
        <strong>{label}</strong>
        <span>Please keep this window open</span>
      </div>
    </div>
  ) : null;
}
function TooltipLayer() {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{
    label: string;
    anchorLeft: number;
    left: number;
    top: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current) return;
    const bounds = tooltipRef.current.getBoundingClientRect();
    const left = Math.max(bounds.width / 2 + 8, Math.min(tooltip.anchorLeft, window.innerWidth - bounds.width / 2 - 8));
    const top = tooltip.top;
    if (left !== tooltip.left || top !== tooltip.top) setTooltip({ ...tooltip, left, top });
  }, [tooltip]);

  useEffect(() => {
    const findTrigger = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>("[data-tooltip]") : null;
    const show = (trigger: HTMLElement | null) => {
      const label = trigger?.dataset.tooltip;
      if (!trigger || !label) return;
      const triggerRect = trigger.getBoundingClientRect();
      setTooltip({
        label,
        anchorLeft: triggerRect.left + triggerRect.width / 2,
        left: triggerRect.left + triggerRect.width / 2,
        top: triggerRect.bottom + 8,
      });
    };
    const hide = () => setTooltip(null);
    const onPointerOver = (event: PointerEvent) => show(findTrigger(event.target));
    const onPointerOut = (event: PointerEvent) => {
      const current = findTrigger(event.target);
      const next = findTrigger(event.relatedTarget);
      if (current !== next) hide();
    };
    const onFocusIn = (event: FocusEvent) => show(findTrigger(event.target));
    const onFocusOut = () => hide();

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  return tooltip ? (
    <div ref={tooltipRef} className="app-tooltip" role="tooltip" style={{ left: tooltip.left, top: tooltip.top }}>
      {tooltip.label}
    </div>
  ) : null;
}
function SuccessToast({ toast, onClose }: { toast: Toast | null; onClose(): void }) {
  return toast ? (
    <div className={`success-toast ${toast.tone}`} role="status">
      {toast.tone === "danger" ? <CircleAlert size={18} /> : <CircleCheck size={18} />}
      <span>{toast.message}</span>
      <button onClick={onClose} aria-label="Dismiss notification"><X size={15} /></button>
    </div>
  ) : null;
}
function ConfirmDialog({
  confirmation,
  onCancel,
  onConfirm,
}: {
  confirmation: Confirmation | null;
  onCancel(): void;
  onConfirm(): void;
}) {
  return confirmation ? (
    <div className="modal-backdrop confirm-backdrop" role="presentation">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
      >
        <div className="modal-icon">
          <CircleAlert size={22} />
        </div>
        <h2 id="confirmation-title">{confirmation.title}</h2>
        <div className="confirmation-description">{confirmation.description}</div>
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className={confirmation.dangerous ? "danger" : "primary"}
            onClick={onConfirm}
          >
            {confirmation.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  ) : null;
}
function ArchiveProfileDialog({
  profile,
  permanently,
  onPermanentlyChange,
  onClose,
  onConfirm,
}: {
  profile: ClaudeProfile | null;
  permanently: boolean;
  onPermanentlyChange(value: boolean): void;
  onClose(): void;
  onConfirm(): void;
}) {
  return profile ? (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-profile-title"
      >
        <div className="modal-icon">
          <Archive size={22} />
        </div>
        <h2 id="archive-profile-title">Archive {profile.name}?</h2>
        <p>
          Claude will be closed and this profile will be moved to Archives.
          You can import it again later.
        </p>
        <label className="checkbox-row archive-delete-option">
          <input
            type="checkbox"
            checked={permanently}
            onChange={(event) => onPermanentlyChange(event.target.checked)}
          />
          <span>Delete permanently instead</span>
        </label>
        <p className="archive-delete-warning archive-delete-warning-slot">
          {permanently
            ? "All local Claude data for this profile will be permanently deleted."
            : "\u00A0"}
        </p>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className={permanently ? "danger" : "primary"} onClick={onConfirm}>
            {permanently ? "Delete permanently" : "Archive instance"}
          </button>
        </div>
      </section>
    </div>
  ) : null;
}
function ImportSourceDialog({
  target,
  sources,
  loading,
  onClose,
  onSelect,
}: {
  target: ClaudeProfile | null;
  sources: ImportSource[];
  loading: boolean;
  onClose(): void;
  onSelect(source: ImportSource): void;
}) {
  return target ? (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal import-source-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-source-title"
      >
        <h2 id="import-source-title">Import profile data</h2>
        <p>Choose a backup or archived profile to import into {target.name}</p>
        <div className="import-source-list">
          {loading ? (
            <div className="import-source-empty">Loading sources</div>
          ) : sources.length === 0 ? (
            <div className="import-source-empty">No backups or archives available</div>
          ) : (
            sources.map((source) => (
              <button
                className="import-source-item"
                key={`${source.kind}/${source.id}`}
                onClick={() => onSelect(source)}
              >
                {source.kind === "backup" ? <Archive size={17} /> : <FolderOpen size={17} />}
                <span>
                  <strong>{source.profileName}</strong>
                  <small>
                    {source.kind === "backup" ? "Backup" : "Archive"} · {new Date(source.createdAt).toLocaleString()}
                  </small>
                </span>
                <ChevronRight size={17} />
              </button>
            ))
          )}
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  ) : null;
}
function CreateProfileDialog({
  open,
  options,
  onChange,
  onClose,
  onCreate,
}: {
  open: boolean;
  options: CreateProfileOptions;
  onChange(options: CreateProfileOptions): void;
  onClose(): void;
  onCreate(): void;
}) {
  const nameError = profileNameError(options.name);
  const showNameError = Boolean(options.name) && nameError;
  return open ? (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal create-profile-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-profile-title"
      >
        <h2 id="create-profile-title">Create instance</h2>
        <p>
          Give this isolated Claude profile a name and choose where to add
          shortcuts.
        </p>
        <label className="field-label" htmlFor="profile-name">
          Instance name
        </label>
        <input
          id="profile-name"
          className={`text-field ${showNameError ? "invalid" : ""}`}
          autoFocus
          placeholder="Up to 20 English letters, digits, and spaces"
          value={options.name}
          onChange={(event) =>
            onChange({
              ...options,
              name: event.target.value,
            })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && !nameError) onCreate();
          }}
        />
        <p className="name-validation name-validation-slot">{showNameError ? nameError : "\u00A0"}</p>
        <ProfileColorPicker
          value={options.color}
          onChange={(color) => onChange({ ...options, color })}
        />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={options.desktopShortcut}
            onChange={(event) =>
              onChange({ ...options, desktopShortcut: event.target.checked })
            }
          />
          <span>Shortcut to Desktop</span>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={options.startMenuShortcut}
            onChange={(event) =>
              onChange({ ...options, startMenuShortcut: event.target.checked })
            }
          />
          <span>Shortcut to Start menu</span>
        </label>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={onCreate}
            disabled={Boolean(nameError)}
          >
            Create instance
          </button>
        </div>
      </section>
    </div>
  ) : null;
}
function RenameProfileDialog({
  profile,
  value,
  duplicate,
  onChange,
  color,
  onColorChange,
  desktopShortcut,
  startMenuShortcut,
  onDesktopShortcutChange,
  onStartMenuShortcutChange,
  onClose,
  onSave,
}: {
  profile: ClaudeProfile | null;
  value: string;
  duplicate: boolean;
  onChange(value: string): void;
  color: ProfileColor;
  onColorChange(color: ProfileColor): void;
  desktopShortcut: boolean;
  startMenuShortcut: boolean;
  onDesktopShortcutChange(value: boolean): void;
  onStartMenuShortcutChange(value: boolean): void;
  onClose(): void;
  onSave(): void;
}) {
  const nameError = profileNameError(value);
  const validationMessage = nameError ?? (duplicate ? "An instance with this name already exists." : null);
  return profile ? (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal create-profile-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-profile-title"
      >
        <h2 id="rename-profile-title">Edit instance</h2>
        <p>
          Update the display name or taskbar color. The profile folder remains in place.
        </p>
        <label className="field-label" htmlFor="rename-profile-name">
          Instance name
        </label>
        <input
          id="rename-profile-name"
          className={`text-field ${validationMessage ? "invalid" : ""}`}
          autoFocus
          placeholder="Up to 20 English letters, digits, and spaces"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !validationMessage) onSave();
          }}
        />
        <p className="name-validation name-validation-slot">{validationMessage ?? "\u00A0"}</p>
        <ProfileColorPicker value={color} onChange={onColorChange} />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={desktopShortcut}
            onChange={(event) => onDesktopShortcutChange(event.target.checked)}
          />
          <span>Shortcut to Desktop</span>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={startMenuShortcut}
            onChange={(event) => onStartMenuShortcutChange(event.target.checked)}
          />
          <span>Shortcut to Start menu</span>
        </label>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={onSave}
            disabled={Boolean(validationMessage)}
          >
            Save changes
          </button>
        </div>
      </section>
    </div>
  ) : null;
}
function ProfileColorPicker({
  value,
  onChange,
}: {
  value: ProfileColor;
  onChange(color: ProfileColor): void;
}) {
  return (
    <div className="color-picker">
      <span className="field-label">Color</span>
      <div className="color-options">
        {profileColorOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`color-option ${option.value} ${value === option.value ? "selected" : ""}`}
            onClick={() => onChange(option.value)}
          >
            <i />
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
function SettingsDialog({
  open,
  section,
  startup,
  version,
  updating,
  managerSettings,
  routerUpdating,
  install,
  onClose,
  onSectionChange,
  onOpenBackups,
  onOpenArchives,
  onToggle,
  onToggleRouter,
  onRedetect,
}: {
  open: boolean;
  section: "general" | "backups" | "archives";
  startup: StartupSettings | null;
  version: string | null;
  updating: boolean;
  managerSettings: ManagerSettings | null;
  routerUpdating: boolean;
  install: ClaudeInstallSummary | null;
  onClose(): void;
  onSectionChange(section: "general" | "backups" | "archives"): void;
  onOpenBackups(): void;
  onOpenArchives(): void;
  onToggle(): void;
  onToggleRouter(): void;
  onRedetect(): void;
}) {
  return open ? (
    <div className="modal-backdrop settings-backdrop" role="presentation">
      <section
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <aside className="settings-nav">
          <button
            className={`settings-nav-item ${section === "general" ? "active" : ""}`}
            onClick={() => onSectionChange("general")}
          >
            <Settings size={18} />
            General
          </button>
          <button
            className={`settings-nav-item ${section === "backups" ? "active" : ""}`}
            onClick={() => onSectionChange("backups")}
          >
            <Archive size={18} />
            Backups
          </button>
          <button
            className={`settings-nav-item ${section === "archives" ? "active" : ""}`}
            onClick={() => onSectionChange("archives")}
          >
            <FolderOpen size={18} />
            Archives
          </button>
        </aside>
        <section className="settings-content">
          <button
            className="settings-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            <X size={20} />
          </button>
          {section === "general" ? (
            <>
              <h2 id="settings-title">General</h2>
              <div className="settings-divider" />
              <div className="settings-row">
                <div>
                  <h3>App</h3>
                  <p>Current version: {version ? `v${version}` : "Loading…"}</p>
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-install">
                  <h3>Claude Desktop</h3>
                  {install ? (
                    <>
                      <p>
                        {install.version ? `v${install.version}` : "Unknown version"} · {install.label}
                        {install.candidates > 1 && ` · ${install.candidates} installations found, this one is used`}
                      </p>
                      <code>Launched through {install.launchTarget}</code>
                    </>
                  ) : (
                    <p>Not found. Install Claude Desktop, launch it once, then re-detect.</p>
                  )}
                </div>
                <button className="secondary" onClick={onRedetect}>
                  <RefreshCw size={15} />
                  Re-detect
                </button>
              </div>
              <div className="settings-row">
                <div>
                  <h3>Launch at Login</h3>
                  {startup && !startup.supported && (
                    <p className="setting-disabled-note">
                      Unavailable for portable builds
                    </p>
                  )}
                </div>
                <button
                  className={`switch ${startup?.enabled ? "on" : ""}`}
                  data-tooltip={startup?.reason}
                  aria-label="Launch at Login"
                  aria-pressed={startup?.enabled}
                  onClick={onToggle}
                  disabled={!startup?.supported || updating}
                >
                  <i />
                </button>
              </div>
              <div className="settings-row">
                <div>
                  <h3>Deep-link router (experimental)</h3>
                  <p>
                    While the primary Claude is closed, <code>claude://</code> links open in the instance you used last,
                    or you are asked which one. Works only while the manager runs.
                  </p>
                  {managerSettings?.deepLinkRouter && !startup?.enabled && (
                    <p className="setting-disabled-note">Launch at Login is off: the router only works while the manager runs.</p>
                  )}
                </div>
                <button
                  className={`switch ${managerSettings?.deepLinkRouter ? "on" : ""}`}
                  aria-label="Deep-link router"
                  aria-pressed={managerSettings?.deepLinkRouter ?? false}
                  onClick={onToggleRouter}
                  disabled={!managerSettings || routerUpdating}
                >
                  <i />
                </button>
              </div>
            </>
          ) : section === "backups" ? (
            <>
              <h2 id="settings-title">Backups</h2>
              <div className="settings-divider" />
              <div className="settings-row">
                <div>
                  <h3>Profile backups</h3>
                  <p>
                    Open the folder containing profile backups and settings exports. Session and full backups
                    contain an active login; settings exports do not.
                  </p>
                </div>
                <button className="secondary" onClick={onOpenBackups}>
                  <FolderOpen size={16} />
                  Open folder
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 id="settings-title">Archives</h2>
              <div className="settings-divider" />
              <div className="settings-row">
                <div>
                  <h3>Archived instances</h3>
                  <p>Open the folder containing archived profile data.</p>
                </div>
                <button className="secondary" onClick={onOpenArchives}>
                  <FolderOpen size={16} />
                  Open folder
                </button>
              </div>
            </>
          )}
        </section>
      </section>
    </div>
  ) : null;
}
function DashboardSkeleton() {
  return (
    <div className="dashboard-skeleton" aria-label="Refreshing dashboard">
      <div className="skeleton setup-skeleton" />
      <div className="skeleton overview-skeleton" />
      <div className="skeleton title-skeleton" />
      <div className="skeleton card-skeleton" />
      <div className="skeleton card-skeleton" />
    </div>
  );
}
function actionFailureMessage(label: string, error: unknown) {
  const detail = message(error);
  if (/\bEBUSY\b|\bEPERM\b|resource busy|locked/i.test(detail))
    return `${label} failed: Claude files are still in use. Close the instance and try again. (${detail})`;
  return `${label} failed: ${detail}`;
}
