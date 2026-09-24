export { unitRouter } from './unit.routes.js';
export * as unitService from './unit.service.js';
/** For student registration: attach lecturer-made allocations to a new student account. */
export { linkAllocationsToStudent } from './unit.repository.js';
/** For session.service.ts: the activation time gate needs a unit's issued slot. */
export { findUnitSchedule } from './unit.repository.js';
