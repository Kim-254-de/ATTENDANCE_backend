import { query } from '../../db/database.js';

/** Bare id/name lookups so a QA officer can pick an audit's target by name. Every value is parameterised (none are needed here). */

export interface DirectoryRow {
  id: string;
  name: string;
}

export async function listDepartments(): Promise<DirectoryRow[]> {
  const { rows } = await query<DirectoryRow>(`SELECT id, name FROM departments ORDER BY name`);
  return rows;
}

export async function listFaculties(): Promise<DirectoryRow[]> {
  const { rows } = await query<DirectoryRow>(`SELECT id, name FROM faculties ORDER BY name`);
  return rows;
}
