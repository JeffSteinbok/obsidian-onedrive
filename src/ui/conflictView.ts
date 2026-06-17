/**
 * Conflict resolution view — an Obsidian ItemView pane that displays
 * pending sync conflicts with git-style resolution actions and inline diffs.
 */

import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import { ConflictEntry, ConflictResolution } from '../types';
import { ConflictQueue } from '../sync/conflictQueue';
import { diffLines } from 'diff';
import { t } from '../i18n';

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
		return count > 0 ? t('conflictView.titleWithCount', { count }) : t('conflictView.title');
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
		const header = container.createDiv({ cls: 'onedrive-sync-conflict-header' });
		header.createEl('h4', { text: t('conflictView.title') });

		if (entries.length === 0) {
			const empty = container.createDiv({ cls: 'onedrive-sync-conflict-empty' });
			empty.createEl('p', {
				text: t('conflictView.empty'),
				cls: 'onedrive-sync-conflict-empty-text',
			});
			return;
		}

		header.createEl('p', {
			text: t(entries.length === 1 ? 'conflictView.subtitleFile' : 'conflictView.subtitleFiles', {
				count: entries.length,
			}),
			cls: 'onedrive-sync-conflict-subtitle',
		});

		// Bulk actions
		const bulkActions = header.createDiv({ cls: 'onedrive-sync-conflict-bulk-actions' });

		const acceptAllCurrent = bulkActions.createEl('button', {
			text: t('conflictView.acceptAllCurrent'),
			cls: 'onedrive-sync-conflict-btn onedrive-sync-conflict-btn-current',
		});
		acceptAllCurrent.addEventListener('click', () => {
			void (async () => {
				await this.conflictQueue.resolveAll(ConflictResolution.ACCEPT_CURRENT);
				await this.onSaveSettings();
				await this.renderView();
			})();
		});

		const acceptAllIncoming = bulkActions.createEl('button', {
			text: t('conflictView.acceptAllIncoming'),
			cls: 'onedrive-sync-conflict-btn onedrive-sync-conflict-btn-incoming',
		});
		acceptAllIncoming.addEventListener('click', () => {
			void (async () => {
				await this.conflictQueue.resolveAll(ConflictResolution.ACCEPT_INCOMING);
				await this.onSaveSettings();
				await this.renderView();
			})();
		});

		// Conflict entries
		const list = container.createDiv({ cls: 'onedrive-sync-conflict-list' });
		for (const entry of entries) {
			await this.renderConflictEntry(list, entry);
		}
	}

	/**
	 * Render a single conflict entry
	 */
	private async renderConflictEntry(container: HTMLElement, entry: ConflictEntry): Promise<void> {
		const card = container.createDiv({ cls: 'onedrive-sync-conflict-card' });

		// File info header
		const fileHeader = card.createDiv({ cls: 'onedrive-sync-conflict-file-header' });
		const iconEl = fileHeader.createSpan({ cls: 'onedrive-sync-conflict-file-icon' });
		setIcon(iconEl, 'file-text');
		fileHeader.createSpan({ text: entry.path, cls: 'onedrive-sync-conflict-file-path' });

		// Metadata
		const meta = card.createDiv({ cls: 'onedrive-sync-conflict-meta' });
		const currentMeta = meta.createDiv({ cls: 'onedrive-sync-conflict-meta-side' });
		currentMeta.createEl('strong', { text: t('conflictView.currentLabel') });
		currentMeta.createEl('span', {
			text: t('conflictView.modified', {
				time: new Date(entry.localModifiedTime).toLocaleString(),
			}),
		});
		currentMeta.createEl('span', {
			text: t('conflictView.size', { size: this.formatSize(entry.localSize) }),
		});

		const incomingMeta = meta.createDiv({ cls: 'onedrive-sync-conflict-meta-side' });
		incomingMeta.createEl('strong', { text: t('conflictView.incomingLabel') });
		incomingMeta.createEl('span', {
			text: t('conflictView.modified', {
				time: new Date(entry.remoteModifiedTime).toLocaleString(),
			}),
		});
		incomingMeta.createEl('span', {
			text: t('conflictView.size', { size: this.formatSize(entry.remoteSize) }),
		});

		// Diff (for text files)
		if (entry.isTextFile) {
			await this.renderDiff(card, entry);
		} else {
			const binaryNote = card.createDiv({ cls: 'onedrive-sync-conflict-binary' });
			binaryNote.createEl('em', { text: t('conflictView.binaryDiffUnavailable') });
		}

		// Actions
		const actions = card.createDiv({ cls: 'onedrive-sync-conflict-actions' });

		const acceptCurrent = actions.createEl('button', {
			text: t('conflictView.acceptCurrent'),
			cls: 'onedrive-sync-conflict-btn onedrive-sync-conflict-btn-current',
		});
		acceptCurrent.addEventListener('click', () => {
			void (async () => {
				await this.conflictQueue.resolve(entry.id, ConflictResolution.ACCEPT_CURRENT);
				await this.onSaveSettings();
				await this.renderView();
			})();
		});

		const acceptIncoming = actions.createEl('button', {
			text: t('conflictView.acceptIncoming'),
			cls: 'onedrive-sync-conflict-btn onedrive-sync-conflict-btn-incoming',
		});
		acceptIncoming.addEventListener('click', () => {
			void (async () => {
				await this.conflictQueue.resolve(entry.id, ConflictResolution.ACCEPT_INCOMING);
				await this.onSaveSettings();
				await this.renderView();
			})();
		});

		const acceptBoth = actions.createEl('button', {
			text: t('conflictView.acceptBoth'),
			cls: 'onedrive-sync-conflict-btn onedrive-sync-conflict-btn-both',
		});
		acceptBoth.addEventListener('click', () => {
			void (async () => {
				await this.conflictQueue.resolve(entry.id, ConflictResolution.ACCEPT_BOTH);
				await this.onSaveSettings();
				await this.renderView();
			})();
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

			const diffContainer = container.createDiv({ cls: 'onedrive-sync-conflict-diff' });
			const pre = diffContainer.createEl('pre');

			for (const part of diffResult) {
				const span = pre.createEl('span');
				if (part.added) {
					span.addClass('onedrive-sync-diff-added');
					span.textContent = this.prefixLines(part.value, '+ ');
				} else if (part.removed) {
					span.addClass('onedrive-sync-diff-removed');
					span.textContent = this.prefixLines(part.value, '- ');
				} else {
					span.addClass('onedrive-sync-diff-unchanged');
					// Show context — truncate long unchanged sections
					const lines = part.value.split('\n');
					if (lines.length > 6) {
						const top = lines.slice(0, 3).join('\n');
						const bottom = lines.slice(-3).join('\n');
						span.textContent =
							this.prefixLines(top, '  ') +
							`\n  ${t('conflictView.unchangedLines', { count: lines.length - 6 })}\n` +
							this.prefixLines(bottom, '  ');
					} else {
						span.textContent = this.prefixLines(part.value, '  ');
					}
				}
			}
		} catch {
			const errorDiv = container.createDiv({ cls: 'onedrive-sync-conflict-diff-error' });
			errorDiv.createEl('em', { text: t('conflictView.diffLoadError') });
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
}
