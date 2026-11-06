# THE VOID

**THE VOID is a persistent, infinite, shared, anonymous, programmable world on the internet.**

There is no landing page, no account registration, no ownership permissions, no likes, no creator profiles, and no rollback button. Opening the website drops you directly into the shared coordinate space `(0, 0)`.

Every entity in the world is an executable creation written in raw **HTML, CSS, and JavaScript**. Any visitor can create objects at arbitrary coordinates, inspect source code, modify existing creations, break working code, repair broken code, copy source into new independent objects, or delete active objects.

---

## 1. What THE VOID Is

- **The website is the world**: Visitors immediately enter a continuous 2D coordinate space (`[-10,000,000, +10,000,000]` on both axes).
- **Raw programmable matter**: Objects are built strictly from HTML, CSS, and JavaScript—no templates, no drag-and-drop site builders, no social feeds.
- **Anonymous by design**: No login, usernames, avatars, or creator attribution. Objects display only anonymous relative timestamps (`created 4 minutes ago`, `modified 18 seconds ago`) and revision numbers (`r1`, `r2`, ...).
- **Destruction is legitimate**: Any visitor can modify or delete any active object without cooldowns or ownership checks.
- **History is archaeology, not a safety net**: Every mutation is recorded in an immutable revision log (`object_revisions`). Visitors can inspect historical source code and copy it into a new independent object, but automatic restoration (`restore`/`revert`/`rollback`) is prohibited at both the UI and API levels.
- **Strict failure and security isolation**: Each object executes inside a dedicated sandboxed `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer">` with an opaque `null` origin, strict inner Content Security Policy (`connect-src 'none'`), synchronous loop instrumentation (`__voidLoopGuard`), DOM node limits (`<= 1500` nodes), and timer CPU budgets. A broken or hostile object displays a local `FAULT` banner without crashing the world, camera, editor, or other objects.

---

## 2. How to Install Dependencies

Prerequisites:
- **Node.js** `>= 22.0.0` (tested on Node `v26.8.2`)
- **pnpm** `>= 10.0.0` (or `npm`)

```bash
pnpm install
```

---

## 3. How to Configure Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Key configuration variables:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP and WebSocket server port |
| `HOST` | `0.0.0.0` | Server bind address |
| `DATABASE_URL` | *(unset)* | Optional PostgreSQL connection string (`postgresql://user:pass@host:5432/thevoid`). When unset, uses persistent on-disk PostgreSQL via PGlite at `PGLITE_DATA_DIR`. |
| `PGLITE_DATA_DIR` | `./data/pgdata` | On-disk directory for embedded persistent PostgreSQL when `DATABASE_URL` is not provided |
| `SEED_INITIAL_OBJECT` | `true` | Seeds a single initial programmable beacon at `(0, 0)` if the database is completely empty |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://localhost:5173,...` | Comma-separated list of allowed CORS & WebSocket origins (or `*`) |
| `MAX_HTML_BYTES` | `65536` | Maximum HTML byte length per object (64 KB) |
| `MAX_CSS_BYTES` | `65536` | Maximum CSS byte length per object (64 KB) |
| `MAX_JS_BYTES` | `65536` | Maximum JavaScript byte length per object (64 KB) |
| `MAX_REVISIONS_PER_OBJECT` | `100` | Maximum historical revisions retained per object (always preserves `r1` plus the latest `N-1` revisions) |
| `RATE_LIMIT_CREATES_PER_MIN` | `40` | Max object creations per minute per IP |
| `RATE_LIMIT_MUTATIONS_PER_MIN` | `120` | Max object updates per minute per IP |
| `RATE_LIMIT_DELETES_PER_MIN` | `60` | Max object deletions per minute per IP |

---

## 4. How to Start the Database & Run Migrations

THE VOID supports two real PostgreSQL execution modes using the exact same SQL schema, migrations, indexes, and transactional queries:

### Mode A: Zero-Daemon Local Persistent PostgreSQL (Default)
When `DATABASE_URL` is unset, THE VOID runs real PostgreSQL compiled to WASM (`@electric-sql/pglite`) persisted directly to `./data/pgdata`. Data survives browser refreshes and server restarts automatically.

### Mode B: External PostgreSQL / Docker Compose
Start PostgreSQL 16 via Docker Compose:

```bash
docker compose up -d postgres
export DATABASE_URL="postgresql://void_user:void_password@localhost:5432/thevoid"
```

### Apply Database Migrations Explicitly
Migrations run automatically on server startup, and can also be executed manually via CLI:

```bash
pnpm run db:migrate
```

---

## 5. How to Run the Application Locally

### Production Build & Single-Server Run (Recommended)
Compiles the React + Monaco frontend into `dist/client` and the Fastify TypeScript server into `dist/server`, then serves the entire application and WebSocket engine on `http://localhost:3000`:

```bash
pnpm run build
pnpm start
```

### Development Mode
Run the backend watcher (`tsx watch`) on port `3000` and Vite dev server with `/api` and `/ws` proxy on port `5173`:

```bash
# Terminal 1: Backend server
pnpm run dev

# Terminal 2: Vite HMR frontend
pnpm run dev:client
```

---

