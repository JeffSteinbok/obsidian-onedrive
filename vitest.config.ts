import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
	resolve: {
		alias: {
			obsidian: path.resolve(__dirname, 'tests/__mocks__/obsidian.ts'),
		},
	},
	test: {
		globals: true,
		environment: 'node',
		setupFiles: ['./tests/setup.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			exclude: ['tests/', 'node_modules/', '*.config.*', 'main.js', 'version-bump.mjs'],
			thresholds: {
				// Global minimums - fail CI if overall coverage drops
				lines: 70,
				branches: 65,
				functions: 70,
				statements: 70,

				// Critical sync/api code needs higher coverage
				'src/sync/syncEngine.ts': {
					lines: 80,
					branches: 70,
				},
				'src/sync/syncState.ts': {
					lines: 80,
				},
				'src/api/oneDriveClient.ts': {
					lines: 80,
				},
				'src/api/chunkUpload.ts': {
					lines: 90,
				},
				'src/sync/conflictResolver.ts': {
					lines: 90,
				},
			},
		},
	},
});
