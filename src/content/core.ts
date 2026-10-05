/*!
 * Style Detective — content-script entry point.
 *
 * Declared in the manifest (all_frames) and loaded dormant on matching pages
 * and iframes. The service worker broadcasts a toggle; each frame owns its
 * OverlayController (prefs, listeners, highlight, inspect). This module only
 * boots that controller.
 */

import { copyTextToClipboard } from './lib/clipboard';
import { setCopyNotifier } from './lib/copy-feedback';
import {
    asHtmlElement,
    deepElementFromPoint,
    isComposedDescendant,
    keepOverlayInViewport,
    layoutHighlightRect,
    pointOverElement,
    syncCopyValueAccessibility,
} from './lib/dom';
import {
    CSS_CATEGORIES,
    isPropertyEnabled,
    resolveProperty,
    type InspectContext,
} from './lib/properties';
import {
    createBlock,
    collapseSelectorHeader,
    refreshSelectorOverflow,
    isShowCssClasses,
    setClassesChipLines,
    setShowBoxModelDiagram,
    setShowCssClasses,
    updateClassesPanel,
    updateHeader,
    updatePanel,
} from './lib/panel';
import { formatClassesForCopy, parseClassTokens } from './lib/classes';
import {
    clampPanelFontSize,
    loadClassesChipLines,
    loadPanelFontSize,
    loadPanelThemePreference,
    loadShowBoxModel,
    loadSystemPrefersDark,
    loadShowCssClasses,
    parseClassesChipLines,
    parsePanelFontSize,
    parsePanelTheme,
    parseShowBoxModel,
    parseShowCssClasses,
    parseSystemPrefersDark,
    resolvePanelTheme,
    savePanelFontSize,
    saveShowCssClasses,
    saveSystemPrefersDark,
    type PanelThemePreference,
    CLASSES_CHIP_LINES_KEY,
    PANEL_FONT_SIZE_DEFAULT,
    PANEL_FONT_SIZE_KEY,
    PANEL_FONT_SIZE_STEP,
    PANEL_THEME_KEY,
    SHOW_BOX_MODEL_KEY,
    SHOW_CSS_CLASSES_KEY,
    SYSTEM_PREFERS_DARK_KEY,
} from '../shared/prefs';
import { MessageType, Messages, parseExtensionMessage } from '../shared/messages';
import {
    DARK_CLASS,
    FROZEN_CLASS,
    HIGHLIGHT_ID,
    OVERLAY_ID,
    TOAST_ID,
    TOAST_SUCCESS_CLASS,
} from '../shared/dom-ids';
import { ensureOverlayStyles } from './lib/inject-styles';

type Pointer = { clientX: number; clientY: number };

const HOVER_LISTENER_OPTS: AddEventListenerOptions = { capture: true, passive: true };
const HIGHLIGHT_LAYOUT_OPTS: AddEventListenerOptions = { capture: true, passive: true };

const IS_TOP_FRAME = window === window.top;

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Only trustworthy in the top frame: inside an iframe this follows the
 * embedding <iframe>'s color-scheme, not the OS (see SYSTEM_PREFERS_DARK_KEY).
 */
