#!/usr/bin/env node
/**
 * Phase 2 — ongoing sync (runs inside HubSpot's monorepo).
 *
 * Keeps the Postman workspace in step with the monorepo, using migration-state.json
 * (produced by Phase 1) as the source-of-truth mapping. On each run it:
 *
 *   1. CHANGED specs — for every API in state, recomputes the spec file's git blob
 *      SHA. If it changed (an engineer edited the spec, or a newer version became
 *      the latest), it pushes the new content to the SAME specId (name/id are
 *      stable, so nothing downstream breaks) and, when the API is bound to a
 *      curated collection folder, ADDITIVELY adds any brand-new endpoints to that
 *      folder — curated docs/examples are never overwritten.
 *
 *   2. NEW services — a monorepo API with no state entry gets a spec created and a
 *      collection generated + labeled latest, then recorded in state.
 *
 *   3. REMOVED — an API whose spec file is gone from the monorepo is reported, not
 *      deleted (removal from the public workspace is a human decision).
 *
 * Safety: --plan (default) writes nothing and reports the diff; --apply performs
 * changes. Collection content sync is additive-only; the only replace/delete calls
 * are against throwaway generated collections. Spec updates are never destructive.
 *
 * Usage (run from the monorepo root):
 *   node .postman/sync.mjs --plan    [--repo .] [--state ./.postman/migration-state.json]
 *   node .postman/sync.mjs --apply   [--no-collections] [--no-create]
 * Env: POSTMAN_API_KEY (required for apply), TARGET_WORKSPACE_ID (for new services).
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { loadState, saveState, apiKey } from './lib/state.mjs';
import {
  createPostmanClient,
  specTypeForOpenApi,
  createSpec,
  getSpecFiles,
  updateSpecFileContent,
  generateCollection,
  getCollection,
  createCollectionFolder,
  updateCollectionFolder,
  createCollectionRequest,
  deleteCollection,
  folderIdFrom,
  pollTask
} from './lib/postman.mjs';
import { discoverCells, gitBlobSha, readSpec } from './lib/monorepo.mjs';
import { resolveLatestSelections } from './lib/plan.mjs';
import { loadGroupLabelMap, loadVersionOverrides, specName, versionFolderName } from './lib/naming.mjs';
import { newRequests, toCreatePayload, flattenRequests } from './lib/collection-merge.mjs';

const args = parseArgs(process.argv.slice(2));
const mode = args.apply ? 'apply' : 'plan';

const state = loadState(args.state);
const workspaceId = args.workspace ?? state.targetWorkspaceId ?? null;

const client = createPostmanClient({
  apiKey: args.pmak,
  baseUrl: process.env.POSTMAN_API_BASE,
  dryRun: mode !== 'apply'
});

banner(mode, args);

const labelMap = loadGroupLabelMap(args.groupLabelMap, read);
const overrides = loadVersionOverrides(args.versionMap, read);

// Re-derive the current latest spec file per API from the monorepo (repo signals
// + overrides). Used to detect new services and version rolls; content-edit
// detection below uses the path already recorded in state.
const { cells } = discoverCells(args.repo);
const { selected } = resolveLatestSelections(cells, { labelMap, overrides });
const selByKey = new Map(selected.map((s) => [s.key, s]));

const report = { changedSpecs: [], newServices: [], removed: [], collectionUpdates: [], errors: [] };

// ── 1 & 3: walk known APIs for content edits / version rolls / removal ──────────
for (const [key, entry] of Object.entries(state.apis)) {
  try {
    const sel = selByKey.get(key);
    // Prefer the freshly-resolved latest path (catches a version roll); fall back
    // to the path already in state (same-version content edit).
    const specPath = sel?.specPath ?? entry.repo?.specPath ?? null;
    const abs = specPath ? join(args.repo, specPath) : null;

    if (!abs || !existsSync(abs)) {
      report.removed.push({ key, specPath });
      continue;
    }

    const sha = gitBlobSha(abs);
    const rolled = sel && entry.repo?.specPath && sel.specPath !== entry.repo.specPath;
    if (sha === entry.repo?.blobSha && !rolled) continue; // unchanged

    const change = {
      key,
      specId: entry.postman?.specId ?? null,
      from: entry.repo?.specPath,
      to: specPath,
      versionRoll: Boolean(rolled),
      newVersion: sel?.version ?? entry.latestVersion
    };

    if (!entry.postman?.specId) {
      change.status = 'skipped-no-specId';
      report.changedSpecs.push(change);
      continue;
    }

    const content = readFileSync(abs, 'utf8');
    const rootPath = await resolveRootFilePath(client, entry.postman.specId, specPath);
    await updateSpecFileContent(client, entry.postman.specId, rootPath, content);
    change.status = client.dryRun ? 'planned' : 'updated';

    // Keep state current.
    entry.repo.specPath = specPath;
    entry.repo.blobSha = sha;
    entry.latestVersion = change.newVersion;

    report.changedSpecs.push(change);

    // Collection sync for the changed spec:
    //   - version roll on a version-subfolder layout → NEW "[latest]" subfolder
    //     (case 2): the new version gets its own collection, previous latest is
    //     relabeled. Curated older versions stay intact.
    //   - otherwise (in-place edit, or an API-folder/functional layout) →
    //     ADDITIVELY add new endpoints to the bound folder (case 3), preserving docs.
    if (args.collections) {
      const res =
        rolled && entry.postman?.bindingLevel === 'version'
          ? await createVersionCollection(entry, key, change.newVersion)
          : await syncCollectionAdditive(entry, key);
      if (res) report.collectionUpdates.push(res);
    }
  } catch (error) {
    report.errors.push({ key, phase: 'changed', error: describe(error) });
  }
}

// ── 2: new services present in the monorepo but not in state ────────────────────
if (args.create) {
  for (const sel of selected) {
    if (state.apis[sel.key]) continue;
    if ((state.skipped ?? []).some((s) => apiKey(s.group, s.api) === sel.key)) continue;
    try {
      report.newServices.push(await onboardNewService(sel));
    } catch (error) {
      report.errors.push({ key: sel.key, phase: 'new', error: describe(error) });
    }
  }
}

// ── persist + summarize ─────────────────────────────────────────────────────────
if (mode === 'apply') saveState(args.state, state);

printSummary(report, mode);
if (report.errors.length > 0) process.exitCode = 1;

// ────────────────────────────────────────────────────────────────────────────────

/** Find the spec's ROOT file path (fallback to the monorepo basename). */
async function resolveRootFilePath(client, specId, specPath) {
  const fallback = basename(specPath);
  if (client.dryRun) return fallback;
  try {
    const res = await getSpecFiles(client, specId);
    const files = res?.files ?? res?.data ?? [];
    const root = files.find((f) => String(f.type).toUpperCase() === 'ROOT') ?? files[0];
    return root?.path ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Additively merge the changed spec's NEW endpoints into its bound curated
 * folder, preserving all existing curated content. No-op (with a reason) when the
 * API isn't bound to a specific folder.
 */
async function syncCollectionAdditive(entry, key) {
  const p = entry.postman ?? {};
  const collectionUid = p.groupingCollectionUid;
  const folderId = p.versionFolderId ?? p.apiFolderId ?? null;
  if (!collectionUid || !folderId) {
    return { key, status: 'skipped-no-folder', bindingLevel: p.bindingLevel ?? null };
  }
  if (!p.specId) return { key, status: 'skipped-no-specId' };

  if (client.dryRun) {
    return { key, status: 'planned', note: 'would add any new endpoints to the bound folder' };
  }

  // 1. Generate a throwaway collection from the (now-updated) spec.
  const gen = await pollTask(client, await generateCollection(client, p.specId, `__tmp ${key}`));
  const tmpUid = generatedCollectionUid(gen);
  if (!tmpUid) return { key, status: 'error', error: 'could not resolve generated collection id' };

  try {
    // 2. Read the generated requests and the curated folder's existing requests.
    const genDoc = await getCollection(client, tmpUid);
    const curatedDoc = await getCollection(client, collectionUid);
    const genItems = genDoc?.collection?.item ?? [];
    const folder = findFolderById(curatedDoc?.collection?.item ?? [], folderId);
    const existingItems = folder?.item ?? [];

    // 3. Add only the endpoints not already in the folder.
    const toAdd = newRequests(genItems, existingItems);
    let added = 0;
    for (const r of toAdd) {
      await createCollectionRequest(client, collectionUid, folderId, toCreatePayload(r.name, r.request));
      added += 1;
    }
    return {
      key,
      status: 'merged',
      generatedRequests: flattenRequests(genItems).length,
      existingRequests: flattenRequests(existingItems).length,
      added
    };
  } finally {
    // 4. Always remove the throwaway collection.
    await deleteCollection(client, tmpUid).catch(() => {});
  }
}

/**
 * Case 2 — a new version became the latest for an EXISTING service. Create a new
 * "{version} [latest]" subfolder under the API folder, populate it fresh from the
 * spec, and relabel the previous latest so there's only one. Older curated
 * versions are untouched.
 */
async function createVersionCollection(entry, key, newVersion) {
  const p = entry.postman ?? {};
  const collectionUid = p.groupingCollectionUid;
  const apiFolderId = p.apiFolderId;
  if (!collectionUid || !apiFolderId) return { key, status: 'skipped-no-apiFolder' };
  if (!p.specId) return { key, status: 'skipped-no-specId' };

  const newName = versionFolderName(newVersion, 'latest');
  if (client.dryRun) {
    return { key, status: 'planned', note: `would add '${newName}' subfolder + relabel previous latest` };
  }

  // Relabel the previous latest (strip the "[latest]" tag). Rename only — the
  // curated content of the old version is left exactly as-is.
  if (p.versionFolderId && p.versionFolderName) {
    const stripped = p.versionFolderName.replace(/\s*\[latest\]\s*$/i, '').trim();
    if (stripped && stripped !== p.versionFolderName) {
      await updateCollectionFolder(client, collectionUid, p.versionFolderId, { name: stripped }).catch(() => {});
    }
  }

  // Create the new version subfolder and populate it from the spec.
  const created = await createCollectionFolder(client, collectionUid, newName, apiFolderId);
  const newFolderId = folderIdFrom(created);
  if (!newFolderId) return { key, status: 'error', error: 'could not resolve new folder id' };

  const gen = await pollTask(client, await generateCollection(client, p.specId, `__tmp ${key}`));
  const tmpUid = generatedCollectionUid(gen);
  let copied = 0;
  try {
    if (tmpUid) {
      const genDoc = await getCollection(client, tmpUid);
      copied = await copyItemsInto(collectionUid, newFolderId, genDoc?.collection?.item ?? []);
    }
  } finally {
    if (tmpUid) await deleteCollection(client, tmpUid).catch(() => {});
  }

  // Point the mapping at the new version subfolder.
  p.versionFolderId = newFolderId;
  p.versionFolderName = newName;
  p.bindingLevel = 'version';
  return { key, status: 'new-version-collection', versionFolder: newName, copied };
}

/** Recursively copy a generated collection's folder/request tree into a folder. */
async function copyItemsInto(collectionUid, parentFolderId, items) {
  let count = 0;
  for (const node of items ?? []) {
    if (Array.isArray(node.item)) {
      const folder = await createCollectionFolder(client, collectionUid, node.name, parentFolderId);
      const childId = folderIdFrom(folder);
      count += await copyItemsInto(collectionUid, childId, node.item);
    } else if (node.request) {
      await createCollectionRequest(client, collectionUid, parentFolderId, toCreatePayload(node.name, node.request));
      count += 1;
    }
  }
  return count;
}

/** Create a spec + generated collection for a brand-new service and record it. */
async function onboardNewService(sel) {
  const { content, parsed } = readSpec(sel);
  const type = specTypeForOpenApi(parsed?.openapi ?? parsed?.swagger ?? '3.0');
  const name = specName(sel.group, sel.api, labelMap);

  const created = await createSpec(client, workspaceId, {
    name,
    type,
    rootFileName: basename(sel.specPath),
    content
  });
  const specId = created?.id ?? null;

  let collectionUid = null;
  if (specId && !client.dryRun) {
    const gen = await pollTask(client, await generateCollection(client, specId, `${name} [latest]`));
    collectionUid = generatedCollectionUid(gen);
  }

  state.apis[sel.key] = {
    group: sel.group,
    api: sel.api,
    latestVersion: sel.version,
    selectionReason: sel.selectionReason,
    repo: {
      specPath: sel.specPath,
      blobSha: gitBlobSha(sel.specAbsPath),
      curatedCollectionPath: sel.curatedCollectionPath ?? null
    },
    postman: {
      specName: name,
      specId,
      groupingCollectionUid: collectionUid,
      apiFolderId: null,
      versionFolderId: null,
      bindingLevel: collectionUid ? 'collection' : null
    },
    createdBy: 'phase2-sync'
  };
  return { key: sel.key, specId, collectionUid, status: client.dryRun ? 'planned' : 'created' };
}

/** Resolve a generated collection's uid across the generation-response shapes. */
function generatedCollectionUid(gen) {
  return (
    gen?.details?.resources?.[0]?.id ??
    gen?.collection?.uid ??
    gen?.collection?.id ??
    gen?.result?.collection?.uid ??
    gen?.model_id ??
    gen?.id ??
    null
  );
}

function findFolderById(items, id) {
  for (const node of items ?? []) {
    if (!Array.isArray(node.item)) continue;
    if (node.id === id || node.uid === id) return node;
    const nested = findFolderById(node.item, id);
    if (nested) return nested;
  }
  return null;
}

function parseArgs(argv) {
  const get = (flag) => {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    apply: argv.includes('--apply'),
    collections: !argv.includes('--no-collections'),
    create: !argv.includes('--no-create'),
    repo: get('--repo') ?? process.env.HUBSPOT_REPO_PATH ?? '.',
    state: get('--state') ?? process.env.STATE_PATH ?? './.postman/migration-state.json',
    workspace: get('--workspace') ?? process.env.POSTMAN_WORKSPACE_ID ?? process.env.TARGET_WORKSPACE_ID,
    pmak: get('--pmak') ?? process.env.POSTMAN_API_KEY,
    groupLabelMap: get('--group-label-map') ?? process.env.GROUP_LABEL_MAP ?? null,
    versionMap: get('--version-map') ?? process.env.VERSION_OVERRIDES ?? './version-overrides.json'
  };
}

function read(p) {
  return readFileSync(p, 'utf8');
}

function banner(mode, args) {
  const label = mode === 'apply' ? 'APPLY (mutating)' : 'PLAN (read-only)';
  process.stderr.write(
    `\n${'='.repeat(60)}\nPhase 2 sync — ${label}\n` +
      `repo: ${args.repo}  state: ${args.state}\n` +
      `collections: ${args.collections ? 'on' : 'off'}  new-services: ${args.create ? 'on' : 'off'}\n` +
      `${'='.repeat(60)}\n\n`
  );
}

function printSummary(r, mode) {
  const changed = r.changedSpecs.filter((c) => c.status === 'updated' || c.status === 'planned').length;
  const merged = r.collectionUpdates.filter((c) => c.status === 'merged').length;
  const addedEndpoints = r.collectionUpdates.reduce((n, c) => n + (c.added ?? 0), 0);
  process.stderr.write(
    `\n${mode.toUpperCase()} summary\n` +
      `  specs changed:     ${changed}\n` +
      `  collections merged:${merged} (${addedEndpoints} new endpoint(s) added)\n` +
      `  new services:      ${r.newServices.length}\n` +
      `  removed (flagged): ${r.removed.length}\n` +
      `  errors:            ${r.errors.length}\n`
  );
  if (r.removed.length) {
    process.stderr.write(`  removed: ${r.removed.map((x) => x.key).join(', ')}\n`);
  }
  if (r.errors.length) {
    for (const e of r.errors) process.stderr.write(`  ERROR ${e.key} (${e.phase}): ${e.error?.message ?? e.error}\n`);
  }
  // Machine-readable report on stdout for the workflow to archive.
  process.stdout.write(JSON.stringify({ mode, ...r }, null, 2) + '\n');
}

function describe(error) {
  if (error && typeof error === 'object') return { message: error.message, status: error.status, body: error.body };
  return { message: String(error) };
}
