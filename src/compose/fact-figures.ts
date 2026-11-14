export type FigureUnit = 'percent' | 'currency' | 'multiple' | 'bps' | 'plain';

export interface Figure {
  raw: string;
  value: number;
  unit: FigureUnit;
  precision: number;
  sign: 1 | -1 | 0;
  index: number;
}

export interface FigureCheckOptions {
  currentYear?: number;
  exempt?: string[];
}

interface Span {
  start: number;
  end: number;
}

const SKIP_PATTERNS: RegExp[] = [
  /\b(?:S&P[\s-]?500|Nasdaq[\s-]100|Russell[\s-]2000|FTSE[\s-]100|Nikkei[\s-]225|DAX[\s-]40|CAC[\s-]40|Euro\s+Stoxx[\s-]50)\b/gi,
  /\b(?:24\/7|T\+\d+)\b/gi,
  /\b[A-Z]{2,}-\d+(?:\.\d+)?\b/g,
  /\b[A-Za-z]+\d[A-Za-z0-9.]*/g,
];

const SUFFIX_SOURCE =
  '(?:(?:(?:mn|bn|tn|[kKmMbBtT])|\\s+(?:mn|bn|tn|thousand|million|billion|trillion)\\b)(?:\\s+USDT?\\b)?|\\s+USDT?\\b|%|\\s+(?:percent|pct)\\b|[x×]|\\s+(?:bps|basis\\s+points?)\\b|-(?:second|minute|hour|day|week|month|year)s?\\b)';

const RANGE_RE = new RegExp(
  `(?<![A-Za-z0-9_.$–-])(?<lPrefix>[+-]?(?:US\\$|\\$)?|(?:US\\$|\\$)[+-]?)(?<lNum>\\d+(?:,\\d{3})*(?:\\.\\d+)?)(?<lSuffix>(?:mn|bn|tn|[kKmMbBtT]|%|[x×])?)(?<sep>[-–]|\\s+to\\s+)(?<rPrefix>(?:US\\$|\\$)?)(?<rNum>\\d+(?:,\\d{3})*(?:\\.\\d+)?)(?<rSuffix>${SUFFIX_SOURCE}?)(?![A-Za-z0-9_]|,\\d|\\.\\d)`,
  'gi',
);

const TIME_RE = /(?<![A-Za-z0-9_.$:–-])\b([01]?\d|2[0-3]):([0-5]\d)\b(?![A-Za-z0-9_.:])/g;

const SINGLE_RE = new RegExp(
  `(?<![A-Za-z0-9_.$–-])(?<prefix>[+-]?(?:US\\$|\\$)?|(?:US\\$|\\$)[+-]?)(?<num>\\d+(?:,\\d{3})*(?:\\.\\d+)?)(?<suffix>${SUFFIX_SOURCE}?)(?![A-Za-z0-9_]|,\\d|\\.\\d)`,
  'gi',
);

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

function collectSkipSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const pattern of SKIP_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const m of text.matchAll(re)) {
      spans.push({ start: m.index!, end: m.index! + m[0].length });
    }
  }
  return spans;
}

function collectExemptSpans(text: string, exempt?: string[]): Span[] {
  if (!exempt || exempt.length === 0) return [];
  const spans: Span[] = [];
  for (const item of exempt) {
    if (!item) continue;
    let pos = 0;
    while (pos <= text.length - item.length) {
      const idx = text.indexOf(item, pos);
      if (idx === -1) break;
      spans.push({ start: idx, end: idx + item.length });
      pos = idx + 1;
    }
  }
  return spans;
}

