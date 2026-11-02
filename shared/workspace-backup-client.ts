// Exact app-owned browser state that belongs in an encrypted full backup.
// Never include cookies, authentication tokens, connection caches or unknown keys.
export const WORKSPACE_BACKUP_CLIENT_KEYS = [
  "mausclaw-drafts",
  "mausclaw-draft-attachments",
  "mausclaw-draft-send-ids",
  "mausclaw-draft-channel-modes",
  "mausclaw-skin",
  "mausclaw-show-threads",
  "mausclaw-show-run-card",
  "mausclaw-send-key",
  "mausclaw-color-user-bubbles",
  "mausclaw-chat-width",
  "mausclaw.sidebarDensity",
  "mausclaw.sidebarToolsLayout",
  "mausclaw.sidebarCollapsedSections.v1",
  "mausclaw.sidebarSectionOrder.v1",
  "mausclaw-analytics-opt-out",
  "mausclaw.remote-voice.v1",
] as const;

export type WorkspaceBackupClientState = Partial<Record<(typeof WORKSPACE_BACKUP_CLIENT_KEYS)[number], string>>;
