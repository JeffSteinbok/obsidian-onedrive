/**
 * Structured logging utility
 * Respects debug mode settings and provides consistent log formatting
 * Optionally writes to a file for external monitoring (tail -f)
 */

import { PLUGIN_INFO } from '../constants';
import * as fs from 'fs';
import * as path from 'path';

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
}

class Logger {
	private enableDebug = false;
	private minLevel = LogLevel.INFO;
	private logFilePath: string | null = null;
	private recentLogs: string[] = [];
	private static readonly MAX_RECENT_LOGS = 500;

	setDebugMode(enabled: boolean) {
		this.enableDebug = enabled;
		this.minLevel = enabled ? LogLevel.DEBUG : LogLevel.INFO;
	}

	/**
	 * Enable file logging — call with the vault path to write logs to
	 * <vault>/.obsidian/plugins/obsidian-onedrive/sync.log
	 */
	enableFileLogging(vaultPath: string): void {
		try {
			const logDir = path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-onedrive');
			this.logFilePath = path.join(logDir, 'sync.log');
			// Ensure directory exists
			if (!fs.existsSync(logDir)) {
				fs.mkdirSync(logDir, { recursive: true });
			}
			// Truncate on startup so the file doesn't grow forever
			fs.writeFileSync(this.logFilePath, '');
			this.info(`File logging enabled: ${this.logFilePath}`);
		} catch (e) {
			// eslint-disable-next-line no-console
			console.error('Failed to enable file logging:', e);
			this.logFilePath = null;
		}
	}

	disableFileLogging(): void {
		this.logFilePath = null;
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
			this.recentLogs.splice(0, this.recentLogs.length - Logger.MAX_RECENT_LOGS);
		}
	}

	getRecentLogs(limit = Logger.MAX_RECENT_LOGS): string[] {
		if (limit <= 0) return [];
		return this.recentLogs.slice(-limit);
	}

	private writeToFile(line: string): void {
		if (!this.logFilePath) return;
		try {
			fs.appendFileSync(this.logFilePath, line + '\n');
		} catch {
			// silently ignore write errors
		}
	}

	debug(message: string, ...args: unknown[]) {
		if (this.shouldLog(LogLevel.DEBUG)) {
			const formatted = this.formatMessage('DEBUG', message);
			const line = formatted + this.formatExtraArgs(args);
			// eslint-disable-next-line no-console
			console.debug(formatted, ...args);
			this.addToBuffer(line);
			this.writeToFile(line);
		}
	}

	info(message: string, ...args: unknown[]) {
		if (this.shouldLog(LogLevel.INFO)) {
			const formatted = this.formatMessage('INFO', message);
			const line = formatted + this.formatExtraArgs(args);
			// eslint-disable-next-line no-console
			console.info(formatted, ...args);
			this.addToBuffer(line);
			this.writeToFile(line);
		}
	}

	warn(message: string, ...args: unknown[]) {
		if (this.shouldLog(LogLevel.WARN)) {
			const formatted = this.formatMessage('WARN', message);
			const line = formatted + this.formatExtraArgs(args);
			// eslint-disable-next-line no-console
			console.warn(formatted, ...args);
			this.addToBuffer(line);
			this.writeToFile(line);
		}
	}

	error(message: string, ...args: unknown[]) {
		if (this.shouldLog(LogLevel.ERROR)) {
			const formatted = this.formatMessage('ERROR', message);
			const line = formatted + this.formatExtraArgs(args);
			// eslint-disable-next-line no-console
			console.error(formatted, ...args);
			this.addToBuffer(line);
			this.writeToFile(line);
		}
	}

	/**
	 * Log without exposing sensitive data (tokens, passwords, etc.)
	 */
	safeLog(level: LogLevel, message: string, data?: Record<string, unknown>) {
		if (!this.shouldLog(level)) return;

		const sanitized = data ? this.sanitizeData(data) : undefined;
		/* eslint-disable no-console */
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
		this.writeToFile(line);
		/* eslint-enable no-console */
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
