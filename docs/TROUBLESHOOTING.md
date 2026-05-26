# Troubleshooting

## "Not authenticated" error

- Go to Settings → OneDrive Sync
- Click "Disconnect" and then "Connect to OneDrive" again
- Complete the authentication flow

## Files not syncing

- Check that you're connected (Settings → OneDrive Sync)
- Manually trigger sync: click ribbon icon or use Command Palette → "OneDrive: Sync now"
- Enable debug logging (Settings → OneDrive Sync → Advanced) and check console

## Authentication fails

- Ensure you're using a **Personal Microsoft account** (@outlook.com, @hotmail.com, etc.)
- Business/Work accounts (Office 365) are not supported
- Check that you entered the device code correctly
- Try disconnecting and reconnecting

## Large files fail to upload

- Check your OneDrive storage quota
- Files larger than 4MB use chunked upload (may take longer)
- Check console for detailed error messages
