/**
 * Settings tab for the OneDrive plugin
 */

import {
	App,
	Plugin,
	PluginSettingTab,
	requireApiVersion,
	Setting,
	Notice,
	type PluginManifest,
	type SettingDefinitionItem,
} from 'obsidian';
import {
	PluginSettings,
	ConflictResolutionStrategy,
	OneDriveAccessMode,
	OneDriveItem,
	ExperimentalSettings,
	DEFAULT_EXPERIMENTAL_SETTINGS,
} from '../types';
import { DEFAULT_ONEDRIVE_CLIENT_ID } from '../constants';
import { FolderBrowserModal, FolderSelection } from './folderBrowserModal';
import type { SyncStatusInfo } from '../main';
import { SyncStatus } from './statusBar';
import { t } from '../i18n';

// Forward declaration for the plugin type
interface OneDrivePlugin extends Plugin {
	settings: PluginSettings;
	manifest: PluginManifest;
	saveSettings(): Promise<void>;
	onAppSettingsSyncChanged(enabled: boolean): Promise<void>;
	onPluginManifestSyncChanged(enabled: boolean): Promise<void>;
	onCssSnippetSyncChanged(enabled: boolean): Promise<void>;
	onBookmarkSyncChanged(enabled: boolean): Promise<void>;
	resetSyncToken(): Promise<void>;
	reconcileFromCloud(): Promise<void>;
	authenticate(): Promise<void>;
	disconnect(): Promise<void>;
	triggerManualSync(): Promise<void>;
	listFoldersForPicker(
		path: string,
		sharedDriveId?: string,
		sharedItemId?: string,
		relativePathInShared?: string
	): Promise<OneDriveItem[]>;
	listAppFoldersForPicker(path: string): Promise<OneDriveItem[]>;
	onRemoteFolderChanged(selection: FolderSelection): Promise<void>;
	onAppFolderSubpathChanged(subpath: string): Promise<void>;
	getSyncStatusInfo(): SyncStatusInfo;
	getExperimentalSetting<K extends keyof ExperimentalSettings>(key: K): ExperimentalSettings[K];
}

/**
 * Settings tab UI
 */
export class OneDriveSettingTab extends PluginSettingTab {
	plugin: OneDrivePlugin;

