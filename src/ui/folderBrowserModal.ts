/**
 * Modal for browsing and selecting OneDrive folders
 */

import { App, Modal, Setting } from 'obsidian';
import { OneDriveItem } from '../types';

export interface FolderSelection {
	path: string;
	name: string;
	isShared: boolean;
	driveId?: string;
	itemId?: string;
}

type FolderListFn = (path: string) => Promise<OneDriveItem[]>;

/**
 * Modal that lets the user browse OneDrive folders and select one
 */
export class FolderBrowserModal extends Modal {
	private currentPath: string[] = [];
	private onSelect: (selection: FolderSelection) => void;
	private listFolders: FolderListFn;
	private contentEl_body: HTMLElement;
	private loading = false;

	// Track the shared folder info if the user navigated into one at the top level
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

		contentEl.createEl('h3', { text: 'Select OneDrive Folder' });

		this.contentEl_body = contentEl.createDiv({ cls: 'folder-browser-body' });
		this.contentEl_body.style.minHeight = '200px';
		this.contentEl_body.style.maxHeight = '400px';
		this.contentEl_body.style.overflowY = 'auto';

		this.loadFolder();
	}

	onClose() {
		this.contentEl.empty();
	}

	private get currentPathStr(): string {
		return this.currentPath.length > 0 ? this.currentPath.join('/') : '';
	}

	private async loadFolder() {
		if (this.loading) return;
		this.loading = true;

		const body = this.contentEl_body;
		body.empty();

		// Breadcrumb
		const breadcrumb = body.createDiv({ cls: 'folder-breadcrumb' });
		breadcrumb.style.marginBottom = '8px';
		breadcrumb.style.fontSize = '13px';
		breadcrumb.style.color = 'var(--text-muted)';
		breadcrumb.style.display = 'flex';
		breadcrumb.style.alignItems = 'center';
		breadcrumb.style.flexWrap = 'wrap';
		breadcrumb.style.gap = '2px';

		// Root link
		const rootLink = breadcrumb.createEl('span', { text: '📁 OneDrive' });
		rootLink.style.cursor = 'pointer';
		rootLink.style.color = 'var(--text-accent)';
		rootLink.onclick = () => {
			this.currentPath = [];
			this.sharedDriveId = undefined;
			this.sharedItemId = undefined;
			this.sharedAtDepth = undefined;
			this.loadFolder();
		};

		for (let i = 0; i < this.currentPath.length; i++) {
			breadcrumb.createEl('span', { text: ' / ' });
			const seg = breadcrumb.createEl('span', { text: this.currentPath[i] });
			if (i < this.currentPath.length - 1) {
				seg.style.cursor = 'pointer';
				seg.style.color = 'var(--text-accent)';
				const depth = i;
				seg.onclick = () => {
					this.currentPath = this.currentPath.slice(0, depth + 1);
					if (this.sharedAtDepth !== undefined && depth < this.sharedAtDepth) {
						this.sharedDriveId = undefined;
						this.sharedItemId = undefined;
						this.sharedAtDepth = undefined;
					}
					this.loadFolder();
				};
			}
		}

		// Select button for current folder
		if (this.currentPath.length > 0) {
			const selectRow = body.createDiv();
			selectRow.style.marginBottom = '12px';
			new Setting(selectRow)
				.setName(`Select "/${this.currentPath.join('/')}"`)
				.addButton((btn) =>
					btn.setButtonText('Use this folder').setCta().onClick(() => {
						const isShared = !!(this.sharedDriveId && this.sharedItemId);
						this.onSelect({
							path: `/${this.currentPath.join('/')}`,
							name: this.currentPath[this.currentPath.length - 1],
							isShared,
							driveId: this.sharedDriveId,
							itemId: this.sharedItemId,
						});
						this.close();
					})
				);
		}

		// Loading indicator
		const loadingEl = body.createDiv({ text: 'Loading folders...' });
		loadingEl.style.color = 'var(--text-muted)';
		loadingEl.style.fontStyle = 'italic';

		try {
			const folders = await this.listFolders(this.currentPathStr);

			loadingEl.remove();

			if (folders.length === 0) {
				const emptyEl = body.createDiv({ text: 'No subfolders' });
				emptyEl.style.color = 'var(--text-muted)';
				emptyEl.style.fontStyle = 'italic';
				emptyEl.style.padding = '8px 0';
			}

			for (const folder of folders) {
				const isShared = !!folder.remoteItem;
				const name = folder.name;
				const childCount = folder.folder?.childCount ?? folder.remoteItem?.folder?.childCount ?? 0;

				const row = body.createDiv({ cls: 'folder-row' });
				row.style.display = 'flex';
				row.style.alignItems = 'center';
				row.style.padding = '6px 8px';
				row.style.cursor = 'pointer';
				row.style.borderRadius = '4px';

				row.onmouseenter = () => { row.style.backgroundColor = 'var(--background-modifier-hover)'; };
				row.onmouseleave = () => { row.style.backgroundColor = ''; };

				const icon = isShared ? '🔗' : '📁';
				row.createEl('span', { text: `${icon} ${name}` });

				const meta = row.createEl('span');
				meta.style.marginLeft = 'auto';
				meta.style.fontSize = '12px';
				meta.style.color = 'var(--text-muted)';
				const parts: string[] = [];
				if (isShared) parts.push('shared');
				if (childCount > 0) parts.push(`${childCount} items`);
				meta.textContent = parts.join(' · ');

				row.onclick = () => {
					// If this is a shared/remote item at this level, capture its drive info
					if (isShared && folder.remoteItem) {
						this.sharedDriveId = folder.remoteItem.parentReference.driveId;
						this.sharedItemId = folder.remoteItem.id;
						this.sharedAtDepth = this.currentPath.length;
					}
					this.currentPath.push(name);
					this.loadFolder();
				};
			}
		} catch (error) {
			loadingEl.remove();
			const errorEl = body.createDiv({
				text: `Error loading folders: ${error instanceof Error ? error.message : 'Unknown error'}`,
			});
			errorEl.style.color = 'var(--text-error)';
		}

		this.loading = false;
	}
}
