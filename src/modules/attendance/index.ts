export { attendanceRouter } from './attendance.routes.js';
export * as attendanceService from './attendance.service.js';
/** For terminal.schema.ts: a paired terminal sends the same card, barcode and finger fields. */
export { barcodeCheckInSchema, cardCheckInSchema, fingerprintCheckInSchema } from './attendance.schema.js';
