# Sync Engine Test Coverage

This document describes the sync engine test suites and the scenarios they cover.

## Test Files

| File | Tests | Description |
|---|---|---|
| `sync/syncEngine.test.ts` | 27 | Core sync operations — uploads, downloads, deletes, conflicts, delta handling |
| `sync/syncEngine.deletion.test.ts` | 16 | Deletion permutations — local→remote, remote→local, folder cleanup, reconcile |
| `sync/eventManager.test.ts` | 37 | Event detection — TFile events, TFolder events, raw config events, debouncing, scheduling |
| `sync/syncState.test.ts` | 3 | State manager — file state cleanup, folder reverse lookups |
| `sync/conflictQueue.test.ts` | 11 | Conflict queue — add, resolve, persistence |
| `api/chunkUpload.test.ts` | 9 | Chunked upload — size alignment, constraints |

## Sync Engine — Core (`syncEngine.test.ts`)

### Basic Operations
- No-op when nothing changed
- Upload locally modified files
- Download remote changes
- Delete remote files for local deletes
- Delete local files for remote deletes
- Handle local renames (delete old + upload new)

### First Sync
- Upload local-only files even when dirty queue is empty
- Skip duplicate uploads for files already matched by remote
- Skip local files excluded from sync (e.g. log folder)
- No local enumeration on subsequent syncs

### Conflict Resolution
- Upload when local is newer
- Download when remote is newer
- Create duplicate conflict file when configured
- Re-upload local changes when remote was deleted

### Delta Handling
- Realign localized app-folder delta paths
- Use separate delta token for `.obsidian` scope when enabled
- Preserve `.obsidian` delta token when scope disabled
- Filter `.obsidian` files from delta results
- Filter deeply nested `.obsidian` paths
- Resolve id-only delete entries via tracked state
- Expand folder deletes into per-file deletes for tracked descendants

### Config File Changes
- Backfill missing content hashes without generating false MODIFY
- Upload when stored hash differs from current hash
- Update mtime only when hash matches (no false upload)

### Safety & Progress
- Large-delete circuit breaker (threshold, user cancel, disabled)
- Skip large-delete warning on first sync
- Progress notice for 5+ operations
- Parallel operation execution
- `.syncIgnore` pattern filtering

## Sync Engine — Deletion Permutations (`syncEngine.deletion.test.ts`)

### Local → Remote
| # | Scenario | Expected |
|---|---|---|
| 1 | Single file deleted locally | Queue remote delete |
| 2 | Multiple files in same folder deleted | Queue individual remote deletes |
| 3 | Entire plugin folder deleted (`.obsidian/plugins/X/`) | Detect all files, queue remote deletes |
| 4 | Folder with subfolders deleted | Queue deletes for all nested tracked files |
| 5 | File already deleted remotely | Handle gracefully, no error |
| 6 | Untracked file deleted | Ignored |
| 7 | File vanishes during upload (ENOENT) | Convert to remote delete |

### Remote → Local (Cloud Delta)
| # | Scenario | Expected |
|---|---|---|
| 8 | Delta reports single file delete | Delete local file |
| 9 | Folder delete with untracked local files | Keep folder, only remove tracked files |
| 10 | Folder delete, empty after file deletes | Delete folder |
| 11 | Nested folder structure deleted | Handle deepest-first |

### Remote Folder Pruning (config folders only)
| # | Scenario | Expected |
|---|---|---|
| 12 | Local config folder gone, remote exists | Delete remote config folder |
| 13 | Local config folder still exists | Do NOT delete remote folder |
| 14 | Multiple plugin folders deleted | Prune all independently |

> **Note:** Regular (non-config) folder deletes are handled by explicit `FOLDER_DELETE`
> events via `processFolderChanges`, not by pruning. Config folders (`.obsidian/`) don't
> fire TFolder vault events, so they still need the prune path.

### Reconcile
| # | Scenario | Expected |
|---|---|---|
| 15 | Ghost entries in tracked state | Dropped during reconcile |
| 16 | Rebuild from cloud listing | Only cloud files appear in tracked state |

## Event Manager (`eventManager.test.ts`)

### TFile Events (vault files)
- Modify → dirty queue
- Create → dirty queue (unless already tracked = startup noise)
- Delete → dirty queue
- Rename → remove old path, add new

### TFolder Events (vault folders)
- Delete → dirty queue as FOLDER_DELETE
- Create → dirty queue as FOLDER_CREATE (only after initial sync completes)
- Create suppressed before initial sync (Obsidian fires create for all existing folders on startup)
- Create suppressed for already-tracked folders
- Rename updates pending FOLDER_CREATE path (Untitled → real name)
- Folder create and delete both schedule sync

### Raw Events (`.obsidian/` config files)
- Tracked config file deleted (stat returns null) → queue DELETE
- Untracked config file gone → ignored
- Tracked config file changed (mtime/size differ) → queue MODIFY

### Filtering
- Ignore `.obsidian/` paths for typed events (handled by raw)
- Allow plugin manifests/binaries when opted in
- Exclude plugin data files even when plugin sync enabled
- Suppress own-write events (prevent echo loops)

### Scheduling
- Debounced sync after events
- Coalesce rapid events into single sync
- Block scheduling during active sync
- Periodic sync start/stop
- Manual sync trigger

## State Manager (`syncState.test.ts`)

- `clearFileStates()` — wipes file states, preserves folder states
- `getFolderIdByPath()` — reverse lookup: vault path → OneDrive ID
- `removeFolderStateByPath()` — remove folder mapping by vault path

## Chunk Upload (`chunkUpload.test.ts`)

- Minimum chunk size for small files
- Appropriate chunk size for medium files
- Maximum chunk size for very large files
- Target ~20 chunks per file
- **All chunk sizes are multiples of 320 KiB** (Microsoft Graph requirement)
- Alignment verified across multiple file sizes (8.4MB, 20MB, 100MB, 500MB)
- Constants validation (min=320KB, max=60MB, target=20 chunks, threshold=4MB)

## Running Tests

```bash
# All tests
npx vitest run

# Sync tests only
npx vitest run tests/unit/sync/

# Specific test file
npx vitest run tests/unit/sync/syncEngine.deletion.test.ts

# Watch mode
npx vitest tests/unit/sync/
```
