/**
 * Mock tokens and responses for testing
 */

import { TokenResponse, DeviceCodeResponse, OneDriveUser, StoredTokens } from '../../src/types';

export const mockDeviceCodeResponse: DeviceCodeResponse = {
	device_code: 'mock_device_code_12345',
	user_code: 'ABC-DEF',
	verification_uri: 'https://microsoft.com/devicelogin',
	expires_in: 900, // 15 minutes
	interval: 5,
	message: 'To sign in, use a web browser to open the page...',
};

export const mockTokenResponse: TokenResponse = {
	access_token: 'mock_access_token_67890',
	token_type: 'Bearer',
	expires_in: 3600, // 1 hour
	scope: 'User.Read Files.ReadWrite.AppFolder Files.Read.All offline_access',
	refresh_token: 'mock_refresh_token_11111',
};

export const mockStoredTokens: StoredTokens = {
	accessToken: 'mock_access_token_67890',
	refreshToken: 'mock_refresh_token_11111',
	expiresAt: Date.now() + 3600 * 1000, // 1 hour from now
	expiresIn: 3600,
};

export const mockOneDriveUser: OneDriveUser = {
	id: 'user_12345',
	displayName: 'John Doe',
	mail: 'john.doe@outlook.com',
	userPrincipalName: 'john.doe@outlook.com',
};
