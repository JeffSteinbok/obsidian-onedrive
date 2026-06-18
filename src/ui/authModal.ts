/**
 * Authentication modal for Device Code Flow
 * Shows user code and verification instructions
 */

import { Modal, App, Setting } from 'obsidian';

import { t } from '../i18n';
import { timerApi } from '../utils/timerApi';

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
		contentEl.createEl('h2', { text: t('authModal.title') });

		// Instructions
		const instructions = contentEl.createDiv({ cls: 'onedrive-auth-instructions' });
		instructions.createEl('p', {
			text: t('authModal.instructions'),
		});

		const steps = instructions.createEl('ol');
		steps.createEl('li', {
			text: t('authModal.openLinkStep', { verificationUri: this.verificationUri }),
		});

		const codeStep = steps.createEl('li');
		codeStep.appendText(t('authModal.enterCodePrefix'));
		codeStep.createEl('strong', {
			text: this.userCode,
			cls: 'onedrive-user-code onedrive-sync-auth-user-code',
		});

		steps.createEl('li', { text: t('authModal.signInStep') });
		steps.createEl('li', { text: t('authModal.grantPermissionsStep') });
		steps.createEl('li', { text: t('authModal.returnStep') });

		// Copy button for verification URL
		new Setting(contentEl)
			.setName(t('authModal.verificationUrl'))
			.setDesc(this.verificationUri)
			.addButton((button) =>
				button.setButtonText(t('authModal.copyUrl')).onClick(() => {
					void navigator.clipboard.writeText(this.verificationUri);
					button.setButtonText(t('authModal.copied'));
					timerApi.setTimeout(() => {
						button.setButtonText(t('authModal.copyUrl'));
					}, 2000);
				})
			);

		// Copy button for user code
		new Setting(contentEl)
			.setName(t('authModal.userCode'))
			.setDesc(this.userCode)
			.addButton((button) =>
				button.setButtonText(t('authModal.copyCode')).onClick(() => {
					void navigator.clipboard.writeText(this.userCode);
					button.setButtonText(t('authModal.copied'));
					timerApi.setTimeout(() => {
						button.setButtonText(t('authModal.copyCode'));
					}, 2000);
				})
			);

		// Open browser button
		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText(t('authModal.openInBrowser'))
				.setCta()
				.onClick(() => {
					window.open(this.verificationUri, '_blank');
				})
		);

		// Completion buttons
		const buttonContainer = contentEl.createDiv({
			cls: 'modal-button-container onedrive-sync-auth-actions',
		});

		const cancelButton = buttonContainer.createEl('button', { text: t('authModal.cancel') });
		cancelButton.addEventListener('click', () => {
			this.onCancel();
			this.close();
		});

		const completeButton = buttonContainer.createEl('button', {
			text: t('authModal.completed'),
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
