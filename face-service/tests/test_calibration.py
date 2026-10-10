"""The calibration rules, on hand-made vectors whose similarities are known."""

import numpy as np
import pytest

from app.calibration import FLOOR, Person, min_agreement, recommend, scores, simulate


def at(degrees: float) -> np.ndarray:
    """A unit vector in the plane: the cosine between two of them is cos(difference)."""
    r = np.radians(degrees)
    return np.array([np.cos(r), np.sin(r)])


def person(name: str, centre: float, spread: float = 5) -> Person:
    """Three enrollment photos and two terminal photos, all within `spread` degrees of `centre`."""
    return Person(name, [at(centre), at(centre + spread), at(centre - spread)], [at(centre + spread / 2), at(centre - spread / 2)])


# Far enough apart that nobody looks like anyone else.
CLASS = [person('a', 0), person('b', 90), person('c', 180), person('d', 270)]


def test_scores_split_genuine_from_impostor():
    genuine, impostor = scores(CLASS)
    assert len(genuine) == 8 and len(impostor) == 8 * 3
    assert min(genuine) > 0.99
    assert max(impostor) < 0.2  # cos(82.5°): the closest two photos of different people


def test_simulate_recognises_everyone_in_a_distinct_class():
    outcome = simulate(CLASS, threshold=0.5, margin=0.05)
    assert (outcome.correct, outcome.wrong_person, outcome.not_recognised, outcome.ambiguous) == (8, 0, 0, 0)


def test_too_high_a_threshold_refuses_enrollments_whose_photos_vary():
    # Enrollment photos 60 degrees apart agree at cos(60) = 0.5.
    loose = [person('a', 0, spread=30), person('b', 180, spread=30)]
    assert simulate(loose, threshold=0.45, margin=0.05).enrollments_refused == 0
    assert simulate(loose, threshold=0.55, margin=0.05).enrollments_refused == 2


def test_too_high_a_threshold_recognises_nobody():
    outcome = simulate(CLASS, threshold=1.01, margin=0.05)
    assert outcome.not_recognised == outcome.probes


def test_look_alikes_are_not_sure_rather_than_wrong():
    twins = [person('a', 0), person('b', 2), person('c', 180)]
    outcome = simulate(twins, threshold=0.5, margin=0.05)
    assert outcome.wrong_person == 0
    assert outcome.ambiguous == 4


def test_recommend_never_goes_below_the_published_floor():
    assert recommend(CLASS).threshold >= FLOOR


def test_recommend_clears_the_worst_impostor():
    close = [person('a', 0), person('b', 50), person('c', 180)]  # a and b score cos(50) = 0.64 against each other
    best = recommend(close)
    assert best.wrong_person == 0
    assert best.threshold >= 0.64 + 0.05


def test_min_agreement():
    assert min_agreement([at(0), at(10), at(40)]) == pytest.approx(np.cos(np.radians(40)))
