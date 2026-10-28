# Room survey sheet

One block per room. Fill it in while standing in the room, then run the
command at the bottom of the block. Copy a blank block for each extra room.

---

## Before you start

- [ ] Run `npm run dev:set-room -- --list` and copy the room codes into the summary table below, **exactly as listed**
- [ ] Phone has **precise location** on (not approximate), and Wi-Fi on
- [ ] An app that shows accuracy is installed (Android: "GPS Test" / "GPS Status"; iPhone: Google Maps pin)
- [ ] Laptop with the backend, or note the readings here and enter them later

**Rules of thumb**

- Stand in the **centre of the seating area**, not at the lecturer's desk
- Wait **30-60 s** for the accuracy to settle before writing a reading down
- Write coordinates with **at least 5 decimal places** (`-0.37031`, not `-0.3703`)
- Latitude on campus is about **-0.37** (negative); longitude about **+35.9**
- Accuracy must be **30 m or better** (the script refuses worse); aim for **10 m or better**
- Indoor GPS stuck above 20 m? Use a satellite-map pin instead (method **B**) and record accuracy as about 5

---

## Summary

| # | Room code | Name | Building / floor | Surveyed (date) | Accuracy (m) | Corners OK | Outside refused | Done |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | ☐ | ☐ | ☐ |
| 2 | | | | | | ☐ | ☐ | ☐ |
| 3 | | | | | | ☐ | ☐ | ☐ |
| 4 | | | | | | ☐ | ☐ | ☐ |
| 5 | | | | | | ☐ | ☐ | ☐ |
| 6 | | | | | | ☐ | ☐ | ☐ |
| 7 | | | | | | ☐ | ☐ | ☐ |
| 8 | | | | | | ☐ | ☐ | ☐ |
| 9 | | | | | | ☐ | ☐ | ☐ |
| 10 | | | | | | ☐ | ☐ | ☐ |

---

## Room 1

| Field | Value |
|---|---|
| Room code (from `--list`) | |
| Room name | |
| Building / floor | |
| Approx. size (m × m) | |
| Date / time | |
| Surveyor name | |
| Surveyor staff number | |
| Phone model | |
| App used | |
| Method | ☐ **A** Phone GPS in the room ☐ **B** Satellite-map pin |

### Readings

| # | Time | Latitude | Longitude | Accuracy (m) |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| **Chosen** (smallest accuracy) | | | | |

- [ ] Map link printed by the script shows the pin in the right building and the right part of it

### Command run

```bash
npm run dev:set-room -- <CODE> <LATITUDE> <LONGITUDE> <ACCURACY> --name "<NAME>" --by <STAFF_NUMBER>
```

```bash

```

### Verification

Activate a test session in the room and check in from each corner.

| Position | Accepted? | Distance shown (m) |
|---|---|---|
| Front left | ☐ Yes ☐ No | |
| Front right | ☐ Yes ☐ No | |
| Back left | ☐ Yes ☐ No | |
| Back right | ☐ Yes ☐ No | |
| Outside the building (should be refused) | ☐ Refused ☐ Accepted | |

- [ ] Re-surveyed after a failed check (note why below)

**Notes** (poor signal spots, room bigger than 40 m across, stacked rooms, etc.)

>

---

## Room 2

| Field | Value |
|---|---|
| Room code (from `--list`) | |
| Room name | |
| Building / floor | |
| Approx. size (m × m) | |
| Date / time | |
| Surveyor name | |
| Surveyor staff number | |
| Phone model | |
| App used | |
| Method | ☐ **A** Phone GPS in the room ☐ **B** Satellite-map pin |

### Readings

| # | Time | Latitude | Longitude | Accuracy (m) |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| **Chosen** (smallest accuracy) | | | | |

- [ ] Map link printed by the script shows the pin in the right building and the right part of it

### Command run

```bash

```

### Verification

| Position | Accepted? | Distance shown (m) |
|---|---|---|
| Front left | ☐ Yes ☐ No | |
| Front right | ☐ Yes ☐ No | |
| Back left | ☐ Yes ☐ No | |
| Back right | ☐ Yes ☐ No | |
| Outside the building (should be refused) | ☐ Refused ☐ Accepted | |

- [ ] Re-surveyed after a failed check (note why below)

**Notes**

>

---

## Room 3

| Field | Value |
|---|---|
| Room code (from `--list`) | |
| Room name | |
| Building / floor | |
| Approx. size (m × m) | |
| Date / time | |
| Surveyor name | |
| Surveyor staff number | |
| Phone model | |
| App used | |
| Method | ☐ **A** Phone GPS in the room ☐ **B** Satellite-map pin |

### Readings

| # | Time | Latitude | Longitude | Accuracy (m) |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| **Chosen** (smallest accuracy) | | | | |

- [ ] Map link printed by the script shows the pin in the right building and the right part of it

### Command run

```bash

```

### Verification

| Position | Accepted? | Distance shown (m) |
|---|---|---|
| Front left | ☐ Yes ☐ No | |
| Front right | ☐ Yes ☐ No | |
| Back left | ☐ Yes ☐ No | |
| Back right | ☐ Yes ☐ No | |
| Outside the building (should be refused) | ☐ Refused ☐ Accepted | |

- [ ] Re-surveyed after a failed check (note why below)

**Notes**

>

---

## Rooms that need follow-up

Rooms wider than about 40 m (need a bigger radius), rooms where no reading got
under 30 m, or rooms that failed verification.

| Room code | Problem | Action needed |
|---|---|---|
| | | |
| | | |
| | | |
