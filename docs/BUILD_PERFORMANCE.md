# Build Performance Documentation

This document records build timing measurements for the MTG Proxy Builder project.

## Build Timing Summary

All timings measured on: $(uname -a)
Date: $(date)

### Component Build Times (Clean Build)

| Component | Time (real) | Notes |
|-----------|-------------|-------|
| Client | ~34s | Vite build with PWA generation |
| Server | ~4s | TypeScript compilation |
| Electron | ~11s | TypeScript compilation |
| **Total Sequential** | ~49s | Sum of all components |

### Client Build
- **Time**: 33.732s (real), 40.684s (user), 11.114s (sys)
- **Tool**: Vite 7.3.0
- **Output**: ~2.7 MB precache (31 entries)
- **Command**: `npm run build --prefix client`

### Server Build  
- **Time**: 4.059s (real), 5.663s (user), 0.785s (sys)
- **Tool**: TypeScript compiler (tsc)
- **Command**: `npm run build --prefix server`
- **Note**: Requires clean .tsbuildinfo cache for consistent results

### Electron Build
- **Time**: 10.804s (real), 8.160s (user), 2.820s (sys)
- **Tool**: TypeScript compiler (tsc)
- **Command**: `npm run build:electron:ts`

## Recommended Build Commands

### Development
```bash
# Run all services in dev mode with hot reload
npm run dev
```

### Production Build
```bash
# Build all components in parallel (recommended)
npm run build:parallel

# Or build individually:
npm run build:client
npm run build:server  
npm run build:electron:ts
```

### Clean Build
```bash
# If experiencing build cache issues:
cd server && rm -rf .tsbuildinfo dist && cd ..
npm run build:parallel
```

## Build Optimization Notes

### Current Optimizations
1. **Incremental compilation** enabled for TypeScript (tsBuildInfoFile)
2. **Code splitting** in Vite for client bundle
3. **Tree shaking** and minification in production
4. **Parallel builds** via concurrently for independent components

### Potential Future Optimizations
- **SWC/esbuild**: Could replace tsc for faster transpilation
- **Turbopack**: Alternative to Vite for faster bundling
- **Build caching**: Implement persistent caching for CI/CD

## Troubleshooting

### Server Build Failing with "No such file or directory"
**Symptom**: `cp: cannot create directory 'dist/server/': No such file or directory`

**Cause**: Stale incremental build cache preventing TypeScript emission

**Solution**:
```bash
cd server
rm -rf .tsbuildinfo dist
npm run build
```

### Inconsistent Build Times
- First build after cache clear will be slower
- Subsequent incremental builds should be faster
- Warm vs cold builds can vary by 2-3x

## Local Development Recommendations
- Use `npm run dev` for development (hot reload)
- Only run full production builds when testing deployment
- Clean builds recommended after major dependency updates
