# Development

## Prerequisites

- Node.js 18+ (recommend 20.x)
- npm
- Obsidian (for testing)

## Setup

```bash
git clone https://github.com/JeffSteinbok/obsidian-onedrive.git
cd obsidian-onedrive
npm install
```

## Commands

```bash
npm run dev          # Development build (watch mode)
npm run build        # Production build
npm test             # Run tests
npm run test:watch   # Tests in watch mode
npm run test:coverage # Coverage report
npm run lint         # Linter
npm run format       # Format code
```

## Project Structure

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

## Guidelines

- Follow existing code style (`npm run format`)
- Write tests for new features
- Update documentation as needed
- Use conventional commit messages
