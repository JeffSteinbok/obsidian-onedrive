vi.mock('obsidian', async (importOriginal) => ({
	...(await importOriginal<typeof import('obsidian')>()),
	// Exercise the declarative (Obsidian 1.13+) settings definitions.
	requireApiVersion: () => true,
}));

import { describe, it, expect, vi } from 'vitest';
import { OneDriveSettingTab } from '../../../src/ui/settings';
import { DEFAULT_SETTINGS, OneDriveAccessMode, type PluginSettings } from '../../../src/types';
import { t } from '../../../src/i18n';

type Definition = {
	type?: string;
	heading?: string;
	name?: string;
	visible?: () => boolean;
	items?: Definition[];
};

const createTab = (settings: Partial<PluginSettings>, connected: boolean) => {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, ...settings },
		isConnected: () => connected,
		loadConnectedUser: vi.fn().mockResolvedValue(false),
	};
	const app = { vault: { configDir: '.obsidian' } };
	const tab = new OneDriveSettingTab(app as any, plugin as any);
	// The Obsidian mock's PluginSettingTab does not keep the app reference.
	(tab as any).app = app;
	return tab;
};

const findGroup = (definitions: Definition[], heading: string) => {
	const group = definitions.find((d) => d.type === 'group' && d.heading === heading);
	if (!group) throw new Error(`No settings group "${heading}"`);
	return group;
};

const isVisible = (definition: Definition) => definition.visible?.() ?? true;

describe('OneDriveSettingTab connection state (#208)', () => {
	it('shows the App Folder sync folder picker when signed in but GET /me failed', () => {
		const tab = createTab(
			{ accessMode: OneDriveAccessMode.APP_FOLDER, connectedUser: undefined },
			true
		);

		const group = findGroup(tab.getSettingDefinitions() as Definition[], t('settings.syncFolder.heading'));
		const subfolder = group.items?.find((item) => item.name === t('settings.syncFolder.vaultSubfolder'));

		expect(isVisible(group)).toBe(true);
		expect(subfolder && isVisible(subfolder)).toBe(true);
	});

	it('hides the App Folder sync folder picker when not signed in', () => {
		const tab = createTab(
			{ accessMode: OneDriveAccessMode.APP_FOLDER, connectedUser: undefined },
			false
		);

		const group = findGroup(tab.getSettingDefinitions() as Definition[], t('settings.syncFolder.heading'));

		expect(isVisible(group)).toBe(false);
	});

	it('shows "account name unavailable" when signed in without user info', () => {
		const tab = createTab({ connectedUser: undefined }, true);

		expect((tab as any).connectionStatusDesc()).toBe(
			t('settings.auth.connectionStatus.connectedAccountUnknown')
		);
	});

	it('shows the account when user info is loaded', () => {
		const tab = createTab(
			{ connectedUser: { id: '1', displayName: 'Test User', userPrincipalName: 'test@test.com' } },
			true
		);

		expect((tab as any).connectionStatusDesc()).toBe(
			t('settings.auth.connectionStatus.connectedAs', {
				displayName: 'Test User',
				userPrincipalName: 'test@test.com',
			})
		);
	});

	it('shows "not connected" for a stale cached user with no tokens', () => {
		const tab = createTab(
			{ connectedUser: { id: '1', displayName: 'Test User', userPrincipalName: 'test@test.com' } },
			false
		);

		expect((tab as any).connectionStatusDesc()).toBe(t('settings.auth.connectionStatus.notConnected'));
	});
});