	constructor(app: App, plugin: OneDrivePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		if (!this.supportsDeclarativeSettings()) {
			return [];
		}

		return [
			{
				type: 'group',
				heading: t('settings.auth.heading'),
				items: [
					{
						name: t('settings.auth.accessMode.name'),
						desc: t('settings.auth.accessMode.fullAccessDesc'),
						render: (setting) => {
							this.renderAccessModeSetting(setting);
						},
					},
					{
						name: t('settings.auth.connectionStatus.name'),
						desc: t('settings.auth.connectionStatus.notConnected'),
						render: (setting) => {
							this.renderConnectionStatusSetting(setting);
						},
					},
				],
			},
			{
				type: 'group',
				heading: t('settings.syncFolder.heading'),
				visible: () =>
					this.plugin.settings.accessMode === OneDriveAccessMode.FULL_ACCESS ||
					(this.plugin.settings.accessMode === OneDriveAccessMode.APP_FOLDER &&
						!!this.plugin.settings.connectedUser),
				items: [
					{
						name: t('settings.syncFolder.remoteFolder'),
						desc: t('settings.syncFolder.connectFirst'),
						visible: () => this.plugin.settings.accessMode === OneDriveAccessMode.FULL_ACCESS,
						render: (setting) => {
							this.renderRemoteFolderSetting(setting);
						},
					},
					{
						name: t('settings.syncFolder.vaultSubfolder'),
						desc: t('settings.syncFolder.vaultSubfolderDesc', {
							path: this.plugin.settings.appFolderSubpath || t('settings.syncFolder.appFolderRoot'),
						}),
						visible: () =>
							this.plugin.settings.accessMode === OneDriveAccessMode.APP_FOLDER &&
							!!this.plugin.settings.connectedUser,
						render: (setting) => {
							this.renderVaultSubfolderSetting(setting);
						},
					},
					{
						name: t('settings.sync.status.name'),
						desc: t('settings.sync.status.desc', {
							status: t('settings.sync.status.idle'),
							lastSync: t('settings.sync.status.notSyncedYet'),
							progress: t('settings.sync.status.noProgress'),
							conflicts: t('settings.sync.status.noConflicts'),
						}),
						visible: () => !!this.plugin.settings.connectedUser,
						render: (setting) => {
							this.renderSyncStatusSetting(setting);
						},
					},
				],
			},
			{
				type: 'group',
				heading: t('settings.sync.heading'),
				items: [
					{
						name: t('settings.sync.automaticInterval.name'),
						desc: t('settings.sync.automaticInterval.desc'),
						render: (setting) => {
							this.renderSyncIntervalSetting(setting);
						},
					},
					{
						name: t('settings.sync.syncOnFileChange.name'),
						desc: t('settings.sync.syncOnFileChange.desc'),
						control: {
							type: 'toggle',
							key: 'syncOnFileChange',
							defaultValue: true,
						},
					},
					{
						name: t('settings.sync.startupDelay.name'),
						desc: t('settings.sync.startupDelay.desc'),
						control: {
							type: 'dropdown',
							key: 'startupSyncDelay',
							options: {
								'0': t('settings.sync.startupDelay.disabled'),
								'1': t('settings.sync.startupDelay.oneSecond'),
								'10': t('settings.sync.startupDelay.tenSeconds'),
								'30': t('settings.sync.startupDelay.thirtySeconds'),
							},
						},
					},
					{
						name: t('settings.sync.conflictResolution.name'),
						desc: t('settings.sync.conflictResolution.desc'),
						control: {
							type: 'dropdown',
							key: 'conflictResolution',
							options: {
								[ConflictResolutionStrategy.LAST_WRITE_WINS]: t(
									'settings.sync.conflictResolution.lastWriteWins'
								),
								[ConflictResolutionStrategy.CREATE_DUPLICATE]: t(
									'settings.sync.conflictResolution.createDuplicate'
								),
								[ConflictResolutionStrategy.MANUAL]: t(
									'settings.sync.conflictResolution.manual'
								),
							},
						},
					},
					{
						name: t('settings.sync.notificationLevel.name'),
						desc: t('settings.sync.notificationLevel.desc'),
						control: {
							type: 'dropdown',
							key: 'notificationLevel',
							options: {
								all: t('settings.sync.notificationLevel.all'),
								errors: t('settings.sync.notificationLevel.errors'),
								off: t('settings.sync.notificationLevel.off'),
							},
							defaultValue: 'all',
						},
					},
					{
						name: t('settings.sync.appSettings.name'),
						desc: t('settings.sync.appSettings.desc', { configDir: this.app.vault.configDir }),
						control: {
							type: 'toggle',
							key: 'appSettings',
						},
					},
					{
						name: t('settings.sync.plugins.name'),
						desc: t('settings.sync.plugins.desc', { configDir: this.app.vault.configDir }),
						control: {
							type: 'toggle',
							key: 'pluginManifests',
						},
					},
					{
						name: t('settings.sync.cssSnippets.name'),
						desc: t('settings.sync.cssSnippets.desc', { configDir: this.app.vault.configDir }),
						control: {
							type: 'toggle',
							key: 'cssSnippets',
						},
					},
					{
						name: t('settings.sync.bookmarks.name'),
						desc: t('settings.sync.bookmarks.desc', { configDir: this.app.vault.configDir }),
						control: {
							type: 'toggle',
							key: 'bookmarks',
						},
					},
				],
			},
			{
				type: 'group',
				heading: t('settings.advanced.heading'),
				items: [
					{
						name: t('settings.advanced.logLevel.name'),
						desc: t('settings.advanced.logLevel.desc'),
						control: {
							type: 'dropdown',
							key: 'logLevel',
							options: {
								off: t('settings.advanced.logLevel.off'),
								error: t('settings.advanced.logLevel.error'),
								warn: t('settings.advanced.logLevel.warn'),
								info: t('settings.advanced.logLevel.info'),
								debug: t('settings.advanced.logLevel.debug'),
							},
						},
					},
					{
						name: t('settings.advanced.largeDeleteThreshold.name'),
						desc: t('settings.advanced.largeDeleteThreshold.desc'),
						render: (setting) => {
							this.renderLargeDeleteThresholdSetting(setting);
						},
					},
					{
						name: t('settings.advanced.remotePath.name'),
						desc: t('settings.advanced.remotePath.desc'),
						visible: () => this.plugin.settings.accessMode === OneDriveAccessMode.APP_FOLDER,
					},
					{
						name: t('settings.advanced.resetSyncToken.name'),
						desc: t('settings.advanced.resetSyncToken.desc'),
						render: (setting) => {
							this.renderResetSyncTokenSetting(setting);
						},
					},
					{
						name: t('settings.advanced.reconcileFromCloud.name'),
						desc: t('settings.advanced.reconcileFromCloud.desc'),
						render: (setting) => {
							this.renderReconcileFromCloudSetting(setting);
						},
					},
					{
						name: t('settings.advanced.customClientId.toggleName'),
						desc: t('settings.advanced.customClientId.toggleDesc'),
						control: {
							type: 'toggle',
							key: 'useCustomClientId',
						},
					},
					{
						name: t('settings.advanced.customClientId.name'),
						desc: t('settings.advanced.customClientId.desc'),
						visible: () => this.plugin.settings.useCustomClientId,
						render: (setting) => {
							this.renderCustomClientIdSetting(setting);
						},
					},
				],
			},
			{
				type: 'group',
				heading: t('settings.experimental.heading'),
				items: [
					{
						name: t('settings.experimental.skipFolderChecks.name'),
						desc: t('settings.experimental.skipFolderChecks.desc'),
						control: {
							type: 'toggle',
							key: 'experimental.skipFolderChecks',
						},
					},
					{
						name: t('settings.experimental.maxConcurrentOperations.name'),
						desc: t('settings.experimental.maxConcurrentOperations.desc'),
						render: (setting) => {
							this.renderMaxConcurrentOperationsSetting(setting);
						},
					},
					{
						name: t('settings.experimental.useAtomicMoves.name'),
						desc: t('settings.experimental.useAtomicMoves.desc'),
						control: {
							type: 'toggle',
							key: 'experimental.useAtomicMoves',
						},
					},
					{
						name: t('settings.experimental.pullOnlyMode.name'),
						desc: t('settings.experimental.pullOnlyMode.desc'),
						control: {
							type: 'toggle',
							key: 'experimental.pullOnlyMode',
						},
					},
				],
			},
		];
	}

