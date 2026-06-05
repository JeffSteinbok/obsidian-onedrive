/**
 * Log note management utilities.
 */

import { TFile } from 'obsidian';

export const SYNC_LOGS_NOTE_PATH = '.obsidian/plugins/onedrive-sync/OneDrive Sync Logs.md';
export const LIVE_LOG_FOLDER = '_OneDriveSyncLogs';
export const LIVE_LOG_HEADER = `> [!warning] OneDrive sync debug log
> This folder is **excluded from sync** — each device keeps its own. To share a specific day's log, move that file out of this folder.

`;

export interface LogNoteVault {
	adapter: VaultLogAdapter;
	getAbstractFileByPath(path: string): unknown;
	modify(file: TFile, content: string): Promise<void>;
	create(path: string, content: string): Promise<TFile>;
}

export interface LogNoteWorkspace {
	getLeaf(newLeaf: boolean): {
		openFile(file: TFile): Promise<void>;
	};
}

export interface VaultLogAdapter {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	write(path: string, data: string): Promise<void>;
	append(path: string, data: string): Promise<void>;
}

export interface OpenLogsNoteParams {
	vault: LogNoteVault;
	workspace: LogNoteWorkspace;
	getRecentLogs(): string[];
	notify(message: string): void;
	now?: Date;
}

export interface ApplyVaultLogHookParams {
	enabled: boolean;
	adapter: VaultLogAdapter;
	setVaultLogHook(hook: ((line: string) => void) | null): void;
	now?: () => Date;
}

export function liveLogNotePath(date: Date = new Date()): string {
	const yyyy = date.getFullYear();
	const mm = String(date.getMonth() + 1).padStart(2, '0');
	const dd = String(date.getDate()).padStart(2, '0');
	return `${LIVE_LOG_FOLDER}/${yyyy}-${mm}-${dd}.md`;
}

export function buildSyncLogsNoteContent(lines: string[], now: Date = new Date()): string {
	return `# OneDrive Sync Logs

Last updated: ${now.toISOString()}

\`\`\`
${lines.join('\n')}
\`\`\`
`;
}

export async function openLogsNote({
	vault,
	workspace,
	getRecentLogs,
	notify,
	now = new Date(),
}: OpenLogsNoteParams): Promise<void> {
	const lines = getRecentLogs();
	if (lines.length === 0) {
		notify('No sync logs available yet.');
		return;
	}

	const content = buildSyncLogsNoteContent(lines, now);

	let logFile: TFile;
	const existing = vault.getAbstractFileByPath(SYNC_LOGS_NOTE_PATH);
	if (existing instanceof TFile) {
		await vault.modify(existing, content);
		logFile = existing;
	} else if (!existing) {
		logFile = await vault.create(SYNC_LOGS_NOTE_PATH, content);
	} else {
		notify(`Cannot write logs to ${SYNC_LOGS_NOTE_PATH} because that path is a folder.`);
		return;
	}

	await workspace.getLeaf(false).openFile(logFile);
}

export function applyVaultLogHook({
	enabled,
	adapter,
	setVaultLogHook,
	now = () => new Date(),
}: ApplyVaultLogHookParams): void {
	if (!enabled) {
		setVaultLogHook(null);
		return;
	}

	let inFlight: Promise<void> = Promise.resolve();
	setVaultLogHook((line) => {
		inFlight = inFlight.then(async () => {
			try {
				const path = liveLogNotePath(now());
				const exists = await adapter.exists(path);
				if (!exists) {
					const folderExists = await adapter.exists(LIVE_LOG_FOLDER);
					if (!folderExists) {
						await adapter.mkdir(LIVE_LOG_FOLDER);
					}
					await adapter.write(path, LIVE_LOG_HEADER + line + '\n');
				} else {
					await adapter.append(path, line + '\n');
				}
			} catch {
				// Swallow — never let log mirroring break the plugin.
			}
		});
	});
}
