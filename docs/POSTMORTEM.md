# Automated Bug-Fix Postmortems

When a **bug-fix PR is merged**, this repo automatically runs a structured
[5-Whys](https://en.wikipedia.org/wiki/Five_whys) postmortem and produces a
*hardening* change that makes a whole **class** of similar bugs harder to
reintroduce — not just a patch for the single instance.

> A fix removes one bug. A good postmortem removes the conditions that let it exist.

This is a maintainer/contributor process. It requires no action from plugin
users.

## The pipeline at a glance

```
 bug-fix PR merged
        │
        ▼
 postmortem.yml ───────────► opens a tracking issue (label: postmortem)
 (on: pull_request closed)    and assigns the Copilot coding agent
        │
        ▼
 Copilot coding agent ──────► follows .github/skills/postmortem/SKILL.md:
                              5-Whys analysis + surgical hardening + tests,
                              opens a hardening PR that `Closes #<issue>`,
                              with the writeup between HTML markers
        │
        ├──► postmortem-guard.yml   (fails + comments if the PR is
        │    (on: pull_request_target)  incomplete — see "Guardrails")
        │
        └──► postmortem-publish.yml (mirrors the writeup from the PR body
             (on: pull_request_target)  to the tracking issue as a comment)
```

## The moving parts

| File | Trigger | Responsibility |
| --- | --- | --- |
| [`.github/workflows/postmortem.yml`](../.github/workflows/postmortem.yml) | a bug-fix PR is merged (or manual dispatch) | Opens the tracking issue and assigns the Copilot coding agent. |
| [`.github/skills/postmortem/SKILL.md`](../.github/skills/postmortem/SKILL.md) | read by the coding agent | The step-by-step 5-Whys + hardening process the agent follows. |
| [`.github/workflows/postmortem-guard.yml`](../.github/workflows/postmortem-guard.yml) | the hardening PR opens/updates | Fails the check (and comments) if the PR isn't deliverable. |
| [`.github/workflows/postmortem-publish.yml`](../.github/workflows/postmortem-publish.yml) | the hardening PR opens/updates | Mirrors the 5-Whys writeup from the PR body to the tracking issue. |

### What qualifies as a "bug fix"

`postmortem.yml` only fires for a merged PR that either carries the **`bug`
label** or has **`- [x] Bug fix`** checked in its *Type of Change* section. Only
that section is inspected, so quoted templates elsewhere in the body can't cause
false positives. Postmortem PRs themselves (`postmortem/*` branches or the
`postmortem` label) are excluded so the process can't loop.

### The writeup markers

The coding agent puts the full 5-Whys writeup in its **PR body** between:

```html
<!-- postmortem-writeup:start -->
... 5-Whys analysis ...
<!-- postmortem-writeup:end -->
```

`postmortem-publish.yml` reads that block and posts (or idempotently updates) it
as a comment on the tracking issue the PR `Closes`. The agent must **not**
comment on the tracking issue directly — a coding-agent cross-resource write to a
*separate* issue needs manual approval, which is exactly what this indirection
avoids.

## Guardrails

Postmortem PRs are opened by an autonomous agent, which sometimes fails
mid-flight — leaving the PR titled `[WIP]`, as a draft, with an **empty branch**
(work never committed), or with a missing/garbled writeup. Because the branch
often equals `main`, CI can stay green, so nothing signals the PR is
undeliverable.

[`postmortem-guard.yml`](../.github/workflows/postmortem-guard.yml) closes that
gap. On every `postmortem/*` / `copilot/postmortem*` PR it **fails the check**
and posts an actionable checklist comment when any of these are true:

1. the title still contains `[WIP]`,
2. the PR is still a draft,
3. the branch has **no file changes** (the hardening work was never committed),
4. the writeup markers are missing, or the writeup is empty / too thin, or
5. there is no `Fixes #<issue>` / `Closes #<issue>` reference.

`postmortem-publish.yml` also refuses to mirror a writeup that is too short or has
no "Why", so junk can never reach a tracking issue.

> **Maintainer setup:** add **Postmortem PR Guard** to the branch-protection
> *required status checks* so a failing guard actually blocks the merge.

## Why `pull_request_target`?

Both `postmortem-guard.yml` and `postmortem-publish.yml` use
`pull_request_target` rather than `pull_request`. This:

- avoids the manual *"approve workflows"* gate that GitHub applies to workflows
  triggered by PRs the Copilot coding agent authors, and
- runs the **trusted** workflow definition from the base branch.

Both workflows only **read** PR metadata (title, body, changed-files list) via
the API and never check out PR head code, so the elevated-trust context is safe.

## Tokens

`postmortem.yml` and `postmortem-publish.yml` prefer a `PAT_TOKEN` secret
(falling back to `GITHUB_TOKEN`). The PAT is needed to **assign the Copilot
coding agent** (the default `GITHUB_TOKEN` cannot) and to comment on the separate
tracking issue.

## Running it manually

To backfill or re-run a postmortem for a specific PR:

```bash
gh workflow run postmortem.yml -f pr_number=<PR>
```

Or, in the Copilot CLI inside the repo, ask it to *"run the postmortem skill for
PR #N"* and follow [`SKILL.md`](../.github/skills/postmortem/SKILL.md).