	override getControlValue(key: string): unknown {
		switch (key) {
			case 'startupSyncDelay':
				return String(this.plugin.settings.startupSyncDelay);
			case 'appSettings':
				return this.plugin.settings.syncAppSettings;
			case 'pluginManifests':
				return this.plugin.settings.syncPluginManifests;
			case 'cssSnippets':
				return this.plugin.settings.syncCssSnippets;
			case 'bookmarks':
				return this.plugin.settings.syncBookmarks;
			case 'experimental.skipFolderChecks':
				return this.plugin.getExperimentalSetting('skipFolderChecks');
			case 'experimental.maxConcurrentOperations':
				return this.plugin.getExperimentalSetting('maxConcurrentOperations');
			case 'experimental.useAtomicMoves':
				return this.plugin.getExperimentalSetting('useAtomicMoves');
			case 'experimental.pullOnlyMode':
				return this.plugin.getExperimentalSetting('pullOnlyMode');
			default:
				return super.getControlValue(key);
		}
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		switch (key) {
			case 'startupSyncDelay': {
				const parsed = Number.parseInt(String(value), 10);
				if (!Number.isNaN(parsed)) {
					this.plugin.settings.startupSyncDelay = parsed;
					await this.plugin.saveSettings();
				}
				return;
			}
			case 'appSettings':
				await this.plugin.onAppSettingsSyncChanged(Boolean(value));
				return;
			case 'pluginManifests':
				await this.plugin.onPluginManifestSyncChanged(Boolean(value));
				return;
			case 'cssSnippets':
				await this.plugin.onCssSnippetSyncChanged(Boolean(value));
				return;
			case 'bookmarks':
				await this.plugin.onBookmarkSyncChanged(Boolean(value));
				return;
			case 'useCustomClientId':
				this.plugin.settings.useCustomClientId = Boolean(value);
				await this.plugin.saveSettings();
				this.refreshSettingsUi();
				return;
			case 'experimental.skipFolderChecks':
				await this.saveExperimentalSetting('skipFolderChecks', Boolean(value));
				return;
			case 'experimental.useAtomicMoves':
				await this.saveExperimentalSetting('useAtomicMoves', Boolean(value));
				return;
			case 'experimental.pullOnlyMode':
				await this.saveExperimentalSetting('pullOnlyMode', Boolean(value));
				return;
			default:
				await super.setControlValue(key, value);
		}
	}

	// display() is the imperative rendering entry point, called by Obsidian
	// when the settings tab is opened on versions before 1.13.
	display(): void {
		this.renderSettings();
	}

	private renderSettings(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Sections in logical order
		this.displayAuthSection(containerEl);
		this.displaySyncFolderSection(containerEl);
		this.displaySyncSection(containerEl);
		this.displayAdvancedSection(containerEl);
		this.displayExperimentalSection(containerEl);
	}

	private supportsDeclarativeSettings(): boolean {
		return requireApiVersion('1.13.0');
	}

	private refreshSettingsUi(): void {
		if (this.supportsDeclarativeSettings()) {
			this.update();
			return;
		}

		this.renderSettings();
	}

	private async saveExperimentalSetting<K extends keyof ExperimentalSettings>(
		key: K,
		value: ExperimentalSettings[K]
	): Promise<void> {
		this.plugin.settings.experimental = {
			...DEFAULT_EXPERIMENTAL_SETTINGS,
			...this.plugin.settings.experimental,
			[key]: value,
		};
		await this.plugin.saveSettings();
	}

	private renderAccessModeSetting(setting: Setting): void {
		const isConnected = !!this.plugin.settings.connectedUser;
		const modeDesc =
			this.plugin.settings.accessMode === OneDriveAccessMode.FULL_ACCESS
				? t('settings.auth.accessMode.fullAccessDesc')
				: t('settings.auth.accessMode.appFolderDesc');
		const descWithWarning = isConnected
			? modeDesc + t('settings.auth.accessMode.reconnectRequired')
			: modeDesc;

		setting
			.setName(t('settings.auth.accessMode.name'))
			.setDesc(descWithWarning)
			.addDropdown((dropdown) =>
				dropdown
					.addOption(OneDriveAccessMode.APP_FOLDER, t('settings.auth.accessMode.appFolder'))
					.addOption(OneDriveAccessMode.FULL_ACCESS, t('settings.auth.accessMode.fullAccess'))
					.setValue(this.plugin.settings.accessMode)
					.onChange(async (value) => {
						this.plugin.settings.accessMode = value as OneDriveAccessMode;
						await this.plugin.saveSettings();
						this.refreshSettingsUi();
					})
			);
	}

	private renderConnectionStatusSetting(setting: Setting): void {
		setting.setName(t('settings.auth.connectionStatus.name'));

		if (this.plugin.settings.connectedUser) {
			setting.setDesc(
				t('settings.auth.connectionStatus.connectedAs', {
					displayName: this.plugin.settings.connectedUser.displayName,
					userPrincipalName: this.plugin.settings.connectedUser.userPrincipalName,
				})
			);

			setting.addButton((button) =>
				button.setButtonText(t('settings.auth.connectionStatus.disconnect')).onClick(async () => {
					await this.plugin.disconnect();
					this.refreshSettingsUi();
				})
			);
			return;
		}

		setting.setDesc(t('settings.auth.connectionStatus.notConnected'));
		setting.addButton((button) =>
			button
				.setButtonText(t('settings.auth.connectionStatus.connect'))
				.setCta()
				.onClick(async () => {
					try {
						await this.plugin.authenticate();
						this.refreshSettingsUi();
					} catch (error) {
						new Notice(
							t('settings.auth.connectionStatus.connectFailed', {
								message:
									error instanceof Error
										? error.message
										: t('settings.auth.connectionStatus.unknownError'),
							})
						);
					}
				})
		);
	}

