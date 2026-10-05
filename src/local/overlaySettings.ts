export interface OverlaySettings {
  detail: 'detailed' | 'off';
  abilityTipMode: 'points' | 'fixed';
  tipSeconds: number;
  pointLimitSeconds: number;
  /** Missing in older saved settings; absence means enabled. */
  showTeamWinRates?: boolean;
}
export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  detail: 'detailed',
  abilityTipMode: 'points',
  tipSeconds: 15,
  pointLimitSeconds: 60,
  showTeamWinRates: true,
};
export function isOverlaySettings(value: unknown): value is OverlaySettings {
  if (!value || typeof value !== 'object') return false;
  const v = value as OverlaySettings;
  return (
    (v.detail === 'detailed' || v.detail === 'off') &&
    (v.abilityTipMode === 'points' || v.abilityTipMode === 'fixed') &&
    Number.isInteger(v.tipSeconds) &&
    v.tipSeconds >= 5 &&
    v.tipSeconds <= 120 &&
    Number.isInteger(v.pointLimitSeconds) &&
    v.pointLimitSeconds >= 5 &&
    v.pointLimitSeconds <= 180 &&
    (v.showTeamWinRates === undefined || typeof v.showTeamWinRates === 'boolean')
  );
}
/** Only a confirmed positive on-screen count can authorize spending a reroll. */
export function availableReroll<T>(advice: T | null | undefined, count: number | null | undefined): T | null {
  return count !== null && count !== undefined && Number.isInteger(count) && count > 0 ? (advice ?? null) : null;
}

/** Older compact advice maps to Off while retaining independently configured overlay features. */
export function migrateOverlaySettings(value: unknown): OverlaySettings | null {
  if (!value || typeof value !== 'object') return null;
  const saved = value as Record<string, unknown>;
  const migrated = { ...saved, detail: saved.detail === 'compact' ? 'off' : (saved.detail ?? 'detailed') };
  return isOverlaySettings(migrated) ? migrated : null;
}

export function readMigratedOverlaySettings(): OverlaySettings {
  try {
    const raw = localStorage.getItem('brawl.overlaySettings');
    if (raw === null) return { ...DEFAULT_OVERLAY_SETTINGS };
    const migrated = migrateOverlaySettings(JSON.parse(raw));
    if (!migrated) return { ...DEFAULT_OVERLAY_SETTINGS };
    try {
      localStorage.setItem('brawl.overlaySettings', JSON.stringify(migrated));
    } catch {
      /* The migrated preferences still apply when storage is unavailable. */
    }
    return migrated;
  } catch {
    return { ...DEFAULT_OVERLAY_SETTINGS };
  }
}
