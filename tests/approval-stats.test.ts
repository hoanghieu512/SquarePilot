import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { memoryDb, seedDraft, seedVisual } from './helpers/approval-db.js';
import { computeApprovalStats, formatApprovalStats } from '../src/stats/approval-stats.js';

describe('approval-stats', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = memoryDb();
  });

  afterEach(() => {
    db.close();
  });

  function resolveDraft(id: number, status: 'approved' | 'rejected' | 'expired', reason: string | null = null): void {
    db.prepare('UPDATE drafts SET status = ?, reject_reason = ?, resolved_at = ? WHERE id = ?').run(
      status,
      reason,
      '2026-11-15T02:00:00.000Z',
      id,
    );
  }

  function addPost(draftId: number): void {
    db.prepare(
      `INSERT INTO posts (draft_id, square_post_id, content_snapshot, hashtag, published_at)
       VALUES (?, ?, 'snapshot', '#BTCHolds', '2026-11-15T02:00:00.000Z')`,
    ).run(draftId, `post-${draftId}`);
  }

  function addLlmCall(opts: {
    draftId: number | null;
    purpose?: string;
    model: string;
    costUsd?: number;
    ok?: boolean;
  }): void {
    db.prepare(
      `INSERT INTO llm_calls (draft_id, purpose, model, prompt_tokens, output_tokens, cost_usd, ok, created_at)
       VALUES (?, ?, ?, 100, 50, ?, ?, '2026-11-15T01:00:00.000Z')`,
    ).run(opts.draftId, opts.purpose ?? 'draft', opts.model, opts.costUsd ?? 0, (opts.ok ?? true) ? 1 : 0);
  }

  it('excludes drafts that were never offered from decision counts and rates', () => {
    // Draft 1: no visual row at all (failed gates)
    const d1 = seedDraft(db, { status: 'rejected' });
    resolveDraft(d1, 'rejected', 'gates-failed');

    // Draft 2: visual exists, but offered_at is NULL (never reached chat)
    const d2 = seedDraft(db, { status: 'rejected' });
    seedVisual(db, d2, { imageUrl: null, offered: false });
    resolveDraft(d2, 'rejected', 'not-sent');

    // Draft 3: offered and published
    const d3 = seedDraft(db, { outcome: 'angle', sourceRef: 'angles/a1.md', status: 'approved' });
    seedVisual(db, d3, { offered: true });
    addPost(d3);

    const stats = computeApprovalStats(db);

    expect(stats.totals).toEqual({
      written: 3,
      offered: 1,
      published: 1,
      rejected: 0,
      expired: 0,
      withdrawn: 0,
      uncertain: 0,
      pending: 0,
      rate: 1,
    });
    expect(stats.bySource).toEqual([
      { key: 'angle', offered: 1, published: 1, rejected: 0, rate: 1 },
    ]);
    expect(stats.rejectReasons).toEqual([]);
  });

  it('classifies each outcome of an offered draft as defined and excludes non-decisions from the rate', () => {
    // 1. published: offered + row in posts
    const pubId = seedDraft(db, { status: 'approved' });
    seedVisual(db, pubId, { offered: true });
    addPost(pubId);

    // 2. uncertain: offered + status 'approved' + no row in posts
    const uncId = seedDraft(db, { status: 'approved' });
    seedVisual(db, uncId, { offered: true });

    // 3. rejected: REJECT_REASONS codes + 'rewrite-requested'
    const ownerReasons = ['voice', 'take', 'facts', 'visual', 'timing', 'other', 'rewrite-requested'] as const;
    for (const reason of ownerReasons) {
      const id = seedDraft(db, { status: 'pending' });
      seedVisual(db, id, { offered: true });
      resolveDraft(id, 'rejected', reason);
    }
    // Second 'voice' rejection to verify sorting by count desc then reason asc
    const extraVoice = seedDraft(db, { status: 'pending' });
    seedVisual(db, extraVoice, { offered: true });
    resolveDraft(extraVoice, 'rejected', 'voice');

    // 4. expired: status 'expired'
    const expId = seedDraft(db, { status: 'expired' });
    seedVisual(db, expId, { offered: true });

    // 5. withdrawn: status 'rejected' with system withdraw reasons
    const withdrawReasons = ['session-ended', 'not-sent', 'dry-run', 'no-visual', 'gates-failed'] as const;
    for (const reason of withdrawReasons) {
      const id = seedDraft(db, { status: 'pending' });
      seedVisual(db, id, { offered: true });
      resolveDraft(id, 'rejected', reason);
    }

    // 6. pending: status 'pending'
    const pendId = seedDraft(db, { status: 'pending' });
    seedVisual(db, pendId, { offered: true });

    const stats = computeApprovalStats(db);

    // Total offered = 1 (pub) + 1 (unc) + 8 (rejected) + 1 (exp) + 5 (withdrawn) + 1 (pending) = 17
    // Rate = 1 / (1 + 8) = 1/9
    expect(stats.totals).toEqual({
      written: 17,
      offered: 17,
      published: 1,
      rejected: 8,
      expired: 1,
      withdrawn: 5,
      uncertain: 1,
      pending: 1,
      rate: 1 / 9,
    });

    expect(stats.rejectReasons).toEqual([
      { reason: 'voice', count: 2 },
      { reason: 'facts', count: 1 },
      { reason: 'other', count: 1 },
      { reason: 'rewrite-requested', count: 1 },
      { reason: 'take', count: 1 },
      { reason: 'timing', count: 1 },
      { reason: 'visual', count: 1 },
    ]);
  });

  it('resolves model from the last successful draft llm_call and falls back to drafts.model_used', () => {
    // Draft 1: has two successful draft calls and a later failed draft call + tone-gate call
    const d1 = seedDraft(db, { modelTier: 'paid', status: 'approved', outcome: 'angle', sourceRef: 'angles/a.md' });
    seedVisual(db, d1, { offered: true });
    addPost(d1);
    addLlmCall({ draftId: d1, purpose: 'draft', model: 'nvidia/nemotron:free', ok: true });
    addLlmCall({ draftId: d1, purpose: 'draft', model: 'anthropic/claude-sonnet-5.5', ok: true });
    addLlmCall({ draftId: d1, purpose: 'draft', model: 'anthropic/claude-opus', ok: false });
    addLlmCall({ draftId: d1, purpose: 'tone-gate', model: 'nvidia/nemotron:free', ok: true });

    // Draft 2: same resolved model, rejected
    const d2 = seedDraft(db, { modelTier: 'paid', status: 'pending', outcome: 'lens', sourceRef: 'funding-mood' });
    seedVisual(db, d2, { offered: true });
    resolveDraft(d2, 'rejected', 'take');
    addLlmCall({ draftId: d2, purpose: 'draft', model: 'anthropic/claude-sonnet-5.5', ok: true });

    // Draft 3: no successful draft llm_call -> falls back to drafts.model_used ('free')
    const d3 = seedDraft(db, { modelTier: 'free', status: 'pending', outcome: 'tension', sourceRef: '1' });
    seedVisual(db, d3, { offered: true });

    const stats = computeApprovalStats(db);

    expect(stats.byModel).toEqual([
      { key: 'anthropic/claude-sonnet-5.5', offered: 2, published: 1, rejected: 1, rate: 0.5 },
      { key: 'free', offered: 1, published: 0, rejected: 0, rate: null },
    ]);

    expect(stats.bySource).toEqual([
      { key: 'angle', offered: 1, published: 1, rejected: 0, rate: 1 },
      { key: 'lens', offered: 1, published: 0, rejected: 1, rate: 0 },
      { key: 'tension', offered: 1, published: 0, rejected: 0, rate: null },
    ]);
  });

  it('counts byLens including lenses chosen in selections without any draft', () => {
    const trendId = Number(
      db
        .prepare(
          `INSERT INTO trends (hashtag, rank, view_count, content_count, collected_at)
           VALUES ('#ETH', 1, 5000, 10, '2026-11-15T00:00:00Z')`,
        )
        .run().lastInsertRowid,
    );

    // Lens 'oi-divergence' chosen twice without any draft (e.g. failed data gate or not top candidate)
    for (let i = 0; i < 2; i++) {
      db.prepare(
        `INSERT INTO selections (trend_id, outcome, source_ref, created_at)
         VALUES (?, 'lens', 'oi-divergence', '2026-11-15T00:00:00Z')`,
      ).run(trendId);
    }

    // Lens 'funding-mood': 1 offered + published draft, 1 unoffered draft
    const dPub = seedDraft(db, { outcome: 'lens', sourceRef: 'funding-mood', status: 'approved' });
    seedVisual(db, dPub, { offered: true });
    addPost(dPub);

    const dUnoffered = seedDraft(db, { outcome: 'lens', sourceRef: 'funding-mood', status: 'rejected' });
    resolveDraft(dUnoffered, 'rejected', 'gates-failed');

    // Non-lens selection should not appear in byLens
    const dAngle = seedDraft(db, { outcome: 'angle', sourceRef: 'angles/x.md', status: 'approved' });
    seedVisual(db, dAngle, { offered: true });
    addPost(dAngle);

    const stats = computeApprovalStats(db);

    expect(stats.byLens).toEqual([
      { lens: 'funding-mood', chosen: 2, offered: 1, published: 1 },
      { lens: 'oi-divergence', chosen: 2, offered: 0, published: 0 },
    ]);
  });

  it('computes cost per published post including the cost of drafts that were never offered', () => {
    // Draft 1: failed gates (never offered), cost $0.12 across two calls
    const dFailed = seedDraft(db, { status: 'rejected' });
    resolveDraft(dFailed, 'rejected', 'gates-failed');
    addLlmCall({ draftId: dFailed, purpose: 'draft', model: 'anthropic/claude-sonnet-5.5', costUsd: 0.08 });
    addLlmCall({ draftId: dFailed, purpose: 'fact-gate', model: 'nvidia/nemotron:free', costUsd: 0.04 });

    // Draft 2: offered and rejected, cost $0.05
    const dRejected = seedDraft(db, { status: 'pending' });
    seedVisual(db, dRejected, { offered: true });
    resolveDraft(dRejected, 'rejected', 'voice');
    addLlmCall({ draftId: dRejected, purpose: 'draft', model: 'anthropic/claude-sonnet-5.5', costUsd: 0.05 });

    // No published posts yet -> perPublished is null
    const beforePublish = computeApprovalStats(db);
    expect(beforePublish.cost.total).toBeCloseTo(0.17, 6);
    expect(beforePublish.cost.perPublished).toBeNull();

    // Draft 3 & 4: offered and published, cost $0.07 and $0.10
    const dPub1 = seedDraft(db, { status: 'approved' });
    seedVisual(db, dPub1, { offered: true });
    addPost(dPub1);
    addLlmCall({ draftId: dPub1, purpose: 'draft', model: 'anthropic/claude-sonnet-5.5', costUsd: 0.07 });

    const dPub2 = seedDraft(db, { status: 'approved' });
    seedVisual(db, dPub2, { offered: true });
    addPost(dPub2);
    addLlmCall({ draftId: dPub2, purpose: 'draft', model: 'anthropic/claude-sonnet-5.5', costUsd: 0.1 });

    const afterPublish = computeApprovalStats(db);
    // Total = 0.12 + 0.05 + 0.07 + 0.10 = 0.34; published = 2 -> perPublished = 0.17
    expect(afterPublish.cost.total).toBeCloseTo(0.34, 6);
    expect(afterPublish.cost.perPublished).toBeCloseTo(0.17, 6);
  });

  it('filters by since (drafts.created_at >= since)', () => {
    const oldDraft = seedDraft(db, {
      createdAt: '2026-11-10T12:00:00.000Z',
      outcome: 'lens',
      sourceRef: 'old-lens',
      status: 'approved',
    });
    seedVisual(db, oldDraft, { offered: true });
    addPost(oldDraft);
    addLlmCall({ draftId: oldDraft, model: 'model-old', costUsd: 0.5 });

    const newDraft = seedDraft(db, {
      createdAt: '2026-11-16T08:00:00.000Z',
      outcome: 'angle',
      sourceRef: 'angles/new.md',
      status: 'pending',
    });
    seedVisual(db, newDraft, { offered: true });
    resolveDraft(newDraft, 'rejected', 'timing');
    addLlmCall({ draftId: newDraft, model: 'model-new', costUsd: 0.08 });

    const stats = computeApprovalStats(db, { since: '2026-11-15T00:00:00.000Z' });

    expect(stats.totals).toEqual({
      written: 1,
      offered: 1,
      published: 0,
      rejected: 1,
      expired: 0,
      withdrawn: 0,
      uncertain: 0,
      pending: 0,
      rate: 0,
    });
    expect(stats.byModel).toEqual([
      { key: 'model-new', offered: 1, published: 0, rejected: 1, rate: 0 },
    ]);
    expect(stats.bySource).toEqual([
      { key: 'angle', offered: 1, published: 0, rejected: 1, rate: 0 },
    ]);
    expect(stats.byLens).toEqual([]);
    expect(stats.rejectReasons).toEqual([{ reason: 'timing', count: 1 }]);
    expect(stats.cost.total).toBeCloseTo(0.08, 6);
    expect(stats.cost.perPublished).toBeNull();
  });

  it('formats plain-text tables with every section header, n/a rate when undecided, and no em dash', () => {
    // One pending offered draft so nothing is decided yet
    const d1 = seedDraft(db, { status: 'pending', modelTier: 'free', outcome: 'lens', sourceRef: 'funding-mood' });
    seedVisual(db, d1, { offered: true });

    const emptyDecided = computeApprovalStats(db);
    const out = formatApprovalStats(emptyDecided);

    expect(out).toContain('Totals');
    expect(out).toContain('By model');
    expect(out).toContain('By source');
    expect(out).toContain('By lens');
    expect(out).toContain('Reject reasons');
    expect(out).toContain('Cost');
    expect(out).toContain('n/a');
    expect(out).not.toContain('\u2014');

    // Also verify formatting when populated with decisions and costs
    resolveDraft(d1, 'rejected', 'voice');
    const d2 = seedDraft(db, { status: 'approved', modelTier: 'paid', outcome: 'angle', sourceRef: 'angles/a.md' });
    seedVisual(db, d2, { offered: true });
    addPost(d2);
    addLlmCall({ draftId: d2, model: 'anthropic/claude-sonnet-5.5', costUsd: 0.045 });

    const populated = formatApprovalStats(computeApprovalStats(db));
    expect(populated).toContain('50.0%');
    expect(populated).toContain('anthropic/claude-sonnet-5.5');
    expect(populated).toContain('funding-mood');
    expect(populated).toContain('voice');
    expect(populated).toContain('$0.0450');
    expect(populated).not.toContain('\u2014');
  });
});