function parseScaleAndUnit(
  prefix: string,
  suffix: string,
): { scale: number; unit: FigureUnit; hasCurrency: boolean; hasScale: boolean } {
  const hasPrefixCurrency = prefix.includes('$');
  const s = suffix.trim();
  const lower = s.toLowerCase();

  if (lower === '%' || lower === 'percent' || lower === 'pct') {
    return { scale: 1, unit: 'percent', hasCurrency: false, hasScale: false };
  }
  if (lower === 'x' || lower === '×') {
    return { scale: 1, unit: 'multiple', hasCurrency: false, hasScale: false };
  }
  if (lower === 'bps' || lower === 'basis point' || lower === 'basis points') {
    return { scale: 1, unit: 'bps', hasCurrency: false, hasScale: false };
  }
  if (lower.startsWith('-')) {
    return {
      scale: 1,
      unit: hasPrefixCurrency ? 'currency' : 'plain',
      hasCurrency: hasPrefixCurrency,
      hasScale: false,
    };
  }

  let hasSuffixCurrency = false;
  let scalePart = lower;
  const usdMatch = scalePart.match(/^(.*?)\s*usdt?$/i);
  if (usdMatch) {
    hasSuffixCurrency = true;
    scalePart = usdMatch[1]!.trim();
  }

  let scale = 1;
  if (scalePart === 'k' || scalePart === 'thousand') scale = 1e3;
  else if (scalePart === 'm' || scalePart === 'mn' || scalePart === 'million') scale = 1e6;
  else if (scalePart === 'b' || scalePart === 'bn' || scalePart === 'billion') scale = 1e9;
  else if (scalePart === 't' || scalePart === 'tn' || scalePart === 'trillion') scale = 1e12;

  const hasCurrency = hasPrefixCurrency || hasSuffixCurrency;
  return {
    scale,
    unit: hasCurrency ? 'currency' : 'plain',
    hasCurrency,
    hasScale: scale > 1,
  };
}

function buildNumericFigure(
  raw: string,
  prefix: string,
  numStr: string,
  suffix: string,
  index: number,
  spanEnd: number,
  opts: FigureCheckOptions | undefined,
  exemptSet: Set<string>,
  exemptSpans: Span[],
  isSource: boolean,
): Figure | null {
  if (!isSource) {
    if (exemptSet.has(raw)) return null;
    if (exemptSpans.some((s) => s.start <= index && s.end >= spanEnd)) return null;
  }

  const clean = numStr.replace(/,/g, '');
  const dotIdx = clean.indexOf('.');
  const decimals = dotIdx === -1 ? 0 : clean.length - dotIdx - 1;
  const intDigits = Number(clean.replace('.', ''));
  const divisor = 10 ** decimals;

  const { scale, unit, hasCurrency, hasScale } = parseScaleAndUnit(prefix, suffix);
  const precision = scale / divisor;
  const value = scale >= divisor ? intDigits * precision : (intDigits * scale) / divisor;
  const sign: 1 | -1 | 0 = prefix.includes('-') ? -1 : prefix.includes('+') ? 1 : 0;

  // Bare integers 0..10 with no suffix at all, no "$" and no scale are skipped in drafts.
  if (
    !isSource &&
    unit === 'plain' &&
    suffix === '' &&
    !hasCurrency &&
    !hasScale &&
    decimals === 0 &&
    value >= 0 &&
    value <= 10
  ) {
    return null;
  }

  // A bare year 1900-2100 equal to opts.currentYear is allowed without support in drafts.
  if (
    !isSource &&
    opts?.currentYear !== undefined &&
    unit === 'plain' &&
    !hasCurrency &&
    !hasScale &&
    /^\d{4}$/.test(raw) &&
    value >= 1900 &&
    value <= 2100 &&
    value === opts.currentYear
  ) {
    return null;
  }

  return { raw, value, unit, precision, sign, index };
}

