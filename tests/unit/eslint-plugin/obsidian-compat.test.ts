/**
 * Regression + generalization tests for eslint-plugin-obsidian-compat.
 *
 * Covers the class of bug fixed in PR #125: deprecated Obsidian component API
 * calls that are not caught by existing lint rules.
 *
 * ESLint's RuleTester.run() integrates with the test framework by calling
 * describe/it directly at the module level — do NOT nest it inside it() blocks.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RuleTester } = require('eslint');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../../../eslint-plugin-obsidian-compat/index.js');

const tester = new RuleTester({
	languageOptions: { ecmaVersion: 2020, sourceType: 'module' },
});

// ── no-deprecated-slider-api ──────────────────────────────────────────────────
// Regression: the exact pattern that caused PR #125 — calling setDynamicTooltip()
// on a chained Obsidian SliderComponent builder.
tester.run('no-deprecated-slider-api', plugin.rules['no-deprecated-slider-api'], {
	valid: [
		// Other slider methods must remain allowed.
		{ code: `slider.setLimits(0, 60, 5);` },
		{ code: `slider.setValue(30);` },
		{ code: `slider.onChange(() => {});` },
		{ code: `slider.setLimits(0, 60, 5).setValue(10).onChange(() => {});` },
	],
	invalid: [
		// Regression: exact pattern from PR #125 — chained call.
		{
			code: `slider.setLimits(0, 60, 5).setValue(10).setDynamicTooltip().onChange(() => {});`,
			errors: [{ message: /setDynamicTooltip.*deprecated/ as unknown as string }],
		},
		// Sibling: standalone call.
		{
			code: `slider.setDynamicTooltip();`,
			errors: [{ message: /setDynamicTooltip.*deprecated/ as unknown as string }],
		},
		// Sibling: inside addSlider callback — real-world usage pattern.
		{
			code: `addSlider(s => s.setLimits(0, 100, 1).setDynamicTooltip());`,
			errors: [{ message: /setDynamicTooltip.*deprecated/ as unknown as string }],
		},
		// Sibling: call on any receiver (heuristic is method-name-based, consistent
		// with all other rules in the plugin).
		{
			code: `someOtherObj.setDynamicTooltip();`,
			errors: [{ message: /setDynamicTooltip.*deprecated/ as unknown as string }],
		},
	],
});

// ── no-deprecated-display (sibling rule — same "forbidden Obsidian API" class) ─
tester.run('no-deprecated-display', plugin.rules['no-deprecated-display'], {
	valid: [
		// Non-settings file — should not be flagged.
		{
			code: `class MyModal { show() { this.display(); } }`,
			filename: 'src/ui/myModal.ts',
		},
	],
	invalid: [
		// Settings file — should be flagged.
		{
			code: `class MySettingTab { show() { this.display(containerEl); } }`,
			filename: 'src/ui/settings.ts',
			errors: [{ message: /display.*deprecated/i as unknown as string }],
		},
	],
});

// ── no-missing-getSettingDefinitions ─────────────────────────────────────────
// Flags PluginSettingTab subclasses that do not override getSettingDefinitions().
tester.run(
	'no-missing-getSettingDefinitions',
	plugin.rules['no-missing-getSettingDefinitions'],
	{
		valid: [
			// Implements getSettingDefinitions — no warning.
			{
				code: `class MyTab extends PluginSettingTab {
					getSettingDefinitions() { return []; }
					display() {}
				}`,
			},
			// Not a PluginSettingTab subclass — should not be flagged.
			{
				code: `class MyOtherClass extends SomeBase {
					display() {}
				}`,
			},
			// Plain class — not flagged.
			{
				code: `class MyClass { someMethod() {} }`,
			},
		],
		invalid: [
			// Missing getSettingDefinitions — should be flagged.
			{
				code: `class MyTab extends PluginSettingTab {
					display() {}
				}`,
				errors: [{ message: /getSettingDefinitions/ as unknown as string }],
			},
			// Subclass with other methods but still missing getSettingDefinitions.
			{
				code: `class OneDriveSettingTab extends PluginSettingTab {
					constructor(app, plugin) { super(app, plugin); }
					display() { this.renderSettings(); }
				}`,
				errors: [{ message: /getSettingDefinitions/ as unknown as string }],
			},
		],
	}
);
tester.run('no-bare-timers', plugin.rules['no-bare-timers'], {
	valid: [{ code: `window.setTimeout(() => {}, 1000);` }, { code: `window.setInterval(() => {}, 1000);` }],
	invalid: [
		{
			code: `setTimeout(() => {}, 1000);`,
			errors: [{ message: /window\.setTimeout/ as unknown as string }],
		},
		{
			code: `setInterval(() => {}, 1000);`,
			errors: [{ message: /window\.setInterval/ as unknown as string }],
		},
	],
});
