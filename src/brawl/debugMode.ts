/** A version with a pre-release suffix, such as `0.3.0-rc.1`. */
export const isPreRelease = (version: string): boolean => /^\d+\.\d+\.\d+-[0-9A-Za-z]/.test(version);

/** Debug mode is on at start in dev runs and in pre-release builds, off in plain versions. */
export const debugDefault = (version: string, dev: boolean): boolean => dev || isPreRelease(version);