function extractFiguresInternal(
  text: string,
  opts: FigureCheckOptions | undefined,
  isSource: boolean,
): Figure[] {
  const skipSpans = collectSkipSpans(text);
  const exemptSet = isSource ? new Set<string>() : new Set(opts?.exempt ?? []);
  const exemptSpans = isSource ? [] : collectExemptSpans(text, opts?.exempt);
  const matchText = text.replace(/(?<=[A-Za-z%])[-–](?=[\d$])/g, ' ');
  const consumed: Span[] = [...skipSpans];
  const out: Figure[] = [];

  for (const m of matchText.matchAll(new RegExp(TIME_RE.source, TIME_RE.flags))) {
    const start = m.index!;
    const end = start + m[0].length;
    const span = { start, end };
    if (consumed.some((s) => overlaps(s, span))) continue;
    consumed.push(span);

    const raw = m[0];
    if (!isSource) {
      if (exemptSet.has(raw)) continue;
      if (exemptSpans.some((s) => s.start <= start && s.end >= end)) continue;
    }

    out.push({
      raw,
      value: Number(`${m[1]!}${m[2]!}`),
      unit: 'plain',
      precision: 1,
      sign: 0,
      index: start,
    });
  }

  for (const m of matchText.matchAll(new RegExp(RANGE_RE.source, RANGE_RE.flags))) {
    const start = m.index!;
    const end = start + m[0].length;
    const span = { start, end };
    if (consumed.some((s) => overlaps(s, span))) continue;
    consumed.push(span);

    const g = m.groups!;
    const lPrefix = g.lPrefix ?? '';
    const lNum = g.lNum!;
    const lSuffix = g.lSuffix ?? '';
    const sep = g.sep!;
    const rPrefix = g.rPrefix ?? '';
    const rNum = g.rNum!;
    const rSuffix = g.rSuffix ?? '';

    const effLeftPrefix = lPrefix || (rPrefix.includes('$') ? rPrefix : '');
    const effLeftSuffix = lSuffix || rSuffix;
    const effRightPrefix = rPrefix || (lPrefix.includes('$') ? '$' : '');

    const leftRaw = `${effLeftPrefix}${lNum}${effLeftSuffix}`;
    const leftSpanEnd = start + lPrefix.length + lNum.length + lSuffix.length;
    const rightIndex = leftSpanEnd + sep.length;
    const rightRaw = `${rPrefix}${rNum}${rSuffix}`;

    const first = buildNumericFigure(
      leftRaw,
      effLeftPrefix,
      lNum,
      effLeftSuffix,
      start,
      leftSpanEnd,
      opts,
      exemptSet,
      exemptSpans,
      isSource,
    );
    if (first) out.push(first);

    const second = buildNumericFigure(
      rightRaw,
      effRightPrefix,
      rNum,
      rSuffix,
      rightIndex,
      end,
      opts,
      exemptSet,
      exemptSpans,
      isSource,
    );
    if (second) out.push(second);
  }

  for (const m of matchText.matchAll(new RegExp(SINGLE_RE.source, SINGLE_RE.flags))) {
    const start = m.index!;
    const end = start + m[0].length;
    const span = { start, end };
    if (consumed.some((s) => overlaps(s, span))) continue;
    consumed.push(span);

    const g = m.groups!;
    const fig = buildNumericFigure(
      m[0],
      g.prefix ?? '',
      g.num!,
      g.suffix ?? '',
      start,
      end,
      opts,
      exemptSet,
      exemptSpans,
      isSource,
    );
    if (fig) out.push(fig);
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}

export function extractFigures(text: string, opts?: FigureCheckOptions): Figure[] {
  return extractFiguresInternal(text, opts, false);
}

function unitsCompatible(figUnit: FigureUnit, srcUnit: FigureUnit): boolean {
  if (figUnit === srcUnit) return true;
  return figUnit === 'plain' && srcUnit === 'currency';
}

export function isSupported(figure: Figure, sources: Figure[]): boolean {
  const figVal = Math.abs(figure.value);
  const p = figure.precision;
  const tol = p * 1e-6;

  for (const src of sources) {
    if (figure.sign * src.sign === -1) continue;
    if (!unitsCompatible(figure.unit, src.unit)) continue;
    const rounded = Math.round(Math.abs(src.value) / p) * p;
    if (Math.abs(rounded - figVal) <= tol) return true;
  }
  return false;
}

export function checkFigures(
  body: string,
  sourceTexts: string[],
  opts?: FigureCheckOptions,
): { ok: boolean; unsupported: Figure[]; corrections: string[] } {
  const bodyFigures = extractFigures(body, opts);
  const sources = extractFiguresInternal(sourceTexts.join('\n'), undefined, true);

  const seenRaw = new Set<string>();
  const unsupported: Figure[] = [];

  for (const fig of bodyFigures) {
    if (isSupported(fig, sources)) continue;
    if (seenRaw.has(fig.raw)) continue;
    seenRaw.add(fig.raw);
    unsupported.push(fig);
  }

  const corrections = unsupported.map(
    (fig) =>
      `The figure "${fig.raw}" is not in the evidence. Remove it or use a figure the evidence states; do not estimate or recall numbers.`,
  );

  return {
    ok: unsupported.length === 0,
    unsupported,
    corrections,
  };
}

export function figureAppearsIn(raw: string, text: string): boolean {
  const targets = extractFigures(raw);
  if (targets.length === 0) return false;
  const sources = extractFiguresInternal(text, undefined, true);
  return targets.every((fig) => isSupported(fig, sources));
}
