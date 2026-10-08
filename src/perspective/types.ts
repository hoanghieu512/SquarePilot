export type PerspectiveKind = 'angle' | 'lens' | 'tension';

export interface Perspective {
  kind: PerspectiveKind;
  /** Angle file path, lens id, or tension row id. */
  ref: string;
  /** One line stating the point of view this post is written from. */
  summary: string;
  /** Concrete, checkable facts backing it. Never empty. */
  evidence: string[];
  /** Constraints carried down from the source, e.g. a campaign's rules. */
  guardrails: string[];
}

export interface Rejection {
  rung: PerspectiveKind;
  candidate: string;
  reason: string;
}

export type SelectionResult =
  | { outcome: PerspectiveKind; perspective: Perspective; rejected: Rejection[] }
  | { outcome: 'stop'; rejected: Rejection[] };