function systemPrefersDark(): boolean {
    return window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

function eventTargetElement(e: Event): HTMLElement | null {
    const target = e.target;
    if (target instanceof HTMLElement) return target;
    if (target instanceof Node) return target.parentElement;

    return null;
}

function isInsidePanel(el: HTMLElement | null): boolean {
    return !!el && !!el.closest && el.closest(`#${OVERLAY_ID}`) !== null;
}

/**
 * Prefer a stable inspect target when the page toggles `pointer-events: none`
 * under :hover (Animista's active SCALE-UP circle does this). Hit-testing then
 * falls through to a parent/underlay and would thrash the panel every frame.
 * Keep the current element while the pointer stays in its layout box; still
 * allow drilling into descendants (including across open shadow roots).
 */
function resolveInspectTarget(
    hit: HTMLElement,
    current: HTMLElement | null,
    pointer: Pointer | null,
): HTMLElement {
    if (!current || !pointer || !current.isConnected || hit === current) return hit;
    if (isComposedDescendant(current, hit)) return hit;
    if (pointOverElement(current, pointer.clientX, pointer.clientY)) return current;
    return hit;
}

/** Deepest HTMLElement under the pointer (pierces open shadow roots). */
function hitElementFromEvent(e: MouseEvent): HTMLElement | null {
    return asHtmlElement(deepElementFromPoint(e.clientX, e.clientY));
}

/**
 * False after the extension is reloaded/updated while this content script is
 * still attached to the page. Touching chrome.* then throws "Extension context
 * invalidated" — callers should tear down and stop.
 */
function isExtensionContextValid(): boolean {
    try {
        return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
    } catch {
        return false;
    }
}

/** Fire-and-forget runtime message; no-ops when the extension context is dead. */
function sendRuntimeMessage(message: unknown): void {
    if (!isExtensionContextValid()) return;
    try {
        void chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
        // Orphaned content script after reload/update.
    }
}

function removeElement(id: string): void {
    const n = document.getElementById(id);
    if (n) n.remove();
}

/**
 * Compound selector for the copied rule: `tag#id.class1.class2` (no spaces —
 * spaces would be descendant combinators and break multi-class elements).
 */
function cssDefinitionSelector(el: HTMLElement): string {
    const classes = parseClassTokens(el)
        .map((token) => '.' + CSS.escape(token))
        .join('');
    const id = el.id === '' ? '' : '#' + CSS.escape(el.id);
    return el.tagName.toLowerCase() + id + classes;
}

/**
 * Walk the catalog for copy: only properties that would appear in the panel
 * (same `when` / `hideDefault` visibility), omitting `panelOnly` rows and
 * tag-gated categories that don't match the element. Shared by every copy
 * format so they cannot disagree about the same element.
 */
function collectCopyProperties(
    el: HTMLElement,
    style: CSSStyleDeclaration,
): { title: string; entries: { name: string; value: string }[] }[] {
    const ctx: InspectContext = {
        style,
        el,
        get: (property) => style.getPropertyValue(property),
    };

    const groups: { title: string; entries: { name: string; value: string }[] }[] = [];

    for (const category of CSS_CATEGORIES) {
        if (category.tags && !category.tags.includes(el.tagName)) continue;

        const entries: { name: string; value: string }[] = [];
        for (const property of category.properties) {
            if (!isPropertyEnabled(property) || property.panelOnly) continue;

            const resolved = resolveProperty(property, ctx);
            if (!resolved.visible) continue;

            // Prefer synthesized values (margin/padding/border shorthands, etc.)
            // and `copySafe` formatters, whose output is valid equivalent CSS so
            // the clipboard matches the panel. Other `format` helpers are
            // display-only (e.g. filename) and would not round-trip.
            const value =
                property.value || property.copySafe ? resolved.value : ctx.get(property.name);
            entries.push({ name: property.name, value });
        }

        if (entries.length > 0) groups.push({ title: category.title, entries });
    }

    return groups;
}

/** Build a CSS definition for copy, grouped by category with heading comments. */
function buildCssDefinition(el: HTMLElement, style: CSSStyleDeclaration): string {
    let css = cssDefinitionSelector(el) + ' {\n';

    for (const group of collectCopyProperties(el, style)) {
        css += `\n\t/* ${group.title} */\n`;
        for (const entry of group.entries) {
            css += '\t' + entry.name + ': ' + entry.value + ';\n';
        }
    }

    css += '}';
    return css;
}

/**
 * Build a JSON snapshot for copy: the same selector and visible properties as
 * the CSS definition, as a flat kebab-case map. Flat (not nested by category)
 * so consumers can read `properties["width"]` without knowing the taxonomy.
 */
function buildJsonDefinition(el: HTMLElement, style: CSSStyleDeclaration): string {
    const properties: Record<string, string> = {};

    for (const group of collectCopyProperties(el, style)) {
        for (const entry of group.entries) {
            properties[entry.name] = entry.value;
        }
    }

    return JSON.stringify({ selector: cssDefinitionSelector(el), properties }, null, 2);
}

/**
 * Owns overlay lifecycle: prefs, hover/key/highlight listeners, inspect state,
 * and panel positioning. Construct once per content-script boot.
 */
class OverlayController {
    /** Distinguishes this frame's controller when broadcasting overlay claims. */
    private readonly instanceId = crypto.randomUUID();

    /** Tab-wide arm state (synced via the service worker). */
    private armed = false;

    // --- inspect / pointer ---
    private inspectedElement: HTMLElement | null = null;
    private lastPointer: Pointer | null = null;
    /** False after the cursor leaves this frame (e.g. into an iframe). */
    private pointerInFrame = false;
    private pendingPanelPointer: { clientX: number; clientY: number } | null = null;
    private panelPositionFrame: number | null = null;
    private claimFrame: number | null = null;
    /** Coalesce same-target style refreshes (avoids thrash while :hover flickers). */
    private styleRefreshTimer: ReturnType<typeof setTimeout> | null = null;

    // --- listener flags ---
    private haveHoverListeners = false;
    private haveKeyListeners = false;

    // --- prefs ---
    private panelFontSize = PANEL_FONT_SIZE_DEFAULT;
    private panelThemePreference: PanelThemePreference = 'system';
    private systemThemeMedia: MediaQueryList | null = null;
    /** OS dark mode — measured in the top frame, relayed via storage to iframes. */
    private systemIsDark = systemPrefersDark();

    private flashMessageTimer: ReturnType<typeof setTimeout> | null = null;

    // Stable handler identities for add/removeEventListener.
    private readonly onPointerLeaveFrame = (): void => {
        // Entering a child browsing context (iframe) leaves this document —
        // drop the stale point so we don't steal the claim from the frame
        // that actually has the cursor.
        this.pointerInFrame = false;
        this.lastPointer = null;
    };

    private readonly onMouseOver = (e: MouseEvent): void => {
        this.notePointer(e);
        const hit = hitElementFromEvent(e);
        if (!hit || isInsidePanel(hit)) return;
        const el = resolveInspectTarget(hit, this.inspectedElement, this.lastPointer);
        this.inspectElement(el, { fromStickyHit: el !== hit });
    };

    private readonly onMouseOut = (e: MouseEvent): void => {
        const el = eventTargetElement(e);
        if (!el || isInsidePanel(el)) return;

        // mouseout fires when entering a descendant — that is not a leave.
        // Use composed ancestry so open-shadow children count as inside the host.
        const next = e.relatedTarget;
        if (next instanceof Node && isComposedDescendant(el, next)) return;

        const inspected = this.inspectedElement;
        if (
            inspected &&
            (el === inspected || isComposedDescendant(el, inspected))
        ) {
            // Pages that set pointer-events:none on :hover fire a synthetic
            // leave while the cursor is still over the element's box — ignore.
            if (
                this.lastPointer &&
                pointOverElement(inspected, this.lastPointer.clientX, this.lastPointer.clientY)
            ) {
                return;
            }
            this.inspectedElement = null;
            this.clearHighlight();
        }
    };

    private readonly onMouseMove = (e: MouseEvent): void => {
        this.notePointer(e);
        const hit = hitElementFromEvent(e);
        if (!hit || isInsidePanel(hit)) return;

        const el = resolveInspectTarget(hit, this.inspectedElement, this.lastPointer);
        this.inspectElement(el, { fromStickyHit: el !== hit });
        if (el === this.inspectedElement) this.highlightElement(el);
        this.schedulePanelPosition(e);
    };

    private readonly onKeyDown = (e: KeyboardEvent): void => {
        this.handleKey(e);
    };

    private readonly onHighlightLayout = (): void => {
        this.syncHighlightToInspected();
    };

    /** Load font size, theme, and feature prefs before the first enable(). */
    async loadPrefs(): Promise<void> {
        setCopyNotifier((message, tone) => {
            this.flashMessage(message, { tone: tone ?? 'default' });
        });
        await Promise.all([
            this.loadPanelFontSizePref(),
            this.loadPanelThemePref(),
            this.loadShowCssClassesPref(),
            this.loadShowBoxModelPref(),
            this.loadClassesChipLinesPref(),
        ]);
        this.watchPrefs();
    }

    isEnabled(): boolean {
        return this.armed;
    }

    /** True while hover listeners are attached (false when frozen). */
    isTracking(): boolean {
        return this.haveHoverListeners;
    }

    /** Apply the tab-wide armed flag from the service worker. */
    setArmed(armed: boolean): void {
        if (armed) this.enable();
        else this.disable();
    }

    /**
     * Another frame claimed the visible pane — hide ours but stay armed so
     * the next hover here can take over again.
     */
    onOverlayClaim(instanceId: string): void {
        if (instanceId === this.instanceId) return;
        this.park();
    }

    enable(): boolean {
        if (this.armed) return false;

        // Re-assert styles in case a document.write iframe wiped injected CSS.
        ensureOverlayStyles();
        this.armed = true;
        this.addHoverListeners();
        this.addKeyListeners();
        this.addHighlightLayoutListeners();
        // Panel opens on the next hover/move in this frame (no dormant
        // mousemove tracker — see notePointer). Cue engagement immediately.
        if (IS_TOP_FRAME) {
            this.flashMessage(
                'Style Detective loaded! Hover any element you want to inspect in the page.',
                { persistent: true },
            );
        }

        return true;
    }

    disable(): boolean {
        const wasArmed = this.armed;
        const block = document.getElementById(OVERLAY_ID);
        const message = document.getElementById(TOAST_ID);

        this.armed = false;

        if (!wasArmed && !block && !message) return false;

        if (block) {
            block.classList.remove(FROZEN_CLASS);
            block.remove();
        }
        if (message) message.remove();

        this.removeHoverListeners();
        this.removeKeyListeners();
        this.removeHighlightLayoutListeners();
        this.removeHighlight();
        this.inspectedElement = null;
        this.pointerInFrame = false;
        this.lastPointer = null;
        this.cancelScheduledPanelPosition();
        this.cancelStyleRefresh();
        if (this.claimFrame !== null) {
            cancelAnimationFrame(this.claimFrame);
            this.claimFrame = null;
        }

        return true;
    }

    freeze(): boolean {
        const block = document.getElementById(OVERLAY_ID);
        if (!this.armed || !block || !this.haveHoverListeners) return false;

        this.removeHoverListeners();
        block.classList.add(FROZEN_CLASS);
        syncCopyValueAccessibility();
        requestAnimationFrame(() => refreshSelectorOverflow());

        return true;
    }

    unfreeze(): boolean {
        const block = document.getElementById(OVERLAY_ID);
        if (!this.armed || !block || this.haveHoverListeners) return false;

        this.clearHighlight();
        this.inspectedElement = null;
        block.classList.remove(FROZEN_CLASS);
        syncCopyValueAccessibility();
        collapseSelectorHeader();
        this.addHoverListeners();
        this.inspectElementUnderCursor();

        return true;
    }

    // --- prefs ---

    private async loadPanelFontSizePref(): Promise<void> {
        this.panelFontSize = await loadPanelFontSize();
    }

    private async loadPanelThemePref(): Promise<void> {
        const [preference, storedSystemDark] = await Promise.all([
            loadPanelThemePreference(),
            loadSystemPrefersDark(),
        ]);
        this.panelThemePreference = preference;

        if (IS_TOP_FRAME) {
            // Skip redundant writes — every frame in every tab hears onChanged.
            if (storedSystemDark !== this.systemIsDark) {
                void saveSystemPrefersDark(this.systemIsDark);
            }
            this.bindSystemThemeListener();
        } else if (storedSystemDark !== undefined) {
            this.systemIsDark = storedSystemDark;
        }
    }

    private async loadShowCssClassesPref(): Promise<void> {
        setShowCssClasses(await loadShowCssClasses());
    }

    private async loadShowBoxModelPref(): Promise<void> {
        setShowBoxModelDiagram(await loadShowBoxModel());
    }

    private async loadClassesChipLinesPref(): Promise<void> {
        setClassesChipLines(await loadClassesChipLines());
    }

    private watchPrefs(): void {
        try {
            if (!chrome.storage?.onChanged) return;
        } catch {
            return;
        }

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'sync') {
                const showClassesChange = changes[SHOW_CSS_CLASSES_KEY];
                if (showClassesChange) {
                    setShowCssClasses(parseShowCssClasses(showClassesChange.newValue));
                    if (this.inspectedElement?.isConnected) {
                        updateClassesPanel(this.inspectedElement);
                    }
                    const block = document.getElementById(OVERLAY_ID);
                    if (block) keepOverlayInViewport(block);
                }

                const showBoxModelChange = changes[SHOW_BOX_MODEL_KEY];
                if (showBoxModelChange) {
                    setShowBoxModelDiagram(parseShowBoxModel(showBoxModelChange.newValue));
                    if (this.inspectedElement?.isConnected) {
                        const style =
                            this.inspectedElement.ownerDocument.defaultView?.getComputedStyle(
                                this.inspectedElement,
                            );
                        if (style) updatePanel(style, this.inspectedElement);
                    }
                    const block = document.getElementById(OVERLAY_ID);
                    if (block) keepOverlayInViewport(block);
                }
                return;
            }

            if (area !== 'local') return;

            const themeChange = changes[PANEL_THEME_KEY];
            if (themeChange) {
                this.panelThemePreference = parsePanelTheme(themeChange.newValue);
                this.applyPanelTheme();
            }

            const systemDarkChange = changes[SYSTEM_PREFERS_DARK_KEY];
            if (systemDarkChange && !IS_TOP_FRAME) {
                const next = parseSystemPrefersDark(systemDarkChange.newValue);
                if (next !== undefined && next !== this.systemIsDark) {
                    this.systemIsDark = next;
                    this.applyPanelTheme();
                }
            }

            const chipLinesChange = changes[CLASSES_CHIP_LINES_KEY];
            if (chipLinesChange) {
                setClassesChipLines(parseClassesChipLines(chipLinesChange.newValue));
                const block = document.getElementById(OVERLAY_ID);
                if (block) keepOverlayInViewport(block);
            }

            const fontSizeChange = changes[PANEL_FONT_SIZE_KEY];
            if (fontSizeChange) {
                const next = parsePanelFontSize(fontSizeChange.newValue);
                if (next !== this.panelFontSize) {
                    this.panelFontSize = next;
                    this.applyPanelFontSize();
                }
            }
        });
    }

    /** Top frame only — publishes OS theme changes for iframes to pick up. */
    private bindSystemThemeListener(): void {
        if (!this.systemThemeMedia) {
            this.systemThemeMedia = window.matchMedia(SYSTEM_DARK_QUERY);
            this.systemThemeMedia.addEventListener('change', (e) => {
                this.systemIsDark = e.matches;
                void saveSystemPrefersDark(e.matches);
                this.applyPanelTheme();
            });
        }
    }

    private appliedPanelTheme(): 'light' | 'dark' {
        return resolvePanelTheme(this.panelThemePreference, this.systemIsDark);
    }

    private applyPanelFontSize(): void {
        const block = document.getElementById(OVERLAY_ID);
        if (!block) return;

        block.style.setProperty('--sd-font-size', `${this.panelFontSize}px`);
        keepOverlayInViewport(block);
    }

    private applyPanelTheme(): void {
        const block = document.getElementById(OVERLAY_ID);
        if (block) {
            block.classList.toggle(DARK_CLASS, this.appliedPanelTheme() === 'dark');
        }
    }

    private adjustPanelFontSize(delta: number): void {
        const next = clampPanelFontSize(this.panelFontSize + delta);
        if (next === this.panelFontSize) return;
        this.panelFontSize = next;
        this.applyPanelFontSize();
        void savePanelFontSize(this.panelFontSize);
    }

    private resetPanelFontSize(): void {
        if (this.panelFontSize === PANEL_FONT_SIZE_DEFAULT) return;
        this.panelFontSize = PANEL_FONT_SIZE_DEFAULT;
        this.applyPanelFontSize();
        void savePanelFontSize(this.panelFontSize);
    }

    // --- panel DOM ---

    /** Create the panel on first use in this frame. */
    private ensurePanel(): HTMLElement {
        let block = document.getElementById(OVERLAY_ID);
        if (!block) {
            block = createBlock(document);
            document.body.append(block);
            this.applyPanelFontSize();
            this.applyPanelTheme();
        }
        return block;
    }

    private flashMessage(
        msg: string,
        options: { persistent?: boolean; tone?: 'default' | 'success' } = {},
    ): void {
        removeElement(TOAST_ID);
        if (this.flashMessageTimer) {
            clearTimeout(this.flashMessageTimer);
            this.flashMessageTimer = null;
        }

        const p = document.createElement('p');
        p.id = TOAST_ID;
        if (options.tone === 'success') p.className = TOAST_SUCCESS_CLASS;
        p.append(document.createTextNode(msg));
        document.body.append(p);

        if (!options.persistent) {
            this.flashMessageTimer = setTimeout(() => {
                removeElement(TOAST_ID);
                this.flashMessageTimer = null;
            }, 2000);
        }
    }

    // --- highlight ---

    private ensureHighlight(): HTMLElement {
        let box = document.getElementById(HIGHLIGHT_ID);
        if (!box) {
            box = document.createElement('div');
            box.id = HIGHLIGHT_ID;
            box.setAttribute('aria-hidden', 'true');
            document.body.append(box);
        }
        return box;
    }

    private clearHighlight(): void {
        const box = document.getElementById(HIGHLIGHT_ID);
        if (box) box.style.display = 'none';
    }

    private removeHighlight(): void {
        removeElement(HIGHLIGHT_ID);
    }

    private highlightElement(el: HTMLElement): void {
        if (el.tagName === 'BODY' || el.tagName === 'HTML') {
            this.clearHighlight();
            return;
        }

        const box = this.ensureHighlight();
        const rect = layoutHighlightRect(el);
        box.style.display = 'block';
        box.style.top = `${rect.top}px`;
        box.style.left = `${rect.left}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
    }

    private syncHighlightToInspected(): void {
        if (this.inspectedElement?.isConnected) {
            this.highlightElement(this.inspectedElement);
        } else {
            this.clearHighlight();
        }
    }

    private addHighlightLayoutListeners(): void {
        window.addEventListener('scroll', this.onHighlightLayout, HIGHLIGHT_LAYOUT_OPTS);
        window.addEventListener('resize', this.onHighlightLayout, HIGHLIGHT_LAYOUT_OPTS);
    }

    private removeHighlightLayoutListeners(): void {
        window.removeEventListener('scroll', this.onHighlightLayout, HIGHLIGHT_LAYOUT_OPTS);
        window.removeEventListener('resize', this.onHighlightLayout, HIGHLIGHT_LAYOUT_OPTS);
    }

    // --- inspect / position ---

    private notePointer(e: MouseEvent): void {
        this.pointerInFrame = true;
        this.lastPointer = {
            clientX: e.clientX,
            clientY: e.clientY,
        };
    }

    /** Tell sibling frames to hide their pane; coalesce to one message per frame. */
    private claimOverlay(): void {
        if (this.claimFrame !== null) return;

        this.claimFrame = requestAnimationFrame(() => {
            this.claimFrame = null;
            sendRuntimeMessage(Messages.overlayClaim(this.instanceId));
        });
    }

    /**
     * Hide the panel and highlight without disabling this frame. Restores hover
     * tracking if we were frozen so a later hover can reclaim the pane.
     */
    private park(): void {
        const block = document.getElementById(OVERLAY_ID);
        if (!block && !this.inspectedElement) return;

        if (block) {
            const wasFrozen = block.classList.contains(FROZEN_CLASS);
            block.classList.remove(FROZEN_CLASS);
            if (wasFrozen) syncCopyValueAccessibility();
            block.style.display = 'none';
            if (wasFrozen && !this.haveHoverListeners) {
                collapseSelectorHeader();
                this.addHoverListeners();
            }
        }

        this.clearHighlight();
        this.inspectedElement = null;
        this.cancelScheduledPanelPosition();
        this.cancelStyleRefresh();
        if (this.claimFrame !== null) {
            cancelAnimationFrame(this.claimFrame);
            this.claimFrame = null;
        }
        // Another frame has the cursor — don't keep a point that could re-claim.
        this.pointerInFrame = false;
        this.lastPointer = null;
    }

    private inspectElement(
        el: HTMLElement,
        options: { fromStickyHit?: boolean } = {},
    ): void {
        if (!this.armed || isInsidePanel(el)) return;

        // Same target: refresh styles on a timer so :hover / class toggles
        // still update, but pointer-events:none flicker (Animista) does not
        // rebuild the panel every frame. Sticky re-hits skip refresh entirely.
        if (el === this.inspectedElement) {
            if (!options.fromStickyHit) this.scheduleStyleRefresh();
            return;
        }

        this.cancelStyleRefresh();
        this.ensurePanel();
        this.claimOverlay();
        updateHeader(el);
        updateClassesPanel(el);
        this.highlightElement(el);

        if (!document.defaultView) return;
        const style = document.defaultView.getComputedStyle(el);
        updatePanel(style, el);
        removeElement(TOAST_ID);

        this.inspectedElement = el;
    }

    /** Re-read computed style for the current target without rebuilding chrome. */
    private refreshInspectedStyles(): void {
        const el = this.inspectedElement;
        if (!el?.isConnected || !document.defaultView) return;
        updatePanel(document.defaultView.getComputedStyle(el), el);
    }

    private scheduleStyleRefresh(): void {
        if (this.styleRefreshTimer !== null) return;
        this.styleRefreshTimer = setTimeout(() => {
            this.styleRefreshTimer = null;
            this.refreshInspectedStyles();
        }, 200);
    }

    private cancelStyleRefresh(): void {
        if (this.styleRefreshTimer === null) return;
        clearTimeout(this.styleRefreshTimer);
        this.styleRefreshTimer = null;
    }

    private positionPanelAtPointer(e: { clientX: number; clientY: number }): void {
        if (!this.armed) return;

        const block = this.ensurePanel();
        this.claimOverlay();
        block.style.display = 'flex';

        const MARGIN = 8;
        const BOTTOM_MARGIN = 40;
        const pageWidth = window.innerWidth;
        const pageHeight = window.innerHeight - BOTTOM_MARGIN;
        const blockWidth = block.offsetWidth;
        const blockHeight = block.offsetHeight;

        // Client coordinates match position:fixed left/top.
        let left = e.clientX + 20;
        if (e.clientX + blockWidth > pageWidth) {
            left = e.clientX - blockWidth - 40;
            if (left < MARGIN) left = MARGIN;
        }

        let top = e.clientY + 20;
        if (e.clientY + blockHeight > pageHeight) {
            top = e.clientY - blockHeight - 20;
            if (top < MARGIN) top = MARGIN;
        }

        block.style.left = `${left}px`;
        block.style.top = `${top}px`;
        keepOverlayInViewport(block);
    }

    private schedulePanelPosition(e: { clientX: number; clientY: number }): void {
        this.pendingPanelPointer = { clientX: e.clientX, clientY: e.clientY };
        if (this.panelPositionFrame !== null) return;

        this.panelPositionFrame = requestAnimationFrame(() => {
            this.panelPositionFrame = null;
            const pointer = this.pendingPanelPointer;
            this.pendingPanelPointer = null;
            if (pointer) this.positionPanelAtPointer(pointer);
        });
    }

    private cancelScheduledPanelPosition(): void {
        if (this.panelPositionFrame !== null) {
            cancelAnimationFrame(this.panelPositionFrame);
            this.panelPositionFrame = null;
        }
        this.pendingPanelPointer = null;
    }

    private inspectElementUnderCursor(): void {
        if (!this.pointerInFrame || !this.lastPointer) return;

        const hit = asHtmlElement(
            deepElementFromPoint(this.lastPointer.clientX, this.lastPointer.clientY),
        );
        if (!hit || isInsidePanel(hit)) return;

        const el = resolveInspectTarget(hit, this.inspectedElement, this.lastPointer);
        this.inspectElement(el, { fromStickyHit: el !== hit });
        this.positionPanelAtPointer(this.lastPointer);
    }

    // --- listeners ---

    private addHoverListeners(): void {
        if (this.haveHoverListeners) return;
        document.addEventListener('mouseover', this.onMouseOver, HOVER_LISTENER_OPTS);
        document.addEventListener('mouseout', this.onMouseOut, HOVER_LISTENER_OPTS);
        document.addEventListener('mousemove', this.onMouseMove, HOVER_LISTENER_OPTS);
        document.documentElement.addEventListener(
            'mouseleave',
            this.onPointerLeaveFrame,
            HOVER_LISTENER_OPTS,
        );
        this.haveHoverListeners = true;
    }

    private removeHoverListeners(): void {
        if (!this.haveHoverListeners) return;
        document.removeEventListener('mouseover', this.onMouseOver, HOVER_LISTENER_OPTS);
        document.removeEventListener('mouseout', this.onMouseOut, HOVER_LISTENER_OPTS);
        document.removeEventListener('mousemove', this.onMouseMove, HOVER_LISTENER_OPTS);
        document.documentElement.removeEventListener(
            'mouseleave',
            this.onPointerLeaveFrame,
            HOVER_LISTENER_OPTS,
        );
        this.cancelScheduledPanelPosition();
        this.cancelStyleRefresh();
        this.haveHoverListeners = false;
    }

    private addKeyListeners(): void {
        if (this.haveKeyListeners) return;
        // Capture so Esc still reaches us before page handlers when possible.
        document.addEventListener('keydown', this.onKeyDown, true);
        this.haveKeyListeners = true;
    }

    private removeKeyListeners(): void {
        if (!this.haveKeyListeners) return;
        document.removeEventListener('keydown', this.onKeyDown, true);
        this.haveKeyListeners = false;
    }

    private handleKey(e: KeyboardEvent): void {
        if (!this.armed) return;
        // After `npm run dev` / Reload in chrome://extensions, this script can
        // outlive the extension. Drop listeners instead of spamming the console.
        if (!isExtensionContextValid()) {
            this.disable();
            return;
        }

        if (e.key === 'Escape') {
            e.preventDefault();
            // Close this frame immediately; broadcast disarms the rest of the tab.
            this.disable();
            sendRuntimeMessage(Messages.disarmOverlay());
            return;
        }

        if (e.altKey || e.ctrlKey || e.metaKey) return;

        const key = e.key.length === 1 ? e.key.toLowerCase() : '';
        if (key === 'f') {
            if (this.isTracking()) this.freeze();
            else this.unfreeze();
            return;
        }
        if (key === 'c') {
            e.preventDefault();
            if (e.shiftKey) void this.copyElementClasses();
            else void this.copyCssDefinition();
            return;
        }
        if (key === 'j') {
            e.preventDefault();
            void this.copyJsonDefinition();
            return;
        }
        if (key === 'l') {
            e.preventDefault();
            this.toggleShowCssClasses();
            return;
        }
        if (key === 's') {
            e.preventDefault();
            sendRuntimeMessage(Messages.openOptions());
            return;
        }

        if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') {
            e.preventDefault();
            this.adjustPanelFontSize(PANEL_FONT_SIZE_STEP);
            return;
        }
        if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
            e.preventDefault();
            this.adjustPanelFontSize(-PANEL_FONT_SIZE_STEP);
            return;
        }
        if (e.key === '0' || e.code === 'Numpad0') {
            e.preventDefault();
            this.resetPanelFontSize();
        }
    }

    private toggleShowCssClasses(): void {
        const next = !isShowCssClasses();
        setShowCssClasses(next);
        void saveShowCssClasses(next);
        this.flashMessage(next ? 'Classes shown' : 'Classes hidden', { tone: 'success' });
        if (this.inspectedElement?.isConnected) {
            updateClassesPanel(this.inspectedElement);
        }
        const block = document.getElementById(OVERLAY_ID);
        if (block) keepOverlayInViewport(block);
    }

    private async copyElementClasses(): Promise<void> {
        const el = this.inspectedElement;
        if (!el || !el.isConnected) {
            this.flashMessage('Nothing to copy — hover an element first.');
            return;
        }

        const tokens = parseClassTokens(el);
        if (tokens.length === 0) {
            this.flashMessage('No classes on this element.');
            return;
        }

        try {
            await copyTextToClipboard(formatClassesForCopy(tokens));
            this.flashMessage('Classes copied to clipboard', { tone: 'success' });
        } catch {
            this.flashMessage('Could not copy to clipboard');
        }
    }

    private async copyCssDefinition(): Promise<void> {
        const el = this.inspectedElement;
        if (!el || !el.isConnected) {
            this.flashMessage('Nothing to copy — hover an element first.');
            return;
        }

        const view = document.defaultView;
        if (!view) {
            this.flashMessage('Could not copy to clipboard');
            return;
        }

        try {
            const css = buildCssDefinition(el, view.getComputedStyle(el));
            await copyTextToClipboard(css);
            this.flashMessage('CSS definition copied to clipboard', { tone: 'success' });
        } catch {
            this.flashMessage('Could not copy to clipboard');
        }
    }

    private async copyJsonDefinition(): Promise<void> {
        const el = this.inspectedElement;
        if (!el || !el.isConnected) {
            this.flashMessage('Nothing to copy — hover an element first.');
            return;
        }

        const view = document.defaultView;
        if (!view) {
            this.flashMessage('Could not copy to clipboard');
            return;
        }

        try {
            const json = buildJsonDefinition(el, view.getComputedStyle(el));
            await copyTextToClipboard(json);
            this.flashMessage('JSON copied to clipboard', { tone: 'success' });
        } catch {
            this.flashMessage('Could not copy to clipboard');
        }
    }
}

// === Entry point ===

const controller = new OverlayController();
const ready = controller.loadPrefs().catch(() => {
    // Prefs unavailable (orphaned script / restricted frame) — keep defaults.
});

// Attach styles from JS — declared content_scripts CSS often misses
// document.write() about:blank result frames (e.g. W3Schools Tryit).
ensureOverlayStyles();

const BOOT_FLAG = '__styleDetectiveBooted__';
const bootRoot = globalThis as typeof globalThis & { [BOOT_FLAG]?: boolean };

if (!bootRoot[BOOT_FLAG]) {
    bootRoot[BOOT_FLAG] = true;

    try {
        chrome.runtime?.onMessage.addListener((raw, _sender, sendResponse) => {
            const message = parseExtensionMessage(raw);
            if (!message) return;

            if (message.type === MessageType.PingOverlay) {
                sendResponse({ ok: true });
                return;
            }

            if (message.type === MessageType.OverlayClaim) {
                controller.onOverlayClaim(message.instanceId);
                return;
            }

            if (message.type === MessageType.SetOverlayArmed) {
                // Respond immediately. Waiting on prefs (and returning `true`) made
                // toggles/Esc stall on pages with many iframe content-script copies —
                // Chrome can sit on a slow frame's async reply for seconds.
                if (!message.armed) {
                    controller.setArmed(false);
                    sendResponse({ ok: true, enabled: false });
                    return;
                }
                sendResponse({ ok: true });
                void ready
                    .then(() => {
                        controller.setArmed(true);
                    })
                    .catch((err: unknown) => {
                        console.error('[Style Detective] setArmed failed', err);
                    });
                return;
            }
        });
    } catch {
        // Orphaned content script after reload/update.
    }
}
