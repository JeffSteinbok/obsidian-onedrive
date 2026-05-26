/**
 * OAuth 2.0 Device Code Flow implementation
 * Mobile-friendly authentication without custom URL schemes
 */

import { requestUrl } from 'obsidian';
import {
	DeviceCodeResponse,
	TokenResponse,
	AuthenticationError,
	OneDriveError,
	OneDriveAccessMode,
} from '../types';
import {
	OAUTH_ENDPOINTS,
	OAUTH_SCOPES_APP_FOLDER,
	OAUTH_SCOPES_FULL_ACCESS,
	DEFAULT_ONEDRIVE_CLIENT_ID,
} from '../constants';
import { logger } from '../utils/logger';
import { parseHttpError } from '../utils/errors';
import { sleep } from '../utils/retry';

export class DeviceCodeFlowClient {
	private cancelled = false;

	constructor(
		private clientId: string = DEFAULT_ONEDRIVE_CLIENT_ID,
		private accessMode: OneDriveAccessMode = OneDriveAccessMode.APP_FOLDER
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
		const scopes =
			this.accessMode === OneDriveAccessMode.FULL_ACCESS
				? OAUTH_SCOPES_FULL_ACCESS
				: OAUTH_SCOPES_APP_FOLDER;

		logger.debug('Requesting device code with scopes:', scopes);

		try {
			const response = await requestUrl({
				url: OAUTH_ENDPOINTS.DEVICE_CODE,
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					client_id: this.clientId,
					scope: scopes.join(' '),
				}).toString(),
			});

			if (response.status !== 200) {
				throw parseHttpError(response.status, response.text);
			}

			const data: DeviceCodeResponse = response.json;

			logger.debug('Device code received', {
				user_code: data.user_code,
				verification_uri: data.verification_uri,
				expires_in: data.expires_in,
			});

			return data;
		} catch (error) {
			logger.error('Failed to request device code:', error);
			throw new AuthenticationError(
				`Failed to request device code: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
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

		while (Date.now() < expiresAt) {
			if (this.cancelled) {
				logger.info('Token polling cancelled');
				throw new AuthenticationError('Authentication cancelled');
			}

			try {
				const response = await requestUrl({
					url: OAUTH_ENDPOINTS.TOKEN,
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
					const data: TokenResponse = response.json;
					logger.info('Token obtained successfully');
					return data;
				}

				// Handle error responses (including 400s from Obsidian's requestUrl)
				const errorData = response.json;
				const errorCode = errorData?.error;

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
				url: OAUTH_ENDPOINTS.TOKEN,
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

			const data: TokenResponse = response.json;
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
