# Obsidian OneDrive Sync

[![CI](https://github.com/jeffsteinbok/obsidian-onedrive/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffsteinbok/obsidian-onedrive/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-Plugin-purple)](https://obsidian.md)

![Social Preview](socialPreview.png)

Sync your Obsidian vault with **OneDrive Personal/Consumer** accounts using a mobile-friendly, zero-configuration approach.

## ✨ Features

- **Zero-Configuration Setup**: No Azure AD app registration required! Just click connect and authenticate.
- **Mobile-First Design**: Device Code Flow authentication works perfectly on iOS and Android.
- **Event-Driven Sync**: Battery-efficient synchronization triggered by vault changes (no polling).
- **Bidirectional Sync**: Automatic synchronization between your vault and OneDrive.
- **Conflict Resolution**: Multiple strategies (last-write-wins, duplicate files, or manual).
- **Chunked Uploads**: Efficient handling of large files with automatic chunking.
- **Secure Token Storage**: Tokens are obfuscated (not encrypted) for casual protection.
- **Status Indicators**: Real-time sync status in the status bar.

## 🚀 Quick Start

### Installation

#### Via BRAT (Recommended for Beta Testing)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from Obsidian Community Plugins
2. Open BRAT settings → **Add Beta Plugin**
3. Enter: `JeffSteinbok/obsidian-onedrive`
4. Click **Add Plugin** — BRAT will install and keep it updated automatically

#### Manual Installation

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/JeffSteinbok/obsidian-onedrive/releases)
2. Create a folder called `obsidian-onedrive` in your vault's `.obsidian/plugins/` directory
3. Place the downloaded files in that folder
4. Reload Obsidian
5. Enable the plugin in Settings → Community Plugins

### First-Time Setup

1. Open Settings → OneDrive Sync
2. Click **"Connect to OneDrive"**
3. Follow the on-screen instructions:
   - A modal will display a code (e.g., `ABC-DEF`)
   - Click "Open in Browser" to go to microsoft.com/devicelogin
   - Enter the code and sign in with your Microsoft account
   - Grant permissions when prompted
   - Return to Obsidian and click "I've completed authentication"
4. Done! Your vault will start syncing automatically.

## 📱 Mobile Support

This plugin is designed with mobile as a **primary target**:

- **Device Code Flow**: No custom URL schemes or redirects needed
- **Event-Driven Sync**: Only syncs when files change (battery-efficient)
- **No Background Polling**: Respects mobile battery life
- **Works on iOS and Android**: Fully tested on mobile devices

### Mobile Setup Tips

- On iOS: Use Safari to complete authentication
- On Android: Use Chrome or your default browser
- Authentication is a one-time setup; tokens are stored securely

## 🔧 Configuration

### Settings

#### Authentication

- **Connection Status**: Shows your connected Microsoft account
- **Connect/Disconnect**: Manage your OneDrive connection
- **Use Custom Client ID**: Advanced users can provide their own Azure AD app (optional)

#### Sync Configuration

- **Automatic Sync Interval**: Set to 0 for manual-only sync (recommended for battery life)
- **Startup Sync Delay**: Delay before first sync after Obsidian starts (0 = disabled, 10s recommended)
- **Conflict Resolution**:
  - **Last write wins** (default): Newer file overwrites older
  - **Create duplicate**: Saves both versions with conflict marker
  - **Manual**: Ask for resolution each time

#### Advanced

- **Enable Debug Logging**: Log detailed information for troubleshooting

## 🎯 Access Modes: Choose Your Setup

The plugin supports **two access modes** to fit different use cases:

### Mode 1: App Folder (Default - Recommended)

**What it is**: Secure, isolated folder just for this plugin

**Where files go**: `/Apps/ObsidianOneDrive/` (hidden system folder)

✅ **Pros**:

- **Most secure** - minimal permissions
- **Zero configuration** - just works
- **Isolated** - separate from your other OneDrive files
- **Privacy-focused** - plugin can't see your other files

❌ **Cons**:

- Files must be in app folder (can't use existing folders)
- Harder to share with others
- Can't browse to folder easily in OneDrive web/app

**Best for**:

- Personal vaults
- Privacy-conscious users
- Simple setup
- Most users (recommended)

### Mode 2: Full Access (Advanced - For Sharing)

**What it is**: Access to all OneDrive files

**Where files go**: Anywhere you choose (e.g., `/Documents/MyVault`)

✅ **Pros**:

- **Easy sharing** - share folders with family/team via OneDrive
- **Flexible location** - sync to any folder
- **Use existing folders** - no need to move files
- **Browseable** - easy to find in OneDrive web/app

❌ **Cons**:

- More permissions required (security tradeoff)
- Must configure folder path
- Plugin can access all your OneDrive files

**Best for**:

- **Sharing vaults with others** (family, team)
- Syncing to existing OneDrive folders
- Users who want full control over file location

### How to Switch Modes

1. Go to **Settings → OneDrive Sync → Access Mode**
2. Choose your preferred mode
3. If already connected, **disconnect and reconnect** to apply new permissions
4. Done!

## 👥 Sharing Your Vault (Full Access Mode Only)

Want to share your vault with family or team? Here's how:

### Setup (One-Time)

1. **Enable Full Access Mode**:
   - Settings → OneDrive Sync → Access Mode → Full Access
   - Disconnect and reconnect to grant new permissions

2. **Configure Sync Path**:
   - Settings → OneDrive Sync → Sync folder path
   - Set to: `/Documents/MyVault` (or your preferred location)

3. **Sync Your Vault**:
   - Plugin syncs your vault to that OneDrive folder
   - Wait for initial sync to complete

### Share the Folder

4. **Open OneDrive** (web or app)
5. **Navigate to your vault folder** (e.g., `/Documents/MyVault`)
6. **Right-click → Share → Enter email addresses**
7. **Set permissions**: "Can edit" (for full collaboration)
8. **Send invitation**

### Other Person Opens the Vault

**They DON'T need the plugin!** They just use OneDrive's native sync:

#### On Desktop (Windows/Mac):

1. Accept your share invitation
2. OneDrive desktop app syncs the folder locally
3. File appears at: `/Users/[name]/OneDrive/MyVault/`
4. Open Obsidian → "Open folder as vault"
5. Browse to the synced OneDrive folder
6. Done! ✅

#### On Mobile (iOS/Android):

1. Accept your share invitation
2. Open OneDrive app → "Shared"
3. Find your vault folder
4. Tap "..." → "Make available offline"
5. Open Obsidian Mobile → "Open folder as vault"
6. Browse to OneDrive location
7. Done! ✅

### Conflict Handling

If both people edit the same file:

- **Plugin side** (you): Conflict resolution based on your settings (last-write-wins, duplicate, or manual)
- **Non-plugin side** (them): OneDrive may create conflict copies like `Note-PersonName-PC.md`

**Tip**: Set conflict resolution to "Create duplicate" to avoid accidentally overwriting each other's changes.

### Example Use Cases

**Family vault**:

```
You: Install plugin with Full Access
Wife: Just uses OneDrive (no plugin needed)
Both: Can edit, plugin handles sync
```

**Team vault**:

```
Owner: Manages vault with plugin
Team: Access via OneDrive sharing
Collaboration: Real-time via OneDrive sync
```

## 🔐 Security & Privacy

### Token Storage

- Tokens are **obfuscated** (not cryptographically encrypted) before being saved to `data.json`
- This provides casual protection but is **not secure** if someone has file system access
- Tokens are automatically refreshed before expiry (no manual intervention needed)

### Permissions

The plugin requests different scopes based on access mode:

**App Folder Mode** (default):

- `User.Read`: Read your profile (to display your name/email)
- `Files.ReadWrite.AppFolder`: Read/write access to app-specific folder only
- `offline_access`: Enable refresh tokens (required for long-lived access)

**Full Access Mode** (advanced):

- `User.Read`: Read your profile
- `Files.ReadWrite.All`: Read/write access to all OneDrive files
- `offline_access`: Enable refresh tokens

**Security Note**: App Folder mode is more secure (minimal permissions). Only use Full Access if you need folder sharing or existing folder sync.

### Data Location

**App Folder Mode**:

- Files stored in `/Apps/ObsidianOneDrive/` (isolated, secure)
- Only this plugin can access this folder
- Not easily shareable with others

**Full Access Mode**:

- Files stored where you choose (e.g., `/Documents/MyVault`)
- You and others can access via OneDrive sharing
- Easy to browse in OneDrive web/app

## 🎯 How It Works

### Event-Driven Sync

Instead of polling OneDrive every few minutes (battery-draining), this plugin uses **event-driven sync**:

1. Listens to Obsidian vault events: `create`, `modify`, `delete`, `rename`
2. Throttles events with a 3-second delay (prevents excessive syncs during rapid changes)
3. Only syncs when files actually change
4. Dramatically better battery life on mobile!

### Sync Process

1. **Detect Changes**: Compare local vault with OneDrive state
2. **Determine Direction**: Decide whether to upload, download, or skip each file
3. **Handle Conflicts**: Use configured strategy if both sides changed
4. **Execute Operations**: Upload/download files as needed
5. **Update State**: Track last sync time and file hashes

### Conflict Resolution

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

## 🛠️ Development

### Prerequisites

- Node.js 18+ (recommend 20.x)
- npm or yarn
- Obsidian (for testing)

### Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/obsidian-onedrive.git
cd obsidian-onedrive

# Install dependencies
npm install

# Run development build (watch mode)
npm run dev

# Run tests
npm test

# Run tests with coverage
npm test:coverage

# Run linter
npm run lint

# Format code
npm run format
```

### Project Structure

```
obsidian-onedrive/
├── src/
│   ├── auth/          # Authentication (Device Code Flow, token storage)
│   ├── api/           # OneDrive API client (Graph API, chunked upload)
│   ├── sync/          # Sync engine (event manager, conflict resolver)
│   ├── ui/            # User interface (settings, status bar, modals)
│   ├── utils/         # Utilities (errors, logger, retry, path utils)
│   ├── constants.ts   # Constants (endpoints, scopes, client ID)
│   └── types.ts       # TypeScript interfaces
├── tests/
│   ├── unit/          # Unit tests
│   ├── integration/   # Integration tests
│   └── fixtures/      # Test fixtures
├── main.ts            # Plugin entry point
├── manifest.json      # Plugin manifest
└── package.json       # Dependencies and scripts
```

### Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with UI
npm run test:ui

# Generate coverage report
npm run test:coverage
```

### Building

```bash
# Production build
npm run build

# This creates main.js ready for distribution
```

## 🐛 Troubleshooting

### "Not authenticated" error

- Go to Settings → OneDrive Sync
- Click "Disconnect" and then "Connect to OneDrive" again
- Complete the authentication flow

### Files not syncing

- Check that you're connected (Settings → OneDrive Sync)
- Manually trigger sync: click ribbon icon or use Command Palette → "OneDrive: Sync now"
- Enable debug logging (Settings → OneDrive Sync → Advanced) and check console

### Authentication fails

- Ensure you're using a **Personal Microsoft account** (@outlook.com, @hotmail.com, etc.)
- Business/Work accounts (Office 365) are not supported
- Check that you entered the device code correctly
- Try disconnecting and reconnecting

### Large files fail to upload

- Check your OneDrive storage quota
- Files larger than 4MB use chunked upload (may take longer)
- Check console for detailed error messages

## 📜 License

This project is licensed under the **Apache License 2.0**. See [LICENSE](LICENSE) for details.

### Attribution

This plugin references implementation patterns from the following open-source projects:

- [remotely-save](https://github.com/remotely-save/remotely-save) (Apache 2.0) - OneDrive authentication, chunked uploads, and sync patterns
- [Home Assistant OneDrive Integration](https://github.com/home-assistant/core/tree/dev/homeassistant/components/onedrive) - Coordinator pattern, error handling, dynamic chunk sizing

We are grateful to these projects for their excellent open-source work.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Development Guidelines

- Follow the existing code style (run `npm run format`)
- Write tests for new features
- Update documentation as needed
- Use conventional commit messages

## ⚠️ Disclaimer

This is an **unofficial plugin** and is not affiliated with Obsidian or Microsoft.

Use at your own risk. Always maintain backups of your vault.

## 🆘 Support

- [Report Issues](https://github.com/yourusername/obsidian-onedrive/issues)
- [Discussion Forum](https://github.com/yourusername/obsidian-onedrive/discussions)

## 🗺️ Roadmap

Future enhancements (contributions welcome):

- [ ] Selective sync (ignore patterns)
- [ ] End-to-end encryption option
- [ ] OneDrive sharing integration
- [ ] Version history integration
- [ ] Background sync on iOS (if feasible)
- [ ] Conflict resolution with visual diff
- [ ] OneDrive Business support

---

**Made with ❤️ for the Obsidian community**
