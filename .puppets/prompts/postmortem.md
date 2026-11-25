> [!NOTE]
> **Postmortems paused (2026-11-25).** The GitHub Actions workflows are disabled
> because this repo retired Puppets, which analyzed tracking issues opened for
> merged bug-fix PRs and prepared hardening PRs. Issue triage, fixes, and reviews
> now run through Orca bots on the maintainer's machine. A Steward bot coordinates
> separate builder and reviewer agents, and the maintainer approves every change.
> Postmortems may return through Orca. Until then, the trigger stays off because
> nothing processes new postmortem issues.

Follow `.github/skills/postmortem/SKILL.md` exactly for the merged pull request identified
in this issue.

Use `npm run build` and `npx vitest run` for validation. The hardening pull request must:

- use a `postmortem/<pr-number>-<slug>` branch;
- close this tracking issue;
- include the complete 5-Whys analysis between the repository's required
  `postmortem-writeup` markers;
- satisfy `.github/workflows/postmortem-guard.yml`; and
- remain unmerged for maintainer review.
