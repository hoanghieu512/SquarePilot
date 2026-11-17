import type Database from 'better-sqlite3';
import { REJECT_REASONS } from '../deliver/zalo-approver.js';

export type DraftOutcome =
  | 'published'
  | 'uncertain'
  | 'rejected'
  | 'expired'
  | 'withdrawn'
  | 'pending';

export interface ApprovalTotals {
  written: number;
  offered: number;
  published: number;
  rejected: number;
  expired: number;
  withdrawn: number;
  uncertain: number;
  pending: number;
  rate: number | null;
}

export interface ApprovalRateRow {
  key: string;
  offered: number;
  published: number;
  rejected: number;
  rate: number | null;
}

export interface LensUsageRow {
  lens: string;
  chosen: number;
  offered: number;
  published: number;
}

export interface RejectReasonRow {
  reason: string;
  count: number;
}

export interface ApprovalCost {
  total: number;
  perPublished: number | null;
}

export interface ApprovalStats {
  totals: ApprovalTotals;
  byModel: ApprovalRateRow[];
  bySource: ApprovalRateRow[];
  byLens: LensUsageRow[];
  rejectReasons: RejectReasonRow[];
  cost: ApprovalCost;
}

export interface ApprovalStatsOptions {
  /** ISO timestamp or YYYY-MM-DD filter: drafts.created_at >= since. */
  since?: string;
}

const WITHDRAWN_REASONS = new Set<string>([
  'session-ended',
  'not-sent',
  'dry-run',
  'no-visual',
  'gates-failed',
]);

const REASON_LABELS = new Map<string, string>([
  ...REJECT_REASONS.map((r) => [r.code, r.label] as const),
  ['rewrite-requested', 'Rewrite requested'],
]);

interface DraftStatsRow {
  id: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  reject_reason: string | null;
  model_used: string;
  outcome: string;
  source_ref: string | null;
  offered: number;
  has_post: number;
  call_model: string | null;
  cost_usd: number;
}

function classifyOutcome(row: DraftStatsRow): DraftOutcome {
  if (row.has_post === 1) return 'published';
  if (row.status === 'approved') return 'uncertain';
  if (row.status === 'rejected') {
    // The owner's reasons (OWNER_REJECT_CODES) and any unknown reason count
    // as a rejection; the pipeline's own withdrawals do not.
    return row.reject_reason !== null && WITHDRAWN_REASONS.has(row.reject_reason) ? 'withdrawn' : 'rejected';
  }
  if (row.status === 'expired') return 'expired';
  return 'pending';
}

function approvalRate(published: number, rejected: number): number | null {
  const decided = published + rejected;
  return decided > 0 ? published / decided : null;
}

function compareAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function computeApprovalStats(
  db: Database.Database,
  opts: ApprovalStatsOptions = {},
): ApprovalStats {
  const since = opts.since;
  const whereClause = since !== undefined ? 'WHERE d.created_at >= ?' : '';
  const params = since !== undefined ? [since] : [];

  const drafts = db
    .prepare(
      `SELECT
         d.id,
         d.status,
         d.reject_reason,
         d.model_used,
         s.outcome,
         s.source_ref,
         CASE WHEN EXISTS (
           SELECT 1 FROM visuals v WHERE v.draft_id = d.id AND v.offered_at IS NOT NULL
         ) THEN 1 ELSE 0 END AS offered,
         CASE WHEN EXISTS (
           SELECT 1 FROM posts p WHERE p.draft_id = d.id
         ) THEN 1 ELSE 0 END AS has_post,
         (
           SELECT l.model
           FROM llm_calls l
           WHERE l.draft_id = d.id AND l.purpose = 'draft' AND l.ok = 1
           ORDER BY l.id DESC
           LIMIT 1
         ) AS call_model,
         COALESCE((
           SELECT SUM(l.cost_usd)
           FROM llm_calls l
           WHERE l.draft_id = d.id
         ), 0) AS cost_usd
       FROM drafts d
       JOIN selections s ON s.id = d.selection_id
       ${whereClause}
       ORDER BY d.id ASC`,
    )
    .all(...params) as DraftStatsRow[];

  const totals: ApprovalTotals = {
    written: drafts.length,
    offered: 0,
    published: 0,
    rejected: 0,
    expired: 0,
    withdrawn: 0,
    uncertain: 0,
    pending: 0,
    rate: null,
  };

  const modelMap = new Map<string, { offered: number; published: number; rejected: number }>();
  const sourceMap = new Map<string, { offered: number; published: number; rejected: number }>();
  const lensMap = new Map<string, { chosen: number; offered: number; published: number }>();
  const reasonMap = new Map<string, number>();

  let totalCost = 0;

  for (const row of drafts) {
    totalCost += row.cost_usd;

    if (row.offered !== 1) continue;

    totals.offered += 1;
    const outcome = classifyOutcome(row);
    totals[outcome] += 1;

    const modelKey = row.call_model ?? row.model_used;
    const modelAcc = modelMap.get(modelKey) ?? { offered: 0, published: 0, rejected: 0 };
    modelAcc.offered += 1;
    if (outcome === 'published') modelAcc.published += 1;
    if (outcome === 'rejected') modelAcc.rejected += 1;
    modelMap.set(modelKey, modelAcc);

    const sourceKey = row.outcome;
    const sourceAcc = sourceMap.get(sourceKey) ?? { offered: 0, published: 0, rejected: 0 };
    sourceAcc.offered += 1;
    if (outcome === 'published') sourceAcc.published += 1;
    if (outcome === 'rejected') sourceAcc.rejected += 1;
    sourceMap.set(sourceKey, sourceAcc);

    if (row.outcome === 'lens' && row.source_ref) {
      const lensAcc = lensMap.get(row.source_ref) ?? { chosen: 0, offered: 0, published: 0 };
      lensAcc.offered += 1;
      if (outcome === 'published') lensAcc.published += 1;
      lensMap.set(row.source_ref, lensAcc);
    }

    if (outcome === 'rejected' && row.reject_reason !== null) {
      reasonMap.set(row.reject_reason, (reasonMap.get(row.reject_reason) ?? 0) + 1);
    }
  }

  totals.rate = approvalRate(totals.published, totals.rejected);

  const lensSelections = (
    since !== undefined
      ? db
          .prepare(
            `SELECT s.source_ref AS lens, COUNT(*) AS chosen
             FROM selections s
             WHERE s.outcome = 'lens'
               AND s.source_ref IS NOT NULL
               AND (
                 EXISTS (SELECT 1 FROM drafts d WHERE d.selection_id = s.id AND d.created_at >= ?)
                 OR (
                   NOT EXISTS (SELECT 1 FROM drafts d WHERE d.selection_id = s.id)
                   AND s.created_at >= ?
                 )
               )
             GROUP BY s.source_ref`,
          )
          .all(since, since)
      : db
          .prepare(
            `SELECT s.source_ref AS lens, COUNT(*) AS chosen
             FROM selections s
             WHERE s.outcome = 'lens' AND s.source_ref IS NOT NULL
             GROUP BY s.source_ref`,
          )
          .all()
  ) as { lens: string; chosen: number }[];

  for (const sel of lensSelections) {
    const acc = lensMap.get(sel.lens) ?? { chosen: 0, offered: 0, published: 0 };
    acc.chosen = sel.chosen;
    lensMap.set(sel.lens, acc);
  }

  const byModel: ApprovalRateRow[] = [...modelMap.entries()]
    .map(([key, v]) => ({
      key,
      offered: v.offered,
      published: v.published,
      rejected: v.rejected,
      rate: approvalRate(v.published, v.rejected),
    }))
    .sort((a, b) => b.offered - a.offered || compareAsc(a.key, b.key));

  const bySource: ApprovalRateRow[] = [...sourceMap.entries()]
    .map(([key, v]) => ({
      key,
      offered: v.offered,
      published: v.published,
      rejected: v.rejected,
      rate: approvalRate(v.published, v.rejected),
    }))
    .sort((a, b) => b.offered - a.offered || compareAsc(a.key, b.key));

  const byLens: LensUsageRow[] = [...lensMap.entries()]
    .map(([lens, v]) => ({
      lens,
      chosen: v.chosen,
      offered: v.offered,
      published: v.published,
    }))
    .sort((a, b) => b.chosen - a.chosen || compareAsc(a.lens, b.lens));

  const rejectReasons: RejectReasonRow[] = [...reasonMap.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || compareAsc(a.reason, b.reason));

  const cost: ApprovalCost = {
    total: totalCost,
    perPublished: totals.published > 0 ? totalCost / totals.published : null,
  };

  return {
    totals,
    byModel,
    bySource,
    byLens,
    rejectReasons,
    cost,
  };
}

