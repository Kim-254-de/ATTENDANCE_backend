"""Recommend FACE_MATCH_THRESHOLD and FACE_MATCH_MARGIN from real photos.

    python scripts/calibrate.py PHOTOS_DIR [--enroll 3] [--margin 0.05] [--json out.json]

PHOTOS_DIR has one folder per volunteer, each holding their photos:

    photos/
      volunteer-01/  01.jpg 02.jpg ... 08.jpg
      volunteer-02/  ...

The first --enroll photos of each person (by file name) play the enrollment;
the rest play terminal photos. Take them the way the system will be used: on
lecturers' phones, in real rooms, at arm's length. See docs/face-recognition.md
(phase 4) for how to collect them. Photos are only read, never copied or kept.
"""

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.calibration import Person, recommend, scores, sweep  # noqa: E402
from app.config import SERVICE_DIR  # noqa: E402
from app.engine import FaceEngine  # noqa: E402

# The API's own frame checks (FACE_MIN_FACE_PX, FACE_MIN_SHARPNESS defaults):
# a photo the terminal would refuse is left out here too.
MIN_FACE_PX = 80
MIN_SHARPNESS = 40
MAX_SIDE_PX = 1280
IMAGE_TYPES = {'.jpg', '.jpeg', '.png', '.webp'}


def load(path: Path) -> np.ndarray | None:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        return None
    longest = max(image.shape[:2])
    if longest > MAX_SIDE_PX:
        scale = MAX_SIDE_PX / longest
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return image


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('photos', type=Path)
    parser.add_argument('--enroll', type=int, default=3, help='photos per person used as the enrollment (default 3, as in the app)')
    parser.add_argument('--margin', type=float, default=0.05, help='FACE_MATCH_MARGIN to evaluate (default 0.05)')
    parser.add_argument('--json', type=Path, help='also write the full results here')
    args = parser.parse_args()

    engine = FaceEngine(SERVICE_DIR / 'models', 0.8)
    people: list[Person] = []
    skipped: list[str] = []

    for folder in sorted(p for p in args.photos.iterdir() if p.is_dir()):
        vectors = []
        for photo in sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_TYPES):
            image = load(photo)
            count, result = engine.embed(image) if image is not None else (0, None)
            reason = (
                'unreadable' if image is None
                else 'no face' if result is None
                else f'{count} faces' if count > 1
                else 'face too small' if result.face.width < MIN_FACE_PX
                else 'blurred' if result.sharpness < MIN_SHARPNESS
                else None
            )
            if reason:
                skipped.append(f'{folder.name}/{photo.name}: {reason}')
            else:
                vectors.append(np.array(result.vector))
        if len(vectors) <= args.enroll:
            skipped.append(f'{folder.name}: only {len(vectors)} usable photos, need at least {args.enroll + 1}')
            continue
        people.append(Person(folder.name, vectors[: args.enroll], vectors[args.enroll :]))

    if skipped:
        print('Left out:')
        for line in skipped:
            print(f'  {line}')
        print()
    if len(people) < 2:
        print('Need at least two people with enough usable photos.', file=sys.stderr)
        return 1

    genuine, impostor = scores(people)
    print(f'{len(people)} people, {sum(len(p.probes) for p in people)} terminal photos')
    print(f'same person:      min {min(genuine):.3f}  median {np.median(genuine):.3f}')
    print(f'different people: max {max(impostor):.3f}  median {np.median(impostor):.3f}')
    print()
    print(f'At FACE_MATCH_MARGIN={args.margin}:')
    print('threshold  correct  wrong-name  not-recognised  not-sure  enrollments-refused')
    outcomes = sweep(people, args.margin)
    for o in outcomes:
        print(f'  {o.threshold:5.3f}    {o.correct_rate:6.1%}  {o.wrong_person:10d}  {o.not_recognised:14d}  {o.ambiguous:8d}  {o.enrollments_refused:19d}')

    try:
        best = recommend(people, args.margin)
    except ValueError as error:
        print(f'\n{error}', file=sys.stderr)
        return 1
    print()
    print('Recommended (.env of the Node API):')
    print(f'  FACE_MATCH_THRESHOLD={best.threshold}')
    print(f'  FACE_MATCH_MARGIN={args.margin}')
    print(f'  -> {best.correct_rate:.1%} recognised first time, {best.wrong_person} wrong names, '
          f'{best.enrollments_refused} enrollments refused')
    if len(people) < 10:
        print('\nFewer than 10 people: treat this as a rough guide and collect more photos before relying on it.')

    if args.json:
        args.json.write_text(json.dumps({
            'people': len(people),
            'genuine': genuine,
            'impostor': impostor,
            'sweep': [asdict(o) for o in outcomes],
            'recommended': asdict(best),
            'skipped': skipped,
        }, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
