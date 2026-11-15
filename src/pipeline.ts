import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Config } from './config/index.js';
import { collectTrends, type EligibleTrend } from './collect/trend-collector.js';
import { readHashtagPosts, type HashtagPost } from './collect/hashtag-reader.js';
import { readAngles, syncAngles } from './perspective/angle-store.js';
import { readLenses, syncLenses } from './perspective/lens-store.js';
import { recordSelection, selectPerspective } from './perspective/selector.js';
import { gatherAll } from './perspective/evidence.js';
import type { SelectionResult } from './perspective/types.js';
import { recentModes, selectMode, type ModeChoice } from './compose/modes.js';
import { runDataGate, type DataGateResult, type VisualSchema } from './compose/data-gate.js';
import { loadVoiceAssets } from './compose/prompt-assets.js';
import type { DraftRequest } from './compose/drafter.js';
import {
  composeDraft,
  recentAnchorTiers,
  recordDraft,
  withdrawDraft,
  type ComposeOutcome,
} from './compose/compose-draft.js';
import { readRecentPosts } from './compose/recent-posts.js';
import { personaCapInUse } from './compose/persona-guard.js';
import { pipelineFactsFor, resolveAnchor } from './compose/anchor.js';
import { readAnchorBank } from './perspective/anchor-bank.js';
import type { LlmClient } from './llm/client.js';
import type { RenderResult } from './visual/render.js';
import { renderDraftVisual } from './visual/draft-visual.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('pipeline');

export interface Candidate {
  trend: EligibleTrend;
  topPosts: HashtagPost[];
  selection: SelectionResult;
  dataGate: DataGateResult | null;
  mode: ModeChoice | null;
  selectionId: number;
}

/**
 * Everything a draft was written from. Kept in memory by the run that waits
 * for approval, so a rewrite drafts again from the same trend, posts,
 * perspective and anchor without collecting anything a second time.
 */
export interface DraftContext {
  request: DraftRequest;
  selectionId: number;
  /** What the data gate found, before alignment to any one draft. */
  baseSchema: Partial<VisualSchema>;
}

export interface DrawnDraft {
  draft: ComposeOutcome;
  draftId: number;
  /** Present when the draft passed and its card was drawn: only then is it pending. */
  visual?: RenderResult & { path: string };
  /** Why a passed draft has no card, when it has none. */
  visualSkipped?: string;
}

export interface PipelineResult {
  candidates: Candidate[];
  /** The one that will be drafted, or null on a quiet day. */
  chosen: Candidate | null;
  /** Present once a draft has been attempted for `chosen`. */
  draft?: ComposeOutcome;
  draftId?: number;
  /** Present once the visual has been rendered. */
  visual?: RenderResult & { path: string };
  /** Present once a draft has been attempted, for a rewrite. */
  context?: DraftContext;
}

/**
 * Write a draft from its context, record it, and draw its card.
 *
 * Shared by the first draft of a run and every rewrite, so both leave the
 * queue in the same state: a draft is pending only when it passed every gate
 * and has a card, because there is no post without an image.
 */
export async function draftAndDraw(
  db: Database.Database,
  config: Config,
  context: DraftContext,
  options: { llm: LlmClient; visualDir?: string; now?: () => Date },
): Promise<DrawnDraft> {
  const now = options.now ?? (() => new Date());

  // One account, two pipelines: the hand-written posts in the vault count
  // toward the persona cap and the shape comparison exactly like this bot's
  // own. Read per draft, so a rewrite sees a post published meanwhile.
  const history = readRecentPosts(db, path.join(config.vaultDir, 'outputs', 'square'));

  const draft = await composeDraft(context.request, { llm: options.llm, recent: history, now });
  const draftId = recordDraft(db, context.selectionId, draft);
  logger.info(
    draft.ok
      ? `Draft ready: ${draft.lengths.nfc} NFC / ${draft.lengths.nfd} NFD via ${draft.tier}`
      : `Draft failed all ${draft.attempts.length} attempts`,
  );
  if (!draft.ok) return { draft, draftId };

  if (!options.visualDir) {
    withdrawDraft(db, draftId, 'no-visual');
    return { draft, draftId, visualSkipped: 'no visual directory given' };
  }

  const drawn = await renderDraftVisual(db, {
    draftId,
    body: draft.body,
    hashtag: context.request.trend.hashtag,
    baseSchema: context.baseSchema,
    visualDir: options.visualDir,
    now: now(),
  });
  if (!drawn.ok) {
    logger.warn(`Visual skipped: ${drawn.reason}`);
    withdrawDraft(db, draftId, 'no-visual');
    return { draft, draftId, visualSkipped: drawn.reason };
  }
  if (drawn.changed.length > 0) logger.info('Visual aligned to the draft', { changed: drawn.changed });

  return { draft, draftId, visual: { ...drawn.rendered, path: drawn.visual.pngPath! } };
}

