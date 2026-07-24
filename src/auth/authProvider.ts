/**
 * Custom Authentication Provider for Microsoft Graph Client
 *
 * This provider bridges our manual OAuth implementation with the Microsoft Graph SDK.
 * The Graph SDK requires an AuthenticationProvider that supplies access tokens on demand.
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                      Authentication Flow                        │
 * ├─────────────────────────────────────────────────────────────────┤
 * │                                                                 │
 * │  DeviceCodeFlowClient        TokenStorage        OneDriveAuthProvider
 * │  ───────────────────        ────────────        ──────────────────
 * │  • requestDeviceCode()      • SecretStorage     • getAccessToken()
 * │  • pollForToken()           • Token persistence • Auto-refresh
 * │  • refreshToken()           • Expiry tracking   • Graph SDK interface
 * │         │                          │                    │
 * │         └──────────────────────────┴────────────────────┘
 * │                                    │
 * │                          OneDriveClient (Graph SDK)
 * │                          ─────────────────────────
 * │                          • API calls with auto-auth
 * │                                                                 │
 * └─────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Why custom instead of MSAL?
 * See deviceCodeFlow.ts for detailed explanation. TL;DR: MSAL requires Node.js
 * APIs not available on iOS/Android, so we implement OAuth manually using
 * Obsidian's cross-platform requestUrl() API.
 *
 * Implementation pattern based on remotely-save
 * https://github.com/remotely-save/remotely-save
 * Licensed under Apache 2.0
 */

import { AuthenticationProvider } from '@microsoft/microsoft-graph-client';
import { TokenStorage } from './tokenStorage';
import { DeviceCodeFlowClient } from './deviceCodeFlow';
import { SYNC_CONFIG } from '../constants';
import { logger } from '../utils/logger';
import { AuthenticationError } from '../types';

/**
 * Custom auth provider that manages token lifecycle
 * Implements Microsoft Graph's AuthenticationProvider interface
 */
export class OneDriveAuthProvider implements AuthenticationProvider {
	// In-flight refresh, shared across concurrent getAccessToken() callers.
	// Microsoft rotates refresh tokens, so parallel refreshes can invalidate
	// each other's tokens — only one refresh may run at a time.
	private refreshPromise: Promise<void> | null = null;

	constructor(
		private tokenStorage: TokenStorage,
		private deviceCodeClient: DeviceCodeFlowClient,
		private onAuthRequired?: () => Promise<void>
	) {}

	/**
	 * Get access token with automatic refresh
	 * Called by Microsoft Graph client before each API request
	 */
	async getAccessToken(): Promise<string> {
		// Check if we have tokens
		if (!this.tokenStorage.hasTokens()) {
			logger.error('No tokens available');
			throw new AuthenticationError('Not authenticated. Please connect to OneDrive in settings.');
		}

		// Check if token needs refresh (with 2-minute buffer)
		if (this.tokenStorage.isAccessTokenExpired(SYNC_CONFIG.TOKEN_REFRESH_BUFFER_MS)) {
			if (!this.refreshPromise) {
				logger.debug('Access token expired or expiring soon, refreshing...');
				this.refreshPromise = this.refreshAccessToken().finally(() => {
					this.refreshPromise = null;
				});
			} else {
				logger.debug('Refresh already in flight, awaiting it');
			}
			await this.refreshPromise;
		}

		const accessToken = this.tokenStorage.getAccessToken();
		if (!accessToken) {
			throw new AuthenticationError('Failed to get access token');
		}

		return accessToken;
	}

	/**
	 * Refresh the access token using refresh token
	 */
	private async refreshAccessToken(): Promise<void> {
		const refreshToken = this.tokenStorage.getRefreshToken();
		if (!refreshToken) {
			logger.error('No refresh token available');
			throw new AuthenticationError('No refresh token available. Please re-authenticate.');
		}

		try {
			const tokenResponse = await this.deviceCodeClient.refreshToken(refreshToken);

			// Store new tokens
			this.tokenStorage.setTokens(
				tokenResponse.access_token,
				tokenResponse.refresh_token || refreshToken, // Use existing if not provided
				tokenResponse.expires_in
			);

			logger.info('Access token refreshed successfully');
		} catch (error) {
			logger.error('Failed to refresh access token:', error);

			// Trigger re-authentication if available
			if (this.onAuthRequired) {
				await this.onAuthRequired();
			}

			throw new AuthenticationError('Failed to refresh token. Please re-authenticate.');
		}
	}
}
