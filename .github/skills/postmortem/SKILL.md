# Skill: Bug-Fix Postmortem (5 Whys + Hardening)

> [!NOTE]
> **Postmortems run through Steward.** After each bug-fix merge, the
> maintainer's Orca bot, Steward, runs the postmortem using
> `.github/skills/postmortem/SKILL.md`. Codex prepares a hardening PR when
> warranted, Claude reviews it independently, and Steward posts the writeup on
> the bug issue. The maintainer merges hardening PRs. The GitHub Actions
> postmortem workflows remain disabled.

## Purpose

Whenever a bug-fix PR is merged, run a structured postmortem that goes beyond
"the fix works" and asks **why the bug was possible at all**, then make code and
test changes that make a whole *class* of similar bugs harder to reintroduce.

A fix removes one bug. A good postmortem removes the conditions that let it exist.

## When this runs

- **After a bug-fix merge:** Steward dispatches Codex to follow this skill.
- **For a backfill or rerun:** Give Steward the original bug-fix PR number.

## Inputs you are given

- The merged bug-fix PR number, title, body, and merge commit SHA.
- The linked issue (if any) that the PR fixed.

## Process — do these steps in order

### 1. Reconstruct what happened

- Read the PR diff: `gh pr diff <N>` and `git show <mergeSha>`.
- Read the linked/fixing issue and any repro steps or logs.
- Identify the exact lines the fix changed and the user-visible symptom.

### 2. Find where the bug was introduced

- For each changed hunk, blame it: `git log -S "<distinctive snippet>" --oneline`
  and `git blame` on the pre-fix lines.
- Determine whether this was a **regression** (previously-correct behavior broke)
  or a **latent gap** (never worked; only became observable under new conditions).
- Record the introducing commit/PR when identifiable.

### 3. Ask the 5 Whys

Write a genuine 5-level causal chain, not five restatements of the symptom.
Each "why" must answer the previous answer. Example shape:

1. **Why did the bug happen?** — the immediate mechanism in the code.
2. **Why was that possible?** — the design/assumption that allowed it.
3. **Why did that assumption hold in the code?** — where it was encoded.
4. **Why didn't tests catch it?** — the missing test dimension/scenario.
5. **Why didn't review/process catch it?** — the systemic gap (platform coverage,
   invariant not documented, type not making illegal states unrepresentable, etc.).

Stop at the first "why" whose answer is genuinely outside the codebase's control.

### 4. Decide hardening actions

From the deepest actionable "why", choose concrete changes that prevent the
*class* of bug, not just the one instance. Prefer, in order:

1. **Make illegal states unrepresentable** (types, exhaustive switches, invariants).
2. **Assertions / guards** at the boundary where the bad assumption lived, with a
   clear log or error when violated.
3. **Regression + generalization tests** — one test reproducing the original bug,
   plus tests covering the sibling cases that share the same assumption (e.g. the
   other platforms, the other change types, the empty/non-empty variants).
4. **Documentation of the invariant** next to the code that relies on it, so the
   next editor sees it.

Do **not** refactor unrelated code. Keep changes surgical and reviewable.

### 5. Validate

- `npm run build`
- `npx vitest run`
  Both must pass. Any added regression test must fail before your hardening change
  and pass after it.

### 6. Output

- Put the full 5-Whys writeup in the final report. When class-level hardening is
  warranted, prepare a PR from a `postmortem/<pr-number>-<slug>` branch, reference
  the original bug-fix PR and bug issue, and include the writeup in the PR body.
  Use the repository's pull request template and check **Bug fix**.
- Wrap the writeup in these exact marker lines.

  ```
  <!-- postmortem-writeup:start -->
  ...the filled-in postmortem template...
  <!-- postmortem-writeup:end -->
  ```

- Steward coordinates independent Claude review and posts the reviewed writeup
  on the bug issue. Leave the hardening PR for the maintainer to merge.

## Postmortem comment template

```markdown
## 🔬 Postmortem — PR #<N>: <title>

**Symptom:** <what the user saw>
**Fix shipped:** <one line: what PR #N changed>
**Regression?** <Yes/No + introducing commit/PR, or "latent gap since <commit>">

### 5 Whys
1. **Why?** …
2. **Why?** …
3. **Why?** …
4. **Why?** …
5. **Why (root)?** …

### How we missed it
<the specific missing test dimension / coverage gap>

### Hardening (this PR: #<hardening-PR>)
- <invariant/type/guard added>
- <regression test + generalized sibling-case tests>
- <docs of the invariant, if any>

### Follow-ups (optional)
- <anything out of scope for one PR>
```

## Guardrails

- Never merge PRs automatically — maintainer review is required.
- Only run linters/build/tests that already exist in the repo.
- Keep the hardening PR focused on preventing this bug class; no drive-by rewrites.