function formatRate(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

function formatUsd(amount: number | null): string {
  return amount === null ? 'n/a' : `$${amount.toFixed(4)}`;
}

function renderTable(headers: string[], rows: string[][], rightAlign: ReadonlySet<number>): string {
  const widths = headers.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => (r[col] ?? '').length)),
  );
  const padRow = (cells: string[]): string =>
    cells
      .map((cell, col) =>
        rightAlign.has(col) ? cell.padStart(widths[col]!) : cell.padEnd(widths[col]!),
      )
      .join('  ');

  const lines = [padRow(headers)];
  if (rows.length === 0) {
    lines.push('(none)');
  } else {
    for (const row of rows) {
      lines.push(padRow(row));
    }
  }
  return lines.join('\n');
}

export function formatApprovalStats(stats: ApprovalStats): string {
  const totalsSection = [
    'Totals',
    renderTable(
      ['metric', 'value'],
      [
        ['written', String(stats.totals.written)],
        ['offered', String(stats.totals.offered)],
        ['published', String(stats.totals.published)],
        ['rejected', String(stats.totals.rejected)],
        ['expired', String(stats.totals.expired)],
        ['withdrawn', String(stats.totals.withdrawn)],
        ['uncertain', String(stats.totals.uncertain)],
        ['pending', String(stats.totals.pending)],
        ['approval rate', formatRate(stats.totals.rate)],
      ],
      new Set([1]),
    ),
  ].join('\n');

  const modelSection = [
    'By model',
    renderTable(
      ['model', 'offered', 'published', 'rejected', 'rate'],
      stats.byModel.map((r) => [
        r.key,
        String(r.offered),
        String(r.published),
        String(r.rejected),
        formatRate(r.rate),
      ]),
      new Set([1, 2, 3, 4]),
    ),
  ].join('\n');

  const sourceSection = [
    'By source',
    renderTable(
      ['source', 'offered', 'published', 'rejected', 'rate'],
      stats.bySource.map((r) => [
        r.key,
        String(r.offered),
        String(r.published),
        String(r.rejected),
        formatRate(r.rate),
      ]),
      new Set([1, 2, 3, 4]),
    ),
  ].join('\n');

  const lensSection = [
    'By lens',
    renderTable(
      ['lens', 'chosen', 'offered', 'published'],
      stats.byLens.map((r) => [
        r.lens,
        String(r.chosen),
        String(r.offered),
        String(r.published),
      ]),
      new Set([1, 2, 3]),
    ),
  ].join('\n');

  const reasonsSection = [
    'Reject reasons',
    renderTable(
      ['reason', 'label', 'count'],
      stats.rejectReasons.map((r) => [
        r.reason,
        REASON_LABELS.get(r.reason) ?? r.reason,
        String(r.count),
      ]),
      new Set([2]),
    ),
  ].join('\n');

  const costSection = [
    'Cost',
    renderTable(
      ['metric', 'usd'],
      [
        ['total', formatUsd(stats.cost.total)],
        ['per published post', formatUsd(stats.cost.perPublished)],
      ],
      new Set([1]),
    ),
  ].join('\n');

  return [
    totalsSection,
    modelSection,
    sourceSection,
    lensSection,
    reasonsSection,
    costSection,
  ].join('\n\n');
}
