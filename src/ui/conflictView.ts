/**
 * Conflict resolution view — an Obsidian ItemView pane that displays
 * pending sync conflicts with git-style resolution actions and inline diffs.
 */

import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import { ConflictEntry, ConflictResolution } from '../types';
import { ConflictQueue } from '../sync/conflictQueue';
import { diffLines } from 'diff';

export const CONFLICT_VIEW_TYPE = 'onedrive-conflict-view';

export class ConflictView extends ItemView {
	private conflictQueue: ConflictQueue;
	private onSaveSettings: () => Promise<void>;

	constructor(
		leaf: WorkspaceLeaf,
		conflictQueue: ConflictQueue,
		onSaveSettings: () => Promise<void>
	) {
		super(leaf);
		this.conflictQueue = conflictQueue;
		this.onSaveSettings = onSaveSettings;
	}

	getViewType(): string {
		return CONFLICT_VIEW_TYPE;
	}

	getDisplayText(): string {
		const count = this.conflictQueue.count;
		return count > 0 ? `Sync Conflicts (${count})` : 'Sync Conflicts';
	}

	getIcon(): string {
		return 'git-merge';
	}

	async onOpen(): Promise<void> {
		await this.renderView();
	}

	async onClose(): Promise<void> {
		// Nothing to clean up
	}

	/**
	 * Re-render the entire view
	 */
	async renderView(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();

		const entries = this.conflictQueue.getAll();

		// Header
		const header = container.createDiv({ cls: 'onedrive-conflict-header' });
		header.createEl('h4', { text: 'Sync Conflicts' });

		if (entries.length === 0) {
			const empty = container.createDiv({ cls: 'onedrive-conflict-empty' });
			empty.createEl('p', {
				text: 'No conflicts to resolve.',
				cls: 'onedrive-conflict-empty-text',
			});
			return;
		}

		header.createEl('p', {
			text: `${entries.length} file${entries.length === 1 ? '' : 's'} with conflicts`,
			cls: 'onedrive-conflict-subtitle',
		});

		// Bulk actions
		const bulkActions = header.createDiv({ cls: 'onedrive-conflict-bulk-actions' });

		const acceptAllCurrent = bulkActions.createEl('button', {
			text: 'Accept All Current',
			cls: 'onedrive-conflict-btn onedrive-conflict-btn-current',
		});
		acceptAllCurrent.addEventListener('click', async () => {
			await this.conflictQueue.resolveAll(ConflictResolution.ACCEPT_CURRENT);
			await this.onSaveSettings();
			await this.renderView();
		});

		const acceptAllIncoming = bulkActions.createEl('button', {
			text: 'Accept All Incoming',
			cls: 'onedrive-conflict-btn onedrive-conflict-btn-incoming',
		});
		acceptAllIncoming.addEventListener('click', async () => {
			await this.conflictQueue.resolveAll(ConflictResolution.ACCEPT_INCOMING);
			await this.onSaveSettings();
			await this.renderView();
		});

		// Conflict entries
		const list = container.createDiv({ cls: 'onedrive-conflict-list' });
		for (const entry of entries) {
			await this.renderConflictEntry(list, entry);
		}

		// Add styles
		this.addStyles(container);
	}

