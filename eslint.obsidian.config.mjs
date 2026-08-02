// eslint.obsidian.config.mjs
// Flat-config file for the Obsidian community validator (eslint-plugin-obsidianmd).
// This is intentionally separate from .eslintrc.json (our project's ESLint 8 config)
// so they do not interfere with each other.
// Run with: npm run validate-obsidian
import plugin from "eslint-plugin-obsidianmd";

export default [
    ...plugin.configs.recommended,
    {
        languageOptions: {
            parserOptions: {
                project: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        // Mirrors .eslintignore; ESLint 10 flat config ignores instead of .eslintignore
        ignores: [
            "node_modules/**",
            "main.js",
            "**/*.js.map",
            "coverage/**",
            "*.config.mjs",
            "*.config.js",
            "version-bump.mjs",
            "tests/**",
            "dev/**",
        ],
    },
];
