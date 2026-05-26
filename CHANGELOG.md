# Changelog

All notable changes to the OneDrive Sync plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial implementation of OneDrive Personal sync
- Device Code Flow authentication (mobile-friendly)
- Event-driven sync with vault event listeners
- Bidirectional sync engine
- Conflict resolution strategies (last-write-wins, create-duplicate, manual)
- Chunked upload for large files (>4MB)
- Token storage with obfuscation
- Status bar indicator with sync status
- Settings panel with authentication flow
- Debug logging option
- Unit tests for core components
- Comprehensive documentation

### Changed

- N/A (initial release)

### Deprecated

- N/A

### Removed

- N/A

### Fixed

- N/A

### Security

- Token obfuscation (casual protection)
- Automatic token refresh before expiry
- App folder scope by default (limited permissions)

## [0.1.0] - 2026-05-25

### Added

- Initial release (development version)
- Basic project structure
- Authentication infrastructure
- OneDrive API integration
- Sync engine with event-driven architecture
- UI components (settings, status bar, modals)
- Testing infrastructure with Vitest
- Build configuration with esbuild
- Linting and formatting setup

---

## Version History

### Version Numbering

- **Major (X.0.0)**: Breaking changes, major new features
- **Minor (0.X.0)**: New features, backwards compatible
- **Patch (0.0.X)**: Bug fixes, minor improvements

### Release Notes

Each release includes:

- **Added**: New features
- **Changed**: Changes to existing functionality
- **Deprecated**: Features to be removed in future versions
- **Removed**: Features removed in this version
- **Fixed**: Bug fixes
- **Security**: Security improvements

---

## Future Releases

### Planned for 0.2.0

- Selective sync (ignore patterns)
- Improved error messages
- Performance optimizations
- Additional conflict resolution options

### Planned for 0.3.0

- OneDrive sharing integration
- Version history support
- Enhanced mobile experience

### Planned for 1.0.0

- Stable release after community testing
- Production-ready for all platforms
- Comprehensive test coverage (>80%)
- Complete documentation

---

**Note**: This changelog is updated with each release. For the latest changes, see the [Unreleased] section above.
