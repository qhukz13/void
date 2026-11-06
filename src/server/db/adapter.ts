import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import type { ServerConfig } from '../config.js';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface QueryExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
}

export interface DatabaseAdapter extends QueryExecutor {
  readonly engineType: 'pg' | 'pglite';
  withTransaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PgPoolAdapter implements DatabaseAdapter {
  public readonly engineType = 'pg' as const;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params);
    return {
      rows: res.rows as T[],
      rowCount: res.rowCount ?? res.rows.length
    };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async withTransaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txExecutor: QueryExecutor = {
        query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
          const res = await client.query(sql, params);
          return {
            rows: res.rows as R[],
            rowCount: res.rowCount ?? res.rows.length
          };
        },
        exec: async (sql: string) => {
          await client.query(sql);
        }
      };
      const result = await fn(txExecutor);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PGliteAdapter implements DatabaseAdapter {
  public readonly engineType = 'pglite' as const;
  private db: PGlite;
  private mutexPromise: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(dataDir: string) {
    if (dataDir !== 'memory://' && !dataDir.startsWith('memory://')) {
      const resolved = path.resolve(dataDir);
      fs.mkdirSync(resolved, { recursive: true });
      this.db = new PGlite(resolved);
    } else {
      this.db = new PGlite();
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.mutexPromise.then(task, task);
    this.mutexPromise = next.catch(() => {});
    return next;
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.enqueue(async () => {
      const res = await this.db.query<T>(sql, params);
      return {
        rows: res.rows,
        rowCount: res.affectedRows ?? res.rows.length
      };
    });
  }

  async exec(sql: string): Promise<void> {
    return this.enqueue(async () => {
      await this.db.exec(sql);
    });
  }

  async withTransaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      return this.db.transaction(async (tx) => {
        const txExecutor: QueryExecutor = {
          query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            const res = await tx.query<R>(sql, params);
            return {
              rows: res.rows,
              rowCount: res.affectedRows ?? res.rows.length
            };
          },
          exec: async (sql: string) => {
            await tx.exec(sql);
          }
        };
        return fn(txExecutor);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.enqueue(async () => {
      await this.db.close();
    });
  }
}

export async function createDatabaseAdapter(config: Pick<ServerConfig, 'databaseUrl' | 'pgliteDataDir'>): Promise<DatabaseAdapter> {
  if (config.databaseUrl && /^postgres(ql)?:\/\//i.test(config.databaseUrl)) {
    return new PgPoolAdapter(config.databaseUrl);
  }
  const dataDir = config.databaseUrl?.startsWith('pglite://')
    ? config.databaseUrl.slice('pglite://'.length)
    : config.pgliteDataDir;
  return new PGliteAdapter(dataDir);
}
