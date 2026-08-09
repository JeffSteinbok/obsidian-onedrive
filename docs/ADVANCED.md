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

## Account Types

Settings → OneDrive Sync → Authentication → **Account type** controls which Microsoft identity authority the plugin signs in against:

| Account type | Use for | Custom client ID |
| ------------ | ------- | ----------------- |
| **Personal** (default) | Consumer Microsoft accounts (outlook.com, hotmail.com, live.com) | Optional |
| **Work or school (any organization)** | An Entra ID (Azure AD) work or school account, without pinning a specific tenant | **Required** |
| **Work or school (specific organization)** | One named Entra ID tenant, identified by its tenant ID | **Required** |

Personal accounts keep working exactly as before — this setting defaults to Personal and existing installs are unaffected. Work and school accounts (OneDrive for Business, backed by SharePoint Online) need their own app registration, covered below.

## Custom Client ID

### Personal Microsoft accounts

By default the plugin uses a shared Azure AD app registration. For privacy or rate-limit reasons you can bring your own:

1. Go to [Azure Portal](https://portal.azure.com) → Microsoft Entra ID → App registrations
2. Click **New registration**
3. Name: `Obsidian OneDrive Sync` (or anything you like)
4. Supported account types: **Personal Microsoft accounts only**
5. Redirect URI: Leave blank (not needed for device code flow)
6. After registration, copy the **Application (client) ID**
7. Under **Authentication** → enable **Allow public client flows**

Then paste the client ID into Settings → OneDrive Sync → Advanced → Custom client ID.

### Work or school (Entra ID) accounts

The client ID bundled with the plugin is registered for **personal Microsoft accounts only** — Microsoft Graph rejects it immediately for a work or school sign-in. Work and school accounts must register their own application:

1. Go to [Azure Portal](https://portal.azure.com) → Microsoft Entra ID → App registrations
2. Click **New registration**
3. Name: `Obsidian OneDrive Sync` (or anything you like)
4. Supported account types: **Accounts in this organizational directory only** (for the "specific organization" account type) or **Accounts in any organizational directory** (for "any organization")
5. Redirect URI: Leave blank (device code flow needs none)
6. After registration, copy the **Application (client) ID**, and the **Directory (tenant) ID** if you plan to use the "specific organization" account type
7. Under **Authentication** → enable **Allow public client flows**
8. Under **API permissions** → add delegated Microsoft Graph permissions: `User.Read`, `offline_access`, and `Files.ReadWrite.All`. Work and school accounts always run in Full Access mode, which includes browsing and syncing folders shared with the user — that reads other drives, which plain `Files.ReadWrite` does not cover
9. Click **Grant admin consent** — many tenants require this before any user can sign in, regardless of the permissions requested

Then in Settings → OneDrive Sync:
1. Set **Account type** to the matching work/school option
2. For "specific organization", paste the **Tenant ID**
3. Paste the **Application (client) ID** into **Custom client ID** — this field becomes required (not optional) once account type is not Personal
4. Connect as usual via the device code flow

## Work and School Account Limitations

**App Folder mode is unavailable.** Microsoft Graph does not offer the `Files.ReadWrite.AppFolder` scope to work or school accounts, so the plugin restricts these accounts to Full Access mode and hides the App Folder option in settings. Recommended layout: pick a dedicated folder (e.g. `/Documents/ObsidianVaults/<VaultName>`) and set it as the sync folder under Full Access, rather than pointing the vault at the drive root.

**Vault placement.** If this is a work machine, the OneDrive desktop client is likely already running and signed in, mirroring your OneDrive for Business drive to disk. The plugin syncs independently through Obsidian's vault API and Microsoft Graph — it never reads that local mirror — so the two do not interfere, **unless the vault itself is placed inside the OneDrive client's synced folder**. In that case two independent syncers would act on the same files. Keep the vault outside the OneDrive client's local sync folder so the plugin is the only writer.

**Conditional Access can block sign-in entirely.** Some tenants have a Conditional Access policy that forbids the OAuth device code grant outright (the only sign-in method this plugin supports, by design — see the mobile-compatibility note in `src/auth/deviceCodeFlow.ts`). If your organization has such a policy, authentication will fail with a message naming the organization's policy as the cause, and there is no workaround within the plugin; ask your administrator whether device code sign-in can be permitted for this app, or use OneDrive's native sync instead. **This restriction is often stricter for mobile than desktop** — a tenant's Conditional Access policy may require a compliant device or an approved client app, conditions a desktop browser can satisfy that the Obsidian mobile app cannot. It is possible for a tenant to allow this plugin on desktop while blocking it on iOS and Android, the platform this feature exists to serve.

**Continuous Access Evaluation (CAE).** Business tenants can revoke a token mid-session in response to a risk signal (e.g. a password reset, or the user being disabled), via a mechanism this plugin does not implement support for. If you see an unexpected "please reconnect" prompt with no obvious cause, CAE is a likely explanation — simply reconnect.

## Advanced Settings

These settings are available under Settings → OneDrive Sync → Advanced:

| Setting | Description |
| ------- | ----------- |
| **Log Level** | Controls how much detail is written to the console and vault log file. Set to Debug for troubleshooting. |
| **Large Delete Warning Threshold** | Pause and ask before a sync that would delete this many files. Helps catch unintended remote deletions. Set to 0 to disable. |
| **Reset Sync Token** | Force a full re-read from OneDrive on the next sync. Use if files appear missing or out of date. Upload-biased: local-only files will be re-uploaded. |
| **Reconcile from Cloud** | Treat cloud as authoritative. Deletes local files that no longer exist in OneDrive and downloads anything missing. Destructive — confirmation required for large deletes. |
| **Account Type** | Personal, work/school (any organization), or work/school (specific organization). See [Account Types](#account-types) above. |
| **Tenant ID** | Only shown for the "specific organization" account type. |
| **Custom Client ID** | Use your own Azure AD app registration (see above). Required — not optional — for work and school accounts. |

## Experimental Settings

These settings may improve performance but are not fully tested. Use at your own risk.

| Setting | Default | Description |
| ------- | ------- | ----------- |
| **Skip folder existence checks** | ON | Skip API calls to verify folders exist before uploading. OneDrive auto-creates parent folders on PUT, so this is safe and reduces API calls during large syncs. |
| **Max concurrent operations** | 4 | Maximum number of parallel upload/download operations. Higher values (8-12) may speed up large initial syncs but could hit rate limits. Values above 16 are not recommended. |
| **Use atomic moves** | ON | Use OneDrive's native PATCH API to move/rename files instead of delete + re-upload. More efficient (no re-upload needed) and avoids duplicate files if sync state is lost. |

### When to adjust experimental settings

**Large vault initial sync (3000+ files):**
- Try increasing **Max concurrent operations** to 8 or 12
- Keep **Skip folder existence checks** ON (default)

**Rate limit errors (429 responses):**
- Decrease **Max concurrent operations** to 2-3
- The plugin has built-in retry with backoff, but reducing concurrency helps avoid hitting limits

**Upload failures with "folder not found" errors:**
- Try disabling **Skip folder existence checks** (rare edge case)

**Duplicate files appearing after moves/renames:**
- Ensure **Use atomic moves** is ON (default)
- If you see duplicates, check logs for "no tracked state for old path" warnings — this indicates the old location couldn't be found in sync state
