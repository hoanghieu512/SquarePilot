import path from 'node:path';
import { loadConfig, ConfigError } from '../config/index.js';
import { initDb, closeDb, TABLE_NAMES } from '../database/index.js';
import { LlmClient } from '../llm/client.js';
import { runUpToDraft } from '../pipeline.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('dry-run');

/**
 * Walk the pipeline skeleton without touching the network or publishing.
 * Phases 2-7 each attach their stage here as they land.
 */
async function main(): Promise<void> {
  const liveLlm = process.argv.includes('--live-llm');
  const liveCollect = process.argv.includes('--live-collect');
  const headed = process.argv.includes('--headed');
  const liveDraft = process.argv.includes('--live-draft');

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  logger.info('Config loaded', {
    modelFree: config.modelFree,
    modelPaid: config.modelPaid,
    dbPath: config.dbPath,
  });

  const db = initDb(config.dbPath);

  const counts = TABLE_NAMES.map((table) => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return `${table}=${row.n}`;
  });
  logger.info(`Tables ready (${TABLE_NAMES.length}): ${counts.join(' ')}`);

  if (liveCollect) {
    const llm = liveDraft
      ? new LlmClient({
          apiKey: config.openRouterApiKey,
          modelFree: config.modelFree,
          modelPaid: config.modelPaid,
          db,
        })
      : undefined;

    const visualDir = process.argv.includes('--render')
      ? path.join(config.vaultDir, 'outputs', 'visuals', 'square-auto')
      : undefined;

    const { candidates, chosen, draft, visual } = await runUpToDraft(db, config, {
      headed,
      llm,
      visualDir,
    });

    for (const c of candidates) {
      const gate = c.dataGate ? (c.dataGate.ok ? 'visual ok' : `visual: ${c.dataGate.reason}`) : '—';
      logger.info(
        `  ${c.trend.hashtag.padEnd(46).slice(0, 46)} views=${String(c.trend.viewCount).padStart(7)}`,
      );
      logger.info(`      perspective: ${c.selection.outcome}` +
        (c.selection.outcome === 'stop' ? '' : ` (${c.selection.perspective.summary.slice(0, 80)})`));
      logger.info(`      data gate  : ${gate}`);
      if (c.mode) logger.info(`      mode       : ${c.mode.spec.mode} — ${c.mode.spec.question}`);
      for (const r of c.selection.rejected.slice(0, 3)) {
        logger.info(`      skipped [${r.rung}] ${r.candidate}: ${r.reason}`.slice(0, 150));
      }
    }

    if (chosen) {
      logger.info(`  → would draft: ${chosen.trend.hashtag}`);
      logger.info(`     evidence: ${chosen.selection.outcome === 'stop' ? '—' : chosen.selection.perspective.evidence.join(' | ').slice(0, 140)}`);
      if (chosen.dataGate?.ok) {
        const a = chosen.dataGate.available;
        logger.info(`     visual: ${a.visual_type} "${a.headline_1}${a.headline_2 ? ' / ' + a.headline_2 : ''}" focal=${a.focal_number} tiles=${a.stat_tiles?.map((t) => t.label + ':' + t.value).join(' ')}`);
      }
    }

    if (draft) {
      for (const a of draft.attempts) {
        logger.info(
          `     attempt ${a.attempt} (${a.tier}): tone=${a.toneOk ? 'ok' : 'fail'} ` +
            `shape=${a.shapeOk ? 'ok' : 'fail'} persona=${a.personaOk ? 'ok' : 'fail'}`,
        );
        for (const c of a.corrections) logger.info(`       - ${c}`.slice(0, 170));
      }
      logger.info(
        `     ${draft.ok ? 'DRAFT PASSED' : 'DRAFT FAILED'} - ` +
          `${draft.lengths.nfc} NFC / ${draft.lengths.nfd} NFD via ${draft.tier}`,
      );
      logger.info('\n' + draft.body + '\n');
      if (visual) {
        logger.info(`     visual: ${visual.width}x${visual.height}, ${(visual.bytes / 1024).toFixed(0)} KB -> ${visual.path}`);
      } else {
        logger.info('     visual: pass --render to draw it');
      }
    } else {
      logger.info('     draft: pass --live-draft to write for real');
    }
  } else {
    logger.info('Stage: collect trends       - pass --live-collect to hit Binance for real');
    logger.info('Stage: select perspective   - pass --live-collect');
    logger.info('Stage: data gate            - pass --live-collect');
    logger.info('Stage: draft + gates        - pass --live-collect --live-draft');
  }
  logger.info('Stage: telegram approval    - pending Phase 6');

  if (liveLlm) {
    const llm = new LlmClient({
      apiKey: config.openRouterApiKey,
      modelFree: config.modelFree,
      modelPaid: config.modelPaid,
      db,
    });
    logger.info(`Calling ${config.modelFree}...`);
    const result = await llm.complete({
      purpose: 'smoke-test',
      user: 'Reply with exactly: SquarePilot online.',
      temperature: 0,
    });
    logger.info('Model replied', {
      text: result.text.trim(),
      promptTokens: result.promptTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
    });
  } else {
    logger.info('LLM call skipped — pass --live-llm to hit OpenRouter for real');
  }

  closeDb();
  logger.info('Dry run complete. Nothing was published.');
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