	/**
	 * Render a single conflict entry
	 */
	private async renderConflictEntry(container: HTMLElement, entry: ConflictEntry): Promise<void> {
		const card = container.createDiv({ cls: 'onedrive-conflict-card' });

		// File info header
		const fileHeader = card.createDiv({ cls: 'onedrive-conflict-file-header' });
		const iconEl = fileHeader.createSpan({ cls: 'onedrive-conflict-file-icon' });
		setIcon(iconEl, 'file-text');
		fileHeader.createSpan({ text: entry.path, cls: 'onedrive-conflict-file-path' });

		// Metadata
		const meta = card.createDiv({ cls: 'onedrive-conflict-meta' });
		const currentMeta = meta.createDiv({ cls: 'onedrive-conflict-meta-side' });
		currentMeta.createEl('strong', { text: 'Current (local)' });
		currentMeta.createEl('span', {
			text: `Modified: ${new Date(entry.localModifiedTime).toLocaleString()}`,
		});
		currentMeta.createEl('span', { text: `Size: ${this.formatSize(entry.localSize)}` });

		const incomingMeta = meta.createDiv({ cls: 'onedrive-conflict-meta-side' });
		incomingMeta.createEl('strong', { text: 'Incoming (remote)' });
		incomingMeta.createEl('span', {
			text: `Modified: ${new Date(entry.remoteModifiedTime).toLocaleString()}`,
		});
		incomingMeta.createEl('span', { text: `Size: ${this.formatSize(entry.remoteSize)}` });

		// Diff (for text files)
		if (entry.isTextFile) {
			await this.renderDiff(card, entry);
		} else {
			const binaryNote = card.createDiv({ cls: 'onedrive-conflict-binary' });
			binaryNote.createEl('em', { text: 'Binary file — diff not available' });
		}

		// Actions
		const actions = card.createDiv({ cls: 'onedrive-conflict-actions' });

		const acceptCurrent = actions.createEl('button', {
			text: 'Accept Current Change',
			cls: 'onedrive-conflict-btn onedrive-conflict-btn-current',
		});
		acceptCurrent.addEventListener('click', async () => {
			await this.conflictQueue.resolve(entry.id, ConflictResolution.ACCEPT_CURRENT);
			await this.onSaveSettings();
			await this.renderView();
		});

		const acceptIncoming = actions.createEl('button', {
			text: 'Accept Incoming Change',
			cls: 'onedrive-conflict-btn onedrive-conflict-btn-incoming',
		});
		acceptIncoming.addEventListener('click', async () => {
			await this.conflictQueue.resolve(entry.id, ConflictResolution.ACCEPT_INCOMING);
			await this.onSaveSettings();
			await this.renderView();
		});

		const acceptBoth = actions.createEl('button', {
			text: 'Accept Both Changes',
			cls: 'onedrive-conflict-btn onedrive-conflict-btn-both',
		});
		acceptBoth.addEventListener('click', async () => {
			await this.conflictQueue.resolve(entry.id, ConflictResolution.ACCEPT_BOTH);
			await this.onSaveSettings();
			await this.renderView();
		});
	}

	/**
	 * Render an inline diff for a text file conflict
	 */
	private async renderDiff(container: HTMLElement, entry: ConflictEntry): Promise<void> {
		try {
			const localBuf = await this.conflictQueue.readCurrentContent(entry.id);
			const remoteBuf = await this.conflictQueue.readIncomingContent(entry.id);

			const decoder = new TextDecoder('utf-8');
			const localText = decoder.decode(localBuf);
			const remoteText = decoder.decode(remoteBuf);

			const diffResult = diffLines(localText, remoteText);

			const diffContainer = container.createDiv({ cls: 'onedrive-conflict-diff' });
			const pre = diffContainer.createEl('pre');

			for (const part of diffResult) {
				const span = pre.createEl('span');
				if (part.added) {
					span.addClass('onedrive-diff-added');
					span.textContent = this.prefixLines(part.value, '+ ');
				} else if (part.removed) {
					span.addClass('onedrive-diff-removed');
					span.textContent = this.prefixLines(part.value, '- ');
				} else {
					span.addClass('onedrive-diff-unchanged');
					// Show context — truncate long unchanged sections
					const lines = part.value.split('\n');
					if (lines.length > 6) {
						const top = lines.slice(0, 3).join('\n');
						const bottom = lines.slice(-3).join('\n');
						span.textContent =
							this.prefixLines(top, '  ') +
							`\n  ... ${lines.length - 6} unchanged lines ...\n` +
							this.prefixLines(bottom, '  ');
					} else {
						span.textContent = this.prefixLines(part.value, '  ');
					}
				}
			}
		} catch (error) {
			const errorDiv = container.createDiv({ cls: 'onedrive-conflict-diff-error' });
			errorDiv.createEl('em', { text: 'Could not load diff' });
		}
	}

