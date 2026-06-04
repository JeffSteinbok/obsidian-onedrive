/**
 * Settings tab for the OneDrive plugin
 */

import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
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
	manifest: { version: string };
	saveSettings(): Promise<void>;
	onAppSettingsSyncChanged(enabled: boolean): Promise<void>;
	onPluginManifestSyncChanged(enabled: boolean): Promise<void>;
	resetSyncToken(): Promise<void>;
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

		const heading = containerEl.createEl('h2', { text: 'OneDrive Sync Settings' });
		const authorEl = heading.createEl('div');
		authorEl.style.fontSize = '14px';
		authorEl.style.fontWeight = 'normal';
		authorEl.style.color = 'var(--text-muted)';
		authorEl.style.marginTop = '4px';
		authorEl.style.marginBottom = '8px';
		const version = (this.plugin as any).manifest?.version || '';
		const versionStr = version ? ` — v${version}` : '';
		authorEl.innerHTML = `by <strong>Jeff Steinbok</strong>${versionStr} — <a href="https://github.com/jeffsteinbok/obsidian-onedrive" target="_blank">GitHub</a>`;

		// Authentication section
		this.displayAuthSection(containerEl);

		// Access mode section
		this.displayAccessModeSection(containerEl);

		// Sync configuration section
		this.displaySyncSection(containerEl);

		// Advanced section
		this.displayAdvancedSection(containerEl);
	}

	/**
	 * Display authentication section
	 */
	private displayAuthSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: 'Authentication' });

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
					.setWarning()
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
	 * Display access mode section
	 */
	private displayAccessModeSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: 'Access Mode' });

		const isConnected = !!this.plugin.settings.connectedUser;

		// Warning text right below heading
		if (isConnected) {
			const warningEl = containerEl.createEl('p');
			warningEl.style.color = 'var(--text-error)';
			warningEl.style.fontSize = '12px';
			warningEl.style.fontStyle = 'italic';
			warningEl.style.margin = '0 0 8px 0';
			warningEl.textContent = 'Changing access mode requires disconnecting and reconnecting.';
		}

		// Access mode selector
		const accessGroup = containerEl.createDiv();

		new Setting(accessGroup)
			.setName('OneDrive access mode')
			.setDesc('Choose between secure app folder or full OneDrive access')
			.addDropdown((dropdown) =>
				dropdown
					.addOption(OneDriveAccessMode.APP_FOLDER, 'App Folder (Recommended)')
					.addOption(OneDriveAccessMode.FULL_ACCESS, 'Full Access (Advanced)')
					.setValue(this.plugin.settings.accessMode)
					.onChange(async (value) => {
						this.plugin.settings.accessMode = value as OneDriveAccessMode;
						await this.plugin.saveSettings();
						this.display(); // Refresh to show/hide options
					})
			);

		// Determine if sync is ready (folder selected or app-folder mode)
		const isSyncReady =
			isConnected &&
			(this.plugin.settings.accessMode === OneDriveAccessMode.APP_FOLDER ||
				!!this.plugin.settings.remotePath);

		if (this.plugin.settings.accessMode === OneDriveAccessMode.FULL_ACCESS) {
			if (isConnected) {
				// Show folder picker (browse button + current selection)
				const currentPath = this.plugin.settings.remotePath || '(not selected)';
				const isShared = !!this.plugin.settings.remoteDriveId;
				const desc = isShared ? `${currentPath} (shared folder)` : currentPath;

				const folderSetting = new Setting(accessGroup)
					.setName('Sync folder')
					.setDesc(desc)
					.addButton((btn) =>
						btn.setButtonText('Browse...').onClick(() => {
							const modal = new FolderBrowserModal(
								this.app,
								(path, sharedDriveId?, sharedItemId?, relPath?) =>
									this.plugin.listFoldersForPicker(path, sharedDriveId, sharedItemId, relPath),
								async (selection: FolderSelection) => {
									await this.plugin.onRemoteFolderChanged(selection);
									this.display(); // Refresh to show new selection
								}
							);
							modal.open();
						})
					);

				// Sync Now button — only when a folder is selected
				if (this.plugin.settings.remotePath) {
					folderSetting.addButton((btn) =>
						btn
							.setButtonText('Sync Now')
							.setCta()
							.onClick(async () => {
								await this.plugin.triggerManualSync();
							})
					);
				}
			} else {
				// Not connected — just show a note
				const noteEl = accessGroup.createEl('p', { cls: 'setting-item-description' });
				noteEl.style.margin = '0 0 12px 0';
				noteEl.textContent = 'Connect to OneDrive first, then select a sync folder.';
			}

			const descEl = containerEl.createEl('p', { cls: 'setting-item-description' });
			descEl.style.margin = '0 0 12px 0';
			descEl.innerHTML = `Sync to any folder, share with others. Requires more permissions.`;
		} else {
			const descEl = containerEl.createEl('p', { cls: 'setting-item-description' });
			descEl.style.margin = '0 0 12px 0';
			descEl.innerHTML = `Secure isolated folder at <code>/Apps/ObsidianOneDrive/</code>. No configuration needed, but can't sync to existing folders.`;

			// Sync Now for app-folder mode
			if (isConnected) {
				new Setting(accessGroup).addButton((btn) =>
					btn
						.setButtonText('Sync Now')
						.setCta()
						.onClick(async () => {
							await this.plugin.triggerManualSync();
						})
				);
			}
		}
	}

	/**
	 * Display sync configuration section
	 */
	private displaySyncSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: 'Sync Configuration' });

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
				'Sync .obsidian/app.json, .obsidian/appearance.json, and .obsidian/hotkeys.json to keep appearance and hotkeys consistent across devices.'
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncAppSettings).onChange(async (value) => {
					await this.plugin.onAppSettingsSyncChanged(value);
				})
			);

		new Setting(containerEl)
			.setName('Sync plugins')
			.setDesc(
				'Sync .obsidian/community-plugins.json, .obsidian/core-plugins.json, plugin manifests, and plugin binaries (main.js, styles.css). Does not sync plugin data files.'
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
		containerEl.createEl('h3', { text: 'Advanced' });

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
					.setWarning()
					.onClick(async () => {
						await this.plugin.resetSyncToken();
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

			const helpDiv = containerEl.createDiv({ cls: 'setting-item-description' });
			helpDiv.style.marginTop = '4px';
			helpDiv.innerHTML = `See <a href="https://github.com/jeffsteinbok/obsidian-onedrive#custom-client-id" target="_blank">Custom Client ID setup guide</a> in the README.`;
		}
	}
}
