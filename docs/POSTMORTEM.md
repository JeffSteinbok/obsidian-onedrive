# Bug-Fix Postmortems

> [!NOTE]
> **Postmortems run through Steward.** After each bug-fix merge, the
> maintainer's Orca bot, Steward, runs the postmortem using
> `.github/skills/postmortem/SKILL.md`. Codex prepares a hardening PR when
> warranted, Claude reviews it independently, and Steward posts the writeup on
> the bug issue. The maintainer merges hardening PRs. The GitHub Actions
> postmortem workflows remain disabled.

The postmortem traces the bug to its cause and looks for a change that can
prevent similar bugs. This is a maintainer process and requires no action from
plugin users.

## How Steward runs a postmortem

1. After a bug-fix PR merges, Steward gives Codex the PR and linked bug issue.
2. Codex follows the [postmortem skill](../.github/skills/postmortem/SKILL.md).
   It traces when the bug was introduced, writes the 5 Whys, and prepares a
   focused hardening PR when it finds a way to prevent similar bugs. The
   hardening PR runs normal CI.
3. Claude independently reviews the analysis, tests, and any hardening changes.
4. Steward posts the reviewed writeup on the bug issue. The maintainer decides
   whether to merge the hardening PR.

Codex includes the full writeup in its final report and in the hardening PR
body when there is one. Steward uses these markers to identify the writeup.

```html
<!-- postmortem-writeup:start -->
... 5-Whys analysis ...
<!-- postmortem-writeup:end -->
```

To backfill or rerun a postmortem, give Steward the original bug-fix PR number.

## GitHub Actions

The former Puppets workflows for
[opening tracking issues](../.github/workflows/postmortem.yml),
[checking hardening PRs](../.github/workflows/postmortem-guard.yml), and
[publishing writeups](../.github/workflows/postmortem-publish.yml)
remain disabled. Steward coordinates the postmortem, and the repository's
normal CI still runs on hardening PRs.
