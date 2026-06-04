# How It Works

## Event-Driven Sync

Instead of polling OneDrive every few minutes (battery-draining), this plugin uses **event-driven sync**:

1. Listens to Obsidian vault events: `create`, `modify`, `delete`, `rename`
2. Throttles events with a 3-second delay (prevents excessive syncs during rapid changes)
3. Only syncs when files actually change
4. Dramatically better battery life on mobile!

## Sync Process

1. **Detect Changes**: Compare local vault with OneDrive state
2. **Determine Direction**: Decide whether to upload, download, or skip each file
3. **Handle Conflicts**: Use configured strategy if both sides changed
4. **Execute Operations**: Upload/download files in small parallel batches as needed
5. **Update State**: Track last sync time and file hashes

## Conflict Resolution

**Last Write Wins (Default)**:
- Compares modification times
- Newer file overwrites older file
- Simple and automatic

**Create Duplicate**:
- Downloads remote file with conflict marker: `note (conflict 2026-05-25 12-30-45).md`
- Keeps both versions
- You manually merge later

**Manual**:
- Shows a modal asking which version to keep
- You decide for each conflict
