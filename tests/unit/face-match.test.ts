import { describe, expect, it } from 'vitest';
import {
  bestMatch,
  cosineSimilarity,
  minPairwiseSimilarity,
  scoreCandidate,
} from '../../src/modules/verification/face.match.js';

const rules = { threshold: 0.4, margin: 0.05 };

/** A unit vector at `degrees` in the plane: cosine between two of them is cos(difference). */
const at = (degrees: number) => [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];

describe('cosineSimilarity', () => {
  it('is 1 for the same direction, whatever the length', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  });

  it('is 0 for orthogonal vectors and for a zero vector', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('refuses templates of different lengths', () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow();
  });
});

describe('scoreCandidate', () => {
  it("is the best of the student's templates", () => {
    expect(scoreCandidate(at(0), [at(80), at(10), at(60)])).toBeCloseTo(Math.cos((10 * Math.PI) / 180));
  });
});

describe('bestMatch', () => {
  it('matches the closest student above the threshold', () => {
    const outcome = bestMatch(at(0), [
      { studentUserId: 'far', templates: [at(80)] },
      { studentUserId: 'near', templates: [at(80), at(5)] },
    ], rules);
    expect(outcome).toMatchObject({ result: 'MATCH', studentUserId: 'near' });
  });

  it('matches nobody below the threshold, and reports the best score seen', () => {
    const outcome = bestMatch(at(0), [{ studentUserId: 'a', templates: [at(70)] }], rules);
    expect(outcome.result).toBe('NO_MATCH');
    expect(outcome.score).toBeCloseTo(Math.cos((70 * Math.PI) / 180));
  });

  it('matches nobody when nobody is enrolled', () => {
    expect(bestMatch(at(0), [], rules)).toEqual({ result: 'NO_MATCH', score: null });
    expect(bestMatch(at(0), [{ studentUserId: 'a', templates: [] }], rules)).toEqual({ result: 'NO_MATCH', score: null });
  });

  it('refuses to choose between two students scoring within the margin', () => {
    const outcome = bestMatch(at(0), [
      { studentUserId: 'a', templates: [at(10)] },
      { studentUserId: 'b', templates: [at(12)] },
    ], rules);
    expect(outcome.result).toBe('AMBIGUOUS');
  });

  it('applies the margin whichever order the candidates come in', () => {
    const a = { studentUserId: 'a', templates: [at(12)] };
    const b = { studentUserId: 'b', templates: [at(10)] };
    const c = { studentUserId: 'c', templates: [at(85)] };
    expect(bestMatch(at(0), [a, b, c], rules).result).toBe('AMBIGUOUS');
    expect(bestMatch(at(0), [c, b, a], rules).result).toBe('AMBIGUOUS');
  });

  it('matches when the runner-up is clearly behind', () => {
    const outcome = bestMatch(at(0), [
      { studentUserId: 'a', templates: [at(5)] },
      { studentUserId: 'b', templates: [at(50)] },
    ], rules);
    expect(outcome).toMatchObject({ result: 'MATCH', studentUserId: 'a' });
    expect(outcome.result === 'MATCH' && outcome.runnerUpScore).toBeCloseTo(Math.cos((50 * Math.PI) / 180));
  });
});

describe('minPairwiseSimilarity', () => {
  it('is the least similar pair', () => {
    expect(minPairwiseSimilarity([at(0), at(10), at(40)])).toBeCloseTo(Math.cos((40 * Math.PI) / 180));
  });

  it('is 1 for a single template', () => {
    expect(minPairwiseSimilarity([at(0)])).toBe(1);
  });
});
