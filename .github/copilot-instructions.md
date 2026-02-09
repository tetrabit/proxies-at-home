# Proxxied Development Guide

## MANDATORY: Use td for Task Management

Run td usage --new-session at conversation start (or after /clear). This tells you what to work on next.

Sessions are automatic (based on terminal/agent context). Optional:
- td session "name" to label the current session
- td session --new to force a new session in the same context

Use td usage -q after first read.

Proxxied is an MTG proxy printing tool with four main components: React client, Express server, Rust microservice (Scryfall cache), and Electron wrapper.

## Build, Test, and Lint Commands

### Root (Monorepo)
```bash
npm run dev                  # Run both client + server in development
npm run electron:dev         # Run Electron app in development
npm run electron:build       # Build Electron app for current platform
npm run electron:build:win   # Build for Windows (handles better-sqlite3 native deps)
npm run release              # Create a new release (prompts for version bump)
npm run release:patch        # Patch release (1.0.0 -> 1.0.1)
npm run release:minor        # Minor release (1.0.0 -> 1.1.0)
npm run release:major        # Major release (1.0.0 -> 2.0.0)
npm run release:promote      # Promote latest to stable channel
npm run release:dry          # Test release script without making changes
npm run test:contract        # Run API contract tests against Scryfall
```

### Client (`cd client`)
```bash
npm run dev                  # Start dev server (http://localhost:5173)
npm run build                # Production build
npm run build:prerender      # Build with static prerendering for Netlify
npm run lint                 # ESLint
npm test                     # Run all Vitest unit tests
npm run test:ui              # Vitest UI with coverage
npm run test:e2e             # Playwright end-to-end tests (all browsers)
npm run test:e2e:ui          # Playwright UI mode
npm run preview              # Preview production build locally
```

**Single test execution:**
```bash
npx vitest run src/store/cards.test.ts           # Run specific unit test file
npx playwright test tests/e2e/import.spec.ts     # Run specific e2e test
npx vitest run --reporter=verbose src/helpers/   # Run all tests in a directory
```

### Server (`cd server`)
```bash
npm run dev                  # Start dev server (http://localhost:3001)
npm run build                # Compile TypeScript to dist/
npm start                    # Run compiled server
npm run lint                 # ESLint
npm test                     # Run all Vitest tests
npm run test:ui              # Vitest UI with coverage
```

**Single test execution:**
```bash
npx vitest run src/routes/scryfallRouter.test.ts
npx vitest run --reporter=verbose src/routes/    # Run all router tests
```

## Architecture Overview

### Multi-Component Stack
- **Client**: React 19 + TypeScript + Vite + TailwindCSS + Flowbite
- **Server**: Express + better-sqlite3 (caches Scryfall API responses)
- **Microservice**: Rust binary (Scryfall cache, optional, see ADR-001)
- **Electron**: Bundles client + server + Rust microservice into desktop app
- **Shared**: Common TypeScript types in `shared/` directory

### Four Deployment Modes
1. **Web (client only)**: Client deployed to Netlify, makes API calls directly to Scryfall
2. **Web + Server**: Client proxies API calls to `/api/*` → server handles caching
3. **Web + Microservice**: Client → Rust microservice (future architecture)
4. **Electron Desktop**: Bundles all components with embedded SQLite/PostgreSQL cache

### Directory Structure
```
proxies-at-home/
├── client/              # React frontend (Vite + TypeScript)
│   ├── src/
│   │   ├── components/  # React components
│   │   ├── helpers/     # Utilities, APIs, workers
│   │   ├── pages/       # Route pages (lazy-loaded)
│   │   ├── store/       # Zustand state management
│   │   └── db.ts        # Dexie (IndexedDB) schema
│   ├── tests/e2e/       # Playwright tests
│   └── public/          # Static assets
├── server/              # Express backend (Node.js)
│   ├── src/
│   │   ├── routes/      # API routes
│   │   ├── db/          # SQLite database
│   │   └── index.ts     # Server entry point
│   └── cardbacks/       # User-uploaded cardbacks
├── electron/            # Electron wrapper
│   ├── main.ts          # Electron main process
│   ├── preload.cts      # Preload script (IPC)
│   └── microservice-manager.ts  # Manages Rust binary lifecycle
├── shared/              # Shared TypeScript types
├── scripts/             # Build & release scripts
├── docs/                # Architecture Decision Records (ADRs)
└── test-app/            # Standalone Scryfall query tester
```

