# Database & Persistence Documentation — THE VOID

## 1. Database Engines Supported

THE VOID uses PostgreSQL as its authoritative persistence layer via `DatabaseAdapter` (`src/server/db/adapter.ts`):
1. **External PostgreSQL (`pg.Pool`)**: Used automatically whenever `DATABASE_URL` begins with `postgres://` or `postgresql://` (e.g. Docker Compose or managed cloud PostgreSQL).
2. **Embedded Persistent PostgreSQL (`@electric-sql/pglite`)**: Used when `DATABASE_URL` is unset, persisting a real PostgreSQL instance directly to disk at `PGLITE_DATA_DIR` (default `./data/pgdata`). Access is serialized through an internal async transaction mutex so concurrent requests execute ACID transactions safely.

---

## 2. Schema Definition (`src/server/db/migrations/001_initial_schema.sql`)

### `world_objects`
Stores the authoritative state of every created object (both active and tombstoned):

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `TEXT PRIMARY KEY` | UUID v4 identifier |
| `x`, `y` | `DOUBLE PRECISION NOT NULL` | Top-left world coordinates (`[-10,000,000, +10,000,000]`) |
| `width`, `height` | `INTEGER NOT NULL` | Dimensions in world units (`64..4096` width, `48..4096` height) |
| `max_x`, `max_y` | `DOUBLE PRECISION NOT NULL` | Precomputed `x + width` and `y + height` for bounding-box queries |
| `chunk_x`, `chunk_y` | `INTEGER NOT NULL` | Spatial chunk indices (`floor(x / 2048)`, `floor(y / 2048)`) |
| `rotation` | `DOUBLE PRECISION NOT NULL` | Rotation in degrees (`-360..360`) |
| `z_index` | `INTEGER NOT NULL` | Stacking order (`-10000..10000`) |
| `html`, `css`, `javascript` | `TEXT NOT NULL` | Untrusted source code |
| `revision` | `INTEGER NOT NULL` | Monotonically increasing revision number (`1..N`) |
| `deleted` | `BOOLEAN NOT NULL` | `TRUE` when deleted from the active world |
| `deleted_at` | `TIMESTAMPTZ NULL` | Timestamp of deletion |
| `created_at`, `updated_at` | `TIMESTAMPTZ NOT NULL` | Creation and last-modification timestamps |

**Indexes**:
- `idx_world_objects_active_spatial ON world_objects (deleted, x, max_x, y, max_y)`
- `idx_world_objects_chunks ON world_objects (deleted, chunk_x, chunk_y)`
- `idx_world_objects_updated_at ON world_objects (updated_at DESC)`

### `object_revisions`
Stores immutable historical snapshots for revision archaeology:

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `BIGSERIAL PRIMARY KEY` | Surrogate primary key |
| `object_id` | `TEXT NOT NULL` | Foreign key to `world_objects(id) ON DELETE CASCADE` |
| `revision` | `INTEGER NOT NULL` | Revision number (`UNIQUE (object_id, revision)`) |
| `event_type` | `TEXT NOT NULL` | `'created' \| 'updated' \| 'moved' \| 'resized' \| 'deleted'` |
| `x`, `y`, `width`, `height`, `rotation`, `z_index` | Spatial snapshot | Spatial state at this revision |
| `html`, `css`, `javascript` | `TEXT NOT NULL` | Full source snapshot at this revision |
| `html_bytes`, `css_bytes`, `js_bytes` | `INTEGER NOT NULL` | Byte lengths for fast summary listing |
| `created_at` | `TIMESTAMPTZ NOT NULL` | Timestamp of the revision |

**Index**:
- `idx_object_revisions_lookup ON object_revisions (object_id, revision DESC)`

---

## 3. Deletion & Historical Retention Policy

- **Permanent Deletion from Active World**: Deleting an object marks `deleted = TRUE` and `deleted_at = NOW()` inside a transaction and appends a final `'deleted'` revision to `object_revisions`. Deleted objects are excluded from `/api/region` and active `GET /api/objects/:id` lookups, and cannot be edited (`410 Gone`).
- **Bounded Revision Growth**: Each object retains up to `MAX_REVISIONS_PER_OBJECT` (default `100`) revisions. When an object exceeds this limit, intermediate revisions older than the window are pruned while **always preserving `revision = 1` (`created`)** and the most recent `MAX_REVISIONS_PER_OBJECT - 1` revisions.
