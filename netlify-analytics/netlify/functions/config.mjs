import { dashboardConfig } from '../../src/api.js';
import { json } from '../lib/shared.mjs';

export default async () => json(dashboardConfig());

export const config = { path: '/api/config' };
