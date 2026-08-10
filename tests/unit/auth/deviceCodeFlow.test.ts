import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequestUrl } from '../../setup';
import { DeviceCodeFlowClient } from '../../../src/auth/deviceCodeFlow';
import { resolveOAuthEndpoints } from '../../../src/constants';
import { AuthenticationError } from '../../../src/types';

const jsonResponse = (status: number, json: unknown) => ({
	status,
	json,
	text: JSON.stringify(json),
});

describe('DeviceCodeFlowClient', () => {
	beforeEach(() => {
		mockRequestUrl.mockReset();
	});

	it('requests a device code from the injected endpoint using the injected scopes and client ID', async () => {
		const endpoints = resolveOAuthEndpoints('tenant', 'my-tenant-id');
		const scopes = ['User.Read', 'Files.ReadWrite', 'offline_access'];
		mockRequestUrl.mockResolvedValue(
			jsonResponse(200, {
				device_code: 'dc',
				user_code: 'ABCD-EFGH',
				verification_uri: 'https://microsoft.com/devicelogin',
				expires_in: 900,
				interval: 5,
			})
		);

		const client = new DeviceCodeFlowClient(endpoints, scopes, 'custom-client-id');
		await client.requestDeviceCode();

		expect(mockRequestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				url: 'https://login.microsoftonline.com/my-tenant-id/oauth2/v2.0/devicecode',
				body: expect.stringContaining('client_id=custom-client-id'),
			})
		);
		const call = mockRequestUrl.mock.calls[0][0] as { body: string };
		expect(call.body).toContain('scope=User.Read+Files.ReadWrite+offline_access');
	});

	it('polls the injected token endpoint and returns tokens on success', async () => {
		const endpoints = resolveOAuthEndpoints('work-school', undefined);
		mockRequestUrl.mockResolvedValue(
			jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer', scope: 'x' })
		);

		const client = new DeviceCodeFlowClient(endpoints, ['User.Read'], 'client-id');
		const result = await client.pollForToken('device-code', 1, 60);

		expect(result.access_token).toBe('at');
		expect(mockRequestUrl).toHaveBeenCalledWith(
			expect.objectContaining({ url: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token' })
		);
	});

	it('maps a Conditional Access rejection to a plain-language message and stops polling', async () => {
		const endpoints = resolveOAuthEndpoints('tenant', 'tenant-id');
		mockRequestUrl.mockResolvedValue(
			jsonResponse(400, {
				error: 'invalid_grant',
				error_description: 'AADSTS53003: Access has been blocked by Conditional Access policies.',
			})
		);

		const client = new DeviceCodeFlowClient(endpoints, ['User.Read'], 'client-id');

		await expect(client.pollForToken('device-code', 1, 60)).rejects.toMatchObject({
			message: expect.stringMatching(/organization/i),
		});
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
	});

	it('maps an unapproved application rejection to an administrator-approval message', async () => {
		const endpoints = resolveOAuthEndpoints('tenant', 'tenant-id');
		mockRequestUrl.mockResolvedValue(
			jsonResponse(400, {
				error: 'unauthorized_client',
				error_description: 'AADSTS700016: Application not found in directory.',
			})
		);

		const client = new DeviceCodeFlowClient(endpoints, ['User.Read'], 'client-id');

		await expect(client.pollForToken('device-code', 1, 60)).rejects.toMatchObject({
			message: expect.stringMatching(/administrator/i),
		});
	});

	it('maps an account-type mismatch rejection to a message naming the mismatch', async () => {
		const endpoints = resolveOAuthEndpoints('tenant', 'tenant-id');
		mockRequestUrl.mockResolvedValue(
			jsonResponse(400, {
				error: 'invalid_grant',
				error_description: 'AADSTS50020: User account from identity provider does not exist in tenant.',
			})
		);

		const client = new DeviceCodeFlowClient(endpoints, ['User.Read'], 'client-id');

		await expect(client.pollForToken('device-code', 1, 60)).rejects.toMatchObject({
			message: expect.stringMatching(/does not match/i),
		});
	});

	it('still handles authorization_pending without treating it as a fatal error', async () => {
		const endpoints = resolveOAuthEndpoints('personal', undefined);
		mockRequestUrl
			.mockResolvedValueOnce(jsonResponse(400, { error: 'authorization_pending' }))
			.mockResolvedValueOnce(
				jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer', scope: 'x' })
			);

		const client = new DeviceCodeFlowClient(endpoints, ['User.Read'], 'client-id');
		const onPending = vi.fn();
		const result = await client.pollForToken('device-code', 0, 60, onPending);

		expect(result.access_token).toBe('at');
		expect(onPending).toHaveBeenCalled();
	});

	it('refreshes a token using the injected token endpoint', async () => {
		const endpoints = resolveOAuthEndpoints('personal', undefined);
		mockRequestUrl.mockResolvedValue(
			jsonResponse(200, { access_token: 'new-at', expires_in: 3600, token_type: 'Bearer', scope: 'x' })
		);

		const client = new DeviceCodeFlowClient(endpoints, ['User.Read'], 'client-id');
		const result = await client.refreshToken('old-rt');

		expect(result.access_token).toBe('new-at');
		expect(mockRequestUrl).toHaveBeenCalledWith(
			expect.objectContaining({ url: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token' })
		);
	});

	it('maps an Entra rejection from the device code request itself', async () => {
		const endpoints = resolveOAuthEndpoints('tenant', 'tenant-id');
		mockRequestUrl.mockResolvedValue(
			jsonResponse(400, {
				error: 'unauthorized_client',
				error_description: 'AADSTS700016: Application not found in directory.',
			})
		);

		const client = new DeviceCodeFlowClient(endpoints, ['User.Read'], 'client-id');

		await expect(client.requestDeviceCode()).rejects.toMatchObject({
			message: expect.stringMatching(/administrator/i),
		});
		// The mapped message must not be buried behind the generic prefix
		await expect(client.requestDeviceCode()).rejects.toMatchObject({
			message: expect.not.stringContaining('Failed to request device code'),
		});
		expect(mockRequestUrl).toHaveBeenCalledWith(expect.objectContaining({ throw: false }));
	});

	it('does not misclassify a longer AADSTS code that shares a prefix', async () => {
		const endpoints = resolveOAuthEndpoints('tenant', 'tenant-id');
		mockRequestUrl.mockResolvedValue(
			jsonResponse(400, {
				error: 'invalid_grant',
				error_description: 'AADSTS530032: Something unrelated to Conditional Access device policy.',
			})
		);

		const client = new DeviceCodeFlowClient(endpoints, ['User.Read'], 'client-id');

		await expect(client.pollForToken('device-code', 1, 60)).rejects.toMatchObject({
			message: expect.stringContaining('AADSTS530032'),
		});
	});

	it('throws AuthenticationError instances from pollForToken rejections', async () => {
		const endpoints = resolveOAuthEndpoints('personal', undefined);
		mockRequestUrl.mockResolvedValue(jsonResponse(400, { error: 'access_denied' }));

		const client = new DeviceCodeFlowClient(endpoints, ['User.Read'], 'client-id');
		await expect(client.pollForToken('device-code', 1, 60)).rejects.toBeInstanceOf(AuthenticationError);
	});
});
