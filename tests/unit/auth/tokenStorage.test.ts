/**
 * Unit tests for TokenStorage
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TokenStorage } from '../../../src/auth/tokenStorage';

describe('TokenStorage', () => {
	let storage: TokenStorage;

	beforeEach(() => {
		storage = new TokenStorage();
	});

	describe('setTokens', () => {
		it('should store tokens with correct expiration time', () => {
			const accessToken = 'test_access_token';
			const refreshToken = 'test_refresh_token';
			const expiresIn = 3600; // 1 hour

			storage.setTokens(accessToken, refreshToken, expiresIn);

			expect(storage.getAccessToken()).toBe(accessToken);
			expect(storage.getRefreshToken()).toBe(refreshToken);
			expect(storage.hasTokens()).toBe(true);
		});

		it('should calculate correct expiration timestamp', () => {
			const now = Date.now();
			const expiresIn = 3600; // 1 hour

			storage.setTokens('access', 'refresh', expiresIn);

			const expiresAt = storage.getExpiresAt()!;
			const expectedExpiry = now + expiresIn * 1000;

			// Allow 100ms tolerance for test execution time
			expect(Math.abs(expiresAt - expectedExpiry)).toBeLessThan(100);
		});
	});

	describe('isAccessTokenExpired', () => {
		it('should return false for fresh token', () => {
			storage.setTokens('access', 'refresh', 3600); // 1 hour
			expect(storage.isAccessTokenExpired()).toBe(false);
		});

		it('should return true for expired token', () => {
			storage.setTokens('access', 'refresh', -10); // Expired 10 seconds ago
			expect(storage.isAccessTokenExpired()).toBe(true);
		});

		it('should respect buffer time', () => {
			storage.setTokens('access', 'refresh', 60); // 60 seconds

			// Should not be expired without buffer
			expect(storage.isAccessTokenExpired()).toBe(false);

			// Should be considered expired with 2-minute buffer
			expect(storage.isAccessTokenExpired(120000)).toBe(true);
		});

		it('should return true when no tokens exist', () => {
			expect(storage.isAccessTokenExpired()).toBe(true);
		});
	});

	describe('obfuscation', () => {
		it('should obfuscate and deobfuscate tokens correctly', () => {
			const accessToken = 'test_access_token_12345';
			const refreshToken = 'test_refresh_token_67890';

			storage.setTokens(accessToken, refreshToken, 3600);

			// Prepare for save (obfuscated)
			const saved = storage.prepareTokensForSave()!;

			// Obfuscated tokens should not match original
			expect(saved.accessToken).not.toBe(accessToken);
			expect(saved.refreshToken).not.toBe(refreshToken);

			// Should have obfuscation prefix
			expect(saved.accessToken).toContain('__OBF__');
			expect(saved.refreshToken).toContain('__OBF__');

			// Load tokens back
			const newStorage = new TokenStorage();
			newStorage.loadTokens(saved);

			// Should match original tokens after deobfuscation
			expect(newStorage.getAccessToken()).toBe(accessToken);
			expect(newStorage.getRefreshToken()).toBe(refreshToken);
		});
	});

	describe('clearTokens', () => {
		it('should clear all stored tokens', () => {
			storage.setTokens('access', 'refresh', 3600);
			expect(storage.hasTokens()).toBe(true);

			storage.clearTokens();

			expect(storage.hasTokens()).toBe(false);
			expect(storage.getAccessToken()).toBeUndefined();
			expect(storage.getRefreshToken()).toBeUndefined();
		});
	});
});
