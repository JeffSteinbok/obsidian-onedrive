/**
 * OneDrive Sync Plugin for Obsidian
 * Syncs vault with OneDrive Personal/Consumer accounts using Device Code Flow
 */

import { Platform, Plugin, Notice, TFile } from 'obsidian';
import {
	PluginSettings,
	DEFAULT_SETTINGS,
	DEFAULT_EXPERIMENTAL_SETTINGS,
	ExperimentalSettings,
	OneDriveAccessMode,
	OneDriveItem,
} from './types';
import { DEFAULT_ONEDRIVE_CLIENT_ID } from './constants';
import { logger, LogLevel } from './utils/logger';
import { shouldSyncVaultPath } from './utils/pathUtils';
import {
	applyVaultLogHook as applyPluginVaultLogHook,
	type VaultLogAdapter,
} from './utils/logManager';
import {
	ensureSelfInCommunityPluginsList as guardCommunityPluginsList,
	type CommunityPluginsAdapter,
} from './utils/pluginListGuard';

// Auth
import { TokenStorage } from './auth/tokenStorage';
import { DeviceCodeFlowClient } from './auth/deviceCodeFlow';
import { OneDriveAuthProvider } from './auth/authProvider';

// API
import { OneDriveClient } from './api/oneDriveClient';
import { FileOperations } from './api/fileOperations';

// Sync
import { SyncEngine } from './sync/syncEngine';
import { SyncStateManager } from './sync/syncState';
import { ConflictResolver } from './sync/conflictResolver';
import { ConflictQueue } from './sync/conflictQueue';
import { EventManager } from './sync/eventManager';

// UI
import { OneDriveSettingTab } from './ui/settings';
import { StatusBarManager, SyncStatus } from './ui/statusBar';
import { DeviceCodeModal } from './ui/authModal';
import { FolderSelection } from './ui/folderBrowserModal';
import { ConflictView, CONFLICT_VIEW_TYPE } from './ui/conflictView';
import { LargeDeleteWarningModal } from './ui/modals';

import { LargeDeleteWarningInfo, LargeDeleteDecision } from './types';

import { t } from './i18n';
import { timerApi } from './utils/timerApi';

export interface SyncStatusInfo {
	status: SyncStatus;
	lastSyncTime?: number;
	progressMessage?: string;
	conflictCount: number;
}

function isCommunityPluginsAdapter(adapter: unknown): adapter is CommunityPluginsAdapter {
	if (!adapter || typeof adapter !== 'object') {
		return false;
	}

	const candidate = adapter as Record<string, unknown>;
	return ['exists', 'read', 'write'].every((key) => typeof candidate[key] === 'function');
}

function isVaultLogAdapter(adapter: unknown): adapter is VaultLogAdapter {
	if (!adapter || typeof adapter !== 'object') {
		return false;
	}

	const candidate = adapter as Record<string, unknown>;
	return ['exists', 'mkdir', 'write', 'append'].every(
		(key) => typeof candidate[key] === 'function'
	);
}

/**
 * Main plugin class
 */
export default class OneDriveSyncPlugin extends Plugin {
	settings: PluginSettings;

	// Core components
	private tokenStorage: TokenStorage;
	private deviceCodeClient: DeviceCodeFlowClient;
	private authProvider?: OneDriveAuthProvider;
	private oneDriveClient?: OneDriveClient;
	private fileOps?: FileOperations;
	private syncEngine?: SyncEngine;
	private syncStateManager: SyncStateManager;
	private conflictResolver: ConflictResolver;
	private conflictQueue?: ConflictQueue;
	private eventManager?: EventManager;

	// Sync state
	private isSyncing = false;

	// UI components
	private statusBarManager?: StatusBarManager;
	private currentSyncStatus: SyncStatus = SyncStatus.DISCONNECTED;
	private currentProgressMessage?: string;
	private mobileProgressNotice?: Notice;

