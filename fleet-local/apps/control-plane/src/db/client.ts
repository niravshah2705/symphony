import { readFileSync } from 'node:fs';
import pg from 'pg';
import { config } from '../config.ts';

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | undefined> {
  const res = await query<T>(text, params);
  return res.rows[0];
}

// Apply the idempotent schema on boot. schema.sql sits next to this module in
// src; the build copies it into dist (see package.json build script).
export async function migrate(): Promise<void> {
  const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

export async function close(): Promise<void> {
  await pool.end();
}