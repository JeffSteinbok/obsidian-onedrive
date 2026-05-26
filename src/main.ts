/**
 * OneDrive Sync Plugin for Obsidian
 * Syncs vault with OneDrive Personal/Consumer accounts using Device Code Flow
 */

import { Plugin, Notice } from 'obsidian';
import { PluginSettings, DEFAULT_SETTINGS, OneDriveAccessMode, OneDriveItem } from './types';
import { DEFAULT_ONEDRIVE_CLIENT_ID, ONEDRIVE_PATHS } from './constants';
import { logger } from './utils/logger';

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
import { EventManager } from './sync/eventManager';

// UI
import { OneDriveSettingTab } from './ui/settings';
import { StatusBarManager, SyncStatus } from './ui/statusBar';
import { DeviceCodeModal } from './ui/authModal';
import { FolderSelection } from './ui/folderBrowserModal';

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
	private eventManager?: EventManager;

	// UI components
	private statusBarManager?: StatusBarManager;

	async onload() {
		// eslint-disable-next-line no-console
		console.log('Loading OneDrive Sync plugin');

		// Load settings
		await this.loadSettings();

		// Initialize core components
		this.tokenStorage = new TokenStorage();
		this.syncStateManager = new SyncStateManager();
		this.conflictResolver = new ConflictResolver(this.settings.conflictResolution);

		// Load stored data
		this.tokenStorage.loadTokens(this.settings.tokens);
		this.syncStateManager.loadState(this.settings.syncState);

		// Configure logger
		logger.setDebugMode(this.settings.enableDebugLogging);
		// Enable file logging so we can `tail -f` from terminal
		const vaultPath = (this.app.vault.adapter as any).getBasePath?.();
		if (vaultPath) {
			logger.enableFileLogging(vaultPath);
		}

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
		this.addRibbonIcon('cloud', 'OneDrive: Sync now', async () => {
			await this.triggerManualSync();
		});

		// Add commands
		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: async () => {
				await this.triggerManualSync();
			},
		});

		this.addCommand({
			id: 'connect-onedrive',
			name: 'Connect to OneDrive',
			callback: async () => {
				await this.authenticate();
			},
		});

		this.addCommand({
			id: 'disconnect-onedrive',
			name: 'Disconnect from OneDrive',
			callback: async () => {
				await this.disconnect();
			},
		});

		this.addCommand({
			id: 'force-full-sync',
			name: 'Force full sync (re-download everything)',
			callback: async () => {
				this.syncStateManager.clearState();
				await this.saveSettings();
				new Notice('Sync state cleared. Running full sync...');
				await this.triggerManualSync();
			},
		});

		// Add status bar item
		const statusBarItem = this.addStatusBarItem();
		this.statusBarManager = new StatusBarManager(statusBarItem, () => {
			this.triggerManualSync();
		});
		this.updateStatusBar();

		// Add settings tab
		this.addSettingTab(new OneDriveSettingTab(this.app, this));

		// Start event listeners immediately — create events for known files
		// are filtered deterministically via sync state, no timing needed
		if (this.tokenStorage.hasTokens() && this.eventManager) {
			this.eventManager.startListening();
			this.eventManager.startPeriodicSync(this.settings.syncInterval || 0);
		}

		// Perform startup sync if configured
		if (this.tokenStorage.hasTokens() && this.settings.startupSyncDelay > 0) {
			setTimeout(async () => {
				await this.triggerManualSync();
			}, this.settings.startupSyncDelay * 1000);
		}

		logger.info('OneDrive Sync plugin loaded successfully');
	}

	onunload() {
		// eslint-disable-next-line no-console
		console.log('Unloading OneDrive Sync plugin');

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
					new Notice('OneDrive authentication expired. Please reconnect.');
					await this.authenticate();
				}
			);

			// Initialize OneDrive client with access mode
			this.oneDriveClient = new OneDriveClient(this.authProvider, this.settings.accessMode);
			this.fileOps = new FileOperations(this.oneDriveClient);

			// Configure shared drive if previously selected
			if (this.settings.remoteDriveId && this.settings.remoteItemId && this.settings.remoteRootName) {
				this.oneDriveClient.setRemoteDrive(
					this.settings.remoteDriveId,
					this.settings.remoteItemId,
					this.settings.remoteRootName
				);
			}

			// Initialize event manager — listening starts after initial sync
			this.eventManager = new EventManager(this.app, async () => {
				await this.performSync();
			}, this.syncStateManager);

			// Initialize sync engine
			const isShared = this.oneDriveClient.isSharedDrive();
			// For shared drives, upload paths are relative to the shared folder (no prefix needed).
			// For non-shared, prepend the remote path.
			const remoteRoot = isShared ? '' : (this.settings.remotePath || ONEDRIVE_PATHS.APP_FOLDER);
			// For path stripping of delta responses, use the folder name on the remote drive
			const remoteRootOnDrive = isShared
				? `/${this.settings.remoteRootName}`
				: undefined;

			this.syncEngine = new SyncEngine(
				this.app,
				this.fileOps,
				this.oneDriveClient,
				this.syncStateManager,
				this.conflictResolver,
				this.eventManager,
				remoteRoot,
				remoteRootOnDrive
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
			new Notice('Failed to initialize OneDrive client. Please reconnect.');
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

			// Store tokens
			this.tokenStorage.setTokens(
				tokenResponse.access_token,
				tokenResponse.refresh_token!,
				tokenResponse.expires_in
			);

			// Save settings
			await this.saveSettings();

			// Initialize authenticated components
			await this.initializeAuthenticatedComponents();

			// Start event listeners and periodic sync (not started in onload when no tokens exist)
			if (this.eventManager) {
				this.eventManager.startListening();
				this.eventManager.startPeriodicSync(this.settings.syncInterval || 0);
			}

			// Update status bar
			this.updateStatusBar();

			logger.info('Authentication successful');
			new Notice('Successfully connected to OneDrive');
		} catch (error) {
			logger.error('Authentication failed:', error);
			new Notice(
				`Failed to connect to OneDrive: ${error instanceof Error ? error.message : 'Unknown error'}`
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

		// Clear user info and shared drive settings
		this.settings.connectedUser = undefined;
		this.settings.remoteDriveId = undefined;
		this.settings.remoteItemId = undefined;
		this.settings.remoteRootName = undefined;

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
		new Notice('Disconnected from OneDrive');
	}

	/**
	 * Trigger manual sync
	 */
	async triggerManualSync(): Promise<void> {
		if (!this.tokenStorage.hasTokens()) {
			new Notice('Not connected to OneDrive. Please connect in settings.');
			return;
		}

		if (!this.syncEngine) {
			new Notice('Sync engine not initialized. Please reconnect.');
			return;
		}

		if (this.eventManager?.isSyncInProgress()) {
			new Notice('Sync already in progress');
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

		try {
			// Update status bar
			this.statusBarManager?.setStatus(SyncStatus.SYNCING);

			// Perform sync
			await this.syncEngine.performSync();

			// Update status bar
			const now = Date.now();
			this.statusBarManager?.setLastSyncTime(now);
			this.statusBarManager?.setStatus(SyncStatus.IDLE);

			// Save sync state
			await this.saveSettings();

			logger.info('Sync completed successfully');
		} catch (error) {
			logger.error('Sync failed:', error);
			this.statusBarManager?.setStatus(SyncStatus.ERROR);
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`Sync failed: ${errorMsg}`);
			throw error;
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
			this.statusBarManager.setStatus(SyncStatus.IDLE);
		} else {
			this.statusBarManager.setStatus(SyncStatus.DISCONNECTED);
		}
	}

	/**
	 * List folders at a path for the folder picker.
	 * Always lists from the user's own OneDrive root (not scoped to shared drive).
	 */
	async listFoldersForPicker(path: string): Promise<OneDriveItem[]> {
		if (!this.oneDriveClient) {
			throw new Error('Not connected to OneDrive');
		}
		return this.oneDriveClient.listFoldersForPicker(path);
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
		} else {
			this.settings.remoteDriveId = undefined;
			this.settings.remoteItemId = undefined;
			this.settings.remoteRootName = undefined;
		}

		// Clear stale sync state when the target folder changes
		if (oldPath !== selection.path || oldDriveId !== this.settings.remoteDriveId) {
			this.syncStateManager.clearState();
			logger.info('Cleared sync state due to remote folder change');
		}

		await this.saveSettings();

		// Reinitialize components with the new folder config
		if (this.tokenStorage.hasTokens()) {
			await this.initializeAuthenticatedComponents();

			if (this.eventManager) {
				this.eventManager.startListening();
				this.eventManager.startPeriodicSync(this.settings.syncInterval || 0);
			}
		}

		new Notice(`Sync folder set to: ${selection.path}${selection.isShared ? ' (shared)' : ''}`);
	}

	/**
	 * Load settings from disk
	 */
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	/**
	 * Save settings to disk
	 */
	async saveSettings() {
		// Prepare tokens for save (obfuscated)
		this.settings.tokens = this.tokenStorage.prepareTokensForSave();

		// Prepare sync state for save
		this.settings.syncState = this.syncStateManager.prepareForSave();

		// Update conflict resolver strategy if changed
		if (this.conflictResolver) {
			this.conflictResolver.setStrategy(this.settings.conflictResolution);
		}

		// Update logger debug mode if changed
		logger.setDebugMode(this.settings.enableDebugLogging);

		await this.saveData(this.settings);
	}
}