	async onload() {
		logger.info('Loading OneDrive Sync plugin');

		// Load settings
		await this.loadSettings();

		// Self-heal our entry in community-plugins.json. If we're loading,
		// we're enabled on this device — so don't let a sync from another
		// device (which may not have had us installed yet) silently remove
		// us. Without this, the file ping-pongs and we drop off this device
		// the next time another device's list overwrites ours.
		await this.ensureSelfInCommunityPluginsList();

		// Initialize core components
		this.tokenStorage = new TokenStorage();
		this.tokenStorage.setApp(this.app);
		this.syncStateManager = new SyncStateManager();
		this.conflictResolver = new ConflictResolver(this.settings.conflictResolution);

		// Configure logger early so migration logs are captured
		this.applyLogLevel();
		this.applyVaultLogHook();

		// Load stored data — migrate legacy tokens from data.json to SecretStorage
		const migrated = await this.tokenStorage.loadTokens(this.settings.tokens);
		if (migrated) {
			// Clear legacy tokens from data.json now that they're in SecretStorage
			this.settings.tokens = undefined;
			await this.saveData(this.settings);
		}
		this.syncStateManager.loadState(this.settings.syncState);

		// Initialize device code client with appropriate client ID and access mode
		const clientId = this.settings.useCustomClientId
			? this.settings.customClientId || DEFAULT_ONEDRIVE_CLIENT_ID
			: DEFAULT_ONEDRIVE_CLIENT_ID;
		this.deviceCodeClient = new DeviceCodeFlowClient(clientId, this.settings.accessMode);

		// Initialize authenticated components if we have tokens
		if (this.tokenStorage.hasTokens()) {
			await this.initializeAuthenticatedComponents();
		}

		// Add ribbon icon for manual sync
		this.addRibbonIcon('cloud', t('ribbon.syncNow'), async () => {
			await this.triggerManualSync();
		});

		// Add commands
		this.addCommand({
			id: 'sync-now',
			name: t('commands.syncNow'),
			callback: async () => {
				await this.triggerManualSync();
			},
		});

		this.addCommand({
			id: 'connect-onedrive',
			name: t('commands.connect'),
			callback: async () => {
				await this.authenticate();
			},
		});

		this.addCommand({
			id: 'disconnect-onedrive',
			name: t('commands.disconnect'),
			callback: async () => {
				await this.disconnect();
			},
		});

		this.addCommand({
			id: 'force-full-sync',
			name: t('commands.forceFullSync'),
			callback: async () => {
				this.syncStateManager.clearState();
				await this.saveSettings();
				new Notice(t('notices.sync.stateCleared'));
				await this.triggerManualSync();
			},
		});

		this.addCommand({
			id: 'reconcile-from-cloud',
			name: t('commands.reconcileFromCloud'),
			callback: async () => {
				await this.reconcileFromCloud();
			},
		});

		this.addCommand({
			id: 'show-conflicts',
			name: t('commands.showConflicts'),
			callback: () => {
				void this.activateConflictView();
			},
		});

		this.addCommand({
			id: 'dev-create-test-conflict',
			name: t('commands.devCreateTestConflict'),
			callback: async () => {
				await this.createTestConflict();
			},
		});

		// Register conflict view
		this.registerView(CONFLICT_VIEW_TYPE, (leaf) => {
			if (!this.conflictQueue) {
				throw new Error('Conflict queue not initialized');
			}
			return new ConflictView(leaf, this.conflictQueue, async () => {
				await this.saveSettings();
				this.updateConflictCount();
			});
		});

		// Add status bar item
		const statusBarItem = this.addStatusBarItem();
		this.statusBarManager = new StatusBarManager(statusBarItem, () => {
			void this.triggerManualSync();
		});
		this.updateStatusBar();

		// Add settings tab
		this.addSettingTab(new OneDriveSettingTab(this.app, this));

		// Start event listeners and periodic sync only if sync target is configured
		if (this.tokenStorage.hasTokens() && this.eventManager && this.isSyncConfigured()) {
			this.eventManager.startListening();
			this.eventManager.startPeriodicSync(this.settings.syncInterval || 0);
		}

		// Perform startup sync if configured and sync target is set
		if (
			this.tokenStorage.hasTokens() &&
			this.settings.startupSyncDelay > 0 &&
			this.isSyncConfigured()
		) {
			logger.info(`Startup sync scheduled: will run in ${this.settings.startupSyncDelay}s`);
			timerApi.setTimeout(() => {
				logger.info('Startup sync delay elapsed — triggering sync');
				void this.triggerManualSync();
			}, this.settings.startupSyncDelay * 1000);
		}

		logger.info('OneDrive Sync plugin loaded successfully');
	}

	onunload() {
		logger.info('Unloading OneDrive Sync plugin');
		this.hideMobileProgressNotice();

		// Stop event manager
		if (this.eventManager) {
			this.eventManager.stopListening();
		}

		logger.info('OneDrive Sync plugin unloaded');
	}

