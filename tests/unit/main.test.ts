const mocks = vi.hoisted(() => {
	const logger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		setDebugMode: vi.fn(),
		enableFileLogging: vi.fn(),
		getRecentLogs: vi.fn().mockReturnValue([]),
	};

	const tokenStorage = {
		loadTokens: vi.fn(),
		hasTokens: vi.fn().mockReturnValue(false),
		setTokens: vi.fn(),
		clearTokens: vi.fn(),
		prepareTokensForSave: vi.fn().mockReturnValue(undefined),
	};

	const deviceCodeClient = {
		authenticate: vi.fn(),
		cancelPolling: vi.fn(),
	};

	const oneDriveClient = {
		setRemoteDrive: vi.fn(),
		isSharedDrive: vi.fn().mockReturnValue(false),
		getUserInfo: vi.fn().mockResolvedValue({
			id: '1',
			displayName: 'Test User',
			userPrincipalName: 'test@test.com',
		}),
		resolveSharedFolderPath: vi.fn(),
		listFoldersForPicker: vi.fn(),
	};

	const syncEngine = {
		performSync: vi.fn().mockResolvedValue(undefined),
	};

	const syncStateManager = {
		loadState: vi.fn(),
		prepareForSave: vi.fn().mockReturnValue({ lastSyncTime: 0, fileStates: [] }),
		getLastSyncTime: vi.fn().mockReturnValue(0),
		clearState: vi.fn(),
		getDeltaLink: vi.fn(),
		isFirstSync: vi.fn().mockReturnValue(true),
	};

	const conflictResolver = {
		setStrategy: vi.fn(),
	};

	const eventManager = {
		startListening: vi.fn(),
		stopListening: vi.fn(),
		startPeriodicSync: vi.fn(),
		stopPeriodicSync: vi.fn(),
		triggerManualSync: vi.fn().mockResolvedValue(undefined),
		isSyncInProgress: vi.fn().mockReturnValue(false),
		getDirtyFiles: vi.fn().mockReturnValue([]),
		clearDirtyFiles: vi.fn(),
	};

	const statusBarManager = {
		setStatus: vi.fn(),
		setLastSyncTime: vi.fn(),
	};

	const deviceCodeModal = {
		open: vi.fn(),
	};

	return {
		logger,
		tokenStorage,
		deviceCodeClient,
		oneDriveClient,
		syncEngine,
		syncStateManager,
		conflictResolver,
		eventManager,
		statusBarManager,
		deviceCodeModal,
		TokenStorage: vi.fn().mockImplementation(function () {
			return tokenStorage;
		}),
		DeviceCodeFlowClient: vi.fn().mockImplementation(function () {
			return deviceCodeClient;
		}),
		OneDriveAuthProvider: vi.fn().mockImplementation(function () {
			return {};
		}),
		OneDriveClient: vi.fn().mockImplementation(function () {
			return oneDriveClient;
		}),
		FileOperations: vi.fn().mockImplementation(function () {
			return {};
		}),
		SyncEngine: vi.fn().mockImplementation(function () {
			return syncEngine;
		}),
		SyncStateManager: vi.fn().mockImplementation(function () {
			return syncStateManager;
		}),
		ConflictResolver: vi.fn().mockImplementation(function () {
			return conflictResolver;
		}),
		EventManager: vi.fn().mockImplementation(function () {
			return eventManager;
		}),
		OneDriveSettingTab: vi.fn().mockImplementation(function () {
			return {};
		}),
		StatusBarManager: vi.fn().mockImplementation(function () {
			return statusBarManager;
		}),
		DeviceCodeModal: vi.fn().mockImplementation(function () {
			return deviceCodeModal;
		}),
	};
});

vi.mock('../../src/utils/logger', () => ({
	logger: mocks.logger,
}));

vi.mock('../../src/auth/tokenStorage', () => ({
	TokenStorage: mocks.TokenStorage,
}));

vi.mock('../../src/auth/deviceCodeFlow', () => ({
	DeviceCodeFlowClient: mocks.DeviceCodeFlowClient,
}));

vi.mock('../../src/auth/authProvider', () => ({
	OneDriveAuthProvider: mocks.OneDriveAuthProvider,
}));

vi.mock('../../src/api/oneDriveClient', () => ({
	OneDriveClient: mocks.OneDriveClient,
}));

vi.mock('../../src/api/fileOperations', () => ({
	FileOperations: mocks.FileOperations,
}));

vi.mock('../../src/sync/syncEngine', () => ({
	SyncEngine: mocks.SyncEngine,
}));

vi.mock('../../src/sync/syncState', () => ({
	SyncStateManager: mocks.SyncStateManager,
}));

vi.mock('../../src/sync/conflictResolver', () => ({
	ConflictResolver: mocks.ConflictResolver,
}));

vi.mock('../../src/sync/eventManager', () => ({
	EventManager: mocks.EventManager,
}));

vi.mock('../../src/ui/settings', () => ({
	OneDriveSettingTab: mocks.OneDriveSettingTab,
}));

