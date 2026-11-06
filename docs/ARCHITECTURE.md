# Architecture Documentation — THE VOID

## 1. System Overview

THE VOID is structured as a single cohesive full-stack TypeScript application with three layers:

```text
src/
├── shared/                 # Isomorphic protocol types, spatial math, sandbox builder
│   ├── constants.ts        # Coordinate limits, chunk size, sandbox budgets
│   ├── types.ts            # Domain models, REST payloads, WebSocket message union
│   ├── spatial.ts          # Screen<->World transforms, zoom focal math, deep links
│   └── sandbox-builder.ts  # JS loop instrumenter & CSP srcdoc generator
├── server/                 # Fastify v5 + WebSocket + PostgreSQL backend
│   ├── config.ts           # Environment configuration & resource limits
│   ├── app.ts              # Fastify server factory, Helmet CSP, CORS, WS wiring
│   ├── index.ts            # Production entrypoint & graceful shutdown
│   ├── db/
│   │   ├── adapter.ts      # Unified PostgreSQL adapter (pg.Pool + persistent PGlite)
│   │   ├── migrations.ts   # Transactional SQL schema migration runner
│   │   ├── migrate-cli.ts  # CLI migration entrypoint
│   │   └── migrations/001_initial_schema.sql
│   ├── services/
│   │   └── object-repository.ts # Authoritative CRUD, spatial queries, revision pruning
│   ├── security/
│   │   └── rate-limiter.ts # Per-IP sliding-window rate limits, origin & proto guards
│   ├── routes/
│   │   └── api.ts          # REST endpoints (/api/health, /api/region, /api/objects/*)
│   └── ws/
│       └── realtime-hub.ts # Viewport-scoped WebSocket subscription & broadcast engine
└── client/                 # React 19 + Monaco spatial world frontend
    ├── App.tsx             # Infinite canvas, camera controller, HUD, deep-link sync
    ├── styles.css          # Dark brutalist instrument styling
    ├── services/
    │   └── void-client.ts  # Auto-reconnecting WebSocket + REST client
    └── components/
        ├── WorldObjectCard.tsx   # Draggable, resizable world frame & fault display
        ├── SandboxFrame.tsx      # Sandboxed iframe lifecycle & postMessage bridge
        ├── InspectorPanel.tsx    # Code tabs, spatial fields, & revision archaeology
        └── CodeEditorSurface.tsx # Local Monaco Editor + synchronized raw buffer
```

## 2. Spatial Coordinate Model & Virtualization

- **Coordinate Space**: Continuous 2D Cartesian plane bounded at `[-10,000,000, +10,000,000]` on both X and Y axes. Coordinates are stored as `DOUBLE PRECISION` in PostgreSQL and rounded to `0.01` precision to prevent IEEE-754 floating-point drift at large coordinates.
- **Camera Transform**: The camera tracks the world coordinate `(camera.x, camera.y)` at the center of the viewport and a scale factor `camera.zoom` (`0.08x` to `4.0x`).
  - `worldToScreen(wx, wy)`: `screenX = viewportWidth / 2 + (wx - camera.x) * zoom`
  - `screenToWorld(sx, sy)`: `worldX = camera.x + (sx - viewportWidth / 2) / zoom`
- **Chunk Indexing**: Each object stores precomputed `max_x = x + width`, `max_y = y + height`, `chunk_x = floor(x / 2048)`, and `chunk_y = floor(y / 2048)`.
- **Viewport Eviction & Sandbox Lifecycle**:
  - As a visitor pans or zooms, the client debounces `SUBSCRIBE_VIEWPORT` and `GET /api/region` for the visible bounding box expanded by a `50%` preload margin.
  - Objects further than `2.5x` viewport radii away are evicted from client state (unless currently selected in the inspector) to bound browser memory.
  - Only the nearest `36` visible objects (`MAX_ACTIVE_SANDBOXES`) when `zoom >= 0.18` mount live executing `<iframe sandbox="allow-scripts">` instances. Additional or zoomed-out objects render lightweight dormant wireframes.

## 3. Concurrency & Realtime Protocol

- **Authoritative Persistence**: Every mutation (`POST /api/objects`, `PATCH /api/objects/:id`, `DELETE /api/objects/:id`, or equivalent WebSocket mutation commands) executes inside a database transaction (`BEGIN ... COMMIT`).
- **Deterministic Conflict Resolution**: Updates acquire a row lock (`SELECT * FROM world_objects WHERE id = $1 FOR UPDATE`), increment `revision = revision + 1`, and append an immutable snapshot to `object_revisions`. Concurrent edits follow deterministic server-order last-write-wins; no edit is lost from history because every intermediate revision is persisted in `object_revisions`.
- **Deletion Tombstones**: Deleting an object sets `deleted = TRUE, deleted_at = NOW()`, increments `revision`, and writes a final `'deleted'` revision entry. Deleted objects never appear in `/api/region` or active queries and return `410 Gone` if an update is attempted.
