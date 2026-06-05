/**
 * Settings tab for the OneDrive plugin
 */

import { App, PluginSettingTab, Setting, Notice, type PluginManifest } from 'obsidian';
import {
	PluginSettings,
	ConflictResolutionStrategy,
	OneDriveAccessMode,
	OneDriveItem,
} from '../types';
import { DEFAULT_ONEDRIVE_CLIENT_ID } from '../constants';
import { FolderBrowserModal, FolderSelection } from './folderBrowserModal';

// Forward declaration for the plugin type
interface OneDrivePlugin {
	settings: PluginSettings;
	manifest: PluginManifest;
	saveSettings(): Promise<void>;
	onAppSettingsSyncChanged(enabled: boolean): Promise<void>;
	onPluginManifestSyncChanged(enabled: boolean): Promise<void>;
	resetSyncToken(): Promise<void>;
	reconcileFromCloud(): Promise<void>;
	authenticate(): Promise<void>;
	disconnect(): void;
	triggerManualSync(): Promise<void>;
	listFoldersForPicker(
		path: string,
		sharedDriveId?: string,
		sharedItemId?: string,
		relativePathInShared?: string
	): Promise<OneDriveItem[]>;
	onRemoteFolderChanged(selection: FolderSelection): Promise<void>;
}

/**
 * Settings tab UI
 */
export class OneDriveSettingTab extends PluginSettingTab {
	plugin: OneDrivePlugin;

	constructor(app: App, plugin: OneDrivePlugin) {
		super(app, plugin as never);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setDesc('by Jeff Steinbok — v' + (this.plugin.manifest.version || '') + ' — GitHub')
			.setHeading();

		// Sections in logical order
		this.displayAuthSection(containerEl);
		this.displaySyncFolderSection(containerEl);
		this.displaySyncSection(containerEl);
		this.displayAdvancedSection(containerEl);
	}

	/**
	 * Display authentication section
	 */
	private displayAuthSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Authentication').setHeading();

		// Access mode — first setting in this section
		const isConnected = !!this.plugin.settings.connectedUser;
		const modeDesc = this.plugin.settings.accessMode === OneDriveAccessMode.FULL_ACCESS
			? 'Sync to any folder, share with others. Requires more permissions.'
			: 'Secure isolated folder at /Apps/ObsidianOneDrive/. No configuration needed.';
		const descWithWarning = isConnected
			? modeDesc + ' Changing access mode requires disconnecting and reconnecting.'
			: modeDesc;

