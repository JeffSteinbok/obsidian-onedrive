Follow `.github/skills/postmortem/SKILL.md` exactly for the merged pull request identified
in this issue.

Use `npm run build` and `npx vitest run` for validation. The hardening pull request must:

- use a `postmortem/<pr-number>-<slug>` branch;
- close this tracking issue;
- include the complete 5-Whys analysis between the repository's required
  `postmortem-writeup` markers;
- satisfy `.github/workflows/postmortem-guard.yml`; and
- remain unmerged for maintainer review.
