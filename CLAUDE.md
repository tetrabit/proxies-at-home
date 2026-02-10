# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Proxxied is an MTG proxy printing tool with a multi-component architecture:
- **React Client**: Web UI (Vite + TypeScript + TailwindCSS)
- **Express Server**: Node.js API with SQLite caching
- **Rust Microservice**: High-performance Scryfall cache (PostgreSQL/SQLite)
- **Electron Wrapper**: Desktop app bundling all components

Four deployment modes: (1) Web client-only, (2) Web + Server, (3) Web + Microservice, (4) Electron Desktop.

## CRITICAL: Use td for Task Management

**ALWAYS run `td usage --new-session` at the start of every conversation** (or after `/clear`). This tells you what to work on next.

Use `td usage -q` (quiet mode) after the first read to reduce output.

Sessions are automatic based on terminal/agent context. Optional commands:
- `td session "name"` - Label current session
- `td session --new` - Force new session in same context

## Essential Commands

### Root (Monorepo)
```bash
npm run dev                  # Run client + server concurrently
npm run build:parallel       # Build client + server + Electron TypeScript
npm run electron:dev         # Run Electron app in development
npm run electron:build       # Build Electron app for current platform
npm run electron:build:win   # Build for Windows (handles better-sqlite3)
npm run release:patch        # Patch release (1.0.0 -> 1.0.1)
npm run release:minor        # Minor release (1.0.0 -> 1.1.0)
npm run release:major        # Major release (1.0.0 -> 2.0.0)
npm run test:contract        # API contract tests against Scryfall
```

### Client (`cd client`)
```bash
npm run dev                  # Dev server (http://localhost:5173)
npm run build                # Production build
npm run build:prerender      # Build with static prerendering (Netlify)
npm test                     # Run all Vitest unit tests
npm run test:ui              # Vitest UI with coverage
npm run test:e2e             # Playwright E2E tests (all browsers)
npm run test:e2e:ui          # Playwright UI mode
npm run lint                 # ESLint

# Single test execution
npx vitest run src/store/cards.test.ts
npx playwright test tests/e2e/import.spec.ts
npx vitest run --reporter=verbose src/helpers/
```

### Server (`cd server`)
```bash
npm run dev                  # Dev server (http://localhost:3001)
npm run build                # Compile TypeScript to dist/
npm start                    # Run compiled server
npm test                     # Run all Vitest tests
npm run test:ui              # Vitest UI with coverage
npm run lint                 # ESLint

# Single test execution
npx vitest run src/routes/scryfallRouter.test.ts
```

## Architecture Deep-Dive

### Client State Management (Zustand)

Located in `client/src/store/`:
- `cards.ts` - Card collection management
- `projectStore.ts` - Multi-project workspace (tab-like isolation)
- `settings.ts` - User layout/print settings
- `selection.ts` - Multi-select, flip state
- `undoRedo.ts` - Action history with undo/redo
- `artworkModal.ts` / `cardEditorModal.ts` - Modal state
- `indexedDbStorage.ts` - Persistence layer (uses Dexie)

**Project Isolation**: Cards are always scoped to `projectId`. Never query without this filter or you'll mix projects.

### Database Architecture

**Client (Dexie/IndexedDB)** - `client/src/db.ts`:
- `cards` - Card metadata per project
- `images` - Blob cache with refCount (display + export DPI, darkened variants)
- `cardbacks` - User-uploaded cardback library (persists across clears)
- `projects` - Workspace isolation
- `userPreferences` - Last opened project, favorites

**Server (better-sqlite3)** - `server/src/db/db.ts`:
- `scryfall_cache` - API response caching (24h TTL for search, 7d for cards)
- `bulk_cards` - Bulk data imports
- `card_images` - Image caching
- `shares` - Deck sharing with expiring links

### Image Processing Pipeline

**Key file**: `client/src/helpers/imageProcessor.ts`

Generates multiple variants:
- Display (72 DPI) and Export (1200 DPI)
- Darkened modes: `darken-all`, `contrast-edges`, `contrast-full`
- Distance field calculation (JFA) for edge-aware darkening

**Web Workers** (heavy processing offloaded):
- `bleed.webgl.worker.ts` - WebGL-accelerated bleed generation
- `effect.worker.ts` - Image effects (darken, contrast)
- `pdf.worker.ts` - PDF generation
- `cardCanvasWorker.ts` - Canvas operations

**CRITICAL**: Always `URL.revokeObjectURL()` when removing images to prevent memory leaks.

### Electron Architecture

**Key files**:
- `electron/main.ts` - Electron main process
- `electron/preload.cts` - IPC bridge (security boundary)
- `electron/microservice-manager.ts` - Rust binary lifecycle management

**Microservice Bundling** (see `docs/ADR-001-bundled-microservice.md`):
- Rust binary bundled in `extraResources` directory
- Electron starts/stops microservice automatically
- Health checks every 30 seconds
- Auto-restart on crash (max 3 attempts)
- Platform detection via `process.platform`

**Native Modules**: `better-sqlite3` requires platform-specific rebuilds. Use `npm run electron:build:win` for Windows builds.

### Shared Types

