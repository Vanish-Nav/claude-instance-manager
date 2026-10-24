import type { ClaudeProfile, ManagerApi, ManagerState, StorageItem } from "../../shared/contracts";

// Development-only stand-in for the preload bridge so the renderer can be
// opened in a plain browser (`electron-vite dev --rendererOnly`). Never loaded
// in Electron: main.tsx only imports it when `window.manager` is absent.
const profiles: ClaudeProfile[] = [
  { id: "default", name: "Claude", path: "C:\\Users\\me\\AppData\\Roaming\\Claude", isDefault: true, exists: true, running: true, color: "default", desktopShortcut: false, startMenuShortcut: false },
  { id: "instance-CIM-Profile-1", name: "Work", path: "C:\\Users\\me\\AppData\\Local\\ClaudeInstanceManager\\Profiles\\CIM-Profile-1", isDefault: false, exists: true, running: true, color: "green", desktopShortcut: true, startMenuShortcut: true },
  { id: "instance-CIM-Profile-2", name: "Personal", path: "C:\\Users\\me\\AppData\\Local\\ClaudeInstanceManager\\Profiles\\CIM-Profile-2", isDefault: false, exists: true, running: false, color: "amber", desktopShortcut: false, startMenuShortcut: false },
];
const query = new URLSearchParams(window.location.search);
const state: ManagerState = {
  platform: "windows",
  installedVersion: "3.6556.2.0",
  install: { kind: "msix-direct", label: "Claude Desktop (MSIX)", version: "3.6556.2.0", launchTarget: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\Claude_pzs8sxrjxfjjc\\claude-desktop.exe", candidates: query.has("multi") ? 2 : 1 },
  profiles,
  pendingSignIn: query.has("signin"),
  pendingSignInProfileId: query.has("signin") ? "instance-CIM-Profile-2" : null,
  pendingSignInProfileName: query.has("signin") ? "Personal" : null,
  legacySignInRecovery: query.has("legacy"),
  portableCleanup: query.has("portable") ? { path: "C:\\Users\\me\\AppData\\Local\\ClaudeInstanceManager\\Portable", sizeBytes: 548_000_000 } : null,
  deepLinkRouter: { enabled: query.has("router"), active: query.has("router") },
};
const backups: StorageItem[] = [
  { id: "instance-CIM-Profile-1/20261024T120000", profileId: "instance-CIM-Profile-1", profileName: "Work", createdAt: "2026-10-24T12:00:00.000Z", sizeBytes: 42_000_000, tier: "session" },
  { id: "instance-CIM-Profile-1/20261023T090000", profileId: "instance-CIM-Profile-1", profileName: "Work", createdAt: "2026-10-23T09:00:00.000Z", sizeBytes: 1_900_000_000, tier: "full" },
  { id: "default/20261020T080000", profileId: "default", profileName: "Claude", createdAt: "2026-10-20T08:00:00.000Z", sizeBytes: 12_000_000, tier: "settings" },
];
const delay = <T,>(value: T, milliseconds = 250) => new Promise<T>((resolve) => setTimeout(() => resolve(value), milliseconds));
const noop = () => () => {};

const manager: ManagerApi = {
  state: () => delay(state),
  profileRunningStates: () => delay(Object.fromEntries(profiles.map((profile) => [profile.id, profile.running]))),
  createProfile: async (options) => ({ ...profiles[2], id: `instance-${Date.now()}`, name: options.name, color: options.color, running: false }),
  renameProfile: async (id, name) => ({ ...profiles.find((profile) => profile.id === id)!, name }),
  setProfileColor: async (id, color) => ({ ...profiles.find((profile) => profile.id === id)!, color }),
  setProfileShortcuts: async (id, options) => ({ ...profiles.find((profile) => profile.id === id)!, ...options }),
  startProfile: () => delay(undefined),
  stopProfile: () => delay(undefined),
  stopAllClaude: () => delay(undefined),
  onRequestCloseProfile: noop,
  onRequestCloseAll: noop,
  onStateChanged: noop,
  onDeepLinkRequest: (callback) => {
    if (query.has("link")) setTimeout(() => callback({ url: "claude://code/session/abc123", candidates: profiles }), 600);
    return () => {};
  },
  resolveDeepLink: () => delay(undefined),
  backupProfile: () => delay("C:\\Users\\me\\AppData\\Local\\ClaudeInstanceManager\\Backups\\instance-CIM-Profile-1\\20261024T130000", 800),
  profileSizes: () => delay({
    entries: [
      { name: "vm_bundles", sizeBytes: 8_482_325_598, category: "cache" },
      { name: "claude-code", sizeBytes: 590_604_430, category: "cache" },
      { name: "Cache", sizeBytes: 395_924_557, category: "cache" },
      { name: "Code Cache", sizeBytes: 330_958_973, category: "cache" },
      { name: "claude-code-vm", sizeBytes: 292_232_734, category: "cache" },
      { name: "logs", sizeBytes: 49_956_679, category: "cache" },
      { name: "GPUCache", sizeBytes: 5_889_952, category: "cache" },
      { name: "claude-code-sessions", sizeBytes: 7_411_619, category: "session" },
      { name: "local-agent-mode-sessions", sizeBytes: 4_052_362, category: "session" },
      { name: "IndexedDB", sizeBytes: 2_530_237, category: "session" },
      { name: "Partitions", sizeBytes: 1_294_426, category: "data" },
    ],
    projectsBytes: 36_000_000,
    sessionBytes: 52_000_000,
    fullBytes: 70_000_000,
    cacheBytes: 10_147_892_923,
  }, 700),
  cleanCaches: () => delay(undefined, 800),
  cloneSession: () => delay(undefined, 800),
  profileContents: () => delay({ projects: [{ cwd: "D:\\Work\\CXM\\Repos\\backend", title: "Migration", sessions: 12, exists: true }, { cwd: "D:\\Work\\Old\\Repo", title: "Legacy", sessions: 3, exists: false }], coworkSessions: 2 }, 600),
  storageItemContents: () => delay({ projects: [{ cwd: "D:\\Work\\CXM\\Repos\\backend", title: "Migration", sessions: 12, exists: true }], coworkSessions: 0 }, 600),
  archiveProfile: () => delay("C:\\archive"),
  deleteProfile: () => delay(undefined),
  importStorageItem: () => delay({ missingProjects: [{ cwd: "D:\\Work\\Old\\Repo", title: "Migration script" }, { cwd: "E:\\Projects\\gone", title: null }] }, 800),
  beginSignIn: () => delay(undefined, 800),
  finishSignIn: () => delay(undefined, 500),
  restoreSso: () => delay(undefined, 500),
  removePortableRuntime: () => delay(undefined, 800),
  dismissPortableCleanup: () => delay(undefined),
  getManagerSettings: () => delay({ deepLinkRouter: query.has("router") }),
  setDeepLinkRouter: (enabled) => delay({ deepLinkRouter: enabled }),
  openBackups: () => delay(undefined),
  openArchives: () => delay(undefined),
  storageItems: (kind) => delay(kind === "backup" ? backups : []),
  deleteStorageItem: () => delay(undefined),
  getStartupSettings: () => delay({ supported: true, enabled: false }),
  setStartupEnabled: (enabled) => delay({ supported: true, enabled }),
  getAppVersion: () => delay("1.1.0"),
  getSidebarCollapsed: () => delay(false),
  setSidebarCollapsed: () => delay(undefined),
};
window.manager = manager;
