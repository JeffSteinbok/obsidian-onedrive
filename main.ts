/**
 * OneDrive Sync Plugin for Obsidian
 * Syncs vault with OneDrive Personal/Consumer accounts using Device Code Flow
 */

import { Plugin, Notice } from 'obsidian';
import { PluginSettings, DEFAULT_SETTINGS, OneDriveAccessMode } from './src/types';
import { DEFAULT_ONEDRIVE_CLIENT_ID, ONEDRIVE_PATHS } from './src/constants';
import { logger } from './src/utils/logger';

// Auth
import { TokenStorage } from './src/auth/tokenStorage';
import { DeviceCodeFlowClient } from './src/auth/deviceCodeFlow';
import { OneDriveAuthProvider } from './src/auth/authProvider';

// API
import { OneDriveClient } from './src/api/oneDriveClient';
import { FileOperations } from './src/api/fileOperations';

// Sync
import { SyncEngine } from './src/sync/syncEngine';
import { SyncStateManager } from './src/sync/syncState';
import { ConflictResolver } from './src/sync/conflictResolver';
import { EventManager } from './src/sync/eventManager';

// UI
import { OneDriveSettingTab } from './src/ui/settings';
import { StatusBarManager, SyncStatus } from './src/ui/statusBar';
import { DeviceCodeModal } from './src/ui/authModal';

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
			callback: () => {
				this.disconnect();
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
		logger.debug('Initializing authenticated components');

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

			// Initialize event manager — listening starts after initial sync
			this.eventManager = new EventManager(this.app, async () => {
				await this.performSync();
			}, this.syncStateManager);

			// Initialize sync engine
			const remoteRoot = this.settings.remotePath || ONEDRIVE_PATHS.APP_FOLDER;
			this.syncEngine = new SyncEngine(
				this.app,
				this.fileOps,
				this.oneDriveClient,
				this.syncStateManager,
				this.conflictResolver,
				this.eventManager,
				remoteRoot
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
	disconnect(): void {
		logger.info('Disconnecting from OneDrive');

		// Stop event manager
		if (this.eventManager) {
			this.eventManager.stopListening();
		}

		// Clear tokens
		this.tokenStorage.clearTokens();

		// Clear user info
		this.settings.connectedUser = undefined;

		// Clear components
		this.authProvider = undefined;
		this.oneDriveClient = undefined;
		this.fileOps = undefined;
		this.syncEngine = undefined;
		this.eventManager = undefined;

		// Save settings
		this.saveSettings();

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
