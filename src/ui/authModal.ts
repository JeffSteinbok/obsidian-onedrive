/**
 * Authentication modal for Device Code Flow
 * Shows user code and verification instructions
 */

import { Modal, App, Setting } from 'obsidian';

const timerApi = typeof window !== 'undefined' ? window : globalThis;

export class DeviceCodeModal extends Modal {
	private userCode: string;
	private verificationUri: string;
	private onComplete: () => void;
	private onCancel: () => void;

	constructor(
		app: App,
		userCode: string,
		verificationUri: string,
		onComplete: () => void,
		onCancel: () => void
	) {
		super(app);
		this.userCode = userCode;
		this.verificationUri = verificationUri;
		this.onComplete = onComplete;
		this.onCancel = onCancel;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.empty();
		contentEl.addClass('onedrive-auth-modal');

		// Title
		contentEl.createEl('h2', { text: 'Connect to OneDrive' });

		// Instructions
		const instructions = contentEl.createDiv({ cls: 'onedrive-auth-instructions' });
		instructions.createEl('p', {
			text: 'To connect your OneDrive account, follow these steps:',
		});

		const steps = instructions.createEl('ol');
		steps.createEl('li', {
			text: `Open this link in your browser: ${this.verificationUri}`,
		});

		const codeStep = steps.createEl('li');
		codeStep.appendText('Enter this code: ');
		codeStep.createEl('strong', {
			text: this.userCode,
			cls: 'onedrive-user-code onedrive-sync-auth-user-code',
		});

		steps.createEl('li', { text: 'Sign in with your Microsoft account' });
		steps.createEl('li', { text: 'Grant permissions when prompted' });
		steps.createEl('li', { text: 'Return here and click "I\'ve completed authentication"' });

		// Copy button for verification URL
		new Setting(contentEl)
			.setName('Verification URL')
			.setDesc(this.verificationUri)
			.addButton((button) =>
				button.setButtonText('Copy URL').onClick(() => {
					void navigator.clipboard.writeText(this.verificationUri);
					button.setButtonText('Copied!');
					timerApi.setTimeout(() => button.setButtonText('Copy URL'), 2000);
				})
			);

		// Copy button for user code
		new Setting(contentEl)
			.setName('User Code')
			.setDesc(this.userCode)
			.addButton((button) =>
				button.setButtonText('Copy Code').onClick(() => {
					void navigator.clipboard.writeText(this.userCode);
					button.setButtonText('Copied!');
					timerApi.setTimeout(() => button.setButtonText('Copy Code'), 2000);
				})
			);

		// Open browser button
		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText('Open in Browser')
				.setCta()
				.onClick(() => {
					window.open(this.verificationUri, '_blank');
				})
		);

		// Completion buttons
		const buttonContainer = contentEl.createDiv({
			cls: 'modal-button-container onedrive-sync-auth-actions',
		});

		const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.onCancel();
			this.close();
		});

		const completeButton = buttonContainer.createEl('button', {
			text: "I've completed authentication",
			cls: 'mod-cta',
		});
		completeButton.addEventListener('click', () => {
			this.onComplete();
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
