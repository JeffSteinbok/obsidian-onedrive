/**
 * Minimal Obsidian API shim for rendering settings UI in a browser.
 */

export class Notice {
	constructor(message: string) {
		console.log('[Notice]', message);
	}
}

export class Setting {
	private el: HTMLElement;
	private nameEl: HTMLElement;
	private descEl: HTMLElement;
	private controlEl: HTMLElement;

	constructor(container: HTMLElement) {
		this.el = container.createDiv({ cls: 'setting-item' });
		const infoEl = this.el.createDiv({ cls: 'setting-item-info' });
		this.nameEl = infoEl.createDiv({ cls: 'setting-item-name' });
		this.descEl = infoEl.createDiv({ cls: 'setting-item-description' });
		this.controlEl = this.el.createDiv({ cls: 'setting-item-control' });
	}

	setName(name: string): this {
		this.nameEl.textContent = name;
		return this;
	}

	setDesc(desc: string): this {
		this.descEl.textContent = desc;
		return this;
	}

	addButton(cb: (button: ButtonComponent) => void): this {
		const btn = new ButtonComponent(this.controlEl);
		cb(btn);
		return this;
	}

	addToggle(cb: (toggle: ToggleComponent) => void): this {
		const toggle = new ToggleComponent(this.controlEl);
		cb(toggle);
		return this;
	}

	addDropdown(cb: (dropdown: DropdownComponent) => void): this {
		const dropdown = new DropdownComponent(this.controlEl);
		cb(dropdown);
		return this;
	}

	addText(cb: (text: TextComponent) => void): this {
		const text = new TextComponent(this.controlEl);
		cb(text);
		return this;
	}

	addSlider(cb: (slider: SliderComponent) => void): this {
		const slider = new SliderComponent(this.controlEl);
		cb(slider);
		return this;
	}

	addExtraButton(cb: (button: ExtraButtonComponent) => void): this {
		const btn = new ExtraButtonComponent(this.controlEl);
		cb(btn);
		return this;
	}
}

class ButtonComponent {
	el: HTMLButtonElement;
	constructor(container: HTMLElement) {
		this.el = document.createElement('button');
		container.appendChild(this.el);
	}
	setButtonText(text: string): this { this.el.textContent = text; return this; }
	setCta(): this { this.el.classList.add('mod-cta'); return this; }
	setWarning(): this { this.el.classList.add('mod-warning'); return this; }
	onClick(cb: () => void): this { this.el.addEventListener('click', cb); return this; }
}

class ToggleComponent {
	private el: HTMLElement;
	private checkbox: HTMLInputElement;
	private _onChange?: (value: boolean) => void;

	constructor(container: HTMLElement) {
		this.el = document.createElement('div');
		this.el.classList.add('checkbox-container');
		this.checkbox = document.createElement('input');
		this.checkbox.type = 'checkbox';
		this.el.appendChild(this.checkbox);
		container.appendChild(this.el);
		this.checkbox.addEventListener('change', () => {
			this.el.classList.toggle('is-enabled', this.checkbox.checked);
			this._onChange?.(this.checkbox.checked);
		});
	}

	setValue(value: boolean): this {
		this.checkbox.checked = value;
		this.el.classList.toggle('is-enabled', value);
		return this;
	}

	onChange(cb: (value: boolean) => void): this {
		this._onChange = cb;
		return this;
	}
}

class DropdownComponent {
	private selectEl: HTMLSelectElement;
	private _onChange?: (value: string) => void;

	constructor(container: HTMLElement) {
		this.selectEl = document.createElement('select');
		this.selectEl.classList.add('dropdown');
		container.appendChild(this.selectEl);
		this.selectEl.addEventListener('change', () => {
			this._onChange?.(this.selectEl.value);
		});
	}

	addOption(value: string, label: string): this {
		const opt = document.createElement('option');
		opt.value = value;
		opt.textContent = label;
		this.selectEl.appendChild(opt);
		return this;
	}

	setValue(value: string): this {
		this.selectEl.value = value;
		return this;
	}

