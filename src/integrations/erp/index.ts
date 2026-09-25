export { erpClient, ErpHttpClient } from './erp.client.js';
export { compareIdentity, namesMatch } from './erp.identity.js';
export { toCourseRecord, toEnrollmentRecords, toStaffRecord, toStudentRecord } from './erp.mapper.js';
export type {
  ClaimedIdentity,
  ErpCourseLookupResult,
  ErpCourseRecord,
  ErpEnrollmentsResult,
  ErpLookupResult,
  ErpLookupStatus,
  ErpProvider,
  ErpStaffRecord,
  ErpStudentLookupResult,
  ErpStudentRecord,
} from './erp.types.js';