	private renderRemoteFolderSetting(setting: Setting): void {
		const isConnected = !!this.plugin.settings.connectedUser;
		if (!isConnected) {
			setting
				.setName(t('settings.syncFolder.remoteFolder'))
				.setDesc(t('settings.syncFolder.connectFirst'));
			return;
		}

		const currentPath = this.plugin.settings.remotePath || t('settings.syncFolder.notSelected');
		const isShared = !!this.plugin.settings.remoteDriveId;
		const desc = isShared
			? t('settings.syncFolder.sharedFolder', { path: currentPath })
			: currentPath;

		setting
			.setName(t('settings.syncFolder.remoteFolder'))
			.setDesc(desc)
			.addButton((btn) =>
				btn.setButtonText(t('settings.syncFolder.browse')).onClick(() => {
					const modal = new FolderBrowserModal(
						this.app,
						(path, sharedDriveId?, sharedItemId?, relPath?) =>
							this.plugin.listFoldersForPicker(path, sharedDriveId, sharedItemId, relPath),
						(selection: FolderSelection) => {
							void this.plugin.onRemoteFolderChanged(selection).then(() => {
								this.refreshSettingsUi();
							});
						},
						undefined,
						{ warnOnRootSelect: true }
					);
					modal.open();
				})
			);
	}

	private renderVaultSubfolderSetting(setting: Setting): void {
		const currentSubpath =
			this.plugin.settings.appFolderSubpath || t('settings.syncFolder.appFolderRoot');

		setting
			.setName(t('settings.syncFolder.vaultSubfolder'))
			.setDesc(t('settings.syncFolder.vaultSubfolderDesc', { path: currentSubpath }))
			.addButton((btn) =>
				btn.setButtonText(t('settings.syncFolder.browse')).onClick(() => {
					const modal = new FolderBrowserModal(
						this.app,
						(path) => this.plugin.listAppFoldersForPicker(path),
						(selection: FolderSelection) => {
							const subpath = selection.path.replace(/^\/+|\/+$/g, '');
							void this.plugin.onAppFolderSubpathChanged(subpath).then(() => {
								this.refreshSettingsUi();
							});
						},
						this.plugin.settings.appFolderSubpath,
						{ rootLabel: t('settings.syncFolder.appFolderLabel') }
					);
					modal.open();
				})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon('reset')
					.setTooltip(t('settings.syncFolder.useAppFolderRoot'))
					.onClick(() => {
						void this.plugin.onAppFolderSubpathChanged('').then(() => {
							this.refreshSettingsUi();
						});
					})
			);
	}

	private renderSyncIntervalSetting(setting: Setting): void {
		const intervalDesc = (minutes: number): string => {
			const current =
				minutes > 0
					? t('settings.sync.automaticInterval.currentValue', { minutes })
					: t('settings.sync.automaticInterval.currentDisabled');
			return `${t('settings.sync.automaticInterval.desc')} ${current}`;
		};

		setting
			.setName(t('settings.sync.automaticInterval.name'))
			.setDesc(intervalDesc(this.plugin.settings.syncInterval))
			.addSlider((slider) =>
				slider
					.setLimits(0, 60, 5)
					.setValue(this.plugin.settings.syncInterval)
					.onChange(async (value) => {
						this.plugin.settings.syncInterval = value;
						setting.setDesc(intervalDesc(value));
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((button) =>
				button
					.setIcon('reset')
					.setTooltip(t('settings.sync.automaticInterval.resetTooltip'))
					.onClick(async () => {
						this.plugin.settings.syncInterval = 0;
						await this.plugin.saveSettings();
						this.refreshSettingsUi();
					})
			);
	}

	private renderSyncStatusSetting(setting: Setting): void {
		const isConnected = !!this.plugin.settings.connectedUser;
		const syncStatus = this.plugin.getSyncStatusInfo();
		const statusText = this.getSyncStatusText(syncStatus.status);
		const lastSyncText = syncStatus.lastSyncTime
			? new Date(syncStatus.lastSyncTime).toLocaleString()
			: t('settings.sync.status.notSyncedYet');
		const progressText =
			syncStatus.status === SyncStatus.SYNCING
				? syncStatus.progressMessage || t('settings.sync.status.starting')
				: t('settings.sync.status.noProgress');
		const conflictText =
			syncStatus.conflictCount > 0
				? t('settings.sync.status.conflictsPending', { count: syncStatus.conflictCount })
				: t('settings.sync.status.noConflicts');

		setting
			.setName(t('settings.sync.status.name'))
			.setDesc(
				t('settings.sync.status.desc', {
					status: statusText,
					lastSync: lastSyncText,
					progress: progressText,
					conflicts: conflictText,
				})
			)
			.addButton((btn) => {
				btn
					.setButtonText(t('settings.sync.status.syncNow'))
					.setCta()
					.onClick(() => {
						void this.plugin.triggerManualSync();
					});
				if (
					!isConnected ||
					(this.plugin.settings.accessMode === OneDriveAccessMode.APP_FOLDER
						? this.plugin.settings.appFolderSubpathConfirmed !== true
						: !this.plugin.settings.remotePath)
				) {
					btn.setDisabled(true);
					if (!isConnected) {
						btn.setTooltip(t('settings.sync.status.connectTooltip'));
					} else {
						btn.setTooltip(t('settings.sync.status.selectFolderTooltip'));
					}
				}
			});
	}

	private renderLargeDeleteThresholdSetting(setting: Setting): void {
		setting
			.setName(t('settings.advanced.largeDeleteThreshold.name'))
			.setDesc(t('settings.advanced.largeDeleteThreshold.desc'))
			.addText((text) =>
				text
					.setPlaceholder(t('settings.advanced.largeDeleteThreshold.placeholder'))
					.setValue(String(this.plugin.settings.largeDeleteThreshold ?? 25))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isNaN(parsed) || parsed < 0) return;
						this.plugin.settings.largeDeleteThreshold = parsed;
						await this.plugin.saveSettings();
					})
			);
	}

