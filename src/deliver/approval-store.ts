import type Database from 'better-sqlite3';

const DEFAULT_TTL_HOURS = 6;

export function statusOf(db: Database.Database, draftId: number): string | null {
  const r = db.prepare('SELECT status FROM drafts WHERE id = ?').get(draftId) as
    | { status: string }
    | undefined;
  return r?.status ?? null;
}

export function pendingDraftIds(db: Database.Database): number[] {
  const rows = db
    .prepare(`SELECT id FROM drafts WHERE status = 'pending' ORDER BY id ASC`)
    .all() as { id: number }[];
  return rows.map((r) => r.id);
}

export function expireStale(
  db: Database.Database,
  now: Date,
  ttlHours = DEFAULT_TTL_HOURS,
): number[] {
  const cutoff = now.getTime() - ttlHours * 3600_000;
  const pending = db
    .prepare(`SELECT id, created_at FROM drafts WHERE status = 'pending'`)
    .all() as {
    id: number;
    created_at: string;
  }[];
  const stale = pending.filter((d) => {
    const t = Date.parse(d.created_at);
    return Number.isFinite(t) && t < cutoff;
  });
  const update = db.prepare(
    `UPDATE drafts SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'`,
  );
  const expired: number[] = [];
  db.transaction(() => {
    for (const d of stale) {
      if (update.run(now.toISOString(), d.id).changes === 1) expired.push(d.id);
    }
  })();
  return expired;
}

export function resolve(
  db: Database.Database,
  now: Date,
  draftId: number,
  status: 'approved' | 'rejected',
  reason: string | null,
): boolean {
  const info = db
    .prepare(
      `UPDATE drafts SET status = ?, reject_reason = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
    )
    .run(status, reason, now.toISOString(), draftId);
  return info.changes === 1;
}

export function revertToPending(db: Database.Database, draftId: number): boolean {
  const info = db
    .prepare(
      `UPDATE drafts SET status = 'pending', resolved_at = NULL WHERE id = ? AND status = 'approved'`,
    )
    .run(draftId);
  return info.changes === 1;
}
