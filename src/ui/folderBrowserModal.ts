/**
 * Modal for browsing and selecting OneDrive folders
 */

import { App, Modal, Setting } from 'obsidian';
import { OneDriveItem } from '../types';
import { t } from '../i18n';

export interface FolderSelection {
	path: string;
	name: string;
	isShared: boolean;
	driveId?: string;
	itemId?: string;
}

type FolderListFn = (
	path: string,
	sharedDriveId?: string,
	sharedItemId?: string,
	relativePathInShared?: string
) => Promise<OneDriveItem[]>;

/**
 * Modal that lets the user browse OneDrive folders and select one
 */
export class FolderBrowserModal extends Modal {
	private currentPath: string[] = [];
	private onSelect: (selection: FolderSelection) => void;
	private listFolders: FolderListFn;
	private contentEl_body: HTMLElement;
	private loading = false;

	// Track the shared folder info if the user navigated into one
	private sharedDriveId?: string;
	private sharedItemId?: string;
	private sharedAtDepth?: number; // depth at which the shared folder was entered

	constructor(
		app: App,
		listFolders: FolderListFn,
		onSelect: (selection: FolderSelection) => void,
		initialPath?: string
	) {
		super(app);
		this.listFolders = listFolders;
		this.onSelect = onSelect;

		if (initialPath) {
			this.currentPath = initialPath.split('/').filter((s) => s.length > 0);
		}
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('onedrive-folder-browser');

		contentEl.createEl('h3', { text: t('folderBrowser.title') });

		this.contentEl_body = contentEl.createDiv({
			cls: 'folder-browser-body onedrive-sync-folder-browser-body',
		});

		void this.loadFolder();
	}

	onClose() {
		this.contentEl.empty();
	}

	private get currentPathStr(): string {
		return this.currentPath.length > 0 ? this.currentPath.join('/') : '';
	}

	/**
	 * Get the relative path within the shared folder (segments after sharedAtDepth + 1)
	 */
	private get relativePathInShared(): string {
		if (this.sharedAtDepth === undefined) return '';
		const segments = this.currentPath.slice(this.sharedAtDepth + 1);
		return segments.join('/');
	}

	private async loadFolder() {
		if (this.loading) return;
		this.loading = true;

		const body = this.contentEl_body;
		body.empty();

		// Breadcrumb
		const breadcrumb = body.createDiv({
			cls: 'folder-breadcrumb onedrive-sync-folder-breadcrumb',
		});

		// Root link
		const rootLink = breadcrumb.createEl('span', {
			text: '📁 OneDrive',
			cls: 'onedrive-sync-folder-breadcrumb-link',
		});
		rootLink.onclick = () => {
			this.currentPath = [];
			this.sharedDriveId = undefined;
			this.sharedItemId = undefined;
			this.sharedAtDepth = undefined;
			void this.loadFolder();
		};

		for (let i = 0; i < this.currentPath.length; i++) {
			breadcrumb.createEl('span', { text: ' / ' });
			const seg = breadcrumb.createEl('span', { text: this.currentPath[i] });
			if (i < this.currentPath.length - 1) {
				seg.addClass('onedrive-sync-folder-breadcrumb-link');
				const depth = i;
				seg.onclick = () => {
					this.currentPath = this.currentPath.slice(0, depth + 1);
					if (this.sharedAtDepth !== undefined && depth < this.sharedAtDepth) {
						this.sharedDriveId = undefined;
						this.sharedItemId = undefined;
						this.sharedAtDepth = undefined;
					}
					void this.loadFolder();
				};
			}
		}

		// Select button for current folder
		if (this.currentPath.length > 0) {
			const selectRow = body.createDiv({ cls: 'onedrive-sync-folder-browser-select-row' });
			new Setting(selectRow)
				.setName(t('folderBrowser.selectCurrent', { path: this.currentPath.join('/') }))
				.addButton((btn) =>
					btn
						.setButtonText(t('folderBrowser.useThisFolder'))
						.setCta()
						.onClick(() => {
							const isShared = !!(this.sharedDriveId && this.sharedItemId);
							this.onSelect({
								path: `/${this.currentPath.join('/')}`,
								name: this.currentPath[this.sharedAtDepth ?? this.currentPath.length - 1],
								isShared,
								driveId: this.sharedDriveId,
								itemId: this.sharedItemId,
							});
							this.close();
						})
				);
		}

		// Loading indicator
		const loadingEl = body.createDiv({
			text: t('folderBrowser.loading'),
			cls: 'onedrive-sync-folder-browser-note',
		});

		try {
			let folders: OneDriveItem[];

			if (this.sharedDriveId && this.sharedItemId) {
				// Inside a shared folder — use remote drive API
				folders = await this.listFolders(
					this.currentPathStr,
					this.sharedDriveId,
					this.sharedItemId,
					this.relativePathInShared
				);
			} else {
				// User's own drive
				folders = await this.listFolders(this.currentPathStr);
			}

			loadingEl.remove();

			if (folders.length === 0) {
				body.createDiv({
					text: t('folderBrowser.noSubfolders'),
					cls: 'onedrive-sync-folder-browser-note onedrive-sync-folder-browser-empty',
				});
			}

			for (const folder of folders) {
				const isShared = !!folder.remoteItem;
				const name = folder.name;
				const childCount = folder.folder?.childCount ?? folder.remoteItem?.folder?.childCount ?? 0;

				const row = body.createDiv({
					cls: 'folder-row onedrive-sync-folder-row',
				});

				const icon = isShared ? '🔗' : '📁';
				row.createEl('span', { text: `${icon} ${name}` });

				const meta = row.createEl('span', { cls: 'onedrive-sync-folder-row-meta' });
				const parts: string[] = [];
				if (isShared) parts.push(t('folderBrowser.shared'));
				if (childCount > 0) {
					parts.push(
						t(childCount === 1 ? 'folderBrowser.item' : 'folderBrowser.items', {
							count: childCount,
						})
					);
				}
				meta.textContent = parts.join(' · ');

				row.onclick = () => {
					// If this is a shared/remote item, capture its drive info
					if (isShared && folder.remoteItem) {
						this.sharedDriveId = folder.remoteItem.parentReference.driveId;
						this.sharedItemId = folder.remoteItem.id;
						this.sharedAtDepth = this.currentPath.length;
					}
					this.currentPath.push(name);
					void this.loadFolder();
				};
			}
		} catch (error) {
			loadingEl.remove();
			body.createDiv({
				text: t('folderBrowser.loadError', {
					message: error instanceof Error ? error.message : t('folderBrowser.unknownError'),
				}),
				cls: 'onedrive-sync-folder-browser-error',
			});
		}

		this.loading = false;
	}
}
