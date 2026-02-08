# Proxxied Development Guide

Proxxied is an MTG proxy printing tool with three main components: React client, Express server, and Electron wrapper.

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
```

### Client (`cd client`)
```bash
npm run dev                  # Start dev server (http://localhost:5173)
npm run build                # Production build
npm run lint                 # ESLint
npm test                     # Run all Vitest unit tests
npm run test:ui              # Vitest UI with coverage
npm run test:e2e             # Playwright end-to-end tests (all browsers)
npm run test:e2e:ui          # Playwright UI mode
```

**Single test execution:**
```bash
npx vitest run src/store/cards.test.ts           # Run specific unit test file
npx playwright test tests/e2e/import.spec.ts     # Run specific e2e test
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
```

## Architecture Overview

### Multi-Component Stack
- **Client**: React 19 + TypeScript + Vite + TailwindCSS
- **Server**: Express + better-sqlite3 (caches Scryfall API responses)
- **Electron**: Bundles both client + server into desktop app
- **Shared**: Common TypeScript types in `shared/` directory

### Three Deployment Modes
1. **Web (client only)**: Client deployed to Netlify, makes API calls directly to Scryfall
2. **Web + Server**: Client proxies API calls to `/api/*` → server handles caching
3. **Electron Desktop**: Bundles both components with embedded SQLite cache

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
- **Drag & Drop**: `@dnd-kit` for card grid reordering
- **Virtual scrolling**: `@tanstack/react-virtual` for large cardback galleries

### Testing Patterns
- **Vitest**: Unit tests colocated (`*.test.ts` next to implementation)
- **Mocking**: Use `vi.mock()` to isolate dependencies (see `cards.test.ts`)
- **IndexedDB**: Tests use `fake-indexeddb` package
- **Playwright**: E2E tests in `client/tests/e2e/` with retry logic (1-2 retries)

### Type Safety
- **Shared types**: Import from `@/types` or `../../../shared/types` depending on context
- **Zod validation**: Used for API responses and user input
- **API contracts**: Type-safe with Express Request/Response generics

### Performance Optimizations
- **Code splitting**: Manual chunks in `vite.config.ts` (vendor-react, vendor-ui, vendor-db, vendor-dnd, vendor-pixi, pdf)
- **Blob caching**: Multiple DPI variants stored to avoid reprocessing
- **SQLite indexes**: On frequently queried fields (card name, set code)
- **Compression**: gzip for JSON responses (except SSE streams)

### Error Handling
- **API failures**: axios-retry with exponential backoff
- **User feedback**: Toast notifications via `useToastStore`
- **Graceful degradation**: Fallback to direct Scryfall if server unavailable

## Deployment & Releases

### Netlify (Web Client)
- Builds from `client/` directory
- Static site generation via `react-static-prerender`
- API proxied to Scryfall (no server caching)

### Electron Desktop
- GitHub Actions workflow: `.github/workflows/release.yml`
- Release channels: `latest` (auto-updates) and `stable` (manual promotion)
- Platform builds: Windows (NSIS), macOS (DMG/ZIP), Linux (AppImage/deb)
- Native module handling: `better-sqlite3` requires platform-specific rebuilds

### Version Management
- Semver with npm scripts: `npm run release:patch/minor/major`
- Automated changelog generation from commits
- Two-step release: build → promote to stable

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

## ESLint Configuration
- Uses TypeScript ESLint with recommended rules
- React Hooks rules: `rules-of-hooks` (error), `exhaustive-deps` (warn)
- Unused vars: Warn with `_` prefix ignore pattern
- Client and server have separate configs (client adds React plugins)