	private renderResetSyncTokenSetting(setting: Setting): void {
		setting
			.setName(t('settings.advanced.resetSyncToken.name'))
			.setDesc(t('settings.advanced.resetSyncToken.desc'))
			.addButton((button) =>
				button.setButtonText(t('settings.advanced.resetSyncToken.button')).onClick(async () => {
					await this.plugin.resetSyncToken();
				})
			);
	}

	private renderReconcileFromCloudSetting(setting: Setting): void {
		setting
			.setName(t('settings.advanced.reconcileFromCloud.name'))
			.setDesc(t('settings.advanced.reconcileFromCloud.desc'))
			.addButton((button) =>
				button.setButtonText(t('settings.advanced.reconcileFromCloud.button')).onClick(async () => {
					await this.plugin.reconcileFromCloud();
				})
			);
	}

	private renderCustomClientIdSetting(setting: Setting): void {
		setting
			.setName(t('settings.advanced.customClientId.name'))
			.setDesc(t('settings.advanced.customClientId.desc'))
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_ONEDRIVE_CLIENT_ID)
					.setValue(this.plugin.settings.customClientId || '')
					.onChange(async (value) => {
						this.plugin.settings.customClientId = value;
						await this.plugin.saveSettings();
					})
			);

		setting.descEl.appendText(` ${t('settings.advanced.customClientId.helpPrefix')}`);
		setting.descEl.createEl('a', {
			text: t('settings.advanced.customClientId.helpLink'),
			href: 'https://github.com/jeffsteinbok/obsidian-onedrive#custom-client-id',
			attr: { target: '_blank' },
		});
		setting.descEl.appendText(` ${t('settings.advanced.customClientId.helpSuffix')}`);
	}

	private renderMaxConcurrentOperationsSetting(setting: Setting): void {
		setting
			.setName(t('settings.experimental.maxConcurrentOperations.name'))
			.setDesc(t('settings.experimental.maxConcurrentOperations.desc'))
			.addText((text) =>
				text
					.setPlaceholder(t('settings.experimental.maxConcurrentOperations.placeholder'))
					.setValue(String(this.plugin.getExperimentalSetting('maxConcurrentOperations')))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isNaN(parsed) || parsed < 1 || parsed > 16) return;
						await this.saveExperimentalSetting('maxConcurrentOperations', parsed);
					})
			);
	}

	/**
	 * Display authentication section
	 */
	private displayAuthSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t('settings.auth.heading')).setHeading();

		// Access mode — first setting in this section
		const isConnected = !!this.plugin.settings.connectedUser;
		const modeDesc =
			this.plugin.settings.accessMode === OneDriveAccessMode.FULL_ACCESS
				? t('settings.auth.accessMode.fullAccessDesc')
				: t('settings.auth.accessMode.appFolderDesc');
		const descWithWarning = isConnected
			? modeDesc + t('settings.auth.accessMode.reconnectRequired')
			: modeDesc;

		new Setting(containerEl)
			.setName(t('settings.auth.accessMode.name'))
			.setDesc(descWithWarning)
			.addDropdown((dropdown) =>
				dropdown
					.addOption(OneDriveAccessMode.APP_FOLDER, t('settings.auth.accessMode.appFolder'))
					.addOption(OneDriveAccessMode.FULL_ACCESS, t('settings.auth.accessMode.fullAccess'))
					.setValue(this.plugin.settings.accessMode)
					.onChange(async (value) => {
						this.plugin.settings.accessMode = value as OneDriveAccessMode;
						await this.plugin.saveSettings();
						this.renderSettings();
					})
			);

		// Connection status
		const statusSetting = new Setting(containerEl).setName(
			t('settings.auth.connectionStatus.name')
		);

		if (this.plugin.settings.connectedUser) {
			statusSetting.setDesc(
				t('settings.auth.connectionStatus.connectedAs', {
					displayName: this.plugin.settings.connectedUser.displayName,
					userPrincipalName: this.plugin.settings.connectedUser.userPrincipalName,
				})
			);

			// Disconnect button
				statusSetting.addButton((button) =>
					button.setButtonText(t('settings.auth.connectionStatus.disconnect')).onClick(async () => {
						await this.plugin.disconnect();
						this.renderSettings();
					})
				);
		} else {
			statusSetting.setDesc(t('settings.auth.connectionStatus.notConnected'));

			// Connect button
			statusSetting.addButton((button) =>
				button
					.setButtonText(t('settings.auth.connectionStatus.connect'))
						.setCta()
						.onClick(async () => {
							try {
								await this.plugin.authenticate();
								this.renderSettings();
							} catch (error) {
								new Notice(
									t('settings.auth.connectionStatus.connectFailed', {
										message:
											error instanceof Error
												? error.message
												: t('settings.auth.connectionStatus.unknownError'),
									})
							);
						}
					})
			);
		}
	}

	/**
	 * Display sync folder section (for full access mode and app folder mode)
	 */
	private displaySyncFolderSection(containerEl: HTMLElement): void {
		const isConnected = !!this.plugin.settings.connectedUser;
		const accessMode = this.plugin.settings.accessMode;

		if (accessMode === OneDriveAccessMode.FULL_ACCESS) {
			new Setting(containerEl).setName(t('settings.syncFolder.heading')).setHeading();

			if (isConnected) {
				const currentPath = this.plugin.settings.remotePath || t('settings.syncFolder.notSelected');
				const isShared = !!this.plugin.settings.remoteDriveId;
				const desc = isShared
					? t('settings.syncFolder.sharedFolder', { path: currentPath })
					: currentPath;

				new Setting(containerEl)
					.setName(t('settings.syncFolder.remoteFolder'))
					.setDesc(desc)
					.addButton((btn) =>
						btn.setButtonText(t('settings.syncFolder.browse')).onClick(() => {
							const modal = new FolderBrowserModal(
								this.app,
								(path, sharedDriveId?, sharedItemId?, relPath?) =>
									this.plugin.listFoldersForPicker(path, sharedDriveId, sharedItemId, relPath),
								(selection: FolderSelection) => {
									void this.plugin.onRemoteFolderChanged(selection).then(() => {
										this.renderSettings();
									});
								},
								undefined,
								{ warnOnRootSelect: true }
							);
							modal.open();
						})
					);
			} else {
				new Setting(containerEl)
					.setName(t('settings.syncFolder.remoteFolder'))
					.setDesc(t('settings.syncFolder.connectFirst'));
			}
		} else if (accessMode === OneDriveAccessMode.APP_FOLDER && isConnected) {
			// App Folder mode: optional subfolder for multi-vault isolation
			new Setting(containerEl).setName(t('settings.syncFolder.heading')).setHeading();

			const currentSubpath =
				this.plugin.settings.appFolderSubpath || t('settings.syncFolder.appFolderRoot');

			new Setting(containerEl)
				.setName(t('settings.syncFolder.vaultSubfolder'))
				.setDesc(t('settings.syncFolder.vaultSubfolderDesc', { path: currentSubpath }))
				.addButton((btn) =>
					btn.setButtonText(t('settings.syncFolder.browse')).onClick(() => {
						const modal = new FolderBrowserModal(
							this.app,
							(path) => this.plugin.listAppFoldersForPicker(path),
							(selection: FolderSelection) => {
								// selection.path is like "/MyVault" or "/" for root
								const subpath = selection.path.replace(/^\/+|\/+$/g, '');
								void this.plugin.onAppFolderSubpathChanged(subpath).then(() => {
									this.renderSettings();
								});
							},
							this.plugin.settings.appFolderSubpath,
							{ rootLabel: t('settings.syncFolder.appFolderLabel') }
						);
						modal.open();
					})
				)
				.addExtraButton((btn) =>
					btn
						.setIcon('reset')
						.setTooltip(t('settings.syncFolder.useAppFolderRoot'))
						.onClick(() => {
							void this.plugin.onAppFolderSubpathChanged('').then(() => {
								this.renderSettings();
							});
						})
				);
		}

		if (isConnected) {
			this.displaySyncStatus(containerEl);
		}
	}

	/**
	 * Display sync configuration section
	 */
	private displaySyncSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t('settings.sync.heading')).setHeading();

		const { configDir } = this.app.vault;

		// Sync interval — show the current value inline in the description
		// since sliders give no numeric feedback on their own.
		const intervalDesc = (minutes: number): string => {
			const current =
				minutes > 0
					? t('settings.sync.automaticInterval.currentValue', { minutes })
					: t('settings.sync.automaticInterval.currentDisabled');
			return `${t('settings.sync.automaticInterval.desc')} ${current}`;
		};
		const intervalSetting = new Setting(containerEl)
			.setName(t('settings.sync.automaticInterval.name'))
			.setDesc(intervalDesc(this.plugin.settings.syncInterval));
		intervalSetting
			.addSlider((slider) =>
				slider
					.setLimits(0, 60, 5)
					.setValue(this.plugin.settings.syncInterval)
					.onChange(async (value) => {
						this.plugin.settings.syncInterval = value;
						intervalSetting.setDesc(intervalDesc(value));
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((button) =>
				button
					.setIcon('reset')
					.setTooltip(t('settings.sync.automaticInterval.resetTooltip'))
					.onClick(async () => {
						this.plugin.settings.syncInterval = 0;
						await this.plugin.saveSettings();
						this.renderSettings();
					})
			);

		// Sync on file change toggle
		new Setting(containerEl)
			.setName(t('settings.sync.syncOnFileChange.name'))
			.setDesc(t('settings.sync.syncOnFileChange.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnFileChange ?? true)
					.onChange(async (value) => {
						this.plugin.settings.syncOnFileChange = value;
						await this.plugin.saveSettings();
					})
			);

		// Startup sync delay
		new Setting(containerEl)
			.setName(t('settings.sync.startupDelay.name'))
			.setDesc(t('settings.sync.startupDelay.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('0', t('settings.sync.startupDelay.disabled'))
					.addOption('1', t('settings.sync.startupDelay.oneSecond'))
					.addOption('10', t('settings.sync.startupDelay.tenSeconds'))
					.addOption('30', t('settings.sync.startupDelay.thirtySeconds'))
					.setValue(String(this.plugin.settings.startupSyncDelay))
					.onChange(async (value) => {
						this.plugin.settings.startupSyncDelay = parseInt(value);
						await this.plugin.saveSettings();
					})
			);

		// Conflict resolution strategy
		new Setting(containerEl)
			.setName(t('settings.sync.conflictResolution.name'))
			.setDesc(t('settings.sync.conflictResolution.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption(
						ConflictResolutionStrategy.LAST_WRITE_WINS,
						t('settings.sync.conflictResolution.lastWriteWins')
					)
					.addOption(
						ConflictResolutionStrategy.CREATE_DUPLICATE,
						t('settings.sync.conflictResolution.createDuplicate')
					)
					.addOption(
						ConflictResolutionStrategy.MANUAL,
						t('settings.sync.conflictResolution.manual')
					)
					.setValue(this.plugin.settings.conflictResolution)
					.onChange(async (value) => {
						this.plugin.settings.conflictResolution = value as ConflictResolutionStrategy;
						await this.plugin.saveSettings();
					})
			);

		// Notification verbosity
		new Setting(containerEl)
			.setName(t('settings.sync.notificationLevel.name'))
			.setDesc(t('settings.sync.notificationLevel.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('all', t('settings.sync.notificationLevel.all'))
					.addOption('errors', t('settings.sync.notificationLevel.errors'))
					.addOption('off', t('settings.sync.notificationLevel.off'))
					.setValue(this.plugin.settings.notificationLevel ?? 'all')
					.onChange(async (value) => {
						this.plugin.settings.notificationLevel = value as PluginSettings['notificationLevel'];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t('settings.sync.appSettings.name'))
			.setDesc(t('settings.sync.appSettings.desc', { configDir }))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncAppSettings).onChange(async (value) => {
					await this.plugin.onAppSettingsSyncChanged(value);
				})
			);

		new Setting(containerEl)
			.setName(t('settings.sync.plugins.name'))
			.setDesc(t('settings.sync.plugins.desc', { configDir }))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncPluginManifests).onChange(async (value) => {
					await this.plugin.onPluginManifestSyncChanged(value);
				})
			);

		new Setting(containerEl)
			.setName(t('settings.sync.cssSnippets.name'))
			.setDesc(t('settings.sync.cssSnippets.desc', { configDir }))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncCssSnippets).onChange(async (value) => {
					await this.plugin.onCssSnippetSyncChanged(value);
				})
			);

		new Setting(containerEl)
			.setName(t('settings.sync.bookmarks.name'))
			.setDesc(t('settings.sync.bookmarks.desc', { configDir }))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncBookmarks).onChange(async (value) => {
					await this.plugin.onBookmarkSyncChanged(value);
				})
			);
	}

	private displaySyncStatus(containerEl: HTMLElement): void {
		const isConnected = !!this.plugin.settings.connectedUser;
		const syncStatus = this.plugin.getSyncStatusInfo();
		const statusText = this.getSyncStatusText(syncStatus.status);
		const lastSyncText = syncStatus.lastSyncTime
			? new Date(syncStatus.lastSyncTime).toLocaleString()
			: t('settings.sync.status.notSyncedYet');
		const progressText =
			syncStatus.status === SyncStatus.SYNCING
				? syncStatus.progressMessage || t('settings.sync.status.starting')
				: t('settings.sync.status.noProgress');
		const conflictText =
			syncStatus.conflictCount > 0
				? t('settings.sync.status.conflictsPending', { count: syncStatus.conflictCount })
				: t('settings.sync.status.noConflicts');

		new Setting(containerEl)
			.setName(t('settings.sync.status.name'))
			.setDesc(
				t('settings.sync.status.desc', {
					status: statusText,
					lastSync: lastSyncText,
					progress: progressText,
					conflicts: conflictText,
				})
			)
			.addButton((btn) => {
				btn
					.setButtonText(t('settings.sync.status.syncNow'))
					.setCta()
					.onClick(() => {
						void this.plugin.triggerManualSync();
					});
				if (
					!isConnected ||
					(this.plugin.settings.accessMode === OneDriveAccessMode.APP_FOLDER
						? this.plugin.settings.appFolderSubpathConfirmed !== true
						: !this.plugin.settings.remotePath)
				) {
					btn.setDisabled(true);
					if (!isConnected) {
						btn.setTooltip(t('settings.sync.status.connectTooltip'));
					} else {
						btn.setTooltip(t('settings.sync.status.selectFolderTooltip'));
					}
				}
			});
	}

	/**
	 * Display advanced section
	 */
	private displayAdvancedSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t('settings.advanced.heading')).setHeading();

		// Log level
		new Setting(containerEl)
			.setName(t('settings.advanced.logLevel.name'))
			.setDesc(t('settings.advanced.logLevel.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('off', t('settings.advanced.logLevel.off'))
					.addOption('error', t('settings.advanced.logLevel.error'))
					.addOption('warn', t('settings.advanced.logLevel.warn'))
					.addOption('info', t('settings.advanced.logLevel.info'))
					.addOption('debug', t('settings.advanced.logLevel.debug'))
					.setValue(this.plugin.settings.logLevel)
					.onChange(async (value) => {
						this.plugin.settings.logLevel = value as PluginSettings['logLevel'];
						await this.plugin.saveSettings();
					})
			);

		// Large-delete safety threshold
		new Setting(containerEl)
			.setName(t('settings.advanced.largeDeleteThreshold.name'))
			.setDesc(t('settings.advanced.largeDeleteThreshold.desc'))
			.addText((text) =>
				text
					.setPlaceholder(t('settings.advanced.largeDeleteThreshold.placeholder'))
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
				.setName(t('settings.advanced.remotePath.name'))
				.setDesc(t('settings.advanced.remotePath.desc'));
		}

		// Reset sync token
		new Setting(containerEl)
			.setName(t('settings.advanced.resetSyncToken.name'))
			.setDesc(t('settings.advanced.resetSyncToken.desc'))
			.addButton((button) =>
				button.setButtonText(t('settings.advanced.resetSyncToken.button')).onClick(async () => {
					await this.plugin.resetSyncToken();
				})
			);

		// Reconcile from cloud (cloud-as-truth recovery — issue #26)
		new Setting(containerEl)
			.setName(t('settings.advanced.reconcileFromCloud.name'))
			.setDesc(t('settings.advanced.reconcileFromCloud.desc'))
			.addButton((button) =>
				button.setButtonText(t('settings.advanced.reconcileFromCloud.button')).onClick(async () => {
					await this.plugin.reconcileFromCloud();
				})
			);

		// Custom client ID toggle
		new Setting(containerEl)
			.setName(t('settings.advanced.customClientId.toggleName'))
			.setDesc(t('settings.advanced.customClientId.toggleDesc'))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.useCustomClientId).onChange(async (value) => {
					this.plugin.settings.useCustomClientId = value;
					await this.plugin.saveSettings();
					this.renderSettings();
				})
			);

		if (this.plugin.settings.useCustomClientId) {
			new Setting(containerEl)
				.setName(t('settings.advanced.customClientId.name'))
				.setDesc(t('settings.advanced.customClientId.desc'))
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
			helpDiv.appendText(t('settings.advanced.customClientId.helpPrefix'));
			helpDiv.createEl('a', {
				text: t('settings.advanced.customClientId.helpLink'),
				href: 'https://github.com/jeffsteinbok/obsidian-onedrive#custom-client-id',
				attr: { target: '_blank' },
			});
			helpDiv.appendText(t('settings.advanced.customClientId.helpSuffix'));
		}
	}

	private getSyncStatusText(status: SyncStatus): string {
		switch (status) {
			case SyncStatus.SYNCING:
				return t('settings.sync.status.syncing');
			case SyncStatus.IDLE:
				return t('settings.sync.status.idle');
			case SyncStatus.ERROR:
				return t('settings.sync.status.error');
			case SyncStatus.DISCONNECTED:
				return t('settings.sync.status.disconnected');
			default:
				return status;
		}
	}

	/**
	 * Display experimental settings section
	 */
	private displayExperimentalSection(containerEl: HTMLElement): void {
		// Create collapsible details element
		const detailsEl = containerEl.createEl('details', { cls: 'onedrive-experimental-section' });
		const summaryEl = detailsEl.createEl('summary');
		new Setting(summaryEl).setName(t('settings.experimental.heading')).setHeading();

		// Description as a proper setting item (no name, just desc)
		new Setting(detailsEl).setDesc(t('settings.experimental.description'));

		// Skip folder existence checks
		new Setting(detailsEl)
			.setName(t('settings.experimental.skipFolderChecks.name'))
			.setDesc(t('settings.experimental.skipFolderChecks.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.getExperimentalSetting('skipFolderChecks'))
					.onChange(async (value) => {
						this.plugin.settings.experimental = {
							...DEFAULT_EXPERIMENTAL_SETTINGS,
							...this.plugin.settings.experimental,
							skipFolderChecks: value,
						};
						await this.plugin.saveSettings();
					})
			);

		// Max concurrent operations
		new Setting(detailsEl)
			.setName(t('settings.experimental.maxConcurrentOperations.name'))
			.setDesc(t('settings.experimental.maxConcurrentOperations.desc'))
			.addText((text) =>
				text
					.setPlaceholder(t('settings.experimental.maxConcurrentOperations.placeholder'))
					.setValue(String(this.plugin.getExperimentalSetting('maxConcurrentOperations')))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (Number.isNaN(parsed) || parsed < 1 || parsed > 16) return;
						this.plugin.settings.experimental = {
							...DEFAULT_EXPERIMENTAL_SETTINGS,
							...this.plugin.settings.experimental,
							maxConcurrentOperations: parsed,
						};
						await this.plugin.saveSettings();
					})
			);

		// Use atomic moves
		new Setting(detailsEl)
			.setName(t('settings.experimental.useAtomicMoves.name'))
			.setDesc(t('settings.experimental.useAtomicMoves.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.getExperimentalSetting('useAtomicMoves'))
					.onChange(async (value) => {
						this.plugin.settings.experimental = {
							...DEFAULT_EXPERIMENTAL_SETTINGS,
							...this.plugin.settings.experimental,
							useAtomicMoves: value,
						};
						await this.plugin.saveSettings();
					})
			);

		// Pull-only mode
		new Setting(detailsEl)
			.setName(t('settings.experimental.pullOnlyMode.name'))
			.setDesc(t('settings.experimental.pullOnlyMode.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.getExperimentalSetting('pullOnlyMode'))
					.onChange(async (value) => {
						this.plugin.settings.experimental = {
							...DEFAULT_EXPERIMENTAL_SETTINGS,
							...this.plugin.settings.experimental,
							pullOnlyMode: value,
						};
						await this.plugin.saveSettings();
					})
			);
	}
}