Located in `shared/types.ts`:
- `CardOption` - Card instances with uuid (per-project uniqueness)
- `CardOverrides` - Per-card rendering settings (brightness, contrast, darken modes, etc.)
- `ScryfallCard` - Scryfall API response shape
- `TokenPart` - Associated tokens a card creates

Import from `@/types` (client) or `../../../shared/types` (server).

## Key Development Conventions

### Component Patterns
- **Lazy loading**: Use `lazy()` for pages (route-based code splitting in `App.tsx`)
- **Modal state**: Managed in Zustand stores, not component state
- **Drag & Drop**: `@dnd-kit` for card grid reordering (see `@dnd-kit/sortable`)
- **Virtual scrolling**: `@tanstack/react-virtual` for large galleries
- **Icons**: `lucide-react` for all icons (consistent system)

### Testing Patterns
- **Vitest**: Unit tests colocated (`*.test.ts` next to implementation)
- **Mock isolation**: Use `vi.mock()` for dependencies
- **IndexedDB mocking**: `fake-indexeddb` package for tests
- **Playwright**: E2E tests in `client/tests/e2e/` with retry logic (1-2 retries)
- **Coverage thresholds**: 80% for lines, branches, functions, statements
- **Flaky tests**: Vitest retries 5 times automatically (60s timeout for coverage)

### Card Uniqueness System
- **`uuid`**: Generated per-project instance (NOT card identity)
- Same card can have multiple uuids in one project (e.g., 4x Sol Ring)
- Use `name + set + number` for card identity, `uuid` for instance tracking

### Bleed Modes
- `mirror` - Edge pixels mirrored for bleed
- `black` - Solid black border
- Per-card override via `bleedMode` field (overrides global settings)

### Reference Counting
- `images.refCount` tracks how many cards use an image
- Garbage collection on delete (refCount reaches 0)
- Cardbacks have NO refCount (only deleted explicitly via UI)

## Critical Constraints

### CI/CD
**DO NOT** add or use GitHub Actions workflows. This project uses self-hosted tooling. Document any automation needs in `docs/DEPLOYMENT_GUIDE.md`.

### API Rate Limiting
- **Scryfall**: 100ms between requests (`scryfallRouter.ts`)
- **Never parallelize** Scryfall API calls directly
- Use `Bottleneck.js` for bulk imports

### Electron Security
- IPC communication via preload scripts ONLY
- No direct Node.js access from renderer
- Use `base: './'` in Vite config for file protocol compatibility

### Performance Optimizations
- **Code splitting**: Manual chunks in `vite.config.ts` (vendor-react, vendor-ui, vendor-db, vendor-dnd, vendor-pixi, pdf)
- **LRU cache**: Server uses `lru-cache` for hot data
- **PWA caching**: Service worker caches assets up to 5MB
- **SQLite indexes**: On frequently queried fields (name, set, number)
- **Compression**: gzip for JSON responses (NOT for SSE streams)

## Common Pitfalls

### Client
- **Blob URLs**: Always revoke when removing images (memory leaks!)
- **Project isolation**: Cards are per-project, filter by `projectId` always
- **Undo/Redo**: Mark bulk operations as non-undoable (imports, clears)
- **Canvas rendering**: Use `requestAnimationFrame` for smooth updates

### Server
- **SQLite locking**: Use transactions for bulk operations
- **SSE streams**: Don't apply compression to `text/event-stream`
- **File uploads**: Multer configured for 10MB limit

### Electron
- **Process lifecycle**: Always clean up child processes (Rust binary) on exit
- **Binary location**: Use `extraResources` path detection, not hardcoded paths
- **Native modules**: Rebuild for Electron runtime (auto-handled by electron-builder)

## File Locations Reference

### Configuration
- `vite.config.ts` - Build config with manual chunking strategy
- `playwright.config.ts` - E2E test config with retry logic
- `vitest.config.ts` - Unit test config
- `eslint.config.js` - ESLint flat config (ESM)
- `postcss.config.js` - PostCSS with TailwindCSS v4

### Key Implementation Files
- `client/src/db.ts` - Dexie schema (5 tables)
- `server/src/db/db.ts` - SQLite schema (4 tables)
- `shared/types.ts` - Cross-package types
- `electron/microservice-manager.ts` - Rust binary lifecycle
- `client/src/helpers/imageProcessor.ts` - Core image processing

### Documentation
- `docs/ADR-*.md` - Architecture Decision Records
- `docs/DEPLOYMENT_GUIDE.md` - Deployment procedures
- `.github/copilot-instructions.md` - Full development guide (detailed version of this file)

## Shared Client Dependency

The project uses a local TypeScript client in `shared/scryfall-client` via `file:` dependency. No npm registry or `.npmrc` auth required. Both client and server reference it as `@tetrabit/scryfall-cache-client`.

## PowerShell Helper (Windows)

```pwsh
./proxxied.ps1 install   # Install all dependencies
./proxxied.ps1 dev       # Run dev servers
./proxxied.ps1 build     # Build all components
```

## Version Management

- Semver with npm scripts: `npm run release:patch/minor/major`
- Two-step release: build → promote to stable channel
- Release channels: `latest` (auto-updates) and `stable` (manual promotion)
- Release script: `scripts/release.mjs`
