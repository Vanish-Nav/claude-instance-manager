export function formatStorageSize(sizeBytes: number | null) {
  if (sizeBytes === null) return "Size unavailable";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = sizeBytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

export function message(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    : "An unexpected error occurred.";
}

export const tierLabels = {
  session: "Session and chats",
  full: "Full profile",
  settings: "Settings export",
  archive: "Archived profile",
} as const;
