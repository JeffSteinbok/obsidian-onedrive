/**
 * Local ESLint plugin replicating key Obsidian plugin-review lint rules.
 *
 * Rules:
 *   obsidian-compat/no-global-document              – use activeDocument
 *   obsidian-compat/no-global-this                  – use window or activeWindow
 *   obsidian-compat/no-bare-timers                  – use window.setTimeout etc.
 *   obsidian-compat/no-static-styles                – use CSS classes, not element.style
 *   obsidian-compat/no-deprecated-display           – display() is deprecated since 1.13
 *   obsidian-compat/no-deprecated-slider-api        – setDynamicTooltip() removed; value
 *                                                     is always shown next to the slider
 *   obsidian-compat/no-missing-getSettingDefinitions – PluginSettingTab subclasses should
 *                                                     implement getSettingDefinitions() for
 *                                                     Obsidian 1.13.0+ settings search
 */

"use strict";

module.exports = {
	rules: {
		// ── no-global-document ──────────────────────────────────────────
		// Flags bare `document` references. Use `activeDocument` for popout
		// window compatibility.
		"no-global-document": {
			meta: {
				type: "suggestion",
				docs: { description: "Use 'activeDocument' instead of 'document' for popout window compatibility." },
				schema: [],
			},
			create(context) {
				return {
					Identifier(node) {
						if (node.name !== "document") return;
						// Skip property access (obj.document) and declarations
						if (node.parent.type === "MemberExpression" && node.parent.property === node) return;
						if (node.parent.type === "Property" && node.parent.key === node) return;
						// Skip type annotations
						if (node.parent.type === "TSTypeReference") return;
						// Skip imports
						if (node.parent.type === "ImportSpecifier") return;
						context.report({
							node,
							message: "Use 'activeDocument' instead of 'document' for popout window compatibility.",
						});
					},
				};
			},
		},

		// ── no-global-this ──────────────────────────────────────────────
		// Flags `globalThis` usage. Use `window` or `activeWindow`.
		"no-global-this": {
			meta: {
				type: "suggestion",
				docs: { description: "Avoid 'globalThis'. Use 'window' or 'activeWindow' for popout window compatibility." },
				schema: [],
			},
			create(context) {
				return {
					Identifier(node) {
						if (node.name !== "globalThis") return;
						if (node.parent.type === "MemberExpression" && node.parent.property === node) return;
						context.report({
							node,
							message: "Avoid 'globalThis'. Use 'window' or 'activeWindow' for popout window compatibility.",
						});
					},
				};
			},
		},

		// ── no-bare-timers ──────────────────────────────────────────────
		// Flags bare setTimeout/clearTimeout/setInterval/clearInterval.
		// Must be called on window (window.setTimeout) or via timerApi.
		"no-bare-timers": {
			meta: {
				type: "suggestion",
				docs: { description: "Use 'window.setTimeout()' etc. for popout window compatibility." },
				schema: [],
			},
			create(context) {
				const timerNames = new Set(["setTimeout", "clearTimeout", "setInterval", "clearInterval"]);
				return {
					CallExpression(node) {
						if (node.callee.type !== "Identifier") return;
						if (!timerNames.has(node.callee.name)) return;
						// Allow if it's inside timerApi.ts (the wrapper itself)
						const filename = context.filename ?? context.getFilename?.() ?? '';
						if (filename.endsWith("timerApi.ts") || filename.endsWith("timerApi.js")) return;
						context.report({
							node,
							message: `Use 'window.${node.callee.name}()' or 'timerApi.${node.callee.name}()' for popout window compatibility.`,
						});
					},
				};
			},
		},

		// ── no-static-styles ────────────────────────────────────────────
		// Flags `element.style.X = ...` assignments. Use CSS classes or setCssProps.
		"no-static-styles": {
			meta: {
				type: "suggestion",
				docs: { description: "Don't set styles directly. Use CSS classes or setCssProps." },
				schema: [],
			},
			create(context) {
				return {
					AssignmentExpression(node) {
						const left = node.left;
						if (left.type !== "MemberExpression") return;
						const obj = left.object;
						if (obj.type !== "MemberExpression") return;
						const prop = obj.property;
						if (prop.type === "Identifier" && prop.name === "style") {
							context.report({
								node,
								message: "Don't set styles directly. Use CSS classes or 'setCssProps' instead.",
							});
						}
					},
				};
			},
		},

		// ── no-deprecated-display ───────────────────────────────────────
		// Flags calls to `.display(containerEl)` on settings tabs.
		// Since 1.13.0, use getSettingDefinitions instead.
		"no-deprecated-display": {
			meta: {
				type: "suggestion",
				docs: { description: "'display()' is deprecated since 1.13.0. Use getSettingDefinitions instead." },
				schema: [],
			},
			create(context) {
				return {
					CallExpression(node) {
						if (node.callee.type !== "MemberExpression") return;
						const prop = node.callee.property;
						if (prop.type !== "Identifier" || prop.name !== "display") return;
						// Only flag if the caller looks like `this.display(` or `super.display(`
						const obj = node.callee.object;
						if (obj.type === "ThisExpression" || obj.type === "Super") {
							// Check if inside a class that looks like a PluginSettingTab
							const filename = context.filename ?? context.getFilename?.() ?? '';
							if (filename.includes("settings") || filename.includes("Settings")) {
								context.report({
									node,
									message: "'display()' is deprecated since 1.13.0. Use 'getSettingDefinitions()' instead.",
								});
							}
						}
					},
				};
			},
		},

		// ── no-deprecated-slider-api ────────────────────────────────────
		// Flags calls to `.setDynamicTooltip()` on Obsidian SliderComponent.
		// This method was removed; the current value is always shown beside
		// the slider in Obsidian ≥ 1.x.  Keeping the call causes a runtime
		// "is not a function" error and signals a stale understanding of the
		// Obsidian component API.
		"no-deprecated-slider-api": {
			meta: {
				type: "problem",
				docs: {
					description:
						"'setDynamicTooltip()' is deprecated and removed from Obsidian's SliderComponent. " +
						"Remove the call — the slider value is always shown next to the slider.",
				},
				schema: [],
			},
			create(context) {
				const deprecated = new Set(["setDynamicTooltip"]);
				return {
					CallExpression(node) {
						if (node.callee.type !== "MemberExpression") return;
						const prop = node.callee.property;
						if (prop.type !== "Identifier") return;
						if (!deprecated.has(prop.name)) return;
						context.report({
							node,
							message: `'${prop.name}()' is deprecated and removed from Obsidian's SliderComponent. Remove the call — the slider value is always displayed next to the slider.`,
						});
					},
				};
			},
		},

		// ── no-missing-getSettingDefinitions ────────────────────────────
		// Flags PluginSettingTab subclasses that do not override
		// getSettingDefinitions(). Since Obsidian 1.13.0, implementing this
		// method enables settings-search indexing; classes that omit it fall
		// back to the imperative display() path and their settings will not
		// appear in the search results.
		"no-missing-getSettingDefinitions": {
			meta: {
				type: "suggestion",
				docs: {
					description:
						"PluginSettingTab subclasses should implement getSettingDefinitions() " +
						"for Obsidian 1.13.0+ settings search support.",
				},
				schema: [],
			},
			create(context) {
				return {
					ClassDeclaration(node) {
						if (!node.superClass) return;
						// Match direct `extends PluginSettingTab`
						const superName =
							node.superClass.type === "Identifier"
								? node.superClass.name
								: null;
						if (superName !== "PluginSettingTab") return;

						const hasMethod = node.body.body.some(
							(member) =>
								member.type === "MethodDefinition" &&
								member.key.type === "Identifier" &&
								member.key.name === "getSettingDefinitions"
						);

						if (!hasMethod) {
							context.report({
								node,
								message:
									"This PluginSettingTab does not implement getSettingDefinitions(); " +
									"its settings will not appear in Obsidian's settings search for " +
									"users on 1.13.0 or later. Consider adopting the declarative settings API.",
							});
						}
					},
				};
			},
		},
	},
};
