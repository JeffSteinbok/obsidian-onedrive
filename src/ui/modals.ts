/**
 * Modal dialogs for various user interactions
 */

import { Modal, App, Setting } from 'obsidian';
import { LargeDeleteWarningInfo, LargeDeleteDecision } from '../types';
import { t } from '../i18n';

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

		contentEl.createEl('h2', { text: t('largeDeleteModal.title') });

		const total = this.info.localDeleteCount + this.info.remoteDeleteCount;
		const summary = contentEl.createEl('p');
		summary.setText(
			t(total === 1 ? 'largeDeleteModal.summaryFile' : 'largeDeleteModal.summaryFiles', {
				total,
				threshold: this.info.threshold,
			})
		);

		if (this.info.localDeleteCount > 0) {
			contentEl.createEl('h3', {
				text: t(
					this.info.localDeleteCount === 1
						? 'largeDeleteModal.localDeletesFile'
						: 'largeDeleteModal.localDeletesFiles',
					{ count: this.info.localDeleteCount }
				),
			});
			this.renderSamples(contentEl, this.info.sampleLocalDeletes, this.info.localDeleteCount);
		}

		if (this.info.remoteDeleteCount > 0) {
			contentEl.createEl('h3', {
				text: t(
					this.info.remoteDeleteCount === 1
						? 'largeDeleteModal.remoteDeletesFile'
						: 'largeDeleteModal.remoteDeletesFiles',
					{ count: this.info.remoteDeleteCount }
				),
			});
			this.renderSamples(contentEl, this.info.sampleRemoteDeletes, this.info.remoteDeleteCount);
		}

		const hint = contentEl.createEl('p');
		hint.setText(t('largeDeleteModal.hint'));

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText(t('largeDeleteModal.cancelSync'))
					.setCta()
					.onClick(() => {
						this.decision = 'cancel';
						this.close();
					})
			)
			.addButton((b) =>
				b.setButtonText(t('largeDeleteModal.disablePlugin')).onClick(() => {
					this.decision = 'disable';
					this.close();
				})
			)
			.addButton((b) =>
				b.setButtonText(t('largeDeleteModal.proceed')).onClick(() => {
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
			const remaining = total - samples.length;
			parent.createEl('p', {
				text: t(
					remaining === 1
						? 'largeDeleteModal.remainingSample'
						: 'largeDeleteModal.remainingSamples',
					{ count: remaining }
				),
			});
		}
	}

	onClose() {
		this.contentEl.empty();
		this.resolveDecision(this.decision);
	}
}

/**
 * Root-folder warning modal
 *
 * Shown when the user picks the entire OneDrive drive root as their sync
 * target. Syncing the root pulls every file on the drive into the vault and
 * enables delete-tracking across the whole drive, so we make the user
 * explicitly confirm before proceeding. Closing without confirming is a no-op.
 */
export class RootFolderWarningModal extends Modal {
	private readonly onConfirm: () => void;
	private confirmed = false;

	constructor(app: App, onConfirm: () => void) {
		super(app);
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('onedrive-root-warning-modal');

		contentEl.createEl('h2', { text: t('rootFolderWarning.title') });
		contentEl.createEl('p', { text: t('rootFolderWarning.body') });
		contentEl.createEl('p', { text: t('rootFolderWarning.hint') });

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText(t('rootFolderWarning.cancel'))
					.setCta()
					.onClick(() => {
						this.close();
					})
			)
			.addButton((b) =>
				b
					.setButtonText(t('rootFolderWarning.confirm'))
					.setWarning()
					.onClick(() => {
						this.confirmed = true;
						this.close();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
		if (this.confirmed) {
			this.onConfirm();
		}
	}
}
