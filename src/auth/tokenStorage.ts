/**
 * Token storage using Obsidian's SecretStorage API
 * Secrets are stored securely outside of data.json
 */

import { App } from 'obsidian';
import { StoredTokens } from '../types';
import { logger } from '../utils/logger';

const SECRET_KEYS = {
	ACCESS_TOKEN: 'access-token',
	REFRESH_TOKEN: 'refresh-token',
	EXPIRES_AT: 'token-expires-at',
	EXPIRES_IN: 'token-expires-in',
} as const;

/**
 * Deobfuscate legacy token string from data.json migration
 */
function deobfuscateLegacy(str: string): string {
	if (!str.startsWith('__OBF__')) {
		return str;
	}
	const withoutPrefix = str.substring('__OBF__'.length);
	const reversed = withoutPrefix.split('').reverse().join('');
	return atob(reversed);
}

/**
 * Token storage manager using Obsidian's SecretStorage
 */
export class TokenStorage {
	private tokens?: StoredTokens;
	private app?: App;

	/**
	 * Set the app reference for SecretStorage access
	 */
	setApp(app: App): void {
		this.app = app;
	}

	/**
	 * Load tokens from SecretStorage, falling back to legacy data.json tokens for migration.
	 * Returns true if legacy tokens were migrated (caller should clear them from settings).
	 * SecretStorage API is currently synchronous; keeping async here preserves the public
	 * contract (callers await this) and allows a seamless transition if Obsidian's
	 * SecretStorage ever becomes truly async.
	 */
	// eslint-disable-next-line @typescript-eslint/require-await -- keep async for API stability while SecretStorage remains synchronous
	async loadTokens(legacyTokens?: StoredTokens): Promise<boolean> {
		if (!this.app) {
			logger.error('App not set on TokenStorage');
			return false;
		}

		// Try loading from SecretStorage first
		const accessToken = this.app.secretStorage.getSecret(SECRET_KEYS.ACCESS_TOKEN);
		const refreshToken = this.app.secretStorage.getSecret(SECRET_KEYS.REFRESH_TOKEN);
		const expiresAtStr = this.app.secretStorage.getSecret(SECRET_KEYS.EXPIRES_AT);
		const expiresInStr = this.app.secretStorage.getSecret(SECRET_KEYS.EXPIRES_IN);

		if (accessToken && refreshToken && expiresAtStr) {
			this.tokens = {
				accessToken,
				refreshToken,
				expiresAt: Number(expiresAtStr),
				expiresIn: expiresInStr ? Number(expiresInStr) : 3600,
			};
			logger.debug('Tokens loaded from SecretStorage');
			return false; // No migration needed
		}

		// Fall back to legacy data.json tokens and migrate
		if (legacyTokens) {
			try {
				const at = deobfuscateLegacy(legacyTokens.accessToken);
				const rt = deobfuscateLegacy(legacyTokens.refreshToken);

				this.tokens = {
					accessToken: at,
					refreshToken: rt,
					expiresAt: legacyTokens.expiresAt,
					expiresIn: legacyTokens.expiresIn,
				};

				// Migrate to SecretStorage
				this.saveToSecretStorage();
				logger.info('Tokens migrated from data.json to SecretStorage');
				return true; // Caller should clear tokens from settings
			} catch (error) {
				logger.error('Failed to migrate legacy tokens:', error);
				this.tokens = undefined;
				return false;
			}
		}

		this.tokens = undefined;
		return false;
	}

	/**
	 * Persist current tokens to SecretStorage
	 */
	private saveToSecretStorage(): void {
		if (!this.app || !this.tokens) return;

		this.app.secretStorage.setSecret(SECRET_KEYS.ACCESS_TOKEN, this.tokens.accessToken);
		this.app.secretStorage.setSecret(SECRET_KEYS.REFRESH_TOKEN, this.tokens.refreshToken);
		this.app.secretStorage.setSecret(SECRET_KEYS.EXPIRES_AT, String(this.tokens.expiresAt));
		this.app.secretStorage.setSecret(SECRET_KEYS.EXPIRES_IN, String(this.tokens.expiresIn));
	}

	/**
	 * Store new tokens
	 */
	setTokens(accessToken: string, refreshToken: string, expiresIn: number): void {
		const expiresAt = Date.now() + expiresIn * 1000;
		this.tokens = {
			accessToken,
			refreshToken,
			expiresAt,
			expiresIn,
		};
		this.saveToSecretStorage();
		logger.debug('New tokens stored in SecretStorage', {
			expiresIn,
			expiresAt: new Date(expiresAt).toISOString(),
		});
	}

	/**
	 * Get access token (if valid)
	 */
	getAccessToken(): string | undefined {
		return this.tokens?.accessToken;
	}

	/**
	 * Get refresh token
	 */
	getRefreshToken(): string | undefined {
		return this.tokens?.refreshToken;
	}

	/**
	 * Get token expiration timestamp
	 */
	getExpiresAt(): number | undefined {
		return this.tokens?.expiresAt;
	}

	/**
	 * Check if tokens exist
	 */
	hasTokens(): boolean {
		return !!this.tokens;
	}

	/**
	 * Check if access token is expired (with buffer)
	 */
	isAccessTokenExpired(bufferMs = 0): boolean {
		if (!this.tokens) return true;
		return Date.now() + bufferMs >= this.tokens.expiresAt;
	}

	/**
	 * Clear tokens from both memory and SecretStorage
	 */
	clearTokens(): void {
		this.tokens = undefined;
		if (this.app) {
			this.app.secretStorage.setSecret(SECRET_KEYS.ACCESS_TOKEN, '');
			this.app.secretStorage.setSecret(SECRET_KEYS.REFRESH_TOKEN, '');
			this.app.secretStorage.setSecret(SECRET_KEYS.EXPIRES_AT, '');
			this.app.secretStorage.setSecret(SECRET_KEYS.EXPIRES_IN, '');
		}
		logger.debug('Tokens cleared');
	}
}