	/**
	 * Initialize authenticated components (API clients, sync engine)
	 */
	private async initializeAuthenticatedComponents() {
		logger.info(`Initializing authenticated components (mode: ${this.settings.accessMode})`);

		try {
			// Initialize auth provider
			this.authProvider = new OneDriveAuthProvider(
				this.tokenStorage,
				this.deviceCodeClient,
				async () => {
					// Re-authentication callback
					new Notice(t('notices.auth.expired'));
					await this.authenticate();
				}
			);

			// Initialize OneDrive client with access mode
			this.oneDriveClient = new OneDriveClient(this.authProvider, this.settings.accessMode);
			this.fileOps = new FileOperations(
				this.oneDriveClient,
				() => this.getExperimentalSetting('skipFolderChecks')
			);

			// Configure shared drive if previously selected
			if (
				this.settings.remoteDriveId &&
				this.settings.remoteItemId &&
				this.settings.remoteRootName
			) {
				// Compute the relative path from the shared root to the vault.
				// e.g. remotePath="/Jeff Documents/ObsidianVaults/JeffBrain",
				//      remoteRootName="Jeff Documents"
				//      → relativePathInShared="ObsidianVaults/JeffBrain"
				const relativePathInShared = this.getRelativePathInShared();
				this.oneDriveClient.setRemoteDrive(
					this.settings.remoteDriveId,
					this.settings.remoteItemId,
					this.settings.remoteRootName,
					relativePathInShared
				);
			}

			// Initialize event manager — listening starts after initial sync.
			// Pass syncOnFileChange via constructor so the setting is correct from
			// the moment the EventManager is constructed, before startListening().
			this.eventManager = new EventManager(
				this.app,
				async () => {
					await this.performSync();
				},
				this.syncStateManager,
				(path) =>
					shouldSyncVaultPath(
						path,
						this.settings.syncPluginManifests,
						this.settings.syncAppSettings,
						this.app.vault.configDir,
						this.settings.syncCssSnippets,
						this.settings.syncBookmarks
					),
				this.settings.syncOnFileChange ?? true
			);
			// Wire up pull-only mode check
			this.eventManager.setPullOnlyModeCheck(() => this.getExperimentalSetting('pullOnlyMode'));

			// Initialize conflict queue
			this.conflictQueue = new ConflictQueue(
				this.app,
				this.syncStateManager,
				this.eventManager,
				this.app.vault.configDir
			);
			this.conflictQueue.load(this.settings.conflictQueue);

			// Initialize sync engine
			const isShared = this.oneDriveClient.isSharedDrive();
			const isAppFolder = this.settings.accessMode === OneDriveAccessMode.APP_FOLDER;
			// For shared drives, upload paths are relative to the root.
			// For app folder mode, use the optional subfolder path.
			// For full access, prepend remotePath.
			let remoteRoot: string;
			if (isShared) {
				remoteRoot = '';
			} else if (isAppFolder) {
				remoteRoot = this.settings.appFolderSubpath || '';
			} else {
				// A remotePath of "/" means the user chose the drive root itself,
				// which is equivalent to an empty base path (no prefix). Anything
				// else is a real subfolder path like "/Folder/Sub".
				const configuredPath = this.settings.remotePath || '';
				remoteRoot = configuredPath === '/' ? '' : configuredPath;
			}
			// For path stripping of delta responses, use the FULL path on the
			// remote drive down to the vault folder — not just the shared root.
			// e.g. "/Documents/ObsidianVaults/JeffBrain" not just "/Documents"
			let remoteRootOnDrive: string | undefined;
				if (isShared) {
					remoteRootOnDrive = this.getFullRemoteDrivePath();
				} else if (isAppFolder) {
					// Discover the actual app folder path — the name is set by Azure app
					// registration and may differ from the hardcoded constant.
					const appFolderPath = await this.oneDriveClient.resolveAppFolderPath();
					// Include appFolderSubpath so delta paths get stripped correctly
					remoteRootOnDrive = remoteRoot
						? `${appFolderPath}/${remoteRoot}`
						: appFolderPath;
				}

			this.syncEngine = new SyncEngine(
				this.app,
				this.fileOps,
				this.oneDriveClient,
				this.syncStateManager,
				this.conflictResolver,
				this.eventManager,
				this.app.vault.configDir,
				{
					remoteRoot,
					remoteRootOnDrive,
					isAppFolder,
					conflictQueue: this.conflictQueue,
					shouldSyncPath: (path) =>
						shouldSyncVaultPath(
							path,
							this.settings.syncPluginManifests,
							this.settings.syncAppSettings,
							this.app.vault.configDir,
							this.settings.syncCssSnippets,
							this.settings.syncBookmarks
						),
					getLargeDeleteThreshold: () => this.settings.largeDeleteThreshold ?? 0,
					getNotificationLevel: () => this.settings.notificationLevel ?? 'all',
					largeDeleteWarningHandler: (info) => this.handleLargeDeleteWarning(info),
					onProgress: (msg) => this.setSyncProgress(msg),
					pluginVersion: this.manifest.version,
					maxConcurrentOperations: this.getExperimentalSetting('maxConcurrentOperations'),
					useAtomicMoves: this.getExperimentalSetting('useAtomicMoves'),
					isPullOnlyMode: () => this.getExperimentalSetting('pullOnlyMode'),
				}
			);

			// Get user info to display in settings
			if (!this.settings.connectedUser) {
				const userInfo = await this.oneDriveClient.getUserInfo();
				this.settings.connectedUser = userInfo;
				await this.saveSettings();
			}

			logger.info('Authenticated components initialized');
		} catch (error) {
			logger.error('Failed to initialize authenticated components:', error);
			new Notice(t('notices.auth.clientInitFailed'));
		}
	}

