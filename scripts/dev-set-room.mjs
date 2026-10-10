// DEV ONLY. There is no administrator interface for rooms yet, so this stands in for it locally.
// Someone stands in the middle of the room with a phone, reads its position and accuracy, and runs:
//   npm run dev:set-room -- LH1 -0.3031 36.0800 8                   code, latitude, longitude, accuracy (m)
//   npm run dev:set-room -- LH1 -0.3031 36.0800 8 --name "Lecture Hall 1" --by STF/0001
//   npm run dev:set-room -- --list                                  timetabled rooms and whether each is surveyed
// Sessions activated afterwards are geofenced around this point (session.geofence.ts chooseCentre); sessions
// already running keep the centre they opened with. Writes an audit row. Refuses to run against production.
// Deliberately not something a lecturer can do: a lecturer who could move the room could move it to their students.
import 'dotenv/config';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') { console.error('Refusing to run in production.'); process.exit(1); }

const USAGE = 'Usage: npm run dev:set-room -- <ROOM_CODE> <LATITUDE> <LONGITUDE> <ACCURACY_M> [--name "<name>"] [--by <STAFF_NUMBER>]\n'
  + '       npm run dev:set-room -- --list';
// Same limit as a lecturer's device centre: every check-in is measured from this point.
const MAX_ACCURACY = Number(process.env.GEOFENCE_MAX_ANCHOR_ACCURACY_METRES || 30);
const normalise = (code) => code.trim().replace(/\s+/g, ' ').toUpperCase(); // as smarttt.mapper.ts normaliseRoomCode

const args = process.argv.slice(2);
const option = (flag) => {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined) { console.error(`${flag} needs a value.\n${USAGE}`); process.exit(1); }
  args.splice(i, 2);
  return value;
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

if (args[0] === '--list') {
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT codes.code, r.latitude, r.longitude, r.surveyed_accuracy_m, r.surveyed_at,
              (SELECT COUNT(*) FROM unit_schedule s WHERE s.room_code = codes.code)::int AS classes
         FROM (SELECT room_code AS code FROM unit_schedule WHERE room_code IS NOT NULL
               UNION SELECT code FROM rooms) codes
         LEFT JOIN rooms r ON r.code = codes.code
        ORDER BY codes.code`);
    if (rows.length === 0) console.log('No rooms yet. Rooms appear once the SMARTTT sync has run.');
    for (const r of rows) {
      const where = r.latitude === null
        ? 'NOT SURVEYED'
        : `${r.latitude}, ${r.longitude} ±${r.surveyed_accuracy_m ?? '?'} m (${r.surveyed_at.toISOString().slice(0, 10)})`;
      console.log(`${r.code.padEnd(16)} ${String(r.classes).padStart(3)} class(es)  ${where}`);
    }
  } finally { await client.end(); }
  process.exit(0);
}

const name = option('--name');
const by = option('--by')?.trim().toUpperCase();
const [rawCode, rawLat, rawLng, rawAccuracy] = args;
if (!rawCode || rawAccuracy === undefined || args.length !== 4) { console.error(USAGE); process.exit(1); }

// Strict: Number('') is 0 and parseFloat('36.08abc') is 36.08, and either would quietly put the room somewhere wrong.
const number = (text, label) => {
  if (!/^-?\d+(\.\d+)?$/.test(text)) { console.error(`${label} must be a decimal number, got "${text}".`); process.exit(1); }
  return Number(text);
};
const code = normalise(rawCode);
const latitude = number(rawLat, 'Latitude');
const longitude = number(rawLng, 'Longitude');
const accuracy = number(rawAccuracy, 'Accuracy');

if (Math.abs(latitude) > 90) { console.error('Latitude must be between -90 and 90. Are latitude and longitude swapped?'); process.exit(1); }
if (Math.abs(longitude) > 180) { console.error('Longitude must be between -180 and 180.'); process.exit(1); }
if (latitude === 0 && longitude === 0) { console.error('0, 0 is what a phone reports before it has a fix. Wait for a real reading.'); process.exit(1); }
if (accuracy <= 0) { console.error('Accuracy must be more than 0 m.'); process.exit(1); }
if (accuracy > MAX_ACCURACY) {
  console.error(`A ${accuracy} m reading is too vague to fence a room (limit ${MAX_ACCURACY} m). Stand away from walls, wait for the phone to settle and read again.`);
  process.exit(1);
}

await client.connect();
try {
  let surveyor = null;
  if (by) {
    const { rows: [u] } = await client.query(
      `SELECT u.id FROM users u JOIN lecturer_profiles p ON p.user_id = u.id WHERE p.staff_number = $1`, [by]);
    if (!u) throw new Error(`No user registered with staff number ${by}.`);
    surveyor = u.id;
  }

  await client.query('BEGIN');
  const { rows: [previous] } = await client.query(
    `SELECT latitude, longitude, surveyed_accuracy_m FROM rooms WHERE code = $1 FOR UPDATE`, [code]);
  await client.query(
    `INSERT INTO rooms (code, name, latitude, longitude, surveyed_accuracy_m, surveyed_at, surveyed_by_user_id)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6)
     ON CONFLICT (code) DO UPDATE
        SET name = COALESCE(EXCLUDED.name, rooms.name), latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
            surveyed_accuracy_m = EXCLUDED.surveyed_accuracy_m, surveyed_at = NOW(),
            surveyed_by_user_id = EXCLUDED.surveyed_by_user_id, updated_at = NOW()`,
    [code, name ?? null, latitude, longitude, accuracy, surveyor]);
  await client.query(
    `INSERT INTO audit_logs (action, outcome, user_id, subject_staff_number, reason, metadata)
     VALUES ('ROOM_SURVEYED', 'SUCCESS', $1, $2, 'surveyed via dev script', $3)`,
    [surveyor, by ?? null, JSON.stringify({
      dev: true, roomCode: code, latitude, longitude, accuracyMetres: accuracy,
      previous: previous?.latitude != null
        ? { latitude: previous.latitude, longitude: previous.longitude, accuracyMetres: previous.surveyed_accuracy_m }
        : null,
    })]);
  await client.query('COMMIT');

  const { rows: [{ classes }] } = await client.query(
    `SELECT COUNT(*)::int AS classes FROM unit_schedule WHERE room_code = $1`, [code]);
  console.log(`${code}: ${previous?.latitude != null ? 're-surveyed' : 'surveyed'} at ${latitude}, ${longitude} ±${accuracy} m`);
  console.log(`Check it on a map: https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=19/${latitude}/${longitude}`);
  if (classes === 0) {
    console.warn(`Warning: no timetabled class is in ${code} yet. Check the spelling against \`npm run dev:set-room -- --list\`.`);
  } else {
    console.log(`${classes} class(es) are timetabled here; sessions activated from now on are fenced to this point.`);
  }
} catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error(e.message); process.exitCode = 1; }
finally { await client.end(); }
