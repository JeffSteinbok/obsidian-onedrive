import { describe, expect, it } from 'vitest';
import {
	resolveOAuthEndpoints,
	resolveOAuthScopes,
	OAUTH_SCOPES_APP_FOLDER,
	OAUTH_SCOPES_FULL_ACCESS,
	OAUTH_SCOPES_WORK_SCHOOL,
} from '../../src/constants';
import { OneDriveAccessMode } from '../../src/types';

describe('resolveOAuthEndpoints', () => {
	it('resolves the consumers authority for personal accounts', () => {
		const endpoints = resolveOAuthEndpoints('personal', undefined);
		expect(endpoints.DEVICE_CODE).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode');
		expect(endpoints.TOKEN).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
		expect(endpoints.AUTHORIZE).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
	});

	it('resolves the organizations authority for work/school accounts', () => {
		const endpoints = resolveOAuthEndpoints('work-school', undefined);
		expect(endpoints.DEVICE_CODE).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode');
	});

	it('resolves a tenant-specific authority when a tenant ID is configured', () => {
		const endpoints = resolveOAuthEndpoints('tenant', '11111111-1111-1111-1111-111111111111');
		expect(endpoints.DEVICE_CODE).toBe(
			'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/devicecode'
		);
		expect(endpoints.TOKEN).toBe(
			'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/token'
		);
	});

	it('throws when the tenant account type has no tenant ID', () => {
		expect(() => resolveOAuthEndpoints('tenant', undefined)).toThrow(/tenant id/i);
		expect(() => resolveOAuthEndpoints('tenant', '')).toThrow(/tenant id/i);
		expect(() => resolveOAuthEndpoints('tenant', '   ')).toThrow(/tenant id/i);
	});

	it('trims a pasted tenant ID rather than putting whitespace in the authority URL', () => {
		const endpoints = resolveOAuthEndpoints('tenant', '  contoso.onmicrosoft.com\n');
		expect(endpoints.DEVICE_CODE).toBe(
			'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/devicecode'
		);
	});

	it('rejects a tenant ID that would rewrite the authority path', () => {
		expect(() => resolveOAuthEndpoints('tenant', 'https://login.microsoftonline.com/abc')).toThrow(
			/invalid tenant id/i
		);
		expect(() => resolveOAuthEndpoints('tenant', 'abc/def')).toThrow(/invalid tenant id/i);
		expect(() => resolveOAuthEndpoints('tenant', 'a b')).toThrow(/invalid tenant id/i);
	});

	it('accepts a different identity host for future national-cloud support', () => {
		const endpoints = resolveOAuthEndpoints('personal', undefined, 'https://login.microsoftonline.us');
		expect(endpoints.DEVICE_CODE).toBe('https://login.microsoftonline.us/consumers/oauth2/v2.0/devicecode');
	});
});

describe('resolveOAuthScopes', () => {
	it('requests the app folder scope for personal accounts in App Folder mode', () => {
		expect(resolveOAuthScopes('personal', OneDriveAccessMode.APP_FOLDER)).toEqual(OAUTH_SCOPES_APP_FOLDER);
	});

	it('includes the read scope required by the delta API in App Folder mode', () => {
		expect(resolveOAuthScopes('personal', OneDriveAccessMode.APP_FOLDER)).toContain('Files.Read.All');
	});

	it('requests the full access scope for personal accounts in Full Access mode', () => {
		expect(resolveOAuthScopes('personal', OneDriveAccessMode.FULL_ACCESS)).toEqual(OAUTH_SCOPES_FULL_ACCESS);
	});

	it('never requests the app folder scope for work/school or tenant accounts', () => {
		expect(resolveOAuthScopes('work-school', OneDriveAccessMode.APP_FOLDER)).toEqual(OAUTH_SCOPES_WORK_SCHOOL);
		expect(resolveOAuthScopes('tenant', OneDriveAccessMode.FULL_ACCESS)).toEqual(OAUTH_SCOPES_WORK_SCHOOL);
		expect(resolveOAuthScopes('work-school', OneDriveAccessMode.APP_FOLDER)).not.toContain(
			'Files.ReadWrite.AppFolder'
		);
	});

	it('requests a scope that covers shared folders for work/school accounts', () => {
		// Work/school accounts are forced into Full Access mode, which exposes the
		// shared-folder browser — that reads other drives.
		expect(resolveOAuthScopes('work-school', OneDriveAccessMode.FULL_ACCESS)).toContain('Files.ReadWrite.All');
	});

	it('always includes offline_access so refresh tokens are issued', () => {
		expect(resolveOAuthScopes('personal', OneDriveAccessMode.APP_FOLDER)).toContain('offline_access');
		expect(resolveOAuthScopes('work-school', OneDriveAccessMode.FULL_ACCESS)).toContain('offline_access');
	});
});