/**
 * Everything up to but not including the draft.
 *
 * Trends are tried in order until one produces both a perspective and enough
 * data for a visual. Trying more than one is deliberate: the day's slot should
 * not be lost because the highest-ranked trend happened to be unusable.
 */
export async function runUpToDraft(
  db: Database.Database,
  config: Config,
  options: {
    headed?: boolean;
    maxTrends?: number;
    /** Notes a person supplied for `author` lenses, keyed by lens id. */
    authorNotes?: Record<string, string[]>;
    /** Supply to draft the chosen candidate. Omit to stop before writing. */
    llm?: LlmClient;
    /** Where to write the rendered PNG. Omit to skip rendering. */
    visualDir?: string;
  } = {},
): Promise<PipelineResult> {
  const angles = readAngles(path.join(config.vaultDir, 'angles'));
  syncAngles(db, angles);

  const lenses = syncLenses(db, readLenses(path.join(config.vaultDir, 'lenses')));
  logger.info(`Vault: ${angles.length} angles, ${lenses.length} lenses`);

  const collected = await collectTrends(db, { headed: options.headed });
  const recent = recentModes(db);

  const candidates: Candidate[] = [];
  let chosen: Candidate | null = null;

  for (const trend of collected.eligible.slice(0, options.maxTrends ?? 5)) {
    const topPosts = await readHashtagPosts(trend.hashtag, 10).catch((err) => {
      logger.warn(`Could not read posts under ${trend.hashtag}: ${(err as Error).message}`);
      return [] as HashtagPost[];
    });

    // Evidence is gathered before the ladder runs, so a lens is offered only
    // when the thing it demands actually exists. `author` lenses stay empty
    // until a person supplies a note, which drops them at the ladder.
    const lensEvidence = gatherAll(lenses, {
      trend,
      topPosts,
      authorNotes: options.authorNotes,
    });

    const selection = selectPerspective({
      trend,
      allTrends: collected.all,
      angles,
      lenses,
      topPosts,
      lensEvidence,
    });

    // The data gate only matters once there is something to say.
    const dataGate = selection.outcome === 'stop' ? null : runDataGate({ trend, topPosts });
    const mode = selection.outcome === 'stop' || !dataGate?.ok ? null : selectMode(recent);

    const selectionId = recordSelection(
      db,
      trend.trendId,
      selection,
      mode?.spec.mode ?? null,
      dataGate ? (dataGate.ok ? 'pass' : `fail: ${dataGate.reason}`) : null,
    );

    const candidate: Candidate = { trend, topPosts, selection, dataGate, mode, selectionId };
    candidates.push(candidate);

    if (!chosen && selection.outcome !== 'stop' && dataGate?.ok && mode) {
      chosen = candidate;
    }
  }

  if (!chosen) {
    logger.info('Nothing to write today - no trend produced both a perspective and a visual');
    return { candidates, chosen: null };
  }

  logger.info(
    `Chosen: ${chosen.trend.hashtag} via ${chosen.selection.outcome} in ${chosen.mode!.spec.mode} mode`,
  );

  const selection = chosen.selection;
  if (!options.llm || selection.outcome === 'stop') return { candidates, chosen };

  // Voice files are read per run, so an edit in Content-Creator takes effect on
  // the next pass with no deploy.
  const assets = loadVoiceAssets(config.contentCreatorDir);

  // The persona cap counts the hand-written posts too, so the anchor ladder
  // reads the same history the gates will.
  const history = readRecentPosts(db, path.join(config.vaultDir, 'outputs', 'square'));

  // Rule E5's anchor is chosen here, not by the drafter. See `resolveAnchor`.
  const perspective = selection.perspective;
  const anchor = resolveAnchor({
    perspective,
    rawNotes: perspective.kind === 'lens' ? (options.authorNotes?.[perspective.ref] ?? []) : [],
    bank: readAnchorBank(config.vaultDir),
    pipelineFacts: pipelineFactsFor(chosen.trend, chosen.topPosts),
    recentTiers: recentAnchorTiers(db),
    personaCapInUse: personaCapInUse(history.map((p) => p.personaText)),
    now: new Date(),
  });
  logger.info(
    `Anchor: ${anchor.tier}${anchor.ref ? ` (${anchor.ref})` : ''}` +
      (anchor.mayNameJob ? '' : ', job mention not allowed (cap in use)'),
  );

  // The data gate passed for `chosen`, or it would not have been chosen.
  const context: DraftContext = {
    request: {
      trend: chosen.trend,
      perspective,
      mode: chosen.mode!.spec,
      topPosts: chosen.topPosts,
      assets,
      anchor,
    },
    selectionId: chosen.selectionId,
    baseSchema: chosen.dataGate?.ok ? chosen.dataGate.available : {},
  };

  const drawn = await draftAndDraw(db, config, context, {
    llm: options.llm,
    visualDir: options.visualDir,
  });
  return {
    candidates,
    chosen,
    draft: drawn.draft,
    draftId: drawn.draftId,
    visual: drawn.visual,
    context,
  };
}
