"""Choosing FACE_MATCH_THRESHOLD and FACE_MATCH_MARGIN from real photos.

Pure: takes embeddings, returns numbers. scripts/calibrate.py feeds it photos.

The rules mirror the Node API (src/modules/verification/face.match.ts), so a
threshold chosen here behaves the same in production:

  - a student's score is their best enrollment template's cosine similarity
  - a match needs score >= threshold and a lead of >= margin over the runner-up
  - an enrollment needs its photos to agree with each other at >= threshold
"""

from dataclasses import dataclass

import numpy as np

Vector = np.ndarray


@dataclass(frozen=True)
class Person:
    name: str
    enrollment: list[Vector]
    probes: list[Vector]


@dataclass(frozen=True)
class Outcome:
    """What the terminal would do with every probe photo, at one threshold and margin."""

    threshold: float
    margin: float
    probes: int
    correct: int
    # The worst outcome: the lecturer is offered someone else's name.
    wrong_person: int
    not_recognised: int
    ambiguous: int
    # Enrollments that would be refused because their own photos disagree.
    enrollments_refused: int

    @property
    def correct_rate(self) -> float:
        return self.correct / self.probes if self.probes else 0.0


def cosine(a: Vector, b: Vector) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    return float(np.dot(a, b) / (na * nb)) if na and nb else 0.0


def score(probe: Vector, templates: list[Vector]) -> float:
    return max(cosine(probe, t) for t in templates)


def min_agreement(templates: list[Vector]) -> float:
    pairs = [cosine(templates[i], templates[j]) for i in range(len(templates)) for j in range(i + 1, len(templates))]
    return min(pairs) if pairs else 1.0


def scores(people: list[Person]) -> tuple[list[float], list[float]]:
    """Genuine scores (a probe against its own person) and impostor scores (against everyone else)."""
    genuine, impostor = [], []
    for person in people:
        for probe in person.probes:
            genuine.append(score(probe, person.enrollment))
            impostor.extend(score(probe, other.enrollment) for other in people if other is not person)
    return genuine, impostor


def simulate(people: list[Person], threshold: float, margin: float) -> Outcome:
    """Every probe through the terminal's rules, with everyone else enrolled on the same unit."""
    correct = wrong = none = ambiguous = 0
    for person in people:
        for probe in person.probes:
            ranked = sorted(((score(probe, p.enrollment), p.name) for p in people), reverse=True)
            best, name = ranked[0]
            runner_up = ranked[1][0] if len(ranked) > 1 else None
            if best < threshold:
                none += 1
            elif runner_up is not None and best - runner_up < margin:
                ambiguous += 1
            elif name == person.name:
                correct += 1
            else:
                wrong += 1
    refused = sum(1 for p in people if min_agreement(p.enrollment) < threshold)
    return Outcome(threshold, margin, correct + wrong + none + ambiguous, correct, wrong, none, ambiguous, refused)


def sweep(people: list[Person], margin: float, start: float = 0.25, stop: float = 0.7, step: float = 0.025) -> list[Outcome]:
    thresholds = np.round(np.arange(start, stop + step / 2, step), 3)
    return [simulate(people, float(t), margin) for t in thresholds]


# Never recommend below OpenCV's published SFace threshold: a small sample
# can make a looser one look safe when it isn't.
FLOOR = 0.363
# Room above the worst impostor score seen, for the faces not in the sample.
HEADROOM = 0.05


def recommend(people: list[Person], margin: float = 0.05) -> Outcome:
    """The lowest threshold that offers nobody a wrong name, keeps every enrollment, and clears every impostor score by HEADROOM.

    Lowest, because every step up turns more of the right students into
    "not recognised" retries. If no threshold keeps every enrollment, the one
    that offers no wrong names is still returned; check `enrollments_refused`.
    """
    _, impostor = scores(people)
    floor = max(FLOOR, (max(impostor) + HEADROOM) if impostor else FLOOR)
    candidates = [o for o in sweep(people, margin, start=0.3, stop=0.8) if o.threshold >= floor and o.wrong_person == 0]
    if not candidates:
        raise ValueError('No threshold up to 0.8 avoids offering a wrong name. Check the photos are labelled correctly.')
    keeping = [o for o in candidates if o.enrollments_refused == 0]
    return (keeping or candidates)[0]
