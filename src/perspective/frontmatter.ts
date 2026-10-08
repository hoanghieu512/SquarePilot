import { parse } from 'yaml';

export interface ParsedDoc {
  front: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Split a vault markdown file into frontmatter and body.
 *
 * A file with no frontmatter is not an error — angle files written by hand
 * sometimes lack it, and dropping them silently would shrink the bank without
 * anyone noticing. Such a file simply has no fields to match on.
 */
export function parseDoc(raw: string): ParsedDoc {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { front: {}, body: raw.trim() };

  let front: Record<string, unknown> = {};
  try {
    const parsed = parse(match[1]!);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      front = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed YAML: treat as fieldless rather than crashing the run.
    front = {};
  }

  return { front, body: (match[2] ?? '').trim() };
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    // Scores are written as "8/10" as often as "8".
    const m = value.match(/-?\d+(\.\d+)?/);
    if (m) return Number(m[0]);
  }
  return null;
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => asString(v)).filter((v): v is string => v !== null);
  }
  const single = asString(value);
  return single ? [single] : [];
}

/** Dates appear as `2026-08-13` or as a parsed Date, depending on the file. */
export function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const s = asString(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
