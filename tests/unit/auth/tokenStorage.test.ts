/**
 * Unit tests for TokenStorage
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TokenStorage } from '../../../src/auth/tokenStorage';

function createMockApp() {
	const secrets = new Map<string, string>();
	return {
		secretStorage: {
			getSecret: vi.fn((id: string) => secrets.get(id) || null),
			setSecret: vi.fn((id: string, value: string) => { secrets.set(id, value); }),
			listSecrets: vi.fn(() => Array.from(secrets.keys())),
		},
	} as any;
}

describe('TokenStorage', () => {
	let storage: TokenStorage;
	let mockApp: ReturnType<typeof createMockApp>;

	beforeEach(() => {
		storage = new TokenStorage();
		mockApp = createMockApp();
		storage.setApp(mockApp);
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

		it('should persist tokens to SecretStorage', () => {
			storage.setTokens('access', 'refresh', 3600);

			expect(mockApp.secretStorage.setSecret).toHaveBeenCalledWith('access-token', 'access');
			expect(mockApp.secretStorage.setSecret).toHaveBeenCalledWith('refresh-token', 'refresh');
			expect(mockApp.secretStorage.setSecret).toHaveBeenCalledWith('token-expires-at', expect.any(String));
			expect(mockApp.secretStorage.setSecret).toHaveBeenCalledWith('token-expires-in', '3600');
		});
	});

	describe('loadTokens', () => {
		it('should load tokens from SecretStorage', async () => {
			storage.setTokens('stored-access', 'stored-refresh', 3600);

			const newStorage = new TokenStorage();
			newStorage.setApp(mockApp);
			const migrated = await newStorage.loadTokens();

			expect(migrated).toBe(false);
			expect(newStorage.getAccessToken()).toBe('stored-access');
			expect(newStorage.getRefreshToken()).toBe('stored-refresh');
		});

		it('should sanitize a corrupt (non-numeric) expiry into an expired token', async () => {
			mockApp.secretStorage.setSecret('access-token', 'access');
			mockApp.secretStorage.setSecret('refresh-token', 'refresh');
			mockApp.secretStorage.setSecret('token-expires-at', 'not-a-number');

			await storage.loadTokens();

			// NaN comparisons always return false, which would make a broken
			// token appear never-expiring; the loader must coerce it to 0
			// (already expired) so the refresh path runs.
			expect(storage.hasTokens()).toBe(true);
			expect(storage.isAccessTokenExpired()).toBe(true);
		});

		it('should migrate legacy obfuscated tokens from data.json', async () => {
			// Create obfuscated tokens in legacy format
			const accessToken = 'test_access_token_12345';
			const refreshToken = 'test_refresh_token_67890';
			const obfuscated = (s: string) => `__OBF__${btoa(s).split('').reverse().join('')}`;

			const legacyTokens = {
				accessToken: obfuscated(accessToken),
				refreshToken: obfuscated(refreshToken),
				expiresAt: Date.now() + 3600000,
				expiresIn: 3600,
			};

			const migrated = await storage.loadTokens(legacyTokens);

			expect(migrated).toBe(true);
			expect(storage.getAccessToken()).toBe(accessToken);
			expect(storage.getRefreshToken()).toBe(refreshToken);
			// Should have saved to SecretStorage
			expect(mockApp.secretStorage.setSecret).toHaveBeenCalledWith('access-token', accessToken);
		});

		it('should migrate legacy unobfuscated tokens', async () => {
			const legacyTokens = {
				accessToken: 'plain_access_token',
				refreshToken: 'plain_refresh_token',
				expiresAt: Date.now() + 3600000,
				expiresIn: 3600,
			};

			const migrated = await storage.loadTokens(legacyTokens);

			expect(migrated).toBe(true);
			expect(storage.getAccessToken()).toBe('plain_access_token');
		});

		it('should prefer SecretStorage over legacy tokens', async () => {
			// Pre-populate SecretStorage
			storage.setTokens('secret-access', 'secret-refresh', 3600);

			const newStorage = new TokenStorage();
			newStorage.setApp(mockApp);

			const legacyTokens = {
				accessToken: 'legacy-access',
				refreshToken: 'legacy-refresh',
				expiresAt: Date.now() + 3600000,
				expiresIn: 3600,
			};

			const migrated = await newStorage.loadTokens(legacyTokens);

			expect(migrated).toBe(false);
			expect(newStorage.getAccessToken()).toBe('secret-access');
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

	describe('clearTokens', () => {
		it('should clear all stored tokens', () => {
			storage.setTokens('access', 'refresh', 3600);
			expect(storage.hasTokens()).toBe(true);

			storage.clearTokens();

			expect(storage.hasTokens()).toBe(false);
			expect(storage.getAccessToken()).toBeUndefined();
			expect(storage.getRefreshToken()).toBeUndefined();
		});

		it('should clear SecretStorage', () => {
			storage.setTokens('access', 'refresh', 3600);
			vi.clearAllMocks();

			storage.clearTokens();

			expect(mockApp.secretStorage.setSecret).toHaveBeenCalledWith('access-token', '');
			expect(mockApp.secretStorage.setSecret).toHaveBeenCalledWith('refresh-token', '');
			expect(mockApp.secretStorage.setSecret).toHaveBeenCalledWith('token-expires-at', '');
			expect(mockApp.secretStorage.setSecret).toHaveBeenCalledWith('token-expires-in', '');
		});
	});
});
