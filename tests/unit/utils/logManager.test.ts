/**
 * Unit tests for log manager utilities
 */

import { TFile } from 'obsidian';
import { describe, it, expect, vi } from 'vitest';
import {
	LIVE_LOG_FOLDER,
	LIVE_LOG_HEADER,
	getSyncLogsNotePath,
	applyVaultLogHook,
	buildSyncLogsNoteContent,
	liveLogNotePath,
	openLogsNote,
} from '../../../src/utils/logManager';

describe('logManager', () => {
	describe('liveLogNotePath', () => {
		it('builds the per-day live log path', () => {
			const date = new Date('2026-06-04T12:34:56.000Z');

			expect(liveLogNotePath(date)).toBe('_OneDriveSyncLogs/2026-06-04.md');
		});
	});

	describe('buildSyncLogsNoteContent', () => {
		it('formats recent logs as a fenced code block', () => {
			const date = new Date('2026-06-04T12:34:56.000Z');
			const content = buildSyncLogsNoteContent(['line one', 'line two'], date);

			expect(content).toBe(`# OneDrive Sync Logs

Last updated: 2026-06-04T12:34:56.000Z

\`\`\`
line one
line two
\`\`\`
`);
		});
	});

	describe('openLogsNote', () => {
		it('notifies when there are no logs to show', async () => {
			const notify = vi.fn();
			const vault = {
				adapter: {} as any,
				getAbstractFileByPath: vi.fn(),
				modify: vi.fn(),
				create: vi.fn(),
			};
			const workspace = {
				getLeaf: vi.fn(),
			};

			await openLogsNote({
				vault,
				workspace,
				getRecentLogs: () => [],
				notify,
				configDir: '.obsidian',
			});

			expect(notify).toHaveBeenCalledWith('No sync logs available yet.');
			expect(vault.create).not.toHaveBeenCalled();
		});

		it('creates a new logs note and opens it', async () => {
			const createdFile = new TFile();
			createdFile.path = getSyncLogsNotePath('.obsidian');
			const openFile = vi.fn().mockResolvedValue(undefined);
			const vault = {
				adapter: {
					exists: vi.fn().mockResolvedValue(true),
					mkdir: vi.fn().mockResolvedValue(undefined),
				} as any,
				getAbstractFileByPath: vi.fn().mockReturnValue(null),
				modify: vi.fn(),
				create: vi.fn().mockResolvedValue(createdFile),
			};
			const workspace = {
				getLeaf: vi.fn().mockReturnValue({ openFile }),
			};

			await openLogsNote({
				vault,
				workspace,
				getRecentLogs: () => ['[line]'],
				notify: vi.fn(),
				now: new Date('2026-06-04T12:34:56.000Z'),
				configDir: '.obsidian',
			});

			expect(vault.create).toHaveBeenCalledWith(
				getSyncLogsNotePath('.obsidian'),
				`# OneDrive Sync Logs

Last updated: 2026-06-04T12:34:56.000Z

\`\`\`
[line]
\`\`\`
`
			);
			expect(openFile).toHaveBeenCalledWith(createdFile);
		});

		it('updates an existing logs note', async () => {
			const existingFile = new TFile();
			existingFile.path = getSyncLogsNotePath('.obsidian');
			const openFile = vi.fn().mockResolvedValue(undefined);
			const vault = {
				adapter: {} as any,
				getAbstractFileByPath: vi.fn().mockReturnValue(existingFile),
				modify: vi.fn().mockResolvedValue(undefined),
				create: vi.fn(),
			};
			const workspace = {
				getLeaf: vi.fn().mockReturnValue({ openFile }),
			};

			await openLogsNote({
				vault,
				workspace,
				getRecentLogs: () => ['[line]'],
				notify: vi.fn(),
				now: new Date('2026-06-04T12:34:56.000Z'),
				configDir: '.obsidian',
			});

			expect(vault.modify).toHaveBeenCalledWith(
				existingFile,
				expect.stringContaining('[line]')
			);
			expect(vault.create).not.toHaveBeenCalled();
			expect(openFile).toHaveBeenCalledWith(existingFile);
		});

		it('notifies when the target path is a folder', async () => {
			const notify = vi.fn();
			const vault = {
				adapter: {} as any,
				getAbstractFileByPath: vi.fn().mockReturnValue({ path: getSyncLogsNotePath('.obsidian') }),
				modify: vi.fn(),
				create: vi.fn(),
			};
			const workspace = {
				getLeaf: vi.fn(),
			};

			await openLogsNote({
				vault,
				workspace,
				getRecentLogs: () => ['[line]'],
				notify,
				configDir: '.obsidian',
			});

			expect(notify).toHaveBeenCalledWith(
				`Cannot write logs to ${getSyncLogsNotePath('.obsidian')} because that path is a folder.`
			);
			expect(vault.modify).not.toHaveBeenCalled();
			expect(vault.create).not.toHaveBeenCalled();
		});
	});

	describe('applyVaultLogHook', () => {
		it('clears the logger hook when debug logging is disabled', () => {
			const setVaultLogHook = vi.fn();

			applyVaultLogHook({
				enabled: false,
				adapter: {} as any,
				setVaultLogHook,
			});

			expect(setVaultLogHook).toHaveBeenCalledWith(null);
		});

		it('creates the live log file on first write and appends thereafter', async () => {
			const adapter = {
				exists: vi
					.fn()
					.mockResolvedValueOnce(false)
					.mockResolvedValueOnce(false)
					.mockResolvedValueOnce(true),
				mkdir: vi.fn().mockResolvedValue(undefined),
				write: vi.fn().mockResolvedValue(undefined),
				append: vi.fn().mockResolvedValue(undefined),
			};
			const setVaultLogHook = vi.fn();
			const flushAsyncWork = async () => {
				for (let i = 0; i < 10; i++) {
					await Promise.resolve();
				}
			};

			applyVaultLogHook({
				enabled: true,
				adapter,
				setVaultLogHook,
				now: () => new Date('2026-06-04T12:34:56.000Z'),
			});

			expect(setVaultLogHook).toHaveBeenCalledTimes(1);
			const writeHook = setVaultLogHook.mock.calls[0][0] as unknown as (line: string) => void;

			writeHook('first line');
			await flushAsyncWork();
			expect(adapter.write).toHaveBeenCalledWith(
				`${LIVE_LOG_FOLDER}/2026-06-04.md`,
				LIVE_LOG_HEADER + 'first line\n'
			);
			expect(adapter.mkdir).toHaveBeenCalledWith(LIVE_LOG_FOLDER);

			writeHook('second line');
			await flushAsyncWork();
			expect(adapter.append).toHaveBeenCalledWith(
				`${LIVE_LOG_FOLDER}/2026-06-04.md`,
				'second line\n'
			);
		});
	});
});
