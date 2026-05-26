/**
 * Modal dialogs for various user interactions
 */

import { Modal, App, Setting } from 'obsidian';
import { ConflictInfo } from '../types';

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
