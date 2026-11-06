// Settings values, read through the device HTTP API (GET /api/apps/settings?app_id=...),
// which is the documented path for JavaScript apps. The `Settings` global some runtimes
// provide is used first when present.

import { device } from "@shared/device";

/** Stored values: a flat field_id → value map (groups nest as objects). */
export type SettingsValues = Record<string, unknown>;

interface SettingsApi {
  load(): Promise<{ values?: SettingsValues } | SettingsValues>;
}

function globalApi(): SettingsApi | undefined {
  return (globalThis as { Settings?: SettingsApi }).Settings;
}

/** Reads the stored values for the app, or null when they cannot be read. */
export async function loadValues(appId: string): Promise<SettingsValues | null> {
  const api = globalApi();
  if (api) {
    try {
      const result = await api.load();
      const values = (result as { values?: SettingsValues }).values ?? result;
      return values as SettingsValues;
    } catch {
      // fall through to the HTTP API
    }
  }
  try {
    const doc = await device.AppsSettingsGet({ app_id: appId });
    return (doc.values ?? null) as SettingsValues | null;
  } catch {
    return null;
  }
}

/** A string setting, or the fallback when missing or of another type. */
export function str(values: SettingsValues | null, key: string, fallback: string): string {
  const v = values?.[key];
  return typeof v === "string" ? v : fallback;
}

/** A number setting, or the fallback when missing or not finite. */
export function num(values: SettingsValues | null, key: string, fallback: number): number {
  const v = values?.[key];
  return typeof v === "number" && isFinite(v) ? v : fallback;
}

/** A boolean setting, or the fallback when missing or of another type. */
export function bool(values: SettingsValues | null, key: string, fallback: boolean): boolean {
  const v = values?.[key];
  return typeof v === "boolean" ? v : fallback;
}
