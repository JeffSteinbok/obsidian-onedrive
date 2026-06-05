import path from 'path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
	appendFileSync: vi.fn(),
}));

vi.mock('fs', () => fsMocks);

type LoggerModule = typeof import('../../../src/utils/logger');

let logger: LoggerModule['logger'];
let LogLevel: LoggerModule['LogLevel'];

beforeEach(async () => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.useRealTimers();
	vi.resetModules();

	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	vi.spyOn(console, 'info').mockImplementation(() => undefined);
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	vi.spyOn(console, 'debug').mockImplementation(() => undefined);

	fsMocks.existsSync.mockReturnValue(true);
	fsMocks.mkdirSync.mockReturnValue(undefined);
	fsMocks.writeFileSync.mockReturnValue(undefined);
	fsMocks.appendFileSync.mockReturnValue(undefined);

	const module = await import('../../../src/utils/logger');
	logger = module.logger;
	LogLevel = module.LogLevel;
});

afterEach(() => {
	vi.useRealTimers();
});

describe('logger', () => {
	it('setDebugMode suppresses debug logs when false and enables them when true', () => {
		logger.setDebugMode(false);
		logger.debug('hidden');
		expect(console.debug).not.toHaveBeenCalled();

		logger.setDebugMode(true);
		logger.debug('visible', { enabled: true });
		expect(console.debug).toHaveBeenCalledWith(
			expect.stringContaining('[OneDrive Sync] [DEBUG] visible'),
			{ enabled: true }
		);
	});

	it('info, warn, and error always log', () => {
		logger.setDebugMode(false);

		logger.info('info message');
		logger.warn('warn message');
		logger.error('error message');

		expect(console.info).toHaveBeenCalledWith(
			expect.stringContaining('[OneDrive Sync] [INFO] info message')
		);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining('[OneDrive Sync] [WARN] warn message')
		);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('[OneDrive Sync] [ERROR] error message')
		);
	});

	it('getRecentLogs returns buffered lines, respects limits, and caps at 500 entries', () => {
		for (let i = 0; i < 505; i++) {
			logger.info(`entry ${i}`);
		}

		const allLogs = logger.getRecentLogs();
		expect(allLogs).toHaveLength(500);
		expect(allLogs[0]).toContain('entry 5');
		expect(allLogs[499]).toContain('entry 504');

		const limitedLogs = logger.getRecentLogs(2);
		expect(limitedLogs).toHaveLength(2);
		expect(limitedLogs[0]).toContain('entry 503');
		expect(limitedLogs[1]).toContain('entry 504');
	});

	it('safeLog sanitizes sensitive fields recursively before logging', () => {
		logger.safeLog(LogLevel.INFO, 'Sanitized payload', {
			access_token: 'token',
			refresh_token: 'refresh',
			password: 'hunter2',
			secretValue: 'top-secret',
			authorizationHeader: 'Bearer token',
			nested: {
				password: 'nested-password',
				profile: {
					access_token: 'nested-token',
				},
			},
			safe: 'ok',
		});

		expect(console.info).toHaveBeenCalledWith(
			expect.stringContaining('[OneDrive Sync] [INFO] Sanitized payload'),
			{
				access_token: '[REDACTED]',
				refresh_token: '[REDACTED]',
				password: '[REDACTED]',
				secretValue: '[REDACTED]',
				authorizationHeader: '[REDACTED]',
				nested: {
					password: '[REDACTED]',
					profile: {
						access_token: '[REDACTED]',
					},
				},
				safe: 'ok',
			}
		);

		const recentLog = logger.getRecentLogs(1)[0];
		expect(recentLog).toContain('[REDACTED]');
		expect(recentLog).not.toContain('hunter2');
		expect(recentLog).not.toContain('Bearer token');
	});

	it('formatMessage output includes the timestamp and plugin name', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2024-01-02T03:04:05.000Z'));

		logger.info('formatted message');

		expect(console.info).toHaveBeenCalledWith(
			'[2024-01-02T03:04:05.000Z] [OneDrive Sync] [INFO] formatted message'
		);
	});

	it('setVaultLogHook forwards log lines to the hook and null clears it', () => {
		const hook = vi.fn();
		logger.setVaultLogHook(hook);

		logger.info('first line');
		expect(hook).toHaveBeenCalledTimes(1);
		expect(hook).toHaveBeenCalledWith(expect.stringContaining('[INFO] first line'));

		logger.setVaultLogHook(null);
		logger.info('second line');
		expect(hook).toHaveBeenCalledTimes(1);
	});

	it('enableFileLogging creates the log path and subsequent logs append to the file', () => {
		const vaultPath = 'C:\\vault';
		const logDir = path.join(vaultPath, '.obsidian', 'plugins', 'onedrive-sync');
		const logFilePath = path.join(logDir, 'sync.log');
		fsMocks.existsSync.mockReturnValue(false);

		logger.enableFileLogging(vaultPath);
		logger.info('written to file');

		expect(fsMocks.existsSync).toHaveBeenCalledWith(logDir);
		expect(fsMocks.mkdirSync).toHaveBeenCalledWith(logDir, { recursive: true });
		expect(fsMocks.writeFileSync).toHaveBeenCalledWith(logFilePath, '');
		expect(fsMocks.appendFileSync).toHaveBeenCalledWith(
			logFilePath,
			expect.stringContaining('[INFO] written to file\n')
		);
	});

	it('silently catches file append errors', () => {
		fsMocks.appendFileSync.mockImplementation(() => {
			throw new Error('disk full');
		});

		logger.enableFileLogging('C:\\vault');
		expect(() => logger.info('still logs')).not.toThrow();
		expect(console.error).not.toHaveBeenCalledWith('Failed to enable file logging:', expect.anything());
	});
});
