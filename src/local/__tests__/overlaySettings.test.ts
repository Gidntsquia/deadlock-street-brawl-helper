import { describe, expect, it } from 'vitest';
import { DEFAULT_OVERLAY_SETTINGS, isOverlaySettings, migrateOverlaySettings } from '../overlaySettings';

describe('persisted team win-rate display setting', () => {
  it('accepts older settings without the checkbox while retaining their existing values', () => {
    const legacy = { detail: 'compact', abilityTipMode: 'fixed', tipSeconds: 25, pointLimitSeconds: 80 };
    expect(isOverlaySettings(legacy)).toBe(false);
    expect(migrateOverlaySettings(legacy)).toEqual({ ...legacy, detail: 'off' });
    expect({ ...DEFAULT_OVERLAY_SETTINGS, ...migrateOverlaySettings(legacy) }).toEqual({
      ...legacy,
      detail: 'off',
      showTeamWinRates: true,
    });
  });

  it('accepts both explicit states and rejects malformed stored checkbox values', () => {
    expect(DEFAULT_OVERLAY_SETTINGS.showTeamWinRates).toBe(true);
    expect(isOverlaySettings({ ...DEFAULT_OVERLAY_SETTINGS, showTeamWinRates: false })).toBe(true);
    expect(isOverlaySettings({ ...DEFAULT_OVERLAY_SETTINGS, showTeamWinRates: true })).toBe(true);
    for (const showTeamWinRates of [null, 'false', 0, 1, {}])
      expect(isOverlaySettings({ ...DEFAULT_OVERLAY_SETTINGS, showTeamWinRates })).toBe(false);
  });
});