	/**
	 * Authenticate with OneDrive using Device Code Flow
	 */
	async authenticate(): Promise<void> {
		logger.info('Starting authentication flow');

		try {
			// Cancel any in-progress polling from a previous auth attempt
			this.deviceCodeClient.cancelPolling();

			// Recreate the device code client so it uses the current access mode
			const clientId = this.settings.useCustomClientId
				? this.settings.customClientId || DEFAULT_ONEDRIVE_CLIENT_ID
				: DEFAULT_ONEDRIVE_CLIENT_ID;
			this.deviceCodeClient = new DeviceCodeFlowClient(clientId, this.settings.accessMode);
			logger.info(`Authenticating with access mode: ${this.settings.accessMode}`);

			let modalClosed = false;
			let userCompleted = false;

			const tokenPromise = this.deviceCodeClient.authenticate(
				(userCode, verificationUri) => {
					// Show device code modal
					const modal = new DeviceCodeModal(
						this.app,
						userCode,
						verificationUri,
						() => {
							userCompleted = true;
						},
						() => {
							modalClosed = true;
						}
					);
					modal.open();
				},
				() => {
					// Polling callback - user hasn't completed yet
					if (modalClosed && !userCompleted) {
						throw new Error('Authentication cancelled by user');
					}
				}
			);

			// Wait for authentication to complete
			const tokenResponse = await tokenPromise;

			// Validate refresh_token is present (required for token refresh)
			if (!tokenResponse.refresh_token) {
				throw new Error('OAuth response missing refresh_token');
			}

			// Store tokens
			this.tokenStorage.setTokens(
				tokenResponse.access_token,
				tokenResponse.refresh_token,
				tokenResponse.expires_in
			);

			// Save settings
			await this.saveSettings();

			// Initialize authenticated components
			await this.initializeAuthenticatedComponents();

			// Start event listeners and periodic sync (not started in onload when no tokens exist)
			if (this.eventManager && this.isSyncConfigured()) {
				this.eventManager.startListening();
				this.eventManager.startPeriodicSync(this.settings.syncInterval || 0);
			} else if (this.settings.accessMode === OneDriveAccessMode.APP_FOLDER) {
				new Notice(t('notices.sync.selectFolderFirst'));
			}

			// Update status bar
			this.updateStatusBar();

			logger.info('Authentication successful');
			new Notice(t('notices.auth.connectSuccess'));
		} catch (error) {
			logger.error('Authentication failed:', error);
			new Notice(
				t('notices.auth.connectFailed', {
					message: error instanceof Error ? error.message : t('notices.common.unknownError'),
				})
			);
			throw error;
		}
	}

	/**
	 * Disconnect from OneDrive
	 */
	async disconnect(): Promise<void> {
		logger.info('Disconnecting from OneDrive');

		// Cancel any in-progress auth polling
		this.deviceCodeClient.cancelPolling();

		// Stop event manager
		if (this.eventManager) {
			this.eventManager.stopListening();
		}

		// Clear tokens
		this.tokenStorage.clearTokens();

		// Clear any remaining legacy tokens from data.json
		this.settings.tokens = undefined;

		// Clear user info and shared drive settings
		this.settings.connectedUser = undefined;
		this.settings.remoteDriveId = undefined;
		this.settings.remoteItemId = undefined;
		this.settings.remoteRootName = undefined;
		this.settings.remoteRootPath = undefined;

		// Clear components
		this.authProvider = undefined;
		this.oneDriveClient = undefined;
		this.fileOps = undefined;
		this.syncEngine = undefined;
		this.eventManager = undefined;

		// Save settings
		await this.saveSettings();

		// Update status bar
		this.updateStatusBar();

		logger.info('Disconnected from OneDrive');
		new Notice(t('notices.auth.disconnectSuccess'));
	}

	/**
	 * Check if sync target is fully configured
	 */
	private isSyncConfigured(): boolean {
		if (this.settings.accessMode === OneDriveAccessMode.APP_FOLDER) {
			return this.settings.appFolderSubpathConfirmed === true;
		}
		return !!this.settings.remotePath; // Full access needs a folder selected
	}

	/**
	 * Trigger manual sync
	 */
	async triggerManualSync(): Promise<void> {
		if (!this.tokenStorage.hasTokens()) {
			new Notice(t('notices.sync.notConnected'));
			return;
		}

		if (!this.isSyncConfigured()) {
			new Notice(t('notices.sync.selectFolderFirst'));
			return;
		}

		if (!this.syncEngine) {
			new Notice(t('notices.sync.engineNotInitialized'));
			return;
		}

		if (this.eventManager?.isSyncInProgress()) {
			new Notice(t('notices.sync.alreadyInProgress'));
			return;
		}

		// Route through EventManager so suppressEvents is active
		if (this.eventManager) {
			await this.eventManager.triggerManualSync();
		} else {
			await this.performSync();
		}
	}

	/**
	 * Perform sync operation
	 */
	private async performSync(): Promise<void> {
		if (!this.syncEngine) {
			logger.warn('Sync engine not initialized');
			return;
		}

		if (this.isSyncing) {
			logger.debug('Sync already in progress, skipping');
			return;
		}

		this.isSyncing = true;
		try {
			// Update status bar
			this.setSyncStatus(SyncStatus.SYNCING);

			// Perform sync
			await this.syncEngine.performSync();

			// Update status bar
			const now = Date.now();
			this.statusBarManager?.setLastSyncTime(now);
			this.setSyncStatus(SyncStatus.IDLE);

			// Update conflict count and reveal view if there are new conflicts
			this.updateConflictCount();
			if (this.conflictQueue && this.conflictQueue.count > 0) {
				void this.activateConflictView();
			}

			// Save sync state
			await this.saveSettings();

			logger.info('Sync completed successfully');
		} catch (error) {
			logger.error('Sync failed:', error);
			this.setSyncStatus(SyncStatus.ERROR);
			const errorMsg = error instanceof Error ? error.message : t('notices.common.unknownError');
			if ((this.settings.notificationLevel ?? 'all') !== 'off') {
				new Notice(t('notices.sync.failed', { message: errorMsg }));
			}
			throw error;
		} finally {
			this.isSyncing = false;
		}
	}

