import { Router } from 'express';
import { auditRouter } from './audit.routes.js';
import { capaRouter } from './capa.routes.js';
import { checklistRouter } from './checklist.routes.js';
import { directoryRouter } from './directory.routes.js';
import { kpiRouter } from './kpi.routes.js';
import { standardsRouter } from './standards.routes.js';

/**
 * Internal Quality Assurance: standards catalog, checklist templates,
 * audits + findings, corrective actions (CAPA), and the KPI dashboard.
 * Every sub-router gates its own routes to the QA role — see each one's
 * file for its endpoint table.
 */
export const qaRouter: Router = Router();

qaRouter.use('/standards', standardsRouter);
qaRouter.use('/checklist-templates', checklistRouter);
qaRouter.use('/audits', auditRouter);
qaRouter.use('/corrective-actions', capaRouter);
qaRouter.use('/dashboard', kpiRouter);
qaRouter.use(directoryRouter);
