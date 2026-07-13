# Dependency Update Policy

This repo is public OSS with a single maintainer. Dependabot opens PRs
weekly (`.github/dependabot.yml`); this document defines what happens to
them after that.

---

## Auto-merge tiers

Two workflows implement the policy:

- **`.github/workflows/ci.yml`** — runs `yarn typecheck`, `yarn lint`,
  `yarn build`, `yarn test` on every PR. Required to pass before any PR
  (dependabot or otherwise) can merge.
- **`.github/workflows/dependabot-auto-merge.yml`** — runs only on PRs
  opened by `dependabot[bot]`, decides eligibility from
  `dependabot/fetch-metadata`, and calls `gh pr merge --auto --squash`
  for eligible PRs. GitHub then merges automatically once `ci.yml`'s
  `verify` check passes.

### Auto-merges (patch/minor only)

- Any `devDependencies` bump (`dependency-type: direct:development`) —
  eslint, jest/ts-jest, typescript, `@types/*`, etc. Covers the `testing`
  and `eslint` dependabot groups.
- Any `github-actions` ecosystem bump.

### Always manual review

- Anything in the `dependencies` block (production runtime deps) — this
  includes the `langchain` dependabot group. See
  [`UPDATE_WORKFLOW.md`](./UPDATE_WORKFLOW.md) for how to evaluate
  langchain/deepagentsjs-related bumps specifically; that workflow is
  about behavioral parity with upstream, not just "does it build," so it
  stays a deliberate, human-reviewed step regardless of semver level.
- Any **major** version bump, in any ecosystem — the auto-merge gate only
  ever fires on `version-update:semver-patch` or `-minor`.
- Any PR where dependabot groups mixed dependency types together (the
  eligibility check fails closed, not open, in that case).

---

## Why no auto-approval step

GitHub blocks a workflow's own `GITHUB_TOKEN` from approving a PR unless
"Allow GitHub Actions to create and approve pull requests" is enabled for
the repo — a setting worth leaving off on a public repo. This repo's
branch ruleset already requires 0 approving reviews, so
`dependabot-auto-merge.yml` skips approval entirely and goes straight to
`gh pr merge --auto`.

---

## Triaging the backlog

The auto-merge workflow only evaluates PRs on
`opened`/`synchronize`/`reopened`/`ready_for_review`. It does **not**
retroactively evaluate PRs that were already open before the workflow
landed. To bring an old PR under the policy, comment `@dependabot
recreate` on it (forces a new commit, which fires `synchronize`), or
merge it by hand.
