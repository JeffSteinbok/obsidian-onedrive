> [!NOTE]
> **Postmortems run through Steward.** After each bug-fix merge, the
> maintainer's Orca bot, Steward, runs the postmortem using
> `.github/skills/postmortem/SKILL.md`. Codex prepares a hardening PR when
> warranted, Claude reviews it independently, and Steward posts the writeup on
> the bug issue. The maintainer merges hardening PRs. The GitHub Actions
> postmortem workflows remain disabled.

The instructions below describe the retired Puppets workflow.

Follow `.github/skills/postmortem/SKILL.md` exactly for the merged pull request identified
in this issue.

Use `npm run build` and `npx vitest run` for validation. The hardening pull request must:

- use a `postmortem/<pr-number>-<slug>` branch;
- close this tracking issue;
- include the complete 5-Whys analysis between the repository's required
  `postmortem-writeup` markers;
- satisfy `.github/workflows/postmortem-guard.yml`; and
- remain unmerged for maintainer review.
