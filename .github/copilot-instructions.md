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
cp main.js ~/Documents/JeffBrain-Octo/JeffBrain-Octo/.obsidian/plugins/onedrive-sync/main.js
```

Then reload the plugin in Obsidian.

## Postmortems

When a bug-fix PR is merged, `.github/workflows/postmortem.yml` opens a tracking
issue and assigns the Copilot coding agent to run the postmortem skill at
`.github/skills/postmortem/SKILL.md`: a **5 Whys** root-cause analysis plus a
**hardening PR** that prevents the whole bug *class* (types/guards/invariants +
regression and sibling-case tests). To run one by hand, ask Copilot to
"run the postmortem skill for PR #N". Never merge the hardening PR automatically.

