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
			const date = new Date('2026-06-04T12:34:56.000Z');

			expect(liveLogNotePath(date)).toBe('_OneDriveSyncLogs/2026-06-04.md');
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
