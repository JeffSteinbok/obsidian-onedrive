# Advanced Usage

This document covers advanced configuration options for power users.

## `.syncIgnore` File

Create a `.syncIgnore` file at your vault root to skip extra files/folders from sync (similar to `.gitignore`).

- One pattern per line
- `#` starts a comment
- `!` negation patterns are not supported
- Folder pattern example: `private/`
- Wildcard example: `*.tmp`

**Example `.syncIgnore`:**
```
# Don't sync my private notes
private/

# Skip temporary files
*.tmp
*.bak

# Skip large media folder
attachments/videos/
```

## Custom Client ID

By default the plugin uses a shared Azure AD app registration. For privacy or rate-limit reasons you can bring your own:

1. Go to [Azure Portal](https://portal.azure.com) → Microsoft Entra ID → App registrations
2. Click **New registration**
3. Name: `Obsidian OneDrive Sync` (or anything you like)
4. Supported account types: **Personal Microsoft accounts only**
5. Redirect URI: Leave blank (not needed for device code flow)
6. After registration, copy the **Application (client) ID**
7. Under **Authentication** → enable **Allow public client flows**

Then paste the client ID into Settings → OneDrive Sync → Advanced → Custom client ID.

## Advanced Settings

These settings are available under Settings → OneDrive Sync → Advanced:

| Setting | Description |
| ------- | ----------- |
| **Log Level** | Controls how much detail is written to the console and vault log file. Set to Debug for troubleshooting. |
| **Large Delete Warning Threshold** | Pause and ask before a sync that would delete this many files. Helps catch unintended remote deletions. Set to 0 to disable. |
| **Reset Sync Token** | Force a full re-read from OneDrive on the next sync. Use if files appear missing or out of date. Upload-biased: local-only files will be re-uploaded. |
| **Reconcile from Cloud** | Treat cloud as authoritative. Deletes local files that no longer exist in OneDrive and downloads anything missing. Destructive — confirmation required for large deletes. |
| **Custom Client ID** | Use your own Azure AD app registration (see above). |

## Experimental Settings

These settings may improve performance but are not fully tested. Use at your own risk.

| Setting | Default | Description |
| ------- | ------- | ----------- |
| **Skip folder existence checks** | ON | Skip API calls to verify folders exist before uploading. OneDrive auto-creates parent folders on PUT, so this is safe and reduces API calls during large syncs. |
| **Max concurrent operations** | 4 | Maximum number of parallel upload/download operations. Higher values (8-12) may speed up large initial syncs but could hit rate limits. Values above 16 are not recommended. |

### When to adjust experimental settings

**Large vault initial sync (3000+ files):**
- Try increasing **Max concurrent operations** to 8 or 12
- Keep **Skip folder existence checks** ON (default)

**Rate limit errors (429 responses):**
- Decrease **Max concurrent operations** to 2-3
- The plugin has built-in retry with backoff, but reducing concurrency helps avoid hitting limits

**Upload failures with "folder not found" errors:**
- Try disabling **Skip folder existence checks** (rare edge case)
