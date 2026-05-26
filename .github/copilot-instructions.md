# Copilot Instructions

## Releases

**Never create releases manually** (e.g., `gh release create`). Always use the release workflow:

```bash
gh workflow run release.yml -f bump_type=patch   # bug fixes
gh workflow run release.yml -f bump_type=minor   # new features
gh workflow run release.yml -f bump_type=major   # breaking changes
```

The workflow handles version bumping, building, testing, and creating the GitHub release with artifacts. Manual releases bypass CI and can cause version inconsistencies.

## Build & Test

```bash
npm run build    # tsc + esbuild → main.js
npx vitest run   # run all unit tests
```

## Deploy to Test Vault

```bash
cp main.js ~/Documents/JeffBrain-Octo/JeffBrain-Octo/.obsidian/plugins/obsidian-onedrive/main.js
```

Then reload the plugin in Obsidian.
