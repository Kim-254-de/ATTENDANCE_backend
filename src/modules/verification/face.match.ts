/**
 * Comparing face templates. Pure: no database, no HTTP, so the matching rules
 * can be tested exhaustively.
 *
 * face-service returns L2-normalised vectors, so cosine similarity is in
 * [-1, 1] and higher means more alike. A student has several templates (one
 * per enrollment photo); their score is the best of them, so one photo taken
 * at an angle does not drag a good match down.
 */

export type Vector = readonly number[];

export interface Candidate {
  studentUserId: string;
  templates: readonly Vector[];
}

export interface MatchRules {
  /** The score a face must reach to be offered as a match. */
  threshold: number;
  /** How far the best must lead the runner-up. */
  margin: number;
}

export type MatchOutcome =
  | { result: 'MATCH'; studentUserId: string; score: number; runnerUpScore: number | null }
  /** Two students scored too close to choose between. Nobody is offered. */
  | { result: 'AMBIGUOUS'; score: number; runnerUpScore: number }
  /** Nobody reached the threshold. `score` is the best seen, null with no candidates. */
  | { result: 'NO_MATCH'; score: number | null };

/** Cosine similarity. Normalises anyway, so a template stored unnormalised still compares correctly. */
export function cosineSimilarity(a: Vector, b: Vector): number {
  if (a.length !== b.length || a.length === 0) {
    throw new Error(`cannot compare templates of length ${a.length} and ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/** A candidate's score against a probe: their best template. */
export function scoreCandidate(probe: Vector, templates: readonly Vector[]): number {
  let best = -1;
  for (const template of templates) best = Math.max(best, cosineSimilarity(probe, template));
  return best;
}

/**
 * The one student this face belongs to, if the evidence is clear.
 *
 * The margin applies even when the runner-up is below the threshold: two
 * close scores mean the face is not distinctive in this frame, and offering
 * the wrong name is worse than asking for another try.
 */
export function bestMatch(probe: Vector, candidates: readonly Candidate[], rules: MatchRules): MatchOutcome {
  let best: { studentUserId: string; score: number } | null = null;
  let runnerUp: number | null = null;

  for (const candidate of candidates) {
    if (candidate.templates.length === 0) continue;
    const score = scoreCandidate(probe, candidate.templates);
    if (!best || score > best.score) {
      if (best) runnerUp = best.score;
      best = { studentUserId: candidate.studentUserId, score };
    } else if (runnerUp === null || score > runnerUp) {
      runnerUp = score;
    }
  }

  if (!best || best.score < rules.threshold) return { result: 'NO_MATCH', score: best?.score ?? null };
  if (runnerUp !== null && best.score - runnerUp < rules.margin) {
    return { result: 'AMBIGUOUS', score: best.score, runnerUpScore: runnerUp };
  }
  return { result: 'MATCH', studentUserId: best.studentUserId, score: best.score, runnerUpScore: runnerUp };
}

/**
 * The lowest similarity between any two of a set of templates. Enrollment
 * photos that do not agree with each other are not all of the same person, or
 * one of them is unusable.
 */
export function minPairwiseSimilarity(templates: readonly Vector[]): number {
  let lowest = 1;
  for (let i = 0; i < templates.length; i++) {
    for (let j = i + 1; j < templates.length; j++) {
      lowest = Math.min(lowest, cosineSimilarity(templates[i]!, templates[j]!));
    }
  }
  return lowest;
}

/** Scores rounded for storage, audit and display: finer than this means nothing. */
export const roundScore = (score: number): number => Math.round(score * 1000) / 1000;
