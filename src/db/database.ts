import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from '../config';
@Injectable()
export class Database implements OnModuleDestroy {
 readonly pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
 query<T extends QueryResultRow = any>(sql: string, values: unknown[] = []) { return this.pool.query<T>(sql, values); }
 async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await this.pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
 }
 async onModuleDestroy() { await this.pool.end(); }
}
