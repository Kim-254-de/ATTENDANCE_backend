export { smartttClient, SmartttHttpClient } from './smarttt.client.js';
export { normaliseUnitCode, toAuthenticatedAccount, toLecturerUnits, toStaffRecord, toStudentRecord, toStudentUnits } from './smarttt.mapper.js';
export type {
  SmartttAccount,
  SmartttAuthenticateResult,
  SmartttLecturerUnitsResult,
  SmartttSlot,
  SmartttStaffLookupResult,
  SmartttStaffRecord,
  SmartttStudent,
  SmartttStudentLookupResult,
  SmartttStudentRecord,
  SmartttStudentUnit,
  SmartttStudentUnitsResult,
  SmartttTerm,
  SmartttUnit,
} from './smarttt.types.js';