	/**
	 * Update status bar based on current state
	 */
	private updateStatusBar(): void {
		if (!this.statusBarManager) return;

		if (this.tokenStorage.hasTokens()) {
			const lastSyncTime = this.syncStateManager.getLastSyncTime();
			if (lastSyncTime > 0) {
				this.statusBarManager.setLastSyncTime(lastSyncTime);
			}
			this.setSyncStatus(SyncStatus.IDLE);
		} else {
			this.setSyncStatus(SyncStatus.DISCONNECTED);
		}
	}

	getSyncStatusInfo(): SyncStatusInfo {
		const lastSyncTime = this.syncStateManager.getLastSyncTime();
		return {
			status: this.currentSyncStatus,
			lastSyncTime: lastSyncTime > 0 ? lastSyncTime : undefined,
			progressMessage: this.currentProgressMessage,
			conflictCount: this.conflictQueue?.count ?? 0,
		};
	}

	/**
	 * List folders at a path for the folder picker.
	 * Supports both the user's own drive and shared folder navigation.
	 */
	async listFoldersForPicker(
		path: string,
		sharedDriveId?: string,
		sharedItemId?: string,
		relativePathInShared?: string
	): Promise<OneDriveItem[]> {
		if (!this.oneDriveClient) {
			throw new Error('Not connected to OneDrive');
		}
		return this.oneDriveClient.listFoldersForPicker(
			path,
			sharedDriveId,
			sharedItemId,
			relativePathInShared
		);
	}

	/**
	 * Compute the relative path from the shared root to the vault folder.
	 * e.g. remotePath="/Jeff Documents/ObsidianVaults/JeffBrain",
	 *      remoteRootName="Jeff Documents"
	 *      → "ObsidianVaults/JeffBrain"
	 * Returns "" when the vault IS the shared root.
	 */
	private getRelativePathInShared(): string {
		const remotePath = this.settings.remotePath || '';
		const rootName = this.settings.remoteRootName || '';
		if (!remotePath || !rootName) return '';

		// remotePath looks like "/Jeff Documents/ObsidianVaults/JeffBrain"
		// Strip the leading "/{rootName}" prefix to get the relative part
		const prefix = `/${rootName}`;
		const normalized = remotePath.startsWith(prefix)
			? remotePath.substring(prefix.length)
			: remotePath;
		return normalized.replace(/^\/+|\/+$/g, '');
	}

	/**
	 * Get the full path on the remote drive down to the vault folder.
	 * Used for delta path stripping — must include the path to the shared
	 * root (remoteRootPath) PLUS the relative path within it.
	 *
	 * e.g. remoteRootPath="/Documents", relative="ObsidianVaults/JeffBrain"
	 *      → "/Documents/ObsidianVaults/JeffBrain"
	 */
	private getFullRemoteDrivePath(): string {
		const basePath = this.settings.remoteRootPath || `/${this.settings.remoteRootName || ''}`;
		const relative = this.getRelativePathInShared();
		if (!relative) return basePath;
		const cleanBase = basePath.replace(/\/+$/g, '');
		return `${cleanBase}/${relative}`;
	}

	/**
	 * Called when the user selects a new remote folder from the picker.
	 * Stores settings, clears stale sync state, and reconfigures components.
	 */
	async onRemoteFolderChanged(selection: FolderSelection): Promise<void> {
		logger.info('Remote folder changed:', selection);

		const oldPath = this.settings.remotePath;
		const oldDriveId = this.settings.remoteDriveId;

		this.settings.remotePath = selection.path;

		if (selection.isShared && selection.driveId && selection.itemId) {
			this.settings.remoteDriveId = selection.driveId;
			this.settings.remoteItemId = selection.itemId;
			this.settings.remoteRootName = selection.name;

			// Resolve the actual path on the remote drive for delta path stripping
			if (this.oneDriveClient) {
				try {
					const resolvedPath = await this.oneDriveClient.resolveSharedFolderPath(
						selection.driveId,
						selection.itemId
					);
					this.settings.remoteRootPath = resolvedPath;
					logger.info(`Resolved shared folder path on remote drive: ${resolvedPath}`);
				} catch (error) {
					logger.warn('Could not resolve shared folder path, using name fallback:', error);
					this.settings.remoteRootPath = `/${selection.name}`;
				}
			}
		} else {
			this.settings.remoteDriveId = undefined;
			this.settings.remoteItemId = undefined;
			this.settings.remoteRootName = undefined;
			this.settings.remoteRootPath = undefined;
		}

		// Clear stale sync state when the target folder changes
		if (oldPath !== selection.path || oldDriveId !== this.settings.remoteDriveId) {
			this.syncStateManager.clearState();
			this.resetDeviceSpecificSyncSettings();
			logger.info('Cleared sync state due to remote folder change');
		}

		await this.saveSettings();

		// Reinitialize components with the new folder config
		if (this.tokenStorage.hasTokens()) {
			await this.initializeAuthenticatedComponents();

			if (this.eventManager && this.isSyncConfigured()) {
				this.eventManager.startListening();
				this.eventManager.startPeriodicSync(this.settings.syncInterval || 0);
			}
		}

		new Notice(
			t(selection.isShared ? 'notices.sync.folderSetShared' : 'notices.sync.folderSet', {
				path: selection.path,
			})
		);
		new Notice(t('notices.sync.deviceTypeSyncHint'));
	}

