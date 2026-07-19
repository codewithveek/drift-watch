# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).
It holds the intent to release: each `*.md` file here describes a set of changes
and how they should bump package versions.

## Making a change

When you touch a publishable package (`@driftwatch/sdk`), add a changeset:

```bash
pnpm changeset
```

Pick the package(s), pick the bump (patch / minor / major), and write a short
summary — that summary lands in the package's `CHANGELOG.md`. Commit the
generated file alongside your code change.

## How a release happens

On push to `main`, the `release` workflow runs `changesets/action`:

- If unreleased changesets exist, it opens/updates a **"Version Packages"** PR
  that bumps versions and rewrites changelogs.
- Merging that PR runs `changeset publish`, which publishes the bumped packages
  to npm.

Private packages (`@driftwatch/server`, `@driftwatch/console`) and the workspace
root are never published — the SDK is the only public package.
