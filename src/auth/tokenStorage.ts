/**
 * Token storage with obfuscation
 * Implementation pattern based on remotely-save
 * https://github.com/remotely-save/remotely-save
 * Licensed under Apache 2.0
 */

import { StoredTokens } from '../types';
import { logger } from '../utils/logger';

/**
 * Obfuscate token string (NOT cryptographic encryption)
 * Just casual protection from casual viewing
 * Pattern from remotely-save: base64url + string reversal
 */
function obfuscate(str: string): string {
	// Base64url encode
	const base64 = btoa(str);
	// Reverse string
	const reversed = base64.split('').reverse().join('');
	// Add prefix to identify obfuscated strings
	return `__OBF__${reversed}`;
}

/**
 * Deobfuscate token string
 */
function deobfuscate(str: string): string {
	if (!str.startsWith('__OBF__')) {
		// Not obfuscated, return as-is (backward compatibility)
		return str;
	}

	// Remove prefix
	const withoutPrefix = str.substring('__OBF__'.length);
	// Reverse string
	const reversed = withoutPrefix.split('').reverse().join('');
	// Base64url decode
	return atob(reversed);
}

/**
 * Token storage manager
 */
export class TokenStorage {
	private tokens?: StoredTokens;

	/**
	 * Load tokens from plugin data
	 */
	loadTokens(data?: StoredTokens): void {
		if (!data) {
			this.tokens = undefined;
			return;
		}

		// Deobfuscate tokens
		try {
			this.tokens = {
				accessToken: deobfuscate(data.accessToken),
				refreshToken: deobfuscate(data.refreshToken),
				expiresAt: data.expiresAt,
				expiresIn: data.expiresIn,
			};
			logger.debug('Tokens loaded successfully');
		} catch (error) {
			logger.error('Failed to load tokens:', error);
			this.tokens = undefined;
		}
	}

	/**
	 * Save tokens for persistence
	 * Returns obfuscated tokens ready to be saved
	 */
	prepareTokensForSave(): StoredTokens | undefined {
		if (!this.tokens) {
			return undefined;
		}

		// Obfuscate tokens before saving
		return {
			accessToken: obfuscate(this.tokens.accessToken),
			refreshToken: obfuscate(this.tokens.refreshToken),
			expiresAt: this.tokens.expiresAt,
			expiresIn: this.tokens.expiresIn,
		};
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
		logger.debug('New tokens stored', {
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
	 * Clear tokens
	 */
	clearTokens(): void {
		this.tokens = undefined;
		logger.debug('Tokens cleared');
	}
}