	/**
	 * List folders within the App Folder for the folder picker.
	 */
	async listAppFoldersForPicker(path: string): Promise<OneDriveItem[]> {
		if (!this.oneDriveClient) {
			throw new Error('Not connected to OneDrive');
		}
		return this.oneDriveClient.listAppFoldersForPicker(path);
	}

	/**
	 * Called when the user selects a new subfolder within App Folder mode.
	 * Stores settings, clears stale sync state, and reconfigures components.
	 */
	async onAppFolderSubpathChanged(subpath: string): Promise<void> {
		logger.info('App Folder subpath changed:', subpath);

		const oldSubpath = this.settings.appFolderSubpath;

		// Store the new subpath (strip leading/trailing slashes)
		this.settings.appFolderSubpath = subpath.replace(/^\/+|\/+$/g, '');
		this.settings.appFolderSubpathConfirmed = true;

		// Clear sync state when the target folder changes
		if (oldSubpath !== this.settings.appFolderSubpath) {
			this.syncStateManager.clearState();
			this.resetDeviceSpecificSyncSettings();
			logger.info('Cleared sync state due to App Folder subpath change');
		}

		await this.saveSettings();

		// Reinitialize components with the new folder config
		if (this.tokenStorage.hasTokens()) {
			await this.initializeAuthenticatedComponents();

			if (this.eventManager && this.isSyncConfigured()) {
				this.eventManager.startListening();
				this.eventManager.startPeriodicSync(this.settings.syncInterval || 0);
			}
		}

		const displayPath = this.settings.appFolderSubpath || t('settings.syncFolder.appFolderRoot');
		new Notice(t('notices.sync.folderSet', { path: displayPath }));
		new Notice(t('notices.sync.deviceTypeSyncHint'));
	}

	private resetDeviceSpecificSyncSettings(): void {
		// Folder-change flows call saveSettings() after applying this reset.
		this.settings.syncAppSettings = false;
		this.settings.syncPluginManifests = false;
		this.settings.syncCssSnippets = false;
		this.settings.syncBookmarks = false;
	}