### Client Architecture

**State Management (Zustand stores in `client/src/store/`):**
- `cards.ts` - Card collection management
- `projectStore.ts` - Multi-project workspace (like tabs)
- `settings.ts` - User layout/print settings
- `selection.ts` - Multi-select, flip state
- `undoRedo.ts` - Action history with undo/redo
- `artworkModal.ts` / `cardEditorModal.ts` - Modal state
- `indexedDbStorage.ts` - Persistence layer (uses Dexie)

**Database (Dexie/IndexedDB in `client/src/db.ts`):**
- `cards` table: Card metadata per project
- `images` table: Blob cache (display + export DPI, darkened variants)
- `cardbacks` table: User-uploaded cardback library
- `projects` table: Workspace isolation (each project has its own cards)
- `userPreferences` table: Last opened project, favorite cardbacks

**Image Processing Pipeline:**
- `client/src/helpers/imageProcessor.ts` - Canvas-based bleed generation, DPI scaling
- Generates multiple variants: display (72dpi), export (1200dpi), darkened modes
- Distance field calculation (JFA) for edge-aware darkening
- **Web Workers**: Heavy processing runs in workers (see `*.worker.ts` files)
  - `bleed.webgl.worker.ts` - WebGL-accelerated bleed generation
  - `effect.worker.ts` - Image effects (darken, contrast)
  - `pdf.worker.ts` - PDF generation offloaded to worker
  - `cardCanvasWorker.ts` - Canvas operations in worker thread

**Key Conventions:**
- Card uniqueness: `uuid` field (generated per-project instance, not card identity)
- Bleed modes: `mirror` (edge pixels) vs `black` (solid border)
- Reference counting: `images.refCount` tracks card usage (garbage collection on delete)
- Blob URLs: Always revoke with `URL.revokeObjectURL()` to prevent memory leaks

### Server Architecture

**Routes (`server/src/routes/`):**
- `scryfallRouter.ts` - Card search, autocomplete, named card lookups
- `imageRouter.ts` - Image fetching with caching
- `mpcAutofillRouter.ts` - MPC Fill integration
- `archidektRouter.ts` / `moxfieldRouter.ts` - Decklist imports
- `shareRouter.ts` - Deck sharing with expiring links
- `streamRouter.ts` - Server-Sent Events for real-time progress

**Database (`server/src/db/db.ts`):**
- `better-sqlite3` for caching Scryfall API responses
- Tables: `scryfall_cache`, `bulk_cards`, `card_images`, `shares`
- Cache TTLs: 24 hours (search), 7 days (card data)

**API Rate Limiting:**
- Scryfall: 100ms between requests (`scryfallRouter.ts`)
- Bottleneck.js for bulk data imports

## Key Development Conventions

### Component Patterns
- **Lazy loading**: Use `lazy()` for pages to split bundles (`App.tsx`)
- **Modal state**: Managed in Zustand stores, not component state
- **Drag & Drop**: `@dnd-kit` for card grid reordering (sortable, modifiers)
- **Virtual scrolling**: `@tanstack/react-virtual` for large cardback galleries
- **Animations**: `@react-spring/web` for smooth transitions
- **Gestures**: `@use-gesture/react` for pinch-zoom, drag interactions
- **Icons**: `lucide-react` for consistent icon system

### Testing Patterns
- **Vitest**: Unit tests colocated (`*.test.ts` next to implementation)
- **Mocking**: Use `vi.mock()` to isolate dependencies (see `cards.test.ts`)
- **IndexedDB**: Tests use `fake-indexeddb` package
- **Playwright**: E2E tests in `client/tests/e2e/` with retry logic (1-2 retries)
- **Test Isolation**: Each test should be independent, no shared state
- **Coverage thresholds**: 80% for lines, branches, functions, statements (client only)
- **Retry logic**: Vitest retries 5 times for flaky tests (60s timeout for coverage runs)

### Type Safety
- **Shared types**: Import from `@/types` or `../../../shared/types` depending on context
- **Zod validation**: Used for API responses and user input
- **API contracts**: Type-safe with Express Request/Response generics

### Performance Optimizations
- **Code splitting**: Manual chunks in `vite.config.ts` (vendor-react, vendor-ui, vendor-db, vendor-dnd, vendor-pixi, pdf)
- **Blob caching**: Multiple DPI variants stored to avoid reprocessing
- **SQLite indexes**: On frequently queried fields (card name, set code)
- **Compression**: gzip for JSON responses (except SSE streams)
- **Web Workers**: Offload heavy processing (image processing, PDF generation)
- **PWA caching**: Service worker caches assets up to 5MB (see `vite.config.ts`)
- **LRU cache**: Server uses `lru-cache` for hot data in memory

