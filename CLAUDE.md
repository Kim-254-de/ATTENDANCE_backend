# Working in this repo

## GAPS.md: the frontend ↔ backend list

`GAPS.md` at the repo root is how the frontend lead and the backend team tell each other
what they've found. Every AI assistant working here keeps it current.

**At the start of every session, and after every `git pull`:**

1. Read `GAPS.md`.
2. Work out who you're helping from `git config user.name`. **Wayler K** / **Wayler0** is the
   frontend lead; anyone else is on the backend team.
3. Before starting their task, tell them in a few lines about the open entries addressed to
   them: `B-` entries ("For the backend team") for the backend team, `F-` entries ("For the
   frontend team") for the frontend lead. Mention only entries that are open or new since
   their last pull. If none are open, say nothing.

**While working, add an `F-` entry under "For the frontend team"** whenever you:

- add, rename or remove an endpoint, a request or response field, an error code or an enum value;
- change auth, roles, permissions, rate limits, pagination, or the time and date formats;
- change behaviour that a screen depends on (validation rules, what is locked when, what
  publishing does);
- notice something wrong or missing in a frontend while reading its code (a call to a route
  that no longer exists, a field it never sends, a state it doesn't handle).

Include the endpoint, an example request and response for anything new, and the commit. Add
`B-` entries under "For the backend team" the same way when the frontend side notices backend gaps.

**Closing entries:** when you finish one, set its status to `done (<commit>)`. Don't delete it.
Never delete or rewrite the other side's entries; add a reply line under it instead
(`- **Reply (<date>, <who>):** …`). Number new entries one above the highest in their section.

Commit `GAPS.md` with the change it describes, so the other side sees both in the same pull.
