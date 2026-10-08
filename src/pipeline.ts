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
import { composeDraft, recentAnchorTiers, recordDraft, type ComposeOutcome } from './compose/compose-draft.js';
import { readRecentPosts } from './compose/recent-posts.js';
import { personaCapInUse } from './compose/persona-guard.js';
import { pipelineFactsFor, resolveAnchor } from './compose/anchor.js';
import { readAnchorBank } from './perspective/anchor-bank.js';
import type { LlmClient } from './llm/client.js';
import { renderToFile, type RenderResult } from './visual/render.js';
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

export interface PipelineResult {
  candidates: Candidate[];
  /** The one that will be drafted, or null on a quiet day. */
  chosen: Candidate | null;
  /** Present once a draft has been attempted for `chosen`. */
  draft?: ComposeOutcome;
  draftId?: number;
  /** Present once the visual has been rendered. */
  visual?: RenderResult & { path: string };
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

  // One account, two pipelines: the hand-written posts in the vault count
  // toward the persona cap and the shape comparison exactly like this bot's own.
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

  const draft = await composeDraft(
    {
      trend: chosen.trend,
      perspective,
      mode: chosen.mode!.spec,
      topPosts: chosen.topPosts,
      assets,
      anchor,
    },
    { llm: options.llm, recent: history },
  );

  const draftId = recordDraft(db, chosen.selectionId, draft);
  logger.info(
    draft.ok
      ? `Draft ready: ${draft.lengths.nfc} NFC / ${draft.lengths.nfd} NFD via ${draft.tier}`
      : `Draft failed all ${draft.attempts.length} attempts`,
  );

  if (!options.visualDir || !draft.ok || !chosen.dataGate?.ok) {
    return { candidates, chosen, draft, draftId };
  }

  // "No image, no post" - the data gate already proved the schema can be filled,
  // so a failure here is a rendering fault, not a missing-content one.
  const slug = chosen.trend.hashtag.replace(/^#/, '').toLowerCase().slice(0, 48);
  const pngPath = path.join(
    options.visualDir,
    `${new Date().toISOString().slice(0, 10)}-${slug}.png`,
  );

  const rendered = await renderToFile(chosen.dataGate.available as VisualSchema, pngPath);
  db.prepare(
    `INSERT INTO visuals (draft_id, visual_type, mood, schema_json, png_path, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    draftId,
    chosen.dataGate.available.visual_type ?? 'macro_card',
    chosen.dataGate.available.mood_variant ?? 'neutral',
    JSON.stringify(chosen.dataGate.available),
    pngPath,
    rendered.bytes,
    new Date().toISOString(),
  );

  return { candidates, chosen, draft, draftId, visual: { ...rendered, path: pngPath } };
}
