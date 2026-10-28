import { describe, expect, it } from 'vitest';
import { examSessionsPushSchema, termModePushSchema } from '../../src/modules/exam/exam.schema.js';
import { campusInstant } from '../../src/modules/exam/exam.service.js';

/** SMARTTT's exam pushes (attendance_push.py there) and campus times. */
const session = {
  key: 'COSC 130|LH1',
  paper_key: 'COSC 130',
  unit_codes: ['COSC 130'],
  title: 'Programming',
  date: '2026-11-23',
  start_time: '08:30',
  end_time: '10:30',
  room: 'LH1',
  candidates: [{ class_rows: [{ program: 'BSC.COMP SCI', year_of_study: 1 }], reg_from: null, reg_to: null, students: 2 }],
  registration_numbers: ['sct211-0001/2022'],
  invigilator_staff_number: 'STF/0001',
  role: 'main',
  main_invigilator_staff_number: 'STF/0001',
};

describe('exam sessions push', () => {
  it('accepts what SMARTTT sends', () => {
    const parsed = examSessionsPushSchema.parse({ term_id: '7', version: 2, sessions: [session] });
    expect(parsed.sessions[0]).toMatchObject({ room: 'LH1', role: 'main' });
  });

  it('refuses a bad time, role or empty unit codes', () => {
    for (const bad of [{ start_time: '8:30' }, { end_time: '24:00' }, { role: 'chief' }, { unit_codes: [] }, { date: '23/11/2026' }]) {
      expect(examSessionsPushSchema.safeParse({ term_id: '7', version: 1, sessions: [{ ...session, ...bad }] }).success).toBe(false);
    }
  });

  it('takes a term mode with or without times', () => {
    expect(termModePushSchema.parse({ term_id: '7', mode: 'exams', switched_at: '2026-11-20T06:00:00+03:00', closed_at: null }).mode).toBe('exams');
    expect(termModePushSchema.safeParse({ term_id: '7', mode: 'holiday' }).success).toBe(false);
  });
});

describe('campusInstant', () => {
  it('reads a date and time on campus', () => {
    // Nairobi is UTC+3 all year.
    expect(campusInstant('2026-11-23', '08:30').toISOString()).toBe('2026-11-23T05:30:00.000Z');
  });
});
