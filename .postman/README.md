# Postman Spec Sync (`.postman/`)

Keeps HubSpot's public Postman workspace in step with this monorepo, automatically — no more manual re-publishing when an engineering team ships a spec change.

Everything Postman-related lives in this one folder. `migration-state.json` (produced by the Phase 1 migration) is the source-of-truth mapping between each monorepo spec file and its Postman spec + curated collection.

---

## Setup (one time)

This folder and the workflow are already committed to the repo, so setup is just **two secrets**:

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
| --- | --- |
| `POSTMAN_API_KEY` | A Postman API key with write access to the public workspace |
| `POSTMAN_WORKSPACE_ID` | The public workspace ID (`d7645f33-…`) — used only when creating brand-new services |

That's it. Node 20 is the only runtime and there are no dependencies to install.

## How it runs

- **Automatically** — weekday mornings, the workflow does a safe, non-destructive **spec sync** and opens a PR if `.postman/migration-state.json` changed. Nothing is deleted, ever.
- **Manually** — **Actions → Postman Spec Sync → Run workflow**:
  - `mode`: `plan` (preview, writes nothing) or `apply`
  - `collections`: also additively add new endpoints into curated collections
  - `create-new`: create a spec + collection for brand-new services

Start with a `plan` run to preview. Every run uploads a `sync-report.json` artifact listing exactly what changed.

## What it does on each run

For every API in `migration-state.json` it recomputes the spec file's git blob SHA to detect change, and handles four cases:

1. **Brand-new service** (a monorepo API with no state entry) → creates the spec and generates a collection labeled `[latest]`, then records both in state.
2. **New version became latest** for an existing service → updates the spec in place, **adds a new `{version} [latest]` subfolder** under the API folder, populates it from the spec, and relabels the previous latest. Older curated versions are left untouched.
3. **Existing spec edited in place** → updates the spec, then **additively** adds only brand-new endpoints to the bound curated folder. Existing curated requests, descriptions, and examples are never modified or removed.
4. **Removed** — an API whose spec file disappeared from the monorepo is *reported*, never auto-deleted (removing something from the public workspace is a human decision).

In every case the spec's name and ID stay stable, so links and collection bindings never break. Collection writes (cases 2 & 3) only happen when `collections` is on; the spec update always runs.

### Why additive, not Postman's native sync

Postman's native spec→collection sync rebuilds the whole collection, which would wipe HubSpot's curated documentation and examples (and it only works on collections generated from the spec — HubSpot's curated ones weren't). So this sync only ever **adds** to curated collections: it generates a throwaway collection from the spec, diffs requests by `METHOD + normalized path`, creates just the missing ones, then deletes the throwaway.

## The state file

`migration-state.json` is keyed by `{group}/{api}`. Each entry carries the monorepo side (`specPath`, `blobSha`) and the Postman side (`specId`, `groupingCollectionUid`, `apiFolderId`, `versionFolderId`, `bindingLevel`). The sync reads it to know what maps to what, and writes it back (via PR) so blob hashes and any new IDs stay current.

APIs bound only at the grouping-collection level (no specific folder) still get their **spec** synced; the additive collection step is skipped for them and noted in the report.

## Run it locally (optional)

```bash
# preview, no writes
POSTMAN_API_KEY=… node .postman/sync.mjs --plan

# apply spec sync only
POSTMAN_API_KEY=… POSTMAN_WORKSPACE_ID=… node .postman/sync.mjs --apply --no-collections

# apply everything, including additive collection sync
POSTMAN_API_KEY=… POSTMAN_WORKSPACE_ID=… node .postman/sync.mjs --apply
```

Flags: `--plan|--apply`, `--no-collections`, `--no-create`, `--repo <path>`, `--state <path>`, `--workspace <id>`.