	/**
	 * Activate (or reveal) the conflict resolution view
	 */
	private async activateConflictView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(CONFLICT_VIEW_TYPE);
		if (existing.length > 0) {
			void this.app.workspace.revealLeaf(existing[0]);
			// Re-render in case queue changed
			const view = existing[0].view;
			if (view instanceof ConflictView) {
				await view.renderView();
			}
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: CONFLICT_VIEW_TYPE, active: true });
			void this.app.workspace.revealLeaf(leaf);
		}
	}

	/**
	 * Update the conflict count in the status bar
	 */
	private updateConflictCount(): void {
		const count = this.conflictQueue?.count ?? 0;
		this.statusBarManager?.setConflictCount(count);
	}

	private setSyncStatus(status: SyncStatus): void {
		this.currentSyncStatus = status;
		if (status !== SyncStatus.SYNCING) {
			this.currentProgressMessage = undefined;
		}
		this.statusBarManager?.setStatus(status);
		this.updateMobileProgressNotice();
	}

	private setSyncProgress(message: string | undefined): void {
		this.currentProgressMessage = message;
		this.statusBarManager?.setProgress(message);
		this.updateMobileProgressNotice();
	}

	private updateMobileProgressNotice(): void {
		if (!this.isMobileClient()) return;
		if ((this.settings.notificationLevel ?? 'all') !== 'all') {
			this.hideMobileProgressNotice();
			return;
		}
		if (this.currentSyncStatus !== SyncStatus.SYNCING) {
			this.hideMobileProgressNotice();
			return;
		}

		const message = this.currentProgressMessage
			? t('mobileProgress.withProgress', { progress: this.currentProgressMessage })
			: t('mobileProgress.inProgress');

		if (!this.mobileProgressNotice) {
			this.mobileProgressNotice = new Notice(message, 0);
		} else {
			this.mobileProgressNotice.setMessage(message);
		}
	}

	private hideMobileProgressNotice(): void {
		if (this.mobileProgressNotice) {
			this.mobileProgressNotice.hide();
			this.mobileProgressNotice = undefined;
		}
	}

	private isMobileClient(): boolean {
		return (
			(Platform as { isMobile?: boolean } | undefined)?.isMobile === true ||
			(this.app as { isMobile?: boolean }).isMobile === true
		);
	}

	/**
	 * DEV: Create a fake conflict for testing the conflict resolution UI.
	 * Picks the active file (or first .md file) and fabricates a
	 * simulated "incoming" version with some changes.
	 */
	private async createTestConflict(): Promise<void> {
		if (!this.conflictQueue) {
			// Initialize a standalone queue if not authenticated
			if (!this.eventManager) {
				this.eventManager = new EventManager(
					this.app,
					async () => {},
					this.syncStateManager,
					(path) =>
						shouldSyncVaultPath(
							path,
							this.settings.syncPluginManifests,
							false,
							this.app.vault.configDir,
							false
						)
				);
				this.eventManager.setPullOnlyModeCheck(() => this.getExperimentalSetting('pullOnlyMode'));
			}
			this.conflictQueue = new ConflictQueue(
				this.app,
				this.syncStateManager,
				this.eventManager,
				this.app.vault.configDir
			);
			this.conflictQueue.load(this.settings.conflictQueue);
		}

		// Pick the active file, or fall back to the first .md file
		const activeFile = this.app.workspace.getActiveFile?.();
		const file =
			activeFile instanceof TFile
				? activeFile
				: this.app.vault.getFiles().find((f: TFile) => f.extension === 'md');

		if (!file) {
			new Notice(t('notices.dev.noFileFound'));
			return;
		}

		const localContent = await this.app.vault.readBinary(file);
		const decoder = new TextDecoder('utf-8');
		const localText = decoder.decode(localContent);

		// Fabricate a fake "incoming" version
		const fakeRemoteText =
			localText + '\n\n---\n_This line was added on another device (simulated incoming change)_\n';
		const fakeRemoteContent = new TextEncoder().encode(fakeRemoteText).buffer;

		await this.conflictQueue.add(
			file.path,
			localContent,
			fakeRemoteContent,
			file.stat.mtime,
			Date.now() - 60000, // pretend remote was modified 1 minute ago
			`dev-test-${Date.now()}`,
			'fake-hash'
		);

		await this.saveSettings();
		this.updateConflictCount();
		await this.activateConflictView();

		new Notice(t('notices.dev.createdTestConflict', { path: file.path }));
	}

	/**
	 * Load settings from disk
	 */
	async loadSettings() {
		const loaded = ((await this.loadData()) as Partial<PluginSettings>) ?? {};
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			loaded
		);

		// Migrate legacy enableDebugLogging boolean → logLevel string
		const raw = this.settings as unknown as Record<string, unknown>;
		if ('enableDebugLogging' in raw) {
			if (raw['enableDebugLogging'] === true && this.settings.logLevel === 'off') {
				this.settings.logLevel = 'debug';
			}
			delete raw['enableDebugLogging'];
		}

		// Migration: existing connected users in App Folder mode should keep syncing
		// without requiring a one-time re-selection after upgrade.
		if (this.settings.accessMode === OneDriveAccessMode.APP_FOLDER) {
			if (typeof loaded.appFolderSubpathConfirmed === 'boolean') {
				this.settings.appFolderSubpathConfirmed = loaded.appFolderSubpathConfirmed;
			} else {
				this.settings.appFolderSubpathConfirmed = !!(
					this.settings.connectedUser || this.settings.appFolderSubpath
				);
			}
		}
	}

	/**
	 * Get an experimental setting with fallback to defaults.
	 * Experimental settings are optional and may not exist in saved data.
	 */
	getExperimentalSetting<K extends keyof ExperimentalSettings>(key: K): ExperimentalSettings[K] {
		return this.settings.experimental?.[key] ?? DEFAULT_EXPERIMENTAL_SETTINGS[key];
	}

	/**
	 * Make sure this plugin's id is listed in `.obsidian/community-plugins.json`.
	 * That file is the list of *enabled* plugins; if a sync from another device
	 * overwrites it with a version that doesn't include us, we'd silently
	 * disappear on next Obsidian launch. Since we're running, we're enabled —
	 * re-add ourselves if missing.
	 */
	private async ensureSelfInCommunityPluginsList(): Promise<void> {
		const id = this.manifest?.id;
		if (!id) {
			return;
		}

		const { adapter } = this.app.vault;
		if (!isCommunityPluginsAdapter(adapter)) {
			logger.warn('Vault adapter does not support community plugin self-healing');
			return;
		}

		await guardCommunityPluginsList(adapter, id, this.app.vault.configDir);
	}

	async onPluginManifestSyncChanged(enabled: boolean): Promise<void> {
		if (this.settings.syncPluginManifests === enabled) {
			return;
		}

		this.settings.syncPluginManifests = enabled;
		await this.saveSettings();
	}

	async onAppSettingsSyncChanged(enabled: boolean): Promise<void> {
		if (this.settings.syncAppSettings === enabled) {
			return;
		}

		this.settings.syncAppSettings = enabled;
		await this.saveSettings();
	}

	async onCssSnippetSyncChanged(enabled: boolean): Promise<void> {
		if (this.settings.syncCssSnippets === enabled) {
			return;
		}

		this.settings.syncCssSnippets = enabled;
		await this.saveSettings();
	}

	async onBookmarkSyncChanged(enabled: boolean): Promise<void> {
		if (this.settings.syncBookmarks === enabled) {
			return;
		}

		this.settings.syncBookmarks = enabled;
		await this.saveSettings();
	}

	async resetSyncToken(): Promise<void> {
		this.syncStateManager.clearDeltaLink();
		await this.saveSettings();
		new Notice(t('notices.sync.reset'));
	}

	/**
	 * Reconcile the local vault from a full cloud listing. Treats cloud as
	 * authoritative — local-only files are deleted, remote-only files are
	 * downloaded. Destructive deletes are confirmed via the large-delete
	 * modal. See issue #26.
	 */
	async reconcileFromCloud(): Promise<void> {
		if (!this.tokenStorage.hasTokens()) {
			new Notice(t('notices.reconcile.notConnected'));
			return;
		}
		if (!this.isSyncConfigured()) {
			new Notice(t('notices.reconcile.selectFolderFirst'));
			return;
		}
		if (!this.syncEngine) {
			new Notice(t('notices.reconcile.engineNotInitialized'));
			return;
		}
		if (this.isSyncing || this.eventManager?.isSyncInProgress()) {
			new Notice(t('notices.reconcile.alreadyInProgress'));
			return;
		}
		this.isSyncing = true;
		try {
			this.setSyncStatus(SyncStatus.SYNCING);
			await this.syncEngine.reconcileFromCloud();
			await this.saveSettings();
			this.setSyncStatus(SyncStatus.IDLE);
		} catch (error) {
			this.setSyncStatus(SyncStatus.ERROR);
			throw error;
		} finally {
			this.isSyncing = false;
		}
	}

	/**
	 * Save settings to disk
	 */
	async saveSettings() {
		// Tokens are now stored in SecretStorage, not in data.json

		// Prepare sync state for save
		this.settings.syncState = this.syncStateManager.prepareForSave();

		// Prepare conflict queue for save
		if (this.conflictQueue) {
			this.settings.conflictQueue = this.conflictQueue.prepareForSave();
		}

		// Update conflict resolver strategy if changed
		if (this.conflictResolver) {
			this.conflictResolver.setStrategy(this.settings.conflictResolution);
		}

		// Update event manager sync-on-file-change setting
		if (this.eventManager) {
			this.eventManager.setSyncOnFileChange(this.settings.syncOnFileChange ?? true);
		}

		// Update logger level if changed
		this.applyLogLevel();
		this.applyVaultLogHook();

		await this.saveData(this.settings);
	}

	private static readonly LOG_LEVEL_MAP: Record<string, LogLevel> = {
		off: LogLevel.OFF,
		error: LogLevel.ERROR,
		warn: LogLevel.WARN,
		info: LogLevel.INFO,
		debug: LogLevel.DEBUG,
	};

	private applyLogLevel(): void {
		const level = OneDriveSyncPlugin.LOG_LEVEL_MAP[this.settings.logLevel] ?? LogLevel.OFF;
		logger.setLogLevel(level);
	}

	/**
	 * Install (or remove) a Logger hook that appends each log line to a
	 * vault-root daily log file. Files match `_OneDriveSyncLogs-YYYY-MM-DD.md`
	 * and are explicitly excluded from sync via shouldSyncVaultPath so each
	 * device keeps its own.
	 */
	private applyVaultLogHook(): void {
		const { adapter } = this.app.vault;
		if (!isVaultLogAdapter(adapter)) {
			logger.setVaultLogHook(null);
			return;
		}

		applyPluginVaultLogHook({
			enabled: this.settings.logLevel !== 'off',
			adapter,
			stamp: this.buildVaultLogStamp(),
			setVaultLogHook: (hook) => {
				logger.setVaultLogHook(hook);
			},
		});
	}

	private buildVaultLogStamp(): string {
		const syncRoot =
			this.settings.accessMode === OneDriveAccessMode.APP_FOLDER
				? this.settings.appFolderSubpath || '(app-folder root)'
				: this.settings.remoteRootPath || this.settings.remotePath || '/';
		const config = {
			accessMode: this.settings.accessMode,
			syncRoot,
			syncInterval: this.settings.syncInterval,
			syncOnFileChange: this.settings.syncOnFileChange ?? true,
			startupSyncDelay: this.settings.startupSyncDelay,
			conflictResolution: this.settings.conflictResolution,
			syncAppSettings: this.settings.syncAppSettings,
			syncPluginManifests: this.settings.syncPluginManifests,
			syncCssSnippets: this.settings.syncCssSnippets,
			syncBookmarks: this.settings.syncBookmarks,
			notificationLevel: this.settings.notificationLevel ?? 'all',
			logLevel: this.settings.logLevel,
			pullOnlyMode: this.getExperimentalSetting('pullOnlyMode'),
		};

		return [
			`**Plugin version:** \`${this.manifest.version}\``,
			`**Config:** \`${JSON.stringify(config)}\``,
		].join('\n');
	}

	/**
	 * Show the large-delete warning modal and act on the user's choice.
	 *
	 * When the user picks "Disable plugin", we actually disable the plugin
	 * after the modal closes (so the modal can finish unmounting first).
	 * Either 'cancel' or 'disable' is returned to the sync engine, which
	 * treats both as "abort this sync without advancing delta cursors".
	 */
	private handleLargeDeleteWarning(info: LargeDeleteWarningInfo): Promise<LargeDeleteDecision> {
		return new Promise((resolve) => {
			const modal = new LargeDeleteWarningModal(this.app, info, (decision) => {
				if (decision === 'disable') {
					// Defer so the modal closes cleanly before unloading the plugin.
					timerApi.setTimeout(() => {
						try {
							const plugins = (
								this.app as unknown as {
									plugins?: { disablePlugin?: (id: string) => Promise<void> | void };
								}
							).plugins;
							if (plugins?.disablePlugin) {
								void plugins.disablePlugin(this.manifest.id);
							}
						} catch (err) {
							logger.error(
								`Failed to disable plugin from large-delete modal: ${(err as Error)?.message || err}`
							);
						}
					}, 0);
				}
				resolve(decision);
			});
			modal.open();
		});
	}
}
