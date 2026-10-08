import fs from 'node:fs';
import path from 'node:path';
import { asNumber, asString, parseDoc } from './frontmatter.js';

/**
 * Tier 2 of Rule E5: real first-person experiences, de-identified by hand.
 *
 * The bank lives in the vault (`anchor-bank.md`) and is edited by a person, so
 * the parser reads the format as written there rather than a schema of its own.
 * Usage is written back by the vault writer after a post goes out, never here.
 */
export interface BankAnchor {
  id: string;
  title: string;
  lenses: string[];
  /** The only text a post may draw on. */
  textEn: string;
  used: boolean;
  /** `YYYY-MM-DD`, or null when never used. */
  lastUsed: string | null;
}

export interface AnchorBank {
  /** `approved`, a review state such as `draft-pending-review`, or `missing`. */
  status: string;
  cooldownDays: number;
  anchors: BankAnchor[];
}

const DEFAULT_COOLDOWN_DAYS = 30;
const SECTION = /^## (A\d+)\s*-\s*(.+)$/gm;

function bullet(section: string, name: string): string | null {
  const m = section.match(new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.+)$`, 'm'));
  return m ? m[1]!.trim() : null;
}

/** The blockquote directly under `**text_en:**`, and nothing after it. */
function textEnOf(section: string): string {
  const lines = section.split('\n');
  const start = lines.findIndex((l) => l.trim() === '**text_en:**');
  if (start === -1) return '';

  const quoted: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (t.startsWith('>')) {
      quoted.push(t.replace(/^>\s?/, ''));
    } else if (quoted.length > 0 || t !== '') {
      break;
    }
  }
  return quoted.join(' ').replace(/\s+/g, ' ').trim();
}

export function parseAnchorBank(raw: string): AnchorBank {
  const { front, body } = parseDoc(raw);
  const status = asString(front.status) ?? 'unknown';
  const cooldownDays = asNumber(front.cooldown_days) ?? DEFAULT_COOLDOWN_DAYS;

  // The file states that the pipeline may read it only once approved. Until
  // then not a single anchor leaves this function.
  if (status !== 'approved') return { status, cooldownDays, anchors: [] };

  const heads = [...body.matchAll(SECTION)];
  const anchors = heads.map((head, i) => {
    const end = i + 1 < heads.length ? heads[i + 1]!.index : body.length;
    const section = body.slice(head.index, end);
    const lastUsed = bullet(section, 'last_used');

    return {
      id: head[1]!,
      title: head[2]!.trim(),
      lenses: [...(bullet(section, 'lens') ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]!),
      textEn: textEnOf(section),
      used: bullet(section, 'used') === 'true',
      lastUsed: lastUsed && /^\d{4}-\d{2}-\d{2}/.test(lastUsed) ? lastUsed.slice(0, 10) : null,
    };
  });

  return { status, cooldownDays, anchors: anchors.filter((a) => a.textEn !== '') };
}

export function readAnchorBank(vaultDir: string): AnchorBank {
  const file = path.join(vaultDir, 'anchor-bank.md');
  if (!fs.existsSync(file)) {
    return { status: 'missing', cooldownDays: DEFAULT_COOLDOWN_DAYS, anchors: [] };
  }
  return parseAnchorBank(fs.readFileSync(file, 'utf8'));
}