		new Setting(containerEl)
			.setName('OneDrive access mode')
			.setDesc(descWithWarning)
			.addDropdown((dropdown) =>
				dropdown
					.addOption(OneDriveAccessMode.APP_FOLDER, 'App Folder (Recommended)')
					.addOption(OneDriveAccessMode.FULL_ACCESS, 'Full Access (Advanced)')
					.setValue(this.plugin.settings.accessMode)
					.onChange(async (value) => {
						this.plugin.settings.accessMode = value as OneDriveAccessMode;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		// Connection status
		const statusSetting = new Setting(containerEl).setName('Connection status');

		if (this.plugin.settings.connectedUser) {
			statusSetting.setDesc(
				`Connected as: ${this.plugin.settings.connectedUser.displayName} (${this.plugin.settings.connectedUser.userPrincipalName})`
			);

			// Disconnect button
			statusSetting.addButton((button) =>
				button
					.setButtonText('Disconnect')
					.onClick(async () => {
						this.plugin.disconnect();
						new Notice('Disconnected from OneDrive');
						this.display(); // Refresh settings
					})
			);
		} else {
			statusSetting.setDesc('Not connected');

			// Connect button
			statusSetting.addButton((button) =>
				button
					.setButtonText('Connect to OneDrive')
					.setCta()
					.onClick(async () => {
						try {
							await this.plugin.authenticate();
							new Notice('Successfully connected to OneDrive');
							this.display(); // Refresh settings
						} catch (error) {
							new Notice(
								`Failed to connect: ${error instanceof Error ? error.message : 'Unknown error'}`
							);
						}
					})
			);
		}
	}

	/**
	 * Display sync folder section (only for full access mode)
	 */
	private displaySyncFolderSection(containerEl: HTMLElement): void {
		const isConnected = !!this.plugin.settings.connectedUser;

		if (this.plugin.settings.accessMode === OneDriveAccessMode.FULL_ACCESS) {
			new Setting(containerEl).setName('Sync Folder').setHeading();

			if (isConnected) {
				const currentPath = this.plugin.settings.remotePath || '(not selected)';
				const isShared = !!this.plugin.settings.remoteDriveId;
				const desc = isShared ? `${currentPath} (shared folder)` : currentPath;

				new Setting(containerEl)
					.setName('Remote folder')
					.setDesc(desc)
					.addButton((btn) =>
						btn.setButtonText('Browse...').onClick(() => {
							const modal = new FolderBrowserModal(
								this.app,
								(path, sharedDriveId?, sharedItemId?, relPath?) =>
									this.plugin.listFoldersForPicker(path, sharedDriveId, sharedItemId, relPath),
								async (selection: FolderSelection) => {
									await this.plugin.onRemoteFolderChanged(selection);
									this.display();
								}
							);
							modal.open();
						})
					);
			} else {
				new Setting(containerEl)
					.setName('Remote folder')
					.setDesc('Connect to OneDrive first, then select a sync folder.');
			}
		}

		// Sync Now button
		if (isConnected) {
			new Setting(containerEl).addButton((btn) => {
				btn
					.setButtonText('Sync Now')
					.setCta()
					.onClick(() => {
						void this.plugin.triggerManualSync();
					});
				if (
					this.plugin.settings.accessMode !== OneDriveAccessMode.APP_FOLDER &&
					!this.plugin.settings.remotePath
				) {
					btn.setDisabled(true);
					btn.setTooltip('Select a sync folder first');
				}
			});
		}
	}

	/**
	 * Display sync configuration section
	 */
	private displaySyncSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Sync Configuration').setHeading();

		const { configDir } = this.app.vault;

		// Sync interval
		new Setting(containerEl)
			.setName('Automatic sync interval')
			.setDesc('Set to 0 for manual sync only (recommended for battery life)')
			.addSlider((slider) =>
				slider
					.setLimits(0, 60, 5)
					.setValue(this.plugin.settings.syncInterval)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.syncInterval = value;
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((button) =>
				button
					.setIcon('reset')
					.setTooltip('Reset to default')
					.onClick(async () => {
						this.plugin.settings.syncInterval = 0;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		// Startup sync delay
		new Setting(containerEl)
			.setName('Startup sync delay')
			.setDesc('Delay before first sync after Obsidian starts (0 = disabled)')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('0', 'Disabled')
					.addOption('1', '1 second')
					.addOption('10', '10 seconds (recommended)')
					.addOption('30', '30 seconds')
					.setValue(String(this.plugin.settings.startupSyncDelay))
					.onChange(async (value) => {
						this.plugin.settings.startupSyncDelay = parseInt(value);
						await this.plugin.saveSettings();
					})
			);

		// Conflict resolution strategy
		new Setting(containerEl)
			.setName('Conflict resolution')
			.setDesc('How to handle files modified both locally and remotely')
			.addDropdown((dropdown) =>
				dropdown
					.addOption(ConflictResolutionStrategy.LAST_WRITE_WINS, 'Last write wins')
					.addOption(ConflictResolutionStrategy.CREATE_DUPLICATE, 'Create duplicate')
					.addOption(ConflictResolutionStrategy.MANUAL, 'Manual (review conflicts with diff)')
					.setValue(this.plugin.settings.conflictResolution)
					.onChange(async (value) => {
						this.plugin.settings.conflictResolution = value as ConflictResolutionStrategy;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Sync app settings')
			.setDesc(
				`Sync ${configDir}/app.json, ${configDir}/appearance.json, and ${configDir}/hotkeys.json to keep appearance and hotkeys consistent across devices.`
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncAppSettings).onChange(async (value) => {
					await this.plugin.onAppSettingsSyncChanged(value);
				})
			);

		new Setting(containerEl)
			.setName('Sync plugins')
			.setDesc(
				`Sync ${configDir}/community-plugins.json, ${configDir}/core-plugins.json, plugin manifests, and plugin binaries (main.js, styles.css). Does not sync plugin data files.`
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncPluginManifests).onChange(async (value) => {
					await this.plugin.onPluginManifestSyncChanged(value);
				})
			);
	}

	/**
	 * Display advanced section
	 */
	private displayAdvancedSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Advanced').setHeading();

		// Debug logging
		new Setting(containerEl)
			.setName('Enable debug logging')
			.setDesc('Log detailed information to the console (for troubleshooting)')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableDebugLogging).onChange(async (value) => {
					this.plugin.settings.enableDebugLogging = value;
					await this.plugin.saveSettings();
					new Notice(`Debug logging ${value ? 'enabled' : 'disabled'}`);
				})
			);

		// Large-delete safety threshold
		new Setting(containerEl)
			.setName('Large delete warning threshold')
			.setDesc(
				'Pause and ask before a sync that would delete this many files. ' +
					'Helps catch unintended remote deletions or accidental local deletes. ' +
					'Set to 0 to disable.'
			)
			.addText((text) =>
				text
					.setPlaceholder('25')
					.setValue(String(this.plugin.settings.largeDeleteThreshold ?? 25))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (Number.isNaN(parsed) || parsed < 0) return;
						this.plugin.settings.largeDeleteThreshold = parsed;
						await this.plugin.saveSettings();
					})
			);

		// Show remote path as read-only text in App Folder mode
		if (this.plugin.settings.accessMode === OneDriveAccessMode.APP_FOLDER) {
			new Setting(containerEl)
				.setName('Remote path')
				.setDesc(`Files sync to: /Apps/ObsidianOneDrive`);
		}

		// Reset sync token
		new Setting(containerEl)
			.setName('Reset sync token')
			.setDesc('Force a full re-read from OneDrive on the next sync. Use if files appear missing or out of date.')
			.addButton((button) =>
				button
					.setButtonText('Reset sync token')
					.onClick(async () => {
						await this.plugin.resetSyncToken();
					})
			);

		// Reconcile from cloud (cloud-as-truth recovery — issue #26)
		new Setting(containerEl)
			.setName('Reconcile from cloud')
			.setDesc(
				'Treat cloud as authoritative. Deletes local files that no longer exist in OneDrive and downloads anything missing. ' +
					'Use when Reset Sync Token has not cleared stale local files. Destructive — confirmation required for large deletes.'
			)
			.addButton((button) =>
				button
					.setButtonText('Reconcile from cloud')
					.onClick(async () => {
						await this.plugin.reconcileFromCloud();
					})
			);

		// Custom client ID toggle
		new Setting(containerEl)
			.setName('Use custom client ID')
			.setDesc('Use your own Azure AD app registration. See the README for setup instructions.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.useCustomClientId).onChange(async (value) => {
					this.plugin.settings.useCustomClientId = value;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (this.plugin.settings.useCustomClientId) {
			new Setting(containerEl)
				.setName('Custom client ID')
				.setDesc('Your Azure AD Application (client) ID')
				.addText((text) =>
					text
						.setPlaceholder(DEFAULT_ONEDRIVE_CLIENT_ID)
						.setValue(this.plugin.settings.customClientId || '')
						.onChange(async (value) => {
							this.plugin.settings.customClientId = value;
							await this.plugin.saveSettings();
						})
				);

			const helpDiv = containerEl.createDiv({
				cls: 'setting-item-description onedrive-sync-settings-help',
			});
			helpDiv.appendText('See ');
			helpDiv.createEl('a', {
				text: 'Custom Client ID setup guide',
				href: 'https://github.com/jeffsteinbok/obsidian-onedrive#custom-client-id',
				attr: { target: '_blank' },
			});
			helpDiv.appendText(' in the README.');
		}
	}
}
