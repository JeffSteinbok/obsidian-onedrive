/**
 * Modal dialogs for various user interactions
 */

import { Modal, App, Setting } from 'obsidian';
import { ConflictInfo, LargeDeleteWarningInfo, LargeDeleteDecision } from '../types';

/**
 * Conflict resolution modal
 * Shown when manual conflict resolution is needed
 */
export class ConflictResolutionModal extends Modal {
	private conflictInfo: ConflictInfo;
	private onResolve: (useLocal: boolean) => void;

	constructor(app: App, conflictInfo: ConflictInfo, onResolve: (useLocal: boolean) => void) {
		super(app);
		this.conflictInfo = conflictInfo;
		this.onResolve = onResolve;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.empty();
		contentEl.addClass('onedrive-conflict-modal');

		// Title
		contentEl.createEl('h2', { text: 'Sync Conflict Detected' });

		// Conflict description
		const descDiv = contentEl.createDiv({ cls: 'conflict-description' });
		descDiv.createEl('p', {
			text: `The file "${this.conflictInfo.path}" has been modified both locally and on OneDrive.`,
		});

		// Local file info
		const localInfo = descDiv.createDiv({ cls: 'file-info' });
		localInfo.createEl('h3', { text: 'Local Version' });
		localInfo.createEl('p', {
			text: `Modified: ${new Date(this.conflictInfo.localModifiedTime).toLocaleString()}`,
		});
		localInfo.createEl('p', { text: `Size: ${this.formatSize(this.conflictInfo.localSize)}` });

		// Remote file info
		const remoteInfo = descDiv.createDiv({ cls: 'file-info' });
		remoteInfo.createEl('h3', { text: 'OneDrive Version' });
		remoteInfo.createEl('p', {
			text: `Modified: ${new Date(this.conflictInfo.remoteModifiedTime).toLocaleString()}`,
		});
		remoteInfo.createEl('p', {
			text: `Size: ${this.formatSize(this.conflictInfo.remoteSize)}`,
		});

		// Question
		contentEl.createEl('p', {
			text: 'Which version would you like to keep?',
			cls: 'conflict-question',
		});

		// Buttons
		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'space-around';
		buttonContainer.style.marginTop = '20px';

		const localButton = buttonContainer.createEl('button', {
			text: 'Keep Local',
			cls: 'mod-cta',
		});
		localButton.addEventListener('click', () => {
			this.onResolve(true);
			this.close();
		});

		const remoteButton = buttonContainer.createEl('button', {
			text: 'Keep OneDrive',
			cls: 'mod-cta',
		});
		remoteButton.addEventListener('click', () => {
			this.onResolve(false);
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	/**
	 * Format file size in human-readable format
	 */
	private formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	}
}

/**
 * Sync progress modal
 * Shows progress during long sync operations
 */
export class SyncProgressModal extends Modal {
	private progressText: HTMLElement;
	private progressBar: HTMLElement;

	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.empty();
		contentEl.addClass('onedrive-sync-progress-modal');

		// Title
		contentEl.createEl('h2', { text: 'Syncing with OneDrive' });

		// Progress text
		this.progressText = contentEl.createEl('p', { text: 'Preparing sync...' });

		// Progress bar
		const progressContainer = contentEl.createDiv({ cls: 'progress-container' });
		progressContainer.style.width = '100%';
		progressContainer.style.height = '20px';
		progressContainer.style.backgroundColor = 'var(--background-secondary)';
		progressContainer.style.borderRadius = '10px';
		progressContainer.style.overflow = 'hidden';

		this.progressBar = progressContainer.createDiv({ cls: 'progress-bar' });
		this.progressBar.style.height = '100%';
		this.progressBar.style.backgroundColor = 'var(--interactive-accent)';
		this.progressBar.style.width = '0%';
		this.progressBar.style.transition = 'width 0.3s ease';
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	/**
	 * Update progress
	 */
	updateProgress(current: number, total: number, message?: string) {
		const percentage = total > 0 ? Math.round((current / total) * 100) : 0;

		this.progressBar.style.width = `${percentage}%`;
		this.progressText.setText(message || `Syncing: ${current} of ${total} files (${percentage}%)`);
	}
}

/**
 * Error modal
 * Shows detailed error information
 */
export class ErrorModal extends Modal {
	private errorMessage: string;
	private errorDetails?: string;

	constructor(app: App, errorMessage: string, errorDetails?: string) {
		super(app);
		this.errorMessage = errorMessage;
		this.errorDetails = errorDetails;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.empty();
		contentEl.addClass('onedrive-error-modal');

		// Title
		contentEl.createEl('h2', { text: 'Error' });

		// Error message
		contentEl.createEl('p', { text: this.errorMessage });

		// Error details (if available)
		if (this.errorDetails) {
			const detailsDiv = contentEl.createDiv({ cls: 'error-details' });
			detailsDiv.style.marginTop = '20px';
			detailsDiv.style.padding = '10px';
			detailsDiv.style.backgroundColor = 'var(--background-secondary)';
			detailsDiv.style.borderRadius = '5px';
			detailsDiv.style.fontSize = '0.9em';
			detailsDiv.style.fontFamily = 'monospace';
			detailsDiv.style.whiteSpace = 'pre-wrap';
			detailsDiv.style.overflowX = 'auto';

			detailsDiv.createEl('strong', { text: 'Details:' });
			detailsDiv.createEl('br');
			detailsDiv.appendText(this.errorDetails);
		}

		// Close button
		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText('Close')
				.setCta()
				.onClick(() => this.close())
		);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}


/**
 * Large-delete warning modal
 *
 * Shown when a planned sync would delete more files than the configured
 * threshold. Gives the user three choices: proceed with the sync, cancel
 * this sync, or cancel and disable the plugin so they can investigate.
 *
 * The modal returns the user's decision via a Promise; closing without
 * picking a button resolves to "cancel" (the safe default).
 */
export class LargeDeleteWarningModal extends Modal {
	private info: LargeDeleteWarningInfo;
	private resolveDecision: (decision: LargeDeleteDecision) => void;
	private decision: LargeDeleteDecision = 'cancel';

	constructor(
		app: App,
		info: LargeDeleteWarningInfo,
		resolve: (decision: LargeDeleteDecision) => void
	) {
		super(app);
		this.info = info;
		this.resolveDecision = resolve;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('onedrive-large-delete-modal');

		contentEl.createEl('h2', { text: 'OneDrive sync: large delete detected' });

		const total = this.info.localDeleteCount + this.info.remoteDeleteCount;
		const summary = contentEl.createEl('p');
		summary.setText(
			`This sync would delete ${total} file${total === 1 ? '' : 's'} ` +
				`(threshold: ${this.info.threshold}). Review before continuing — ` +
				`this could indicate an unintended remote change or an accidental local delete.`
		);

		if (this.info.localDeleteCount > 0) {
			contentEl.createEl('h3', {
				text: `${this.info.localDeleteCount} file${this.info.localDeleteCount === 1 ? '' : 's'} would be removed from this vault (driven by remote changes)`,
			});
			this.renderSamples(contentEl, this.info.sampleLocalDeletes, this.info.localDeleteCount);
		}

		if (this.info.remoteDeleteCount > 0) {
			contentEl.createEl('h3', {
				text: `${this.info.remoteDeleteCount} file${this.info.remoteDeleteCount === 1 ? '' : 's'} would be removed from OneDrive (driven by local deletes)`,
			});
			this.renderSamples(
				contentEl,
				this.info.sampleRemoteDeletes,
				this.info.remoteDeleteCount
			);
		}

		const hint = contentEl.createEl('p');
		hint.setText(
			'If you cancel or disable, the delta cursor is preserved so the same ' +
				'plan will be re-checked next sync. Nothing has been deleted yet.'
		);

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText('Cancel sync')
					.setCta()
					.onClick(() => {
						this.decision = 'cancel';
						this.close();
					})
			)
			.addButton((b) =>
				b.setButtonText('Disable plugin').onClick(() => {
					this.decision = 'disable';
					this.close();
				})
			)
			.addButton((b) =>
				b.setButtonText('Proceed (this sync only)').setWarning().onClick(() => {
					this.decision = 'proceed';
					this.close();
				})
			);
	}

	private renderSamples(parent: HTMLElement, samples: string[], total: number) {
		const list = parent.createEl('ul');
		for (const path of samples) {
			list.createEl('li', { text: path });
		}
		if (total > samples.length) {
			parent.createEl('p', { text: `… and ${total - samples.length} more.` });
		}
	}

	onClose() {
		this.contentEl.empty();
		this.resolveDecision(this.decision);
	}
}
