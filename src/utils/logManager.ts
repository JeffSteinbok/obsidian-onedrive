/**
 * Log note management utilities.
 */

export const LIVE_LOG_FOLDER = '_OneDriveSyncLogs';
export const LIVE_LOG_HEADER = `> [!warning] OneDrive sync debug log
> This folder is **excluded from sync** — each device keeps its own. To share a specific day's log, move that file out of this folder.

`;

export interface VaultLogAdapter {
	exists(this: void, path: string): Promise<boolean>;
	mkdir(this: void, path: string): Promise<void>;
	write(this: void, path: string, data: string): Promise<void>;
	append(this: void, path: string, data: string): Promise<void>;
}

export interface ApplyVaultLogHookParams {
	enabled: boolean;
	adapter: VaultLogAdapter;
	setVaultLogHook(this: void, hook: ((line: string) => void) | null): void;
	now?: (this: void) => Date;
}

export function liveLogNotePath(date: Date = new Date()): string {
	const yyyy = date.getFullYear();
	const mm = String(date.getMonth() + 1).padStart(2, '0');
	const dd = String(date.getDate()).padStart(2, '0');
	return `${LIVE_LOG_FOLDER}/${yyyy}-${mm}-${dd}.md`;
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