	onChange(cb: (value: string) => void): this {
		this._onChange = cb;
		return this;
	}
}

class TextComponent {
	inputEl: HTMLInputElement;
	private _onChange?: (value: string) => void;

	constructor(container: HTMLElement) {
		this.inputEl = document.createElement('input');
		this.inputEl.type = 'text';
		container.appendChild(this.inputEl);
		this.inputEl.addEventListener('input', () => {
			this._onChange?.(this.inputEl.value);
		});
	}

	setPlaceholder(placeholder: string): this {
		this.inputEl.placeholder = placeholder;
		return this;
	}

	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.inputEl.disabled = disabled;
		return this;
	}

	onChange(cb: (value: string) => void): this {
		this._onChange = cb;
		return this;
	}
}

class SliderComponent {
	private el: HTMLInputElement;
	private tooltipEl: HTMLElement;
	private _onChange?: (value: number) => void;

	constructor(container: HTMLElement) {
		const wrapper = document.createElement('div');
		wrapper.style.display = 'flex';
		wrapper.style.alignItems = 'center';
		wrapper.style.gap = '8px';
		this.el = document.createElement('input');
		this.el.type = 'range';
		this.tooltipEl = document.createElement('span');
		this.tooltipEl.style.minWidth = '24px';
		this.tooltipEl.style.textAlign = 'center';
		this.tooltipEl.style.fontSize = '12px';
		wrapper.appendChild(this.el);
		wrapper.appendChild(this.tooltipEl);
		container.appendChild(wrapper);
		this.el.addEventListener('input', () => {
			const val = parseInt(this.el.value);
			this.tooltipEl.textContent = String(val);
			this._onChange?.(val);
		});
	}

	setLimits(min: number, max: number, step: number): this {
		this.el.min = String(min);
		this.el.max = String(max);
		this.el.step = String(step);
		return this;
	}

	setValue(value: number): this {
		this.el.value = String(value);
		this.tooltipEl.textContent = String(value);
		return this;
	}

	setDynamicTooltip(): this { return this; }

	onChange(cb: (value: number) => void): this {
		this._onChange = cb;
		return this;
	}
}

class ExtraButtonComponent {
	private el: HTMLButtonElement;
	constructor(container: HTMLElement) {
		this.el = document.createElement('button');
		this.el.classList.add('extra-setting-button');
		container.appendChild(this.el);
	}
	setIcon(icon: string): this {
		this.el.textContent = '↺';
		return this;
	}
	setTooltip(tooltip: string): this {
		this.el.title = tooltip;
		return this;
	}
	onClick(cb: () => void): this {
		this.el.addEventListener('click', cb);
		return this;
	}
}

// Extend HTMLElement with Obsidian's createEl/createDiv helpers
declare global {
	interface HTMLElement {
		createEl(tag: string, attrs?: { text?: string; cls?: string; href?: string }): HTMLElement;
		createDiv(attrs?: { cls?: string; text?: string }): HTMLDivElement;
	}
}

HTMLElement.prototype.createEl = function (tag: string, attrs?: { text?: string; cls?: string; href?: string }): HTMLElement {
	const el = document.createElement(tag);
	if (attrs?.text) el.textContent = attrs.text;
	if (attrs?.cls) el.className = attrs.cls;
	if (attrs?.href && el instanceof HTMLAnchorElement) el.href = attrs.href;
	this.appendChild(el);
	return el;
};

HTMLElement.prototype.createDiv = function (attrs?: { cls?: string; text?: string }): HTMLDivElement {
	const el = document.createElement('div');
	if (attrs?.cls) el.className = attrs.cls;
	if (attrs?.text) el.textContent = attrs.text;
	this.appendChild(el);
	return el as HTMLDivElement;
};

(HTMLElement.prototype as any).empty = function () {
	this.innerHTML = '';
};

export class App {}
export class PluginSettingTab {
	app: App;
	containerEl: HTMLElement;
	constructor(app: App, _plugin: any) {
		this.app = app;
		this.containerEl = document.getElementById('settings-root')!;
	}
}
