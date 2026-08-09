/**
 * OAuth 2.0 Device Code Flow implementation
 * Mobile-friendly authentication without custom URL schemes
 *
 * ## Why we implement OAuth manually instead of using @azure/msal-node
 *
 * This plugin must work across all Obsidian platforms:
 * - **Desktop (Electron)**: Has Node.js, could use msal-node
 * - **iOS**: Runs in WebView without Node.js — msal-node fails (needs crypto, http, fs)
 * - **Android**: Runs in WebView without Node.js — same limitation
 *
 * MSAL libraries have platform-specific requirements:
 * - `@azure/msal-node` requires Node.js APIs unavailable in mobile WebViews
 * - `@azure/msal-browser` uses redirect flows incompatible with Obsidian's sandboxed environment
 *
 * Our solution: Implement Device Code Flow manually using Obsidian's `requestUrl()` API,
 * which is provided consistently across all platforms. This gives us:
 * - Single code path for desktop + mobile
 * - No platform-specific dependencies
 * - Full control over token storage (using Obsidian's SecretStorage)
 *
 * The implementation follows the OAuth 2.0 Device Authorization Grant (RFC 8628):
 * 1. Request device code from Microsoft
 * 2. User visits verification URL and enters code
 * 3. Poll token endpoint until user completes auth
 * 4. Store tokens securely, refresh as needed
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8628
 * @see https://learn.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-device-code
 */

import { requestUrl } from 'obsidian';
import { DeviceCodeResponse, TokenResponse, AuthenticationError, OneDriveError } from '../types';
import { OAuthEndpointSet, OAUTH_ENDPOINTS, OAUTH_SCOPES_APP_FOLDER, DEFAULT_ONEDRIVE_CLIENT_ID } from '../constants';
import { logger } from '../utils/logger';
import { parseHttpError } from '../utils/errors';
import { sleep } from '../utils/retry';
import { mapEntraAuthError } from './entraErrors';

interface OAuthErrorResponse {
	error?: string;
	error_description?: string;
}

export class DeviceCodeFlowClient {
	private cancelled = false;

	constructor(
		private endpoints: OAuthEndpointSet = OAUTH_ENDPOINTS,
		private scopes: string[] = OAUTH_SCOPES_APP_FOLDER,
		private clientId: string = DEFAULT_ONEDRIVE_CLIENT_ID
	) {}

	/**
	 * Cancel any in-progress polling loop
	 */
	cancelPolling(): void {
		this.cancelled = true;
	}

	/**
	 * Request a device code from Microsoft
	 * Returns the device code and user code for the user to enter
	 */
	async requestDeviceCode(): Promise<DeviceCodeResponse> {
		logger.debug('Requesting device code with scopes:', this.scopes);

		try {
			const response = await requestUrl({
				url: this.endpoints.DEVICE_CODE,
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					client_id: this.clientId,
					scope: this.scopes.join(' '),
				}).toString(),
				// Without this, requestUrl throws on 4xx before we can read the
				// body — and the body is where Entra puts the AADSTS code that
				// explains work/school failures (unapproved app, tenant policy,
				// wrong account type).
				throw: false,
			});

			if (response.status !== 200) {
				const errorData = this.parseErrorResponse(response);
				const mappedMessage = mapEntraAuthError(errorData.error, errorData.error_description);
				if (mappedMessage) {
					throw new AuthenticationError(mappedMessage, errorData.error);
				}
				throw parseHttpError(response.status, response.text);
			}

			const data = response.json as unknown as DeviceCodeResponse;

			logger.debug(`Device code received (expires_in=${data.expires_in}, uri=${data.verification_uri})`);

