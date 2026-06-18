const mocks = vi.hoisted(() => {
	const logger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		setLogLevel: vi.fn(),
		setDebugMode: vi.fn(),
		enableFileLogging: vi.fn(),
		setVaultLogHook: vi.fn(),
	};

	const tokenStorage = {
		setApp: vi.fn(),
		loadTokens: vi.fn().mockResolvedValue(false),
		hasTokens: vi.fn().mockReturnValue(false),
		setTokens: vi.fn(),
		clearTokens: vi.fn(),
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
		resolveAppFolderPath: vi.fn().mockResolvedValue('/Apps/ObsidianOneDrive'),
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

	const conflictQueue = {
		load: vi.fn(),
		prepareForSave: vi.fn().mockReturnValue(undefined),
		add: vi.fn().mockResolvedValue(undefined),
		count: 0,
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
		setProgress: vi.fn(),
		setConflictCount: vi.fn(),
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
		conflictQueue,
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
		ConflictQueue: vi.fn().mockImplementation(function () {
			return conflictQueue;
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
	LogLevel: {
		DEBUG: 0,
		INFO: 1,
		WARN: 2,
		ERROR: 3,
		OFF: 4,
	},
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

vi.mock('../../src/sync/conflictQueue', () => ({
	ConflictQueue: mocks.ConflictQueue,
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
		configDir: '.obsidian',
		adapter: {
			getBasePath: vi.fn().mockReturnValue('/mock/vault'),
			exists: vi.fn().mockResolvedValue(true),
			mkdir: vi.fn().mockResolvedValue(undefined),
		},
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
		mocks.oneDriveClient.isSharedDrive.mockReturnValue(false);
		mocks.oneDriveClient.getUserInfo.mockResolvedValue({
			id: '1',
			displayName: 'Test User',
			userPrincipalName: 'test@test.com',
		});
		mocks.syncEngine.performSync.mockResolvedValue(undefined);
		mocks.syncStateManager.prepareForSave.mockReturnValue({ lastSyncTime: 0, fileStates: [] });
		mocks.syncStateManager.getLastSyncTime.mockReturnValue(0);
		mocks.conflictQueue.load.mockReset();
		mocks.conflictQueue.prepareForSave.mockReturnValue(undefined);
		mocks.conflictQueue.add.mockResolvedValue(undefined);
		mocks.conflictQueue.count = 0;
		mocks.eventManager.triggerManualSync.mockResolvedValue(undefined);
		mocks.eventManager.isSyncInProgress.mockReturnValue(false);
		mocks.eventManager.getDirtyFiles.mockReturnValue([]);

		plugin = new OneDriveSyncPlugin(
			{} as any,
			{
				id: 'onedrive-sync',
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

	it('saveSettings persists sync state data (tokens stored in SecretStorage)', async () => {
		const savedState = { lastSyncTime: 123, fileStates: [['note.md', { path: 'note.md' }]] };
		mocks.syncStateManager.prepareForSave.mockReturnValue(savedState as any);

		await plugin.onload();
		await plugin.saveSettings();

		expect(mocks.syncStateManager.prepareForSave).toHaveBeenCalled();
		expect((plugin as any).saveData).toHaveBeenCalledWith(plugin.settings);
		// Tokens should NOT be in settings — they're in SecretStorage now
		expect(plugin.settings.tokens).toBeUndefined();
		expect(plugin.settings.syncState).toEqual(savedState);
	});

	it('onPluginManifestSyncChanged saves the new setting without resetting sync state', async () => {
		await plugin.onload();

		// Default is now true, so toggle to false then back to true
		await plugin.onPluginManifestSyncChanged(false);
		await plugin.onPluginManifestSyncChanged(true);

		expect(plugin.settings.syncPluginManifests).toBe(true);
		expect(mocks.syncStateManager.clearState).not.toHaveBeenCalled();
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

	it('getSyncStatusInfo reports disconnected and unsynced state by default', async () => {
		await plugin.onload();

		expect(plugin.getSyncStatusInfo()).toEqual({
			status: 'disconnected',
			lastSyncTime: undefined,
			progressMessage: undefined,
			conflictCount: 0,
		});
	});

	it('getSyncStatusInfo reports idle status and last sync time when connected', async () => {
		mocks.tokenStorage.hasTokens.mockReturnValue(true);
		mocks.syncStateManager.getLastSyncTime.mockReturnValue(123456);
		await plugin.onload();

		expect(plugin.getSyncStatusInfo()).toEqual({
			status: 'idle',
			lastSyncTime: 123456,
			progressMessage: undefined,
			conflictCount: 0,
		});
	});

	it('getSyncStatusInfo reports in-progress sync details', async () => {
		await plugin.onload();
		(plugin as any).setSyncStatus('syncing');
		(plugin as any).setSyncProgress('3/10 files');

		expect(plugin.getSyncStatusInfo()).toEqual({
			status: 'syncing',
			lastSyncTime: undefined,
			progressMessage: '3/10 files',
			conflictCount: 0,
		});
	});

	it('clears progress message when sync status leaves syncing', async () => {
		await plugin.onload();
		(plugin as any).setSyncStatus('syncing');
		(plugin as any).setSyncProgress('2/5 files');
		(plugin as any).setSyncStatus('idle');

		expect(plugin.getSyncStatusInfo().progressMessage).toBeUndefined();
	});

	it('SyncEngine receives remoteRootOnDrive that includes appFolderSubpath', async () => {
		mocks.tokenStorage.hasTokens.mockReturnValue(true);
		mocks.oneDriveClient.resolveAppFolderPath.mockResolvedValue('/Apps/ObsidianOneDrive');
		(plugin as any).loadData = vi.fn().mockResolvedValue({
			accessMode: OneDriveAccessMode.APP_FOLDER,
			appFolderSubpath: 'Test1',
		});

		await plugin.onload();
		await plugin.triggerManualSync();

		// SyncEngine constructor: remoteRoot is arg 7 (index 7), remoteRootOnDrive is arg 8 (index 8)
		const syncEngineCall = mocks.SyncEngine.mock.calls[0];
		expect(syncEngineCall[7]).toBe('Test1'); // remoteRoot (the subpath)
		expect(syncEngineCall[8]).toBe('/Apps/ObsidianOneDrive/Test1'); // remoteRootOnDrive (app folder + subpath)
	});

	it('SyncEngine receives correct remoteRootOnDrive for app folder without subpath', async () => {
		mocks.tokenStorage.hasTokens.mockReturnValue(true);
		mocks.oneDriveClient.resolveAppFolderPath.mockResolvedValue('/Apps/ObsidianOneDrive');
		(plugin as any).loadData = vi.fn().mockResolvedValue({
			accessMode: OneDriveAccessMode.APP_FOLDER,
			appFolderSubpath: undefined,
		});

		await plugin.onload();
		await plugin.triggerManualSync();

		const syncEngineCall = mocks.SyncEngine.mock.calls[0];
		expect(syncEngineCall[7]).toBe(''); // remoteRoot (empty = app folder root)
		expect(syncEngineCall[8]).toBe('/Apps/ObsidianOneDrive'); // remoteRootOnDrive (just app folder)
	});

	it('SyncEngine receives correct paths for full access mode', async () => {
		mocks.tokenStorage.hasTokens.mockReturnValue(true);
		(plugin as any).loadData = vi.fn().mockResolvedValue({
			accessMode: OneDriveAccessMode.FULL_ACCESS,
			remotePath: '/Documents/MyVault',
		});

		await plugin.onload();
		await plugin.triggerManualSync();

		const syncEngineCall = mocks.SyncEngine.mock.calls[0];
		expect(syncEngineCall[7]).toBe('/Documents/MyVault'); // remoteRoot
		expect(syncEngineCall[8]).toBeUndefined(); // remoteRootOnDrive (undefined for full access)
	});

});
