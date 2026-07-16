/**
 * Structured logging utility
 * Respects debug mode settings and provides consistent log formatting
 *
 * This file is the console abstraction layer — all other code must use
 * logger.* instead of console.* directly.
 */

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
	OFF = 4,
}

class Logger {
	private minLevel = LogLevel.OFF;
	private recentLogs: string[] = [];
	private vaultLogHook: ((line: string) => void) | null = null;
	private static readonly MAX_RECENT_LOGS = 500;

	setLogLevel(level: LogLevel) {
		this.minLevel = level;
	}

	/** @deprecated Use setLogLevel instead */
	setDebugMode(enabled: boolean) {
		this.minLevel = enabled ? LogLevel.DEBUG : LogLevel.INFO;
	}

	/**
	 * Register (or clear) a sink that receives every formatted log line.
	 * Used by the plugin to mirror logs into a vault-root note for in-app /
	 * mobile inspection. Pass null to detach.
	 */
	setVaultLogHook(hook: ((line: string) => void) | null): void {
		this.vaultLogHook = hook;
	}

	private shouldLog(level: LogLevel): boolean {
		return level >= this.minLevel;
	}

	private static readonly LEVEL_ABBREV: Record<string, string> = {
		DEBUG: 'DBG',
		INFO: 'INF',
		WARN: 'WRN',
		ERROR: 'ERR',
	};

	private formatMessage(level: string, message: string, ..._args: unknown[]): string {
		const timestamp = new Date().toISOString();
		const abbrev = Logger.LEVEL_ABBREV[level] ?? level;
		return `[${timestamp}] [${abbrev}] ${message}`;
	}

	private formatExtraArgs(args: unknown[]): string {
		if (args.length === 0) return '';
		return ' ' + args.map(a => {
			if (a instanceof Error) {
				const obj: Record<string, unknown> = {};
				// Merge any enumerable own properties (e.g. code, statusCode on OneDriveError) first,
				// then overwrite with the non-enumerable Error properties so they always take precedence.
				Object.assign(obj, a);
				obj.name = a.name;
				obj.message = a.message;
				if (a.stack) obj.stack = a.stack;
				try { return JSON.stringify(obj); }
				catch { return String(a); }
			}
			try { return typeof a === 'string' ? a : JSON.stringify(a); }
			catch { return String(a); }
		}).join(' ');
	}

	private addToBuffer(line: string): void {
		this.recentLogs.push(line);
		if (this.recentLogs.length > Logger.MAX_RECENT_LOGS) {
			this.recentLogs.shift();
		}
		if (this.vaultLogHook) {
			try {
				this.vaultLogHook(line);
			} catch {
				// Never let a sink failure break logging
			}
		}
	}

	private getConsoleMethod(level: LogLevel): ((message: string, ...args: unknown[]) => void) | null {
		if (typeof window === 'undefined') {
			return null;
		}

		switch (level) {
			case LogLevel.DEBUG:
				return window.console.debug.bind(window.console) as (
					message: string,
					...args: unknown[]
				) => void;
			case LogLevel.INFO:
				return window.console.info.bind(window.console) as (
					message: string,
					...args: unknown[]
				) => void;
			case LogLevel.WARN:
				return window.console.warn.bind(window.console) as (
					message: string,
					...args: unknown[]
				) => void;
			case LogLevel.ERROR:
				return window.console.error.bind(window.console) as (
					message: string,
					...args: unknown[]
				) => void;
			default:
				return null;
		}
	}

	getRecentLogs(limit = Logger.MAX_RECENT_LOGS): string[] {
		if (limit <= 0) return [];
		const boundedLimit = Math.min(limit, this.recentLogs.length);
		if (boundedLimit === 0) return [];
		return this.recentLogs.slice(-boundedLimit);
	}

	debug(message: string, ...args: unknown[]) {
		if (this.shouldLog(LogLevel.DEBUG)) {
			const formatted = this.formatMessage('DEBUG', message);
			const line = formatted + this.formatExtraArgs(args);
			this.getConsoleMethod(LogLevel.DEBUG)?.(formatted, ...args);
			this.addToBuffer(line);
		}
	}

	info(message: string, ...args: unknown[]) {
		if (this.shouldLog(LogLevel.INFO)) {
			const formatted = this.formatMessage('INFO', message);
			const line = formatted + this.formatExtraArgs(args);
			this.getConsoleMethod(LogLevel.INFO)?.(formatted, ...args);
			this.addToBuffer(line);
		}
	}

	warn(message: string, ...args: unknown[]) {
		if (this.shouldLog(LogLevel.WARN)) {
			const formatted = this.formatMessage('WARN', message);
			const line = formatted + this.formatExtraArgs(args);
			this.getConsoleMethod(LogLevel.WARN)?.(formatted, ...args);
			this.addToBuffer(line);
		}
	}

	error(message: string, ...args: unknown[]) {
		if (this.shouldLog(LogLevel.ERROR)) {
			const formatted = this.formatMessage('ERROR', message);
			const line = formatted + this.formatExtraArgs(args);
			this.getConsoleMethod(LogLevel.ERROR)?.(formatted, ...args);
			this.addToBuffer(line);
		}
	}

	/**
	 * Log without exposing sensitive data (tokens, passwords, etc.)
	 */
	safeLog(level: LogLevel, message: string, data?: Record<string, unknown>) {
		if (!this.shouldLog(level)) return;

		const sanitized = data ? this.sanitizeData(data) : undefined;
		const formatted = this.formatMessage(LogLevel[level], message);
		this.getConsoleMethod(level)?.(formatted, sanitized);
		const line = formatted + this.formatExtraArgs(sanitized ? [sanitized] : []);
		this.addToBuffer(line);
	}

	/**
	 * Remove sensitive fields from data before logging
	 */
	private sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
		const sensitiveKeys = [
			'access_token',
			'accessToken',
			'refresh_token',
			'refreshToken',
			'password',
			'secret',
			'authorization',
		];

		const sanitized: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(data)) {
			if (sensitiveKeys.some((sensitive) => key.toLowerCase().includes(sensitive))) {
				sanitized[key] = '[REDACTED]';
			} else if (typeof value === 'object' && value !== null) {
				sanitized[key] = this.sanitizeData(value as Record<string, unknown>);
			} else {
				sanitized[key] = value;
			}
		}

		return sanitized;
	}
}

// Export singleton instance
export const logger = new Logger();
