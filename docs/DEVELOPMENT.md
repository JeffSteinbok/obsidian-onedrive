# Development

## Prerequisites

- Node.js 18+ (recommend 20.x)
- npm
- Obsidian (for testing)

## Setup

```bash
git clone https://github.com/JeffSteinbok/obsidian-onedrive.git
cd obsidian-onedrive
npm install
```

## Commands

```bash
npm run dev          # Development build (watch mode)
npm run build        # Production build
npm test             # Run tests
npm run test:watch   # Tests in watch mode
npm run test:coverage # Coverage report
npm run lint         # Linter
npm run format       # Format code
```

## Project Structure

```
obsidian-onedrive/
├── src/
│   ├── auth/          # Authentication (Device Code Flow, token storage)
│   ├── api/           # OneDrive API client (Graph API, chunked upload)
│   ├── sync/          # Sync engine (event manager, conflict resolver)
│   ├── ui/            # User interface (settings, status bar, modals)
│   ├── utils/         # Utilities (errors, logger, retry, path utils)
│   ├── constants.ts   # Constants (endpoints, scopes, client ID)
│   └── types.ts       # TypeScript interfaces
├── tests/
│   ├── unit/          # Unit tests
│   ├── integration/   # Integration tests
│   └── fixtures/      # Test fixtures
├── main.ts            # Plugin entry point
├── manifest.json      # Plugin manifest
└── package.json       # Dependencies and scripts
```

## Release Workflows

### Stable Releases

Use the release workflow to create a new stable release:

```bash
gh workflow run release.yml -f bump_type=patch   # Bug fixes (1.2.3 → 1.2.4)
gh workflow run release.yml -f bump_type=minor   # New features (1.2.3 → 1.3.0)
gh workflow run release.yml -f bump_type=major   # Breaking changes (1.2.3 → 2.0.0)
```

The workflow:
1. Runs tests
2. Bumps version in `manifest.json`, `package.json`, and `versions.json`
3. Commits and tags on `main`
4. Builds and creates a GitHub release

**Never create releases manually** with `gh release create` — always use the workflow.

### Beta Pre-Releases (BRAT)

Use the prerelease workflow for beta testing via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

```bash
gh workflow run prerelease.yml -f bump_type=patch-beta   # 1.2.3 → 1.2.4-beta.0
gh workflow run prerelease.yml -f bump_type=minor-beta   # 1.2.3 → 1.3.0-beta.0
gh workflow run prerelease.yml -f bump_type=major-beta   # 1.2.3 → 2.0.0-beta.0
```

**Key feature:** You can trigger a prerelease from any branch:
- From `main`: Builds and releases current main code
- From a feature branch: Builds from that branch's code, but commits `manifest-beta.json` to `main`

This allows testing unmerged PR code via BRAT without polluting PR branches with version bumps.

The workflow:
1. Checks out `main`
2. Merges the triggering branch (if not main) for the build
3. Bumps `manifest-beta.json` version
4. Commits only `manifest-beta.json` to `main`
5. Builds artifacts from merged code
6. Creates a GitHub pre-release

If there's a merge conflict, the workflow fails with a clear error — resolve the conflict first.

### Version Files

- `manifest.json` — Stable version (used by Obsidian Community Plugins)
- `manifest-beta.json` — Beta version (used by BRAT)
- `package.json` — NPM package version (kept in sync with stable)
- `versions.json` — Version history for Obsidian compatibility

## Guidelines

- Follow existing code style (`npm run format`)
- Write tests for new features
- Update documentation as needed
- Use conventional commit messages

## Automated Issue Implementation

Maintainer-approved issues may be implemented by repository automation; any generated pull request must still pass normal CI and human review before it can be merged.

## Automated Postmortems

When a bug-fix PR is merged, an automated 5-Whys postmortem + hardening pipeline
runs. See [Postmortem Process](POSTMORTEM.md) for how it works and the guardrails
that keep the agent-authored PRs honest.
