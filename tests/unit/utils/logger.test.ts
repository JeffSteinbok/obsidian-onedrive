import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
			expect.stringContaining('[DBG] visible'),
			{ enabled: true }
		);
	});

	it('setLogLevel respects thresholds and LogLevel.OFF disables all logging', () => {
		logger.setLogLevel(LogLevel.WARN);
		logger.info('hidden info');
		logger.warn('visible warn');
		expect(console.info).not.toHaveBeenCalled();
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining('[WRN] visible warn')
		);

		vi.clearAllMocks();
		logger.setLogLevel(LogLevel.OFF);
		logger.error('hidden error');
		expect(console.error).not.toHaveBeenCalled();
	});

	it('info, warn, and error log when enabled', () => {
		logger.setLogLevel(LogLevel.INFO);

		logger.info('info message');
		logger.warn('warn message');
		logger.error('error message');

		expect(console.info).toHaveBeenCalledWith(
			expect.stringContaining('[INF] info message')
		);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining('[WRN] warn message')
		);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('[ERR] error message')
		);
	});

	it('getRecentLogs returns buffered lines, respects limits, and caps at 500 entries', () => {
		logger.setLogLevel(LogLevel.INFO);

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
		logger.setLogLevel(LogLevel.INFO);

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
			expect.stringContaining('[INF] Sanitized payload'),
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

	it('formatMessage output includes the timestamp and abbreviated level', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2024-01-02T03:04:05.000Z'));
		logger.setLogLevel(LogLevel.INFO);

		logger.info('formatted message');

		expect(console.info).toHaveBeenCalledWith(
			'[2024-01-02T03:04:05.000Z] [INF] formatted message'
		);
	});

	it('setVaultLogHook forwards log lines to the hook and null clears it', () => {
		logger.setLogLevel(LogLevel.INFO);
		const hook = vi.fn();
		logger.setVaultLogHook(hook);

		logger.info('first line');
		expect(hook).toHaveBeenCalledTimes(1);
		expect(hook).toHaveBeenCalledWith(expect.stringContaining('[INF] first line'));

		logger.setVaultLogHook(null);
		logger.info('second line');
		expect(hook).toHaveBeenCalledTimes(1);
	});
});
