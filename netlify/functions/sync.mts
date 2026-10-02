import type { Config } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { vocabItems, grammarItems, userSettings, reviewLogs } from '../../db/schema.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://synchbngrabzbngwzqwq.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_lt7eHw6-pBxAUQ0ytk-9Yg_gjCJ4xhQ';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Keep every response well under the 6 MB Functions payload limit (items may carry base64 images).
const MAX_PAGE_BYTES = 3_500_000;
const LOG_PAGE_SIZE = 5000;

async function getUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

const itemTables = { vocab: vocabItems, grammar: grammarItems } as const;
type ItemKind = keyof typeof itemTables;

const asArray = (value: unknown): any[] => (Array.isArray(value) ? value : []);

/**
 * GET /api/sync?kind=vocab|grammar&offset=N  → { items, nextOffset }
 * GET /api/sync?kind=logs&after=<ISO ts>     → { logs, nextAfter }
 * GET /api/sync?kind=settings                → { settings: { [storageKey]: rawString } }
 */
async function handleGet(userId: string, url: URL): Promise<Response> {
  const kind = url.searchParams.get('kind') || '';

  if (kind === 'vocab' || kind === 'grammar') {
    const table = itemTables[kind];
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const rows = await db.select().from(table).where(eq(table.userId, userId)).orderBy(asc(table.id));
    const items: unknown[] = [];
    let bytes = 0;
    let i = offset;
    for (; i < rows.length; i++) {
      const size = JSON.stringify(rows[i].data).length;
      if (items.length > 0 && bytes + size > MAX_PAGE_BYTES) break;
      items.push(rows[i].data);
      bytes += size;
    }
    return Response.json({ success: true, items, nextOffset: i < rows.length ? i : null });
  }

  if (kind === 'logs') {
    const after = url.searchParams.get('after') || '';
    const rows = await db
      .select()
      .from(reviewLogs)
      .where(after ? and(eq(reviewLogs.userId, userId), gt(reviewLogs.ts, after)) : eq(reviewLogs.userId, userId))
      .orderBy(asc(reviewLogs.ts))
      .limit(LOG_PAGE_SIZE);
    return Response.json({
      success: true,
      logs: rows.map((r) => r.data),
      nextAfter: rows.length === LOG_PAGE_SIZE ? rows[rows.length - 1].ts : null,
    });
  }

  if (kind === 'settings') {
    const rows = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
    const settings: Record<string, unknown> = {};
    rows.forEach((r) => {
      settings[r.key] = r.data;
    });
    return Response.json({ success: true, settings });
  }

  return Response.json({ success: false, message: 'Unknown kind' }, { status: 400 });
}

/**
 * POST /api/sync — incremental changes only:
 * { upserts: { vocab, grammar }, deletes: { vocab, grammar }, settings: { key: raw | null }, logs: ReviewLog[] }
 */
async function handlePost(userId: string, req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return Response.json({ success: false, message: 'Invalid body' }, { status: 400 });
  }

  for (const kind of Object.keys(itemTables) as ItemKind[]) {
    const table = itemTables[kind];
    // Dedupe by id: ON CONFLICT DO UPDATE can't touch the same row twice in one statement.
    const upserts = [
      ...new Map(
        asArray(body.upserts?.[kind])
          .filter((item) => item && item.id != null)
          .map((item) => [String(item.id), item] as const)
      ).values(),
    ];
    const deletes = asArray(body.deletes?.[kind]).map(String);

    if (upserts.length > 0) {
      await db
        .insert(table)
        .values(upserts.map((item) => ({ userId, id: String(item.id), data: item, updatedAt: new Date() })))
        .onConflictDoUpdate({
          target: [table.userId, table.id],
          set: { data: sql`excluded.data`, updatedAt: sql`now()` },
        });
    }
    if (deletes.length > 0) {
      await db.delete(table).where(and(eq(table.userId, userId), inArray(table.id, deletes)));
    }
  }

  if (body.settings && typeof body.settings === 'object') {
    const entries = Object.entries(body.settings as Record<string, unknown>);
    const toUpsert = entries.filter(([, v]) => v !== null && v !== undefined);
    const toDelete = entries.filter(([, v]) => v === null || v === undefined).map(([k]) => k);
    if (toUpsert.length > 0) {
      await db
        .insert(userSettings)
        .values(toUpsert.map(([key, data]) => ({ userId, key, data, updatedAt: new Date() })))
        .onConflictDoUpdate({
          target: [userSettings.userId, userSettings.key],
          set: { data: sql`excluded.data`, updatedAt: sql`now()` },
        });
    }
    if (toDelete.length > 0) {
      await db.delete(userSettings).where(and(eq(userSettings.userId, userId), inArray(userSettings.key, toDelete)));
    }
  }

  const logs = asArray(body.logs).filter((l) => l && typeof l.timestamp === 'string');
  if (logs.length > 0) {
    await db
      .insert(reviewLogs)
      .values(
        logs.map((l) => ({ userId, id: `${l.timestamp}|${l.itemType}|${l.itemId}`, ts: l.timestamp, data: l }))
      )
      .onConflictDoNothing();
  }

  return Response.json({ success: true });
}

export default async (req: Request) => {
  const userId = await getUserId(req);
  if (!userId) {
    return Response.json({ success: false, message: 'Unauthorized' }, { status: 401 });
  }

  try {
    if (req.method === 'GET') return await handleGet(userId, new URL(req.url));
    if (req.method === 'POST') return await handlePost(userId, req);
    // The old full-replace PUT is gone on purpose: a stale tab could wipe newer cloud data with it.
    if (req.method === 'PUT') {
      return Response.json({ success: false, message: 'Please reload the app to update sync.' }, { status: 410 });
    }
  } catch (err) {
    console.error('sync error', err);
    return Response.json({ success: false, message: 'Sync failed' }, { status: 500 });
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config: Config = {
  path: '/api/sync',
};
