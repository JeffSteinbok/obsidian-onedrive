/**
 * OneDrive Sync Plugin for Obsidian
 * Syncs vault with OneDrive Personal/Consumer accounts using Device Code Flow
 */

import { Plugin, Notice, TFile } from 'obsidian';
import { PluginSettings, DEFAULT_SETTINGS, OneDriveAccessMode, OneDriveItem } from './types';
import { DEFAULT_ONEDRIVE_CLIENT_ID, ONEDRIVE_PATHS } from './constants';
import { logger } from './utils/logger';
import { shouldSyncVaultPath } from './utils/pathUtils';
import {
	applyVaultLogHook as applyPluginVaultLogHook,
	openLogsNote as openPluginLogsNote,
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

import { timerApi } from './utils/timerApi';

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
	return ['exists', 'mkdir', 'write', 'append'].every((key) => typeof candidate[key] === 'function');
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

	// UI components
	private statusBarManager?: StatusBarManager;

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
		this.syncStateManager = new SyncStateManager();
		this.conflictResolver = new ConflictResolver(this.settings.conflictResolution);

		// Load stored data
		this.tokenStorage.loadTokens(this.settings.tokens);
		this.syncStateManager.loadState(this.settings.syncState);

		// Configure logger
		logger.setDebugMode(this.settings.enableDebugLogging);
		// Mirror logs to a vault-root note when debug logging is on
		this.applyVaultLogHook();

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

		this.addCommand({
			id: 'reconcile-from-cloud',
			name: 'Reconcile from cloud (cloud-as-truth recovery)',
			callback: async () => {
				await this.reconcileFromCloud();
			},
		});

		this.addCommand({
			id: 'show-conflicts',
			name: 'Show sync conflicts',
			callback: () => {
				void this.activateConflictView();
			},
		});

		this.addCommand({
			id: 'view-sync-logs',
			name: 'View sync logs',
			callback: async () => {
				await this.openLogsNote();
			},
		});

		this.addCommand({
			id: 'dev-create-test-conflict',
			name: 'DEV: Create test conflict (for testing conflict UI)',
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
			timerApi.setTimeout(() => {
				void this.triggerManualSync();
			}, this.settings.startupSyncDelay * 1000);
		}

		logger.info('OneDrive Sync plugin loaded successfully');
	}

	onunload() {
		logger.info('Unloading OneDrive Sync plugin');

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

			// Initialize event manager — listening starts after initial sync
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
						this.app.vault.configDir
					)
			);

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
			// For shared drives and app folder mode, upload paths are relative to the
			// root (buildEndpoint handles the base). For full access, prepend remotePath.
			const remoteRoot = (isShared || isAppFolder) ? '' : this.settings.remotePath || '';
			// For path stripping of delta responses, use the FULL path on the
			// remote drive down to the vault folder — not just the shared root.
			// e.g. "/Documents/ObsidianVaults/JeffBrain" not just "/Documents"
			let remoteRootOnDrive: string | undefined;
			if (isShared) {
				remoteRootOnDrive = this.getFullRemoteDrivePath();
			} else if (isAppFolder) {
				// Discover the actual app folder path — the name is set by Azure app
				// registration and may differ from the hardcoded constant.
				remoteRootOnDrive = await this.oneDriveClient.resolveAppFolderPath();
			}

			this.syncEngine = new SyncEngine(
				this.app,
				this.fileOps,
				this.oneDriveClient,
				this.syncStateManager,
				this.conflictResolver,
				this.eventManager,
				this.app.vault.configDir,
				remoteRoot,
				remoteRootOnDrive,
				this.conflictQueue,
				(path) =>
					shouldSyncVaultPath(
						path,
						this.settings.syncPluginManifests,
						this.settings.syncAppSettings,
						this.app.vault.configDir
					),
				() => this.settings.largeDeleteThreshold ?? 0,
				(info) => this.handleLargeDeleteWarning(info),
				(msg) => this.statusBarManager?.setProgress(msg),
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
		new Notice('Disconnected from OneDrive');
	}

	/**
	 * Check if sync target is fully configured
	 */
	private isSyncConfigured(): boolean {
		if (this.settings.accessMode === OneDriveAccessMode.APP_FOLDER) {
			return true; // App folder always has a fixed path
		}
		return !!this.settings.remotePath; // Full access needs a folder selected
	}

	/**
	 * Trigger manual sync
	 */
	async triggerManualSync(): Promise<void> {
		if (!this.tokenStorage.hasTokens()) {
			new Notice('Not connected to OneDrive. Please connect in settings.');
			return;
		}

		if (!this.isSyncConfigured()) {
			new Notice('Please select a sync folder in settings first.');
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

	/**
	 * Create/update a readable vault note with recent plugin logs and open it.
	 */
	private async openLogsNote(): Promise<void> {
		await openPluginLogsNote({
			vault: this.app.vault as Parameters<typeof openPluginLogsNote>[0]['vault'],
			workspace: this.app.workspace as Parameters<typeof openPluginLogsNote>[0]['workspace'],
			configDir: this.app.vault.configDir,
			getRecentLogs: () => logger.getRecentLogs(),
			notify: (message) => {
				new Notice(message);
			},
		});
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
							this.app.vault.configDir
						)
				);
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
			new Notice('OneDrive DEV: No file found to create a test conflict');
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

		new Notice(`OneDrive DEV: Created test conflict for "${file.path}"`);
	}

	/**
	 * Load settings from disk
	 */
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<PluginSettings>);
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

		new Notice(
			`Plugin sync ${enabled ? 'enabled' : 'disabled'} (community-plugins.json, core-plugins.json, plugin manifests and binaries). ` +
				'Run Sync Now to apply the new scope.'
		);
	}

	async onAppSettingsSyncChanged(enabled: boolean): Promise<void> {
		if (this.settings.syncAppSettings === enabled) {
			return;
		}

		this.settings.syncAppSettings = enabled;
		this.syncStateManager.clearState();
		await this.saveSettings();

		new Notice(
			`App settings sync ${enabled ? 'enabled' : 'disabled'} (app.json, appearance.json, hotkeys.json). ` +
				'Run Sync Now to apply the new scope.'
		);
	}

	async resetSyncToken(): Promise<void> {
		this.syncStateManager.clearDeltaLink();
		await this.saveSettings();
		new Notice(
			'Sync reset. Delta cursors, file states, and last sync time cleared. ' +
				'Next sync will re-read from OneDrive and reconcile local files.'
		);
	}

	/**
	 * Reconcile the local vault from a full cloud listing. Treats cloud as
	 * authoritative — local-only files are deleted, remote-only files are
	 * downloaded. Destructive deletes are confirmed via the large-delete
	 * modal. See issue #26.
	 */
	async reconcileFromCloud(): Promise<void> {
		if (!this.tokenStorage.hasTokens()) {
			new Notice('Reconcile from cloud: not connected to OneDrive.');
			return;
		}
		if (!this.isSyncConfigured()) {
			new Notice('Reconcile from cloud: select a sync folder in settings first.');
			return;
		}
		if (!this.syncEngine) {
			new Notice('Reconcile from cloud: sync engine not initialized.');
			return;
		}
		if (this.eventManager?.isSyncInProgress()) {
			new Notice('Reconcile from cloud: a sync is already in progress.');
			return;
		}
		try {
			this.statusBarManager?.setStatus(SyncStatus.SYNCING);
			await this.syncEngine.reconcileFromCloud();
			await this.saveSettings();
			this.statusBarManager?.setStatus(SyncStatus.IDLE);
		} catch (error) {
			this.statusBarManager?.setStatus(SyncStatus.ERROR);
			throw error;
		}
	}

	/**
	 * Save settings to disk
	 */
	async saveSettings() {
		// Prepare tokens for save (obfuscated)
		this.settings.tokens = this.tokenStorage.prepareTokensForSave();

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

		// Update logger debug mode if changed
		logger.setDebugMode(this.settings.enableDebugLogging);
		this.applyVaultLogHook();

		await this.saveData(this.settings);
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
			enabled: this.settings.enableDebugLogging,
			adapter,
			setVaultLogHook: (hook) => {
				logger.setVaultLogHook(hook);
			},
		});
	}

	/**
	 * Show the large-delete warning modal and act on the user's choice.
	 *
	 * When the user picks "Disable plugin", we actually disable the plugin
	 * after the modal closes (so the modal can finish unmounting first).
	 * Either 'cancel' or 'disable' is returned to the sync engine, which
	 * treats both as "abort this sync without advancing delta cursors".
	 */
	private handleLargeDeleteWarning(
		info: LargeDeleteWarningInfo
	): Promise<LargeDeleteDecision> {
		return new Promise((resolve) => {
			const modal = new LargeDeleteWarningModal(this.app, info, (decision) => {
				if (decision === 'disable') {
					// Defer so the modal closes cleanly before unloading the plugin.
					timerApi.setTimeout(() => {
						try {
							const plugins = (this.app as unknown as {
								plugins?: { disablePlugin?: (id: string) => Promise<void> | void };
							}).plugins;
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