vi.mock('../../src/ui/statusBar', () => ({
	StatusBarManager: mocks.StatusBarManager,
	SyncStatus: { IDLE: 'idle', SYNCING: 'syncing', ERROR: 'error', DISCONNECTED: 'disconnected' },
}));

vi.mock('../../src/ui/authModal', () => ({
	DeviceCodeModal: mocks.DeviceCodeModal,
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import OneDriveSyncPlugin from '../../src/main';
import { DEFAULT_SETTINGS, OneDriveAccessMode } from '../../src/types';

const createApp = () => ({
	vault: {
		adapter: { getBasePath: vi.fn().mockReturnValue('/mock/vault') },
		on: vi.fn().mockReturnValue({}),
		offref: vi.fn(),
		getAbstractFileByPath: vi.fn().mockReturnValue(null),
		create: vi.fn(),
		modify: vi.fn(),
	},
	workspace: {
		on: vi.fn(),
		getLeaf: vi.fn().mockReturnValue({ openFile: vi.fn() }),
	},
});

const createStatusBarItem = () => ({
	setText: vi.fn(),
	empty: vi.fn(),
	createEl: vi.fn().mockReturnValue({}),
});

describe('OneDriveSyncPlugin', () => {
	let plugin: OneDriveSyncPlugin;

	beforeEach(() => {
		vi.clearAllMocks();

		mocks.tokenStorage.hasTokens.mockReturnValue(false);
		mocks.tokenStorage.prepareTokensForSave.mockReturnValue(undefined);
		mocks.oneDriveClient.isSharedDrive.mockReturnValue(false);
		mocks.oneDriveClient.getUserInfo.mockResolvedValue({
			id: '1',
			displayName: 'Test User',
			userPrincipalName: 'test@test.com',
		});
		mocks.syncEngine.performSync.mockResolvedValue(undefined);
		mocks.syncStateManager.prepareForSave.mockReturnValue({ lastSyncTime: 0, fileStates: [] });
		mocks.syncStateManager.getLastSyncTime.mockReturnValue(0);
		mocks.eventManager.triggerManualSync.mockResolvedValue(undefined);
		mocks.eventManager.isSyncInProgress.mockReturnValue(false);
		mocks.eventManager.getDirtyFiles.mockReturnValue([]);

		plugin = new OneDriveSyncPlugin(
			{} as any,
			{
				id: 'obsidian-onedrive',
				name: 'OneDrive Sync',
				version: '0.1.0',
			} as any
		);
		(plugin as any).loadData = vi.fn().mockResolvedValue({});
		(plugin as any).saveData = vi.fn().mockResolvedValue(undefined);
		(plugin as any).addRibbonIcon = vi.fn();
		(plugin as any).addCommand = vi.fn();
		(plugin as any).addStatusBarItem = vi.fn().mockReturnValue(createStatusBarItem());
		(plugin as any).addSettingTab = vi.fn();
		(plugin as any).app = createApp();
	});

	it('loadSettings loads defaults when no saved data exists', async () => {
		await plugin.loadSettings();

		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
	});

	it('loadSettings merges saved data with defaults', async () => {
		(plugin as any).loadData = vi.fn().mockResolvedValue({ syncInterval: 10 });

		await plugin.loadSettings();

		expect(plugin.settings.syncInterval).toBe(10);
		expect(plugin.settings.accessMode).toBe(DEFAULT_SETTINGS.accessMode);
		expect(plugin.settings.conflictResolution).toBe(DEFAULT_SETTINGS.conflictResolution);
	});

	it('saveSettings persists prepared token and sync state data', async () => {
		const savedTokens = { accessToken: 'saved-access' };
		const savedState = { lastSyncTime: 123, fileStates: [['note.md', { path: 'note.md' }]] };
		mocks.tokenStorage.prepareTokensForSave.mockReturnValue(savedTokens);
		mocks.syncStateManager.prepareForSave.mockReturnValue(savedState as any);

		await plugin.onload();
		await plugin.saveSettings();

		expect(mocks.tokenStorage.prepareTokensForSave).toHaveBeenCalled();
		expect(mocks.syncStateManager.prepareForSave).toHaveBeenCalled();
		expect((plugin as any).saveData).toHaveBeenCalledWith(plugin.settings);
		expect(plugin.settings.tokens).toEqual(savedTokens);
		expect(plugin.settings.syncState).toEqual(savedState);
	});

	it('onPluginManifestSyncChanged clears sync state and saves the new setting', async () => {
		await plugin.onload();

		await plugin.onPluginManifestSyncChanged(true);

		expect(plugin.settings.syncPluginManifests).toBe(true);
		expect(mocks.syncStateManager.clearState).toHaveBeenCalledTimes(1);
		expect((plugin as any).saveData).toHaveBeenCalledWith(plugin.settings);
	});

	it('triggerManualSync returns early when no tokens are available', async () => {
		await plugin.onload();
		const performSyncSpy = vi.spyOn(plugin as any, 'performSync');

		await plugin.triggerManualSync();

		expect(mocks.eventManager.triggerManualSync).not.toHaveBeenCalled();
		expect(performSyncSpy).not.toHaveBeenCalled();
	});

	it('triggerManualSync blocks full-access sync until a remote path is set', async () => {
		mocks.tokenStorage.hasTokens.mockReturnValue(true);
		(plugin as any).loadData = vi
			.fn()
			.mockResolvedValue({ accessMode: OneDriveAccessMode.FULL_ACCESS });
		await plugin.onload();
		const performSyncSpy = vi.spyOn(plugin as any, 'performSync');

		await plugin.triggerManualSync();

		expect(mocks.eventManager.triggerManualSync).not.toHaveBeenCalled();
		expect(performSyncSpy).not.toHaveBeenCalled();

		plugin.settings.remotePath = '/Vault';
		await plugin.triggerManualSync();

		expect(mocks.eventManager.triggerManualSync).toHaveBeenCalledTimes(1);
	});

	it('triggerManualSync works in app-folder mode without a remote path', async () => {
		mocks.tokenStorage.hasTokens.mockReturnValue(true);
		(plugin as any).loadData = vi.fn().mockResolvedValue({
			accessMode: OneDriveAccessMode.APP_FOLDER,
			remotePath: undefined,
		});

		await plugin.onload();
		await plugin.triggerManualSync();

		expect(mocks.eventManager.triggerManualSync).toHaveBeenCalledTimes(1);
	});

	it('triggerManualSync returns early when sync engine is missing', async () => {
		mocks.tokenStorage.hasTokens.mockReturnValue(true);
		await plugin.onload();
		const performSyncSpy = vi.spyOn(plugin as any, 'performSync');
		(plugin as any).syncEngine = undefined;

		await plugin.triggerManualSync();

		expect(mocks.eventManager.triggerManualSync).not.toHaveBeenCalled();
		expect(performSyncSpy).not.toHaveBeenCalled();
	});

	it('triggerManualSync returns early when a sync is already in progress', async () => {
		mocks.tokenStorage.hasTokens.mockReturnValue(true);
		mocks.eventManager.isSyncInProgress.mockReturnValue(true);
		await plugin.onload();
		const performSyncSpy = vi.spyOn(plugin as any, 'performSync');

		await plugin.triggerManualSync();

		expect(mocks.eventManager.triggerManualSync).not.toHaveBeenCalled();
		expect(performSyncSpy).not.toHaveBeenCalled();
	});

	it('disconnect clears tokens, connection state, and shared-drive settings', async () => {
		mocks.tokenStorage.hasTokens.mockReturnValue(true);
		(plugin as any).loadData = vi.fn().mockResolvedValue({
			remoteDriveId: 'drive-id',
			remoteItemId: 'item-id',
			remoteRootName: 'Shared Root',
			remoteRootPath: '/Shared Root',
			connectedUser: {
				id: '2',
				displayName: 'Connected User',
				userPrincipalName: 'connected@test.com',
			},
		});
		await plugin.onload();

		await plugin.disconnect();

		expect(mocks.deviceCodeClient.cancelPolling).toHaveBeenCalled();
		expect(mocks.tokenStorage.clearTokens).toHaveBeenCalled();
		expect(mocks.eventManager.stopListening).toHaveBeenCalled();
		expect(plugin.settings.connectedUser).toBeUndefined();
		expect(plugin.settings.remoteDriveId).toBeUndefined();
		expect(plugin.settings.remoteItemId).toBeUndefined();
		expect(plugin.settings.remoteRootName).toBeUndefined();
		expect(plugin.settings.remoteRootPath).toBeUndefined();
		expect((plugin as any).syncEngine).toBeUndefined();
		expect((plugin as any).eventManager).toBeUndefined();
	});

	it('view-sync-logs command creates and opens a log note', async () => {
		mocks.logger.getRecentLogs.mockReturnValue(['[2026-01-01T00:00:00.000Z] [OneDrive Sync] [INFO] Test log']);
		const createdFile = { path: '.obsidian/plugins/obsidian-onedrive/OneDrive Sync Logs.md' } as any;
		(plugin as any).app.vault.create = vi.fn().mockResolvedValue(createdFile);
		const openFile = vi.fn().mockResolvedValue(undefined);
		(plugin as any).app.workspace.getLeaf = vi.fn().mockReturnValue({ openFile });

		await plugin.onload();
		const viewLogsCommand = ((plugin as any).addCommand as any).mock.calls
			.map((call: any[]) => call[0])
			.find((cmd: any) => cmd.id === 'view-sync-logs');

		await viewLogsCommand.callback();

		expect((plugin as any).app.vault.create).toHaveBeenCalledWith(
			'.obsidian/plugins/obsidian-onedrive/OneDrive Sync Logs.md',
			expect.stringContaining('[OneDrive Sync] [INFO] Test log')
		);
		expect(openFile).toHaveBeenCalledWith(createdFile);
	});
});