	private prefixLines(text: string, prefix: string): string {
		return text
			.split('\n')
			.map((line) => prefix + line)
			.join('\n');
	}

	private formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	/**
	 * Inject scoped styles into the view container
	 */
	private addStyles(container: HTMLElement): void {
		// Only add once
		if (container.querySelector('style[data-onedrive-conflict]')) return;

		const style = document.createElement('style');
		style.setAttribute('data-onedrive-conflict', 'true');
		style.textContent = `
			.onedrive-conflict-header {
				padding: 12px 16px;
				border-bottom: 1px solid var(--background-modifier-border);
			}
			.onedrive-conflict-header h4 {
				margin: 0 0 4px 0;
			}
			.onedrive-conflict-subtitle {
				color: var(--text-muted);
				font-size: 0.9em;
				margin: 0 0 8px 0;
			}
			.onedrive-conflict-empty {
				padding: 32px 16px;
				text-align: center;
			}
			.onedrive-conflict-empty-text {
				color: var(--text-muted);
			}
			.onedrive-conflict-bulk-actions {
				display: flex;
				gap: 8px;
				margin-top: 8px;
			}
			.onedrive-conflict-list {
				padding: 8px 16px;
			}
			.onedrive-conflict-card {
				border: 1px solid var(--background-modifier-border);
				border-radius: 8px;
				padding: 12px;
				margin-bottom: 12px;
				background: var(--background-secondary);
			}
			.onedrive-conflict-file-header {
				display: flex;
				align-items: center;
				gap: 6px;
				margin-bottom: 8px;
			}
			.onedrive-conflict-file-path {
				font-weight: 600;
				font-size: 0.95em;
				word-break: break-all;
			}
			.onedrive-conflict-meta {
				display: flex;
				gap: 16px;
				margin-bottom: 8px;
				font-size: 0.85em;
			}
			.onedrive-conflict-meta-side {
				display: flex;
				flex-direction: column;
				gap: 2px;
				color: var(--text-muted);
			}
			.onedrive-conflict-meta-side strong {
				color: var(--text-normal);
			}
			.onedrive-conflict-diff {
				margin: 8px 0;
				max-height: 300px;
				overflow-y: auto;
				border: 1px solid var(--background-modifier-border);
				border-radius: 4px;
				background: var(--background-primary);
			}
			.onedrive-conflict-diff pre {
				margin: 0;
				padding: 8px;
				font-size: 0.82em;
				line-height: 1.5;
				white-space: pre-wrap;
				word-wrap: break-word;
			}
			.onedrive-diff-added {
				background: var(--background-modifier-success);
				color: var(--text-success);
				display: block;
			}
			.onedrive-diff-removed {
				background: var(--background-modifier-error);
				color: var(--text-error);
				display: block;
			}
			.onedrive-diff-unchanged {
				color: var(--text-muted);
				display: block;
			}
			.onedrive-conflict-binary {
				padding: 8px;
				color: var(--text-muted);
				font-size: 0.9em;
			}
			.onedrive-conflict-actions {
				display: flex;
				gap: 8px;
				margin-top: 8px;
				flex-wrap: wrap;
			}
			.onedrive-conflict-btn {
				padding: 4px 12px;
				border-radius: 4px;
				font-size: 0.85em;
				cursor: pointer;
				border: 1px solid var(--background-modifier-border);
				background: var(--interactive-normal);
				color: var(--text-normal);
			}
			.onedrive-conflict-btn:hover {
				background: var(--interactive-hover);
			}
			.onedrive-conflict-btn-current {
				border-color: var(--interactive-accent);
			}
			.onedrive-conflict-btn-incoming {
				border-color: var(--text-success);
			}
			.onedrive-conflict-btn-both {
				border-color: var(--text-muted);
			}
			.onedrive-conflict-diff-error {
				padding: 8px;
				color: var(--text-muted);
			}
		`;
		container.appendChild(style);
	}
}
