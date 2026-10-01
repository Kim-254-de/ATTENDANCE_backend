# SMARTTT integration

SMARTTT is the university timetable system (Django, `Kim-254-de/SMARTTT_BACKEND`).
This client asks it which units a lecturer is timetabled to teach this term,
how many students are registered for each, and who they are (registration
number and name) for each unit's roster (`unit.service.ts
syncUnitsFromTimetable`). It also checks staff and registration numbers at
registration (`auth.service.ts`, `student.directory.ts`), and lists the
classes a student is registered for (`student.service.ts
syncMyUnitsFromTimetable`, `SMARTTT_STUDENT_UNITS_PATH`, see
`src/modules/student/README.md`).

## Endpoint on the SMARTTT side

```
GET {SMARTTT_BASE_URL}{SMARTTT_LECTURER_UNITS_PATH}?staff_number=STF/0001&name=Dr.%20Peter%20Kamami
X-API-Key: {SMARTTT_API_KEY}
```

Served by `apps/integrations` in SMARTTT. `SMARTTT_API_KEY` here must equal
`ATTENDANCE_API_KEY` there. `name` lets SMARTTT match department-allocation
slots when the staff number has no SMARTTT account yet.

```json
{
  "staff_number": "STF/0001",
  "lecturer_account": true,
  "term": { "academic_year": "2025/2026", "semester": 1 },
  "units": [
    {
      "code": "COSC 103 GR A", "unit_code": "COSC 103", "group": "GR A",
      "name": "Computer Applications", "registered_students": 150,
      "students_without_group": 40,
      "matched_by": "account",
      "students": [{ "registration_number": "EBT1/08223/23", "full_name": "Peter Kamami" }],
      "slots": [{ "day_of_week": 1, "start_time": "08:00", "end_time": "10:00",
                  "room": "LH1", "class_group": "MAIN", "program": "BSc CS" }]
    }
  ]
}
```

One entry per class: a unit split into groups taught by different lecturers
appears once per group the lecturer is allocated, with only that group's
students (StudentUnit.class_group). A unit that isn't split has `group: null`
and `code` equal to `unit_code`.

`day_of_week` is 0=Sunday..6=Saturday, the same as `unit_schedule`.
`students` can be shorter than `registered_students`: SMARTTT leaves out
students with no registration number, since they can't be put on a roster.

## Results

| SMARTTT answers | Client returns |
|---|---|
| 200, parseable | `FOUND` |
| 404 | `NOT_FOUND` (no such lecturer) |
| 401 / 403 | `UNAVAILABLE`, logged as an error: the keys don't match |
| Anything else, timeout, unparseable body | `UNAVAILABLE` |
| `SMARTTT_BASE_URL` unset | `DISABLED` |

No retries: a lecturer is waiting on the units page, and the sync falls back
to the units already on file.

## The other way: SMARTTT tells us a class moved

A lecturer (or admin) rescheduling a slot in SMARTTT
(`POST /api/v1/timetable/slots/{id}/reschedule/`) changes the day, time or
room that this service gates activation on and fences check-ins to. Our own
sync only re-reads the timetable when a lecturer loads their units (or the
Activate Class card), at most every `SMARTTT_SYNC_INTERVAL_SECONDS`, so
SMARTTT pushes the change straight away
(`apps/integrations/attendance_push.py` there):

```
POST /api/v1/integrations/smarttt/timetable-changes
X-API-Key: {SMARTTT_API_KEY}
{ "staff_number": "STF/0001", "unit_codes": ["COSC 103 GR A"] }
```

Served by `src/modules/integration`. Every lecturer it names (by staff
number, or as the holder of one of the classes) is re-synced at once,
skipping the throttle; the answer is `{ "lecturersResynced": n }`. Same
shared key both ways. On the SMARTTT side set `ATTENDANCE_BASE_URL` to this
service's URL; unset, the push is off and the periodic sync still catches up.
The push is best effort: it never blocks or fails the reschedule.

A running session is not moved: it keeps the window and fence it opened with.