			return data;
		} catch (error) {
			logger.error('Failed to request device code:', error);
			if (error instanceof AuthenticationError) {
				// Already actionable (a mapped Entra rejection) — don't bury it
				// behind a generic prefix.
				throw error;
			}
			throw new AuthenticationError(
				`Failed to request device code: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Read an OAuth error body defensively: a non-JSON or empty response makes
	 * `requestUrl`'s `json` getter throw or yield null.
	 */
	private parseErrorResponse(response: { json: unknown }): OAuthErrorResponse {
		try {
			return (response.json as OAuthErrorResponse) ?? {};
		} catch {
			return {};
		}
	}

	/**
	 * Poll for token after user completes authentication
	 * Polls until user completes auth, code expires, or error occurs
	 */
	async pollForToken(
		deviceCode: string,
		interval: number,
		expiresIn: number,
		onPending?: () => void
	): Promise<TokenResponse> {
		logger.debug('Starting token polling', { interval, expiresIn });

		this.cancelled = false;
		const startTime = Date.now();
		const expiresAt = startTime + expiresIn * 1000;
		// Abort after this many back-to-back network failures instead of
		// silently polling until the device code expires (a persistent server
		// error would otherwise look like a multi-minute hang to the user).
		const maxConsecutiveNetworkErrors = 5;
		let consecutiveNetworkErrors = 0;

		while (Date.now() < expiresAt) {
			if (this.cancelled) {
				logger.info('Token polling cancelled');
				throw new AuthenticationError('Authentication cancelled');
			}

			try {
				const response = await requestUrl({
					url: this.endpoints.TOKEN,
					method: 'POST',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: new URLSearchParams({
						grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
						client_id: this.clientId,
						device_code: deviceCode,
					}).toString(),
					throw: false,
				});

				if (response.status === 200) {
					const data = response.json as unknown as TokenResponse;
					logger.info('Token obtained successfully');
					return data;
				}

				// Got a response from the server — reset the network error streak
				consecutiveNetworkErrors = 0;

				// Handle error responses (including 400s from Obsidian's requestUrl)
				const errorData = this.parseErrorResponse(response);
				const errorCode = errorData.error;

				const mappedMessage = mapEntraAuthError(errorCode, errorData.error_description);
				if (mappedMessage) {
					// Stop polling — a rejection Entra names (tenant policy, unapproved
					// app, wrong account type) will not resolve on retry.
					throw new AuthenticationError(mappedMessage, errorCode);
				}

				if (errorCode === 'authorization_pending') {
					// User hasn't completed auth yet, continue polling
					logger.debug('Authorization pending, continuing to poll');
					if (onPending) onPending();
				} else if (errorCode === 'slow_down') {
					// Server requests slower polling
					logger.debug('Slow down requested, increasing interval');
					interval += 5; // Add 5 seconds
				} else if (errorCode === 'authorization_declined' || errorCode === 'access_denied') {
					throw new AuthenticationError('User declined authorization');
				} else if (errorCode === 'expired_token') {
					throw new AuthenticationError('Device code expired. Please try again.');
				} else {
					throw new AuthenticationError(
						`Authentication failed: ${errorData?.error_description || errorCode || `HTTP ${response.status}`}`
					);
				}
			} catch (error) {
				if (error instanceof AuthenticationError) {
					throw error;
				}
				// Network or temporary error - log but continue polling
				consecutiveNetworkErrors++;
				if (consecutiveNetworkErrors >= maxConsecutiveNetworkErrors) {
					logger.error('Aborting token polling after repeated network errors:', error);
					throw new AuthenticationError(
						'Repeated network errors during authentication. Please check your connection and try again.'
					);
				}
				logger.warn('Network error during token polling, will retry:', error);
				if (onPending) onPending();
			}

			// Wait before next poll
			await sleep(interval * 1000);
		}

		throw new AuthenticationError('Device code expired. Please try again.');
	}

	/**
	 * Refresh access token using refresh token
	 */
	async refreshToken(refreshToken: string): Promise<TokenResponse> {
		logger.debug('Refreshing access token');

		try {
			const response = await requestUrl({
				url: this.endpoints.TOKEN,
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					client_id: this.clientId,
					refresh_token: refreshToken,
				}).toString(),
			});

			if (response.status !== 200) {
				throw parseHttpError(response.status, response.text);
			}

			const data = response.json as unknown as TokenResponse;
			logger.info('Token refreshed successfully');
			return data;
		} catch (error) {
			logger.error('Failed to refresh token:', error);
			if (error instanceof OneDriveError) {
				throw error;
			}
			throw new AuthenticationError(
				`Failed to refresh token: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Complete device code flow
	 * Requests device code, waits for user to authenticate, and returns tokens
	 */
	async authenticate(
		onDeviceCode: (userCode: string, verificationUri: string) => void,
		onPending?: () => void
	): Promise<TokenResponse> {
		// Step 1: Request device code
		const deviceCodeData = await this.requestDeviceCode();

		// Step 2: Show user code to user
		onDeviceCode(deviceCodeData.user_code, deviceCodeData.verification_uri);

		// Step 3: Poll for token
		const tokenData = await this.pollForToken(
			deviceCodeData.device_code,
			deviceCodeData.interval,
			deviceCodeData.expires_in,
			onPending
		);

		return tokenData;
	}
}