### Error Handling
- **API failures**: axios-retry with exponential backoff
- **User feedback**: Toast notifications via `useToastStore`
- **Graceful degradation**: Fallback to direct Scryfall if server unavailable

## Deployment & Releases

### Netlify (Web Client)
- Builds from `client/` directory
- Static site generation via `react-static-prerender`
- API proxied to Scryfall (no server caching)
- Environment: Production build with base URL rewriting

### Electron Desktop
- GitHub Actions workflow: `.github/workflows/release.yml`
- Release channels: `latest` (auto-updates) and `stable` (manual promotion)
- Platform builds: Windows (NSIS), macOS (DMG/ZIP), Linux (AppImage/deb)
- Native module handling: `better-sqlite3` requires platform-specific rebuilds
- **Rust microservice**: Bundled via `scripts/build-microservice.sh` (see ADR-001)
- **Lifecycle management**: Electron starts/stops Rust binary via `microservice-manager.ts`

### Version Management
- Semver with npm scripts: `npm run release:patch/minor/major`
- Automated changelog generation from commits
- Two-step release: build → promote to stable
- Release script: `scripts/release.mjs` handles versioning, tagging, publishing

### CI/CD
- GitHub Actions handles automated builds and releases
- Contract tests run against live Scryfall API (`npm run test:contract`)

## Common Pitfalls

### Client
- **Blob URLs**: Always `URL.revokeObjectURL()` when removing images
- **Project isolation**: Cards are per-project, don't query without `projectId` filter
- **Undo/Redo**: Mark actions as non-undoable (e.g., bulk imports, clears)
- **Canvas rendering**: Use `requestAnimationFrame` for smooth updates

### Server
- **SQLite locking**: Use transactions for bulk operations
- **Rate limiting**: Don't parallelize Scryfall requests
- **SSE streams**: Don't apply compression to `text/event-stream`
- **File uploads**: Multer configured for 10MB limit

### Electron
- **File protocol**: Use `base: './'` in Vite config for relative paths
- **Native modules**: Rebuild for Electron runtime (`electron-builder` handles this)
- **Security**: IPC communication via preload scripts only
- **Microservice binary**: Must be in `extraResources` for bundling
- **Process lifecycle**: Always clean up child processes (Rust binary) on exit
- **Platform detection**: Use `process.platform` to locate correct binary

## Code Quality & Tooling

### ESLint Configuration
- Uses TypeScript ESLint with recommended rules
- React Hooks rules: `rules-of-hooks` (error), `exhaustive-deps` (warn)
- Unused vars: Warn with `_` prefix ignore pattern
- Client and server have separate configs (client adds React plugins)
- Flat config format (ESM): `eslint.config.js`

### Formatting & Linting
- Prettier configured with `.prettierrc` and `.prettierignore`
- TailwindCSS v4 with Vite plugin (`@tailwindcss/vite`)
- PostCSS config at root: `postcss.config.js`

### Development Tools
- **PowerShell script**: `proxxied.ps1` for Windows users (install, dev, build)
- **Test app**: Standalone Scryfall query tester in `test-app/` directory
- **Git hooks**: Custom hooks in `.githooks/` directory

## Important Files & Patterns

### Configuration Files
- `vite.config.ts` - Vite build config with manual chunking strategy
- `playwright.config.ts` - E2E test configuration with retry logic
- `vitest.config.ts` - Unit test configuration (merged with vite config in client)
- `tsconfig.json` - TypeScript configuration (separate for client/server/electron)

### Documentation
- `docs/ADR-*.md` - Architecture Decision Records
- `ARCHITECTURE_SUMMARY.md` - High-level overview
- `*_COMPLETE.md` - Phase completion summaries
- `*_PLAN.md` - Migration and optimization plans

### Key Implementation Files
- `client/src/db.ts` - Dexie schema (5 tables: cards, images, cardbacks, projects, userPreferences)
- `server/src/db/db.ts` - SQLite schema (4 tables: scryfall_cache, bulk_cards, card_images, shares)
- `shared/types.ts` - Cross-package type definitions
- `electron/microservice-manager.ts` - Rust binary lifecycle management
