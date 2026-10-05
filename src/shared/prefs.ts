/*!
 * Shared preference keys, Zod schemas, and helpers for options + content script.
 * Keep storage key names and defaults in one place so they do not drift.
 *
 * chrome.storage values are untyped across versions — schemas parse unknown
 * payloads and heal bad writes back to defaults (see docs/deferred-backlog P1d).
 *
 * When adding Options Settings UI, bump OPTIONS_REVISION (top of this file).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/**
 * chrome.storage can be missing in orphaned content scripts (after reload) and
 * some sandboxed / odd frames. Touching `.local` / `.sync` there throws and
 * shows up in Manage Extensions — prefer defaults / no-ops instead.
 */
function localArea(): chrome.storage.StorageArea | undefined {
    try {
        return globalThis.chrome?.storage?.local;
    } catch {
        return undefined;
    }
}

function syncArea(): chrome.storage.StorageArea | undefined {
    try {
        return globalThis.chrome?.storage?.sync;
    } catch {
        return undefined;
    }
}

async function localGet(
    keys: string | string[],
): Promise<Record<string, unknown> | undefined> {
    const local = localArea();
    if (!local) return undefined;
    try {
        return (await local.get(keys)) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

async function localSet(items: Record<string, unknown>): Promise<void> {
    const local = localArea();
    if (!local) return;
    try {
        await local.set(items);
    } catch {
        // Orphaned / restricted context — ignore.
    }
}

async function localRemove(keys: string | string[]): Promise<void> {
    const local = localArea();
    if (!local) return;
    try {
        await local.remove(keys);
    } catch {
        // Orphaned / restricted context — ignore.
    }
}

async function syncGet(
    keys: string | string[],
): Promise<Record<string, unknown> | undefined> {
    const sync = syncArea();
    if (!sync) return undefined;
    try {
        return (await sync.get(keys)) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

async function syncSet(items: Record<string, unknown>): Promise<void> {
    const sync = syncArea();
    if (!sync) return;
    try {
        await sync.set(items);
    } catch {
        // Orphaned / restricted / quota — ignore.
    }
}

/**
 * Read a local storage key, parse with Zod, and rewrite the default when the
 * stored value is present but invalid. Missing keys stay missing (return default).
 */
async function loadLocalPref<T>(
    key: string,
    schema: z.ZodType<T>,
    defaultValue: T,
): Promise<T> {
    const stored = await localGet(key);
    if (!stored || !(key in stored)) return defaultValue;

    const result = schema.safeParse(stored[key]);
    if (result.success) return result.data;

    await localSet({ [key]: defaultValue });
    return defaultValue;
}

/**
 * Prefer sync; if absent, copy a still-valid local value into sync once and
 * drop the local key so device-local leftovers don't fight synced prefs.
 *
 * TEMPORARY — remove after migration window; see docs/remove-settings-migration.md
 */
async function loadSyncedPrefMigratingFromLocal<T>(
    key: string,
    schema: z.ZodType<T>,
    defaultValue: T,
): Promise<T> {
    const synced = await syncGet(key);
    if (synced && key in synced) {
        const result = schema.safeParse(synced[key]);
        if (result.success) return result.data;
        await syncSet({ [key]: defaultValue });
        return defaultValue;
    }

    const local = await localGet(key);
    if (local && key in local) {
        const result = schema.safeParse(local[key]);
        const value = result.success ? result.data : defaultValue;
        await syncSet({ [key]: value });
        await localRemove(key);
        return value;
    }

    return defaultValue;
}

// =============================================================================
// OPTIONS_REVISION — bump when Options **Settings** UI grows
// =============================================================================
//
// Install opens Options on Guide with `?update=true`. Updates open Options on
// Settings with `?update=true` only when this number is greater than
// `lastSeenOptionsRevision` in chrome.storage.local.
// Do not bump for overlay-only or unrelated code changes.
// Wired from `background.ts` → onInstalled.
//
export const OPTIONS_REVISION = 2;

export const LAST_SEEN_OPTIONS_REVISION_KEY = 'lastSeenOptionsRevision';

export const lastSeenOptionsRevisionSchema = z.number().int().nonnegative();

export async function loadLastSeenOptionsRevision(): Promise<number | null> {
    const stored = await localGet(LAST_SEEN_OPTIONS_REVISION_KEY);
    if (!stored || !(LAST_SEEN_OPTIONS_REVISION_KEY in stored)) return null;

    const result = lastSeenOptionsRevisionSchema.safeParse(
        stored[LAST_SEEN_OPTIONS_REVISION_KEY],
    );
    if (result.success) return result.data;

    await localSet({
        [LAST_SEEN_OPTIONS_REVISION_KEY]: OPTIONS_REVISION,
    });
    return OPTIONS_REVISION;
}

export async function saveLastSeenOptionsRevision(revision: number): Promise<void> {
    await localSet({
        [LAST_SEEN_OPTIONS_REVISION_KEY]: lastSeenOptionsRevisionSchema.parse(revision),
    });
}

// ---------------------------------------------------------------------------
// Panel theme
// ---------------------------------------------------------------------------

/** Overlay panel color scheme. Default: follow OS. */
export const PANEL_THEME_KEY = 'panelTheme';

export const panelThemeSchema = z.enum(['light', 'dark', 'system']);

export type PanelThemePreference = z.infer<typeof panelThemeSchema>;

export const PANEL_THEME_DEFAULT: PanelThemePreference = 'system';

export function parsePanelTheme(value: unknown): PanelThemePreference {
    const result = panelThemeSchema.safeParse(value);
    return result.success ? result.data : PANEL_THEME_DEFAULT;
}

export async function loadPanelThemePreference(): Promise<PanelThemePreference> {
    return loadLocalPref(PANEL_THEME_KEY, panelThemeSchema, PANEL_THEME_DEFAULT);
}

export async function savePanelThemePreference(theme: PanelThemePreference): Promise<void> {
    await localSet({ [PANEL_THEME_KEY]: panelThemeSchema.parse(theme) });
}

/**
 * OS dark-mode flag as seen by a top-level frame. Inside an iframe,
 * prefers-color-scheme follows the embedding <iframe>'s used color-scheme
 * (pages can force `color-scheme: light` on it), so iframes read this instead.
 */
export const SYSTEM_PREFERS_DARK_KEY = 'systemPrefersDark';

export const systemPrefersDarkSchema = z.boolean();

export function parseSystemPrefersDark(value: unknown): boolean | undefined {
    const result = systemPrefersDarkSchema.safeParse(value);
    return result.success ? result.data : undefined;
}

/** Undefined until a top-level frame has reported (or after a bad write). */
export async function loadSystemPrefersDark(): Promise<boolean | undefined> {
    const stored = await localGet(SYSTEM_PREFERS_DARK_KEY);
    return parseSystemPrefersDark(stored?.[SYSTEM_PREFERS_DARK_KEY]);
}

export async function saveSystemPrefersDark(dark: boolean): Promise<void> {
    await localSet({ [SYSTEM_PREFERS_DARK_KEY]: systemPrefersDarkSchema.parse(dark) });
}

/** Resolve a stored preference to the concrete scheme applied to the overlay. */
export function resolvePanelTheme(
    preference: PanelThemePreference,
    systemIsDark: boolean,
): 'light' | 'dark' {
    if (preference === 'system') return systemIsDark ? 'dark' : 'light';
    return preference;
}

// ---------------------------------------------------------------------------
// Panel font size
// ---------------------------------------------------------------------------

export const PANEL_FONT_SIZE_KEY = 'panelFontSize';

export const PANEL_FONT_SIZE_DEFAULT = 11;
export const PANEL_FONT_SIZE_MIN = 8;
export const PANEL_FONT_SIZE_MAX = 18;
export const PANEL_FONT_SIZE_STEP = 1;

export const panelFontSizeSchema = z
    .number()
    .finite()
    .transform((n) => Math.round(n))
    .pipe(z.number().int().min(PANEL_FONT_SIZE_MIN).max(PANEL_FONT_SIZE_MAX));

export function clampPanelFontSize(size: number): number {
    return Math.min(PANEL_FONT_SIZE_MAX, Math.max(PANEL_FONT_SIZE_MIN, size));
}

export function parsePanelFontSize(value: unknown): number {
    const result = panelFontSizeSchema.safeParse(value);
    return result.success ? result.data : PANEL_FONT_SIZE_DEFAULT;
}

export async function loadPanelFontSize(): Promise<number> {
    const stored = await localGet(PANEL_FONT_SIZE_KEY);
    if (!stored || !(PANEL_FONT_SIZE_KEY in stored)) return PANEL_FONT_SIZE_DEFAULT;

    const raw = stored[PANEL_FONT_SIZE_KEY];
    const result = panelFontSizeSchema.safeParse(raw);
    if (result.success) {
        // Heal out-of-band writes that still clamp (e.g. float → int).
        if (raw !== result.data) {
            await localSet({ [PANEL_FONT_SIZE_KEY]: result.data });
        }
        return result.data;
    }

    await localSet({ [PANEL_FONT_SIZE_KEY]: PANEL_FONT_SIZE_DEFAULT });
    return PANEL_FONT_SIZE_DEFAULT;
}

export async function savePanelFontSize(size: number): Promise<void> {
    const next = panelFontSizeSchema.parse(size);
    await localSet({ [PANEL_FONT_SIZE_KEY]: next });
}

// ---------------------------------------------------------------------------
// Show CSS Classes section (synced across devices)
// ---------------------------------------------------------------------------

/** Show the Classes chip row. Default: true. Stored in chrome.storage.sync. */
export const SHOW_CSS_CLASSES_KEY = 'showCssClasses';

/** Legacy key — migrated to `showCssClasses` on read (`!hideCssClasses`). */
const LEGACY_HIDE_CSS_CLASSES_KEY = 'hideCssClasses';

export const showCssClassesSchema = z.boolean();

export const SHOW_CSS_CLASSES_DEFAULT = true;

export function parseShowCssClasses(value: unknown): boolean {
    const result = showCssClassesSchema.safeParse(value);
    return result.success ? result.data : SHOW_CSS_CLASSES_DEFAULT;
}

export async function loadShowCssClasses(): Promise<boolean> {
    const synced = await syncGet(SHOW_CSS_CLASSES_KEY);
    if (synced && SHOW_CSS_CLASSES_KEY in synced) {
        const result = showCssClassesSchema.safeParse(synced[SHOW_CSS_CLASSES_KEY]);
        if (result.success) return result.data;
        await syncSet({ [SHOW_CSS_CLASSES_KEY]: SHOW_CSS_CLASSES_DEFAULT });
        return SHOW_CSS_CLASSES_DEFAULT;
    }

    // One-time migrate from chrome.storage.local (pre-sync) or inverted legacy key.
    // TEMPORARY — see docs/remove-settings-migration.md
    const local = await localGet([SHOW_CSS_CLASSES_KEY, LEGACY_HIDE_CSS_CLASSES_KEY]);
    if (!local) return SHOW_CSS_CLASSES_DEFAULT;

    if (SHOW_CSS_CLASSES_KEY in local) {
        const result = showCssClassesSchema.safeParse(local[SHOW_CSS_CLASSES_KEY]);
        const shown = result.success ? result.data : SHOW_CSS_CLASSES_DEFAULT;
        await syncSet({ [SHOW_CSS_CLASSES_KEY]: shown });
        await localRemove([SHOW_CSS_CLASSES_KEY, LEGACY_HIDE_CSS_CLASSES_KEY]);
        return shown;
    }

    if (LEGACY_HIDE_CSS_CLASSES_KEY in local) {
        const legacy = z.boolean().safeParse(local[LEGACY_HIDE_CSS_CLASSES_KEY]);
        const shown = legacy.success ? !legacy.data : SHOW_CSS_CLASSES_DEFAULT;
        await syncSet({ [SHOW_CSS_CLASSES_KEY]: shown });
        await localRemove(LEGACY_HIDE_CSS_CLASSES_KEY);
        return shown;
    }

    return SHOW_CSS_CLASSES_DEFAULT;
}

export async function saveShowCssClasses(shown: boolean): Promise<void> {
    await syncSet({
        [SHOW_CSS_CLASSES_KEY]: showCssClassesSchema.parse(shown),
    });
    // Drop any leftover local copy so it cannot override sync on next load.
    await localRemove([SHOW_CSS_CLASSES_KEY, LEGACY_HIDE_CSS_CLASSES_KEY]);
}

// ---------------------------------------------------------------------------
// Show box-model diagram (synced across devices)
// ---------------------------------------------------------------------------

/** Show the concentric box-model diagram in the Box section. Default: true. */
export const SHOW_BOX_MODEL_KEY = 'showBoxModelDiagram';

export const showBoxModelSchema = z.boolean();

export const SHOW_BOX_MODEL_DEFAULT = true;

export function parseShowBoxModel(value: unknown): boolean {
    const result = showBoxModelSchema.safeParse(value);
    return result.success ? result.data : SHOW_BOX_MODEL_DEFAULT;
}

export async function loadShowBoxModel(): Promise<boolean> {
    return loadSyncedPrefMigratingFromLocal(
        SHOW_BOX_MODEL_KEY,
        showBoxModelSchema,
        SHOW_BOX_MODEL_DEFAULT,
    );
}

export async function saveShowBoxModel(shown: boolean): Promise<void> {
    await syncSet({
        [SHOW_BOX_MODEL_KEY]: showBoxModelSchema.parse(shown),
    });
    await localRemove(SHOW_BOX_MODEL_KEY);
}

// ---------------------------------------------------------------------------
// Classes chip wrap lines (before "+N more")
// ---------------------------------------------------------------------------

/** How many wrap lines of class chips to show before "+N more". Default: 3. */
export const CLASSES_CHIP_LINES_KEY = 'classesChipLines';

export const CLASSES_CHIP_LINES_DEFAULT = 3;
export const CLASSES_CHIP_LINES_MIN = 1;
export const CLASSES_CHIP_LINES_MAX = 9;

export const classesChipLinesSchema = z
    .number()
    .finite()
    .transform((n) => Math.round(n))
    .pipe(z.number().int().min(CLASSES_CHIP_LINES_MIN).max(CLASSES_CHIP_LINES_MAX));

export function parseClassesChipLines(value: unknown): number {
    const result = classesChipLinesSchema.safeParse(value);
    return result.success ? result.data : CLASSES_CHIP_LINES_DEFAULT;
}

export async function loadClassesChipLines(): Promise<number> {
    return loadLocalPref(
        CLASSES_CHIP_LINES_KEY,
        classesChipLinesSchema,
        CLASSES_CHIP_LINES_DEFAULT,
    );
}

export async function saveClassesChipLines(lines: number): Promise<void> {
    await localSet({
        [CLASSES_CHIP_LINES_KEY]: classesChipLinesSchema.parse(lines),
    });
}

// ---------------------------------------------------------------------------
// Session: per-tab armed flag (service worker)
// ---------------------------------------------------------------------------

/** Session storage prefix: `sdArmed:<tabId>` → boolean. */
export const ARMED_KEY_PREFIX = 'sdArmed:';

export const sessionArmedSchema = z.boolean();

export function armedStorageKey(tabId: number): string {
    return `${ARMED_KEY_PREFIX}${tabId}`;
}

/** Parse a session armed value; anything other than a boolean is treated as false. */
export function parseSessionArmed(value: unknown): boolean {
    const result = sessionArmedSchema.safeParse(value);
    return result.success ? result.data : false;
}
