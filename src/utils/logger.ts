/* eslint-disable no-console -- Logger is the console abstraction layer */
/**
 * Structured logging utility
 * Respects debug mode settings and provides consistent log formatting
 */

import { PLUGIN_INFO } from '../constants';

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
}

class Logger {
	private enableDebug = false;
	private minLevel = LogLevel.INFO;
	private recentLogs: string[] = [];
	private vaultLogHook: ((line: string) => void) | null = null;
	private static readonly MAX_RECENT_LOGS = 500;

	setDebugMode(enabled: boolean) {
		this.enableDebug = enabled;
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

	private formatMessage(level: string, message: string, ..._args: unknown[]): string {
		const timestamp = new Date().toISOString();
		return `[${timestamp}] [${PLUGIN_INFO.NAME}] [${level}] ${message}`;
	}

	private formatExtraArgs(args: unknown[]): string {
		if (args.length === 0) return '';
		return ' ' + args.map(a => {
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
			console.debug(formatted, ...args);
			this.addToBuffer(line);
		}
	}

	info(message: string, ...args: unknown[]) {
		if (this.shouldLog(LogLevel.INFO)) {
			const formatted = this.formatMessage('INFO', message);
			const line = formatted + this.formatExtraArgs(args);
			console.info(formatted, ...args);
			this.addToBuffer(line);
		}
	}

	warn(message: string, ...args: unknown[]) {
		if (this.shouldLog(LogLevel.WARN)) {
			const formatted = this.formatMessage('WARN', message);
			const line = formatted + this.formatExtraArgs(args);
			console.warn(formatted, ...args);
			this.addToBuffer(line);
		}
	}

	error(message: string, ...args: unknown[]) {
		if (this.shouldLog(LogLevel.ERROR)) {
			const formatted = this.formatMessage('ERROR', message);
			const line = formatted + this.formatExtraArgs(args);
			console.error(formatted, ...args);
			this.addToBuffer(line);
		}
	}

	/**
	 * Log without exposing sensitive data (tokens, passwords, etc.)
	 */
	safeLog(level: LogLevel, message: string, data?: Record<string, unknown>) {
		if (!this.shouldLog(level)) return;

		const sanitized = data ? this.sanitizeData(data) : undefined;
		const logMethod =
			level === LogLevel.DEBUG
				? console.debug
				: level === LogLevel.INFO
					? console.info
					: level === LogLevel.WARN
						? console.warn
						: console.error;

		const formatted = this.formatMessage(LogLevel[level], message);
		logMethod(formatted, sanitized);
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
