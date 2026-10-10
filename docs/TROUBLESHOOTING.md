# Troubleshooting

## "Not authenticated" error

- Go to Settings → OneDrive Sync
- Click "Disconnect" and then "Connect to OneDrive" again
- Complete the authentication flow

## Files not syncing

- Check that you're connected (Settings → OneDrive Sync)
- Manually trigger sync: click ribbon icon or use Command Palette → "OneDrive: Sync now"
- Enable debug logging (Settings → OneDrive Sync → Log Level → Debug), sync again, and check the daily log file in the `_OneDriveSyncLogs/` folder of your vault

## Authentication fails

- Check that **Account type** in settings matches your account: personal (@outlook.com, @hotmail.com, etc.) or work/school
- Work and school accounts need a one-time app registration first; see [Account Types](ADVANCED.md#account-types)
- Check that you entered the device code correctly
- Try disconnecting and reconnecting

## Large files fail to upload

- Check your OneDrive storage quota
- Files larger than 4MB use chunked upload (may take longer)
- Check console for detailed error messages
