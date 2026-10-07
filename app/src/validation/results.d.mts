import type { ValidationCase } from '../data/schema';
import type { RunResult } from './main';
export function frameLimitReason(c: ValidationCase, ss: number, limits: { maxTextureDimension2D: number }): string | null;
export function assessCase(c: ValidationCase, result: RunResult | null, opts?: { ss?: number; errors?: string[]; reason?: string | null }): RunResult;
