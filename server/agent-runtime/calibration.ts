// Persisted, bounded token calibration per provider instance/model.
// Used by the agent turn kernel to refine token estimates from provider-reported usage.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";

const CALIBRATION_DIR = join(DATA_DIR, "calibration");
const CALIBRATION_FILE = (providerInstanceId: string, modelId: string) =>
  join(CALIBRATION_DIR, `${providerInstanceId}__${modelId.replace(/[/\\]/g, "_")}.json`);

/** Calibration record for one provider instance + model pair. */
export interface CalibrationRecord {
  readonly providerInstanceId: string;
  readonly modelId: string;
  /** Learned ratio: reportedTokens / estimatedTokens, bounded to [1, 3]. */
  readonly ratio: number;
  /** Number of observations used to compute the ratio. */
  readonly observations: number;
  /** Last updated timestamp. */
  readonly updatedAt: number;
}

/** Default calibration ratio when no data exists. */
const DEFAULT_RATIO = 1.0;
/** Maximum calibration ratio (never scale estimates up by more than 3x). */
const MAX_RATIO = 3.0;
/** Minimum calibration ratio (never scale estimates down). */
const MIN_RATIO = 1.0;
/** Maximum observations to track (bounds memory growth). */
const MAX_OBSERVATIONS = 1000;

/** In-memory cache for active calibrations during a process lifetime. */
const calibrationCache = new Map<string, CalibrationRecord>();

/** Get the cache key for a provider instance + model pair. */
function cacheKey(providerInstanceId: string, modelId: string): string {
  return `${providerInstanceId}:${modelId}`;
}

/** Load a calibration record from disk, or return defaults. */
export function loadCalibration(providerInstanceId: string, modelId: string): CalibrationRecord {
  const key = cacheKey(providerInstanceId, modelId);
  const cached = calibrationCache.get(key);
  if (cached) return cached;

  const file = CALIBRATION_FILE(providerInstanceId, modelId);
  if (!existsSync(file)) {
    const record: CalibrationRecord = {
      providerInstanceId,
      modelId,
      ratio: DEFAULT_RATIO,
      observations: 0,
      updatedAt: Date.now(),
    };
    calibrationCache.set(key, record);
    return record;
  }

  try {
    const content = readFileSync(file, "utf8");
    const parsed = JSON.parse(content) as CalibrationRecord;
    // Validate and bound the ratio
    const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, parsed.ratio ?? DEFAULT_RATIO));
    const record: CalibrationRecord = {
      ...parsed,
      ratio,
      observations: Math.min(MAX_OBSERVATIONS, parsed.observations ?? 0),
    };
    calibrationCache.set(key, record);
    return record;
  } catch {
    const record: CalibrationRecord = {
      providerInstanceId,
      modelId,
      ratio: DEFAULT_RATIO,
      observations: 0,
      updatedAt: Date.now(),
    };
    calibrationCache.set(key, record);
    return record;
  }
}

/** Save a calibration record to disk. */
export function saveCalibration(record: CalibrationRecord): void {
  const key = cacheKey(record.providerInstanceId, record.modelId);
  calibrationCache.set(key, record);

  try {
    mkdirSync(CALIBRATION_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CALIBRATION_FILE(record.providerInstanceId, record.modelId), JSON.stringify(record), { mode: 0o600 });
  } catch {
    // Best-effort persistence; in-memory cache keeps the value for this process.
  }
}

/** Observe a new (estimated, reported) pair and update the calibration.
 *  Uses exponential moving average with bounded ratio. */
export function observeCalibration(
  providerInstanceId: string,
  modelId: string,
  estimated: number,
  reported: number | undefined,
): CalibrationRecord {
  if (!reported || reported <= 0 || estimated <= 0) {
    return loadCalibration(providerInstanceId, modelId);
  }

  const current = loadCalibration(providerInstanceId, modelId);
  const newRatio = reported / estimated;
  const boundedRatio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, newRatio));

  // Exponential moving average: weight new observation by 1/(observations+1)
  const weight = 1 / (current.observations + 1);
  const updatedRatio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, current.ratio * (1 - weight) + boundedRatio * weight));

  const updated: CalibrationRecord = {
    providerInstanceId,
    modelId,
    ratio: updatedRatio,
    observations: Math.min(MAX_OBSERVATIONS, current.observations + 1),
    updatedAt: Date.now(),
  };

  saveCalibration(updated);
  return updated;
}

/** Apply the learned calibration to an estimated token count. */
export function applyCalibration(providerInstanceId: string, modelId: string, estimated: number): number {
  const record = loadCalibration(providerInstanceId, modelId);
  return Math.ceil(estimated * record.ratio);
}

/** Reset calibration for a provider instance + model (for testing). */
export function resetCalibration(providerInstanceId: string, modelId: string): void {
  const key = cacheKey(providerInstanceId, modelId);
  calibrationCache.delete(key);
  const file = CALIBRATION_FILE(providerInstanceId, modelId);
  try {
    if (existsSync(file)) {
      // Don't delete; just reset in-memory. Disk file will be overwritten on next save.
    }
  } catch {}
}

/** Get all calibration records in memory for debugging/inspection. */
export function listCalibrations(): CalibrationRecord[] {
  return Array.from(calibrationCache.values());
}