## 6. How to Run Tests

THE VOID includes unit tests, database & persistence integration tests, multi-client realtime & 10-step scenario tests, security & abuse tests, end-to-end multi-browser Playwright tests, and a multi-stage load test script:

```bash
# Run all unit, integration, 10-step scenario, and security tests (Vitest)
pnpm test

# Run specific Vitest suites
pnpm run test:unit
pnpm run test:integration
pnpm run test:security

# Run real multi-browser End-to-End tests (Playwright Chromium)
pnpm run test:e2e

# Run progressive load & reliability test (10, 50, and 100 concurrent clients)
pnpm run test:load
```

---

## 7. How the Architecture Works

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full details.

- **Shared Protocol (`src/shared/`)**: Coordinate math, chunk calculations (`CHUNK_SIZE = 2048`), deep-link parser (`?x=1200&y=-850&zoom=1.2&object=<id>`), JavaScript loop instrumentation, and TypeScript WebSocket/REST protocol definitions.
- **Backend (`src/server/`)**: Fastify v5 HTTP + WebSocket server (`@fastify/websocket`, `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`), `ObjectRepository` with MVCC transactions (`SELECT ... FOR UPDATE`), spatial bounding-box queries, and `RealtimeHub` for viewport-scoped event broadcasting.
- **Frontend (`src/client/`)**: React 19 spatial viewport engine with virtualized object rendering, sandbox lifecycle prioritization (`MAX_ACTIVE_SANDBOXES = 36`), Monaco Editor + direct source buffer, and revision archaeology inspector.

---

## 8. How Sandbox Isolation Works

See [docs/SECURITY_AND_SANDBOX.md](docs/SECURITY_AND_SANDBOX.md) for the complete threat model and implementation details.

1. **Opaque Origin Boundary**: Every object renders inside `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="...">`. Because `allow-same-origin` is omitted, the iframe runs in a unique opaque origin (`window.origin === "null"`) and cannot access `window.parent.document`, parent storage, cookies, or sibling iframes.
2. **Strict Inner CSP**: Each sandbox injects `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';">`, blocking outbound network requests (`fetch`, `XMLHttpRequest`, `WebSocket`, external images/scripts) and preventing SSRF or private-network probing.
3. **Synchronous Loop & CPU Guard**: Before user JavaScript runs, `instrumentUserJavaScript` injects `__voidLoopGuard()` into `while`, `for`, and `do...while` loops. Loops exceeding `250ms` or `250,000` iterations throw a `RangeError` and report a local `timeout_error` diagnostic without freezing the browser tab.
4. **DOM & Timer Guards**: `Node.prototype.appendChild` / `insertBefore` / `append` enforce a maximum of `1,500` DOM elements per object. `setTimeout`, `setInterval`, and `requestAnimationFrame` are wrapped to cap concurrent timers (`32`) and cumulative timer CPU time (`350ms/sec`).

---

## 9. How Realtime Synchronization Works

- Clients connect to `/ws` and send `SUBSCRIBE_VIEWPORT` containing their current world bounding box (`minX`, `minY`, `maxX`, `maxY`).
- When any visitor creates, edits, moves, resizes, or deletes an object, the server commits the mutation and new revision inside a PostgreSQL transaction, then broadcasts `OBJECT_CREATED`, `OBJECT_UPDATED`, `OBJECT_MOVED`, `OBJECT_RESIZED`, `OBJECT_DELETED`, and `REVISION_CREATED` **only** to clients whose subscribed viewport intersects the object's previous or new coordinates (or who are inspecting that object).
- Concurrent edits use deterministic server-authoritative last-write-wins serialized via row-level locking (`FOR UPDATE`) with monotonically increasing revision numbers (`r1`, `r2`, ...), preserving every overwritten state in `object_revisions`.
- On disconnect, `VoidApiClient` automatically reconnects with exponential backoff and re-subscribes the active viewport to resynchronize with authoritative server state.

---

## 10. How to Deploy the Application

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for complete deployment instructions.

```bash
# Deploy full stack (PostgreSQL 16 + THE VOID server) with Docker Compose:
docker compose up -d --build
```

---

## 11. Known Limitations

- **Single-Thread Browser Sharing**: Sandboxed iframes without a separate physical domain share the browser's renderer process group in some browsers unless Origin-Agent-Cluster / cross-origin subdomain isolation is used. Our synchronous loop instrumenter (`__voidLoopGuard`), timer CPU budget, and DOM node cap mitigate synchronous `while(true){}` and timer floods, while a truly adversarial native browser layout bomb (e.g., deeply nested CSS grid recalculations) is bounded by the `1,500` DOM node limit and viewport sandbox cap (`MAX_ACTIVE_SANDBOXES = 36`).
- **Single-Node WebSocket Hub**: `RealtimeHub` manages WebSocket subscriptions in process memory. Scaling horizontally to multiple backend replicas requires placing a Redis pub/sub adapter behind `RealtimeHub` and using an external PostgreSQL instance via `DATABASE_URL`.
- **Unload Semantics**: Objects outside the active viewport (or beyond the 36 nearest active sandboxes) enter a dormant wireframe state and pause execution until brought back into view.
