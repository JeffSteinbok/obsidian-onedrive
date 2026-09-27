import { describe, it, expect } from 'vitest';
import {
	LIVE_LOG_FOLDER,
	LIVE_LOG_HEADER,
	applyVaultLogHook,
	liveLogNotePath,
} from '../../../src/utils/logManager';

describe('logManager', () => {
	describe('liveLogNotePath', () => {
		it('builds the per-day live log path', () => {
			// Local time on purpose: the path is built from local date parts so
			// the log rolls over at the user's midnight, not UTC's.
			const date = new Date(2026, 5, 4, 12, 34, 56);

			expect(liveLogNotePath(date)).toBe('_OneDriveSyncLogs/2026-06-04.md');
		});

		it('names the file by local date, not UTC date', () => {
			// One second past local midnight: a UTC-derived name would report
			// the previous day west of UTC and the next day far east of it.
			const justAfterLocalMidnight = new Date(2026, 5, 5, 0, 0, 1);
			expect(liveLogNotePath(justAfterLocalMidnight)).toBe(
				'_OneDriveSyncLogs/2026-06-05.md'
			);

			// One second before local midnight still belongs to the old day.
			const justBeforeLocalMidnight = new Date(2026, 5, 4, 23, 59, 59);
			expect(liveLogNotePath(justBeforeLocalMidnight)).toBe(
				'_OneDriveSyncLogs/2026-06-04.md'
			);
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
				// Local time, not UTC: liveLogNotePath derives the filename from
				// local date parts, so a UTC instant would name a different day
				// for anyone whose offset pushes it across midnight.
				now: () => new Date(2026, 5, 4, 12, 34, 56),
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

		it('stamps new daily log files before the first mirrored line', async () => {
			const adapter = {
				exists: vi
					.fn()
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
				stamp: '**Plugin version:** `1.5.1`\n**Config:** `{\"accessMode\":\"app-folder\"}`',
				setVaultLogHook,
				// Local time: one second past local midnight. Pinned as a UTC
				// instant this named 2026-06-04 in every timezone behind UTC.
				now: () => new Date(2026, 5, 5, 0, 0, 1),
			});

			const writeHook = setVaultLogHook.mock.calls[0][0] as unknown as (line: string) => void;
			writeHook('first line');
			await flushAsyncWork();

			expect(adapter.write).toHaveBeenCalledWith(
				`${LIVE_LOG_FOLDER}/2026-06-05.md`,
				LIVE_LOG_HEADER +
					'**Plugin version:** `1.5.1`\n' +
					'**Config:** `{"accessMode":"app-folder"}`\n\n' +
					'first line\n'
			);
		});
	});
});
