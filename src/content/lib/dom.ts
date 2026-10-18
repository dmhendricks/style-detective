/*!
 * Style Detective — typed DOM construction helpers.
 *
 * Builds overlay UI with real DOM nodes (never string-concatenated HTML) so
 * host-page markup cannot leak into the panel and nothing collides with the page.
 */

import { copyTextToClipboard } from './clipboard';
import { notifyCopy } from './copy-feedback';
import { extractFirstCssGradient, parseCssColor } from './format';
import { FROZEN_CLASS, OVERLAY_ID } from '../../shared/dom-ids';

/** Tag names we construct, mapped to their element types for `el()`. */
type TagName = keyof HTMLElementTagNameMap;

interface ElOptions {
    id?: string;
    className?: string;
    text?: string;
    children?: Node[];
}

/** Create an element with optional id/class/text/children in one call. */
export function el<K extends TagName>(
    doc: Document,
    tag: K,
    opts: ElOptions = {},
): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);

    if (opts.id !== undefined) node.id = opts.id;
    if (opts.className !== undefined) node.className = opts.className;
    if (opts.text !== undefined) node.append(doc.createTextNode(opts.text));
    if (opts.children) {
        for (const child of opts.children) node.append(child);
    }

    return node;
}

/**
 * Build the small colour swatch shown next to a colour value.
 * Semi-transparent fills sit on a light checkerboard so they match page paint
 * better than compositing onto the dark panel chrome.
 * Pass `asImage: true` for gradients (painted via background-image).
 */
export function colorSwatch(
    doc: Document,
    cssFill: string,
    options: { asImage?: boolean } = {},
): HTMLSpanElement {
    const swatch = doc.createElement('span');
    swatch.className = 'StyleDetectiveOverlay__color-swatch';

    const fill = doc.createElement('span');
    fill.className = 'StyleDetectiveOverlay__color-swatch-fill';
    if (options.asImage) {
        fill.style.setProperty('background-image', cssFill, 'important');
    } else {
        fill.style.setProperty('background-color', cssFill, 'important');
    }
    swatch.append(fill);

    return swatch;
}

function clipboardIcon(doc: Document): SVGSVGElement {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '9');
    rect.setAttribute('y', '2');
    rect.setAttribute('width', '6');
    rect.setAttribute('height', '4');
    rect.setAttribute('rx', '1');
    rect.setAttribute('ry', '1');

    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute(
        'd',
        'M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3',
    );

    svg.append(rect, path);
    return svg;
}

function checkIcon(doc: Document): SVGSVGElement {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    const polyline = doc.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', '20 6 9 17 4 12');

    svg.append(polyline);
    return svg;
}

export function isOverlayFrozen(doc: Document = document): boolean {
    return doc.getElementById(OVERLAY_ID)?.classList.contains(FROZEN_CLASS) ?? false;
}

/**
 * Shift a fixed-position overlay so its box stays inside the viewport
 * (used after font-size changes and header expand).
 */
export function keepOverlayInViewport(block: HTMLElement): void {
    const MARGIN = 8;
    // Leave room for the browser's link-URL preview along the bottom edge.
    const BOTTOM_MARGIN = 40;
    const rect = block.getBoundingClientRect();

    let left = rect.left;
    let top = rect.top;

    if (left + rect.width > window.innerWidth - MARGIN) {
        left = window.innerWidth - MARGIN - rect.width;
    }
    if (left < MARGIN) {
        left = MARGIN;
    }
    if (top + rect.height > window.innerHeight - BOTTOM_MARGIN) {
        top = window.innerHeight - BOTTOM_MARGIN - rect.height;
    }
    if (top < MARGIN) {
        top = MARGIN;
    }

    if (left !== rect.left) {
        block.style.left = `${left}px`;
    }
    if (top !== rect.top) {
        block.style.top = `${top}px`;
    }
}

/**
 * Viewport box for the hover highlight using layout size (offsetWidth/Height),
 * not the transformed paint box from getBoundingClientRect. Scale animations
 * would otherwise make the dashed outline throb.
 */
export function layoutHighlightRect(el: HTMLElement): {
    top: number;
    left: number;
    width: number;
    height: number;
} {
    const visual = el.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    return {
        // Center the layout box on the visual box so translate/scale-from-center
        // stays put while size ignores the transform.
        top: visual.top + (visual.height - height) / 2,
        left: visual.left + (visual.width - width) / 2,
        width: Math.max(0, width),
        height: Math.max(0, height),
    };
}

/** True when a viewport point lies over the element's layout highlight box. */
export function pointOverElement(
    el: HTMLElement,
    clientX: number,
    clientY: number,
): boolean {
    if (!el.isConnected) return false;
    const rect = layoutHighlightRect(el);
    return (
        clientX >= rect.left &&
        clientX <= rect.left + rect.width &&
        clientY >= rect.top &&
        clientY <= rect.top + rect.height
    );
}

/** Cap nested open-shadow drills (MDN / Lit often nest a few deep). */
export const SHADOW_PIERCE_MAX_DEPTH = 8;

/**
 * Drill into open shadow roots under `start` at a viewport point.
 * `document.elementFromPoint` retargets to the host; closed roots stay opaque
 * (`shadowRoot` is null). Stops when nesting ends or the host is returned again.
 */
export function pierceOpenShadow(
    start: Element,
    clientX: number,
    clientY: number,
    maxDepth: number = SHADOW_PIERCE_MAX_DEPTH,
): Element {
    let current = start;
    for (let depth = 0; depth < maxDepth; depth++) {
        const root = current.shadowRoot;
        if (!root) break;

        let nested: Element | null;
        try {
            nested = root.elementFromPoint(clientX, clientY);
        } catch {
            break;
        }
        if (!nested || nested === current) break;
        current = nested;
    }
    return current;
}

/** Pseudo-element style subset read by `isInvisibleOverlayStyle`. */
export type OverlayPseudoStyle = Pick<
    CSSStyleDeclaration,
    'content' | 'position' | 'backgroundImage' | 'backgroundColor' | 'opacity'
>;

/**
 * True for a positioned ::before/::after that paints nothing you'd notice: no
 * generated text or image and a see-through background. Typical of the
 * "stretched link" pattern (`a::after { position: absolute; inset: 0 }`) that
 * extends a link's click area over its positioned container.
 */
export function isInvisibleOverlayStyle(style: OverlayPseudoStyle): boolean {
    // `none`/`normal` → the pseudo-element isn't generated at all.
    if (style.content === 'none' || style.content === 'normal') return false;
    if (style.position !== 'absolute' && style.position !== 'fixed') return false;
    if (style.opacity === '0') return true;
    if (style.content !== '""' && style.content !== "''") return false;
    if (style.backgroundImage !== 'none') return false;
    const bg = parseCssColor(style.backgroundColor);
    return bg !== null && bg.a < 0.5;
}

function pointInClientRects(el: Element, clientX: number, clientY: number): boolean {
    for (const rect of el.getClientRects()) {
        if (
            clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom
        ) {
            return true;
        }
    }
    return false;
}

/**
 * True when `el` is hit only through an invisible positioned pseudo-element:
 * the point is outside its own boxes (per line, for wrapped inline links), so
 * what's visible there is whatever the overlay covers.
 */
function isHitThroughInvisibleOverlay(el: Element, clientX: number, clientY: number): boolean {
    if (pointInClientRects(el, clientX, clientY)) return false;
    const view = el.ownerDocument.defaultView;
    if (!view) return false;
    return (
        isInvisibleOverlayStyle(view.getComputedStyle(el, '::after')) ||
        isInvisibleOverlayStyle(view.getComputedStyle(el, '::before'))
    );
}

/**
 * Topmost element at a point, looking through invisible click overlays so the
 * user inspects what they see rather than the link whose ::after covers it.
 */
function visibleElementFromPoint(doc: Document, clientX: number, clientY: number): Element | null {
    const hit = doc.elementFromPoint(clientX, clientY);
    if (!hit || !isHitThroughInvisibleOverlay(hit, clientX, clientY)) return hit;

    for (const el of doc.elementsFromPoint(clientX, clientY)) {
        if (!isHitThroughInvisibleOverlay(el, clientX, clientY)) return el;
    }
    return hit;
}

/**
 * Deepest element at a viewport point, including inside open shadow trees.
 * Same as `document.elementFromPoint` on light-DOM-only pages, except that
 * invisible stretched-link overlays are looked through.
 */
export function deepElementFromPoint(
    clientX: number,
    clientY: number,
    doc: Document = document,
): Element | null {
    const hit = visibleElementFromPoint(doc, clientX, clientY);
    if (!hit) return null;
    return pierceOpenShadow(hit, clientX, clientY);
}

/** Nearest HTMLElement for inspection (SVG hits walk up to an HTML parent). */
export function asHtmlElement(node: Element | null): HTMLElement | null {
    let cur: Element | null = node;
    while (cur) {
        if (cur instanceof HTMLElement) return cur;
        cur = cur.parentElement;
    }
    return null;
}

/**
 * True if `node` is `ancestor` or nested under it, crossing open shadow
 * boundaries (`parentNode` then `ShadowRoot.host`). `Node.contains` does not.
 */
export function isComposedDescendant(ancestor: Node, node: Node): boolean {
    let cur: Node | null = node;
    while (cur) {
        if (cur === ancestor) return true;
        if (cur.parentNode) {
            cur = cur.parentNode;
            continue;
        }
        // ShadowRoot.host — plain Nodes lack `.host`.
        const host: Node | undefined = (cur as ShadowRoot).host;
        cur = host ?? null;
    }
    return false;
}

/** Match #RGB, #RRGGBB, or #RRGGBBAA hex tokens in a property value string. */
const HEX_COLOR_RE = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

/** Hex or rgb()/rgba() anywhere in a value (e.g. `1px solid rgba(...)`). */
const COLOR_TOKEN_RE =
    /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)/gi;

/** Expand shorthand #RGB / #RGBA to six- or eight-digit hex for swatch fill. */
function normalizeHexForSwatch(hex: string): string {
    let normalized = hex.toUpperCase();

    if (normalized.length === 4) {
        normalized =
            '#' +
            normalized[1]! +
            normalized[1]! +
            normalized[2]! +
            normalized[2]! +
            normalized[3]! +
            normalized[3]!;
    } else if (normalized.length === 5) {
        normalized =
            '#' +
            normalized[1]! +
            normalized[1]! +
            normalized[2]! +
            normalized[2]! +
            normalized[3]! +
            normalized[3]! +
            normalized[4]! +
            normalized[4]!;
    }

    return normalized;
}

function swatchCssColor(token: string): string {
    return token.startsWith('#') ? normalizeHexForSwatch(token) : token;
}

function firstColorToken(text: string): string | null {
    return text.match(COLOR_TOKEN_RE)?.[0] ?? null;
}

/** Build display nodes for a value, adding a leading swatch when a color is present. */
function textWithColorSwatches(doc: Document, text: string): DocumentFragment {
    const frag = doc.createDocumentFragment();
    const gradient = extractFirstCssGradient(text);

    if (gradient) {
        // Paint the gradient itself — first-stop solid would misrepresent it.
        frag.append(colorSwatch(doc, gradient, { asImage: true }));
    } else {
        const leading = firstColorToken(text);
        if (leading) {
            frag.append(colorSwatch(doc, swatchCssColor(leading)));
        }
    }

    let lastIndex = 0;

    for (const match of text.matchAll(HEX_COLOR_RE)) {
        const hex = match[0];
        const index = match.index ?? 0;

        if (index > lastIndex) {
            frag.append(doc.createTextNode(text.slice(lastIndex, index)));
        }

        frag.append(doc.createTextNode(hex));
        lastIndex = index + hex.length;
    }

    if (lastIndex === 0) {
        frag.append(doc.createTextNode(text));
    } else if (lastIndex < text.length) {
        frag.append(doc.createTextNode(text.slice(lastIndex)));
    }

    return frag;
}

function copyAffordance(doc: Document): HTMLSpanElement {
    const affordance = doc.createElement('span');
    affordance.className = 'StyleDetectiveOverlay__copy-affordance';
    affordance.title = 'Copy';
    // Decorative — the value group is the accessible control when frozen.
    affordance.setAttribute('aria-hidden', 'true');
    affordance.append(clipboardIcon(doc));

    return affordance;
}

function performFrozenCopy(
    doc: Document,
    affordance: HTMLElement,
    copyValue: string,
): void {
    void copyTextToClipboard(copyValue).then(
        () => {
            affordance.replaceChildren(checkIcon(doc));
            window.setTimeout(() => {
                affordance.replaceChildren(clipboardIcon(doc));
            }, 900);
        },
        () => {
            notifyCopy('Could not copy to clipboard', 'default');
        },
    );
}

/** Class for compact frozen-copy targets (box-model labels) without an icon slot. */
export const COPY_TARGET_CLASS = 'StyleDetectiveOverlay__copy-target';

function applyCopyGroupAccessibility(group: HTMLElement, frozen: boolean): void {
    if (frozen) {
        group.setAttribute('role', 'button');
        group.setAttribute('tabindex', '0');
        group.setAttribute('aria-label', 'Copy value');
        group.title = 'Copy';
    } else {
        group.removeAttribute('role');
        group.removeAttribute('tabindex');
        group.removeAttribute('aria-label');
        group.removeAttribute('title');
    }
}

/**
 * When the overlay freezes, value groups and diagram copy targets become
 * keyboard-activatable. Unfreeze removes them from the tab order.
 */
export function syncCopyValueAccessibility(doc: Document = document): void {
    const frozen = isOverlayFrozen(doc);
    for (const group of doc.querySelectorAll<HTMLElement>(
        `.StyleDetectiveOverlay__value-group, .${COPY_TARGET_CLASS}`,
    )) {
        applyCopyGroupAccessibility(group, frozen);
    }
}

function attachFrozenCopy(
    doc: Document,
    target: HTMLElement,
    affordance: HTMLElement,
    copyValue: string,
): void {
    applyCopyGroupAccessibility(target, isOverlayFrozen(doc));

    target.addEventListener('click', (e) => {
        if (!isOverlayFrozen(doc)) return;
        e.preventDefault();
        e.stopPropagation();
        performFrozenCopy(doc, affordance, copyValue);
    });

    target.addEventListener('keydown', (e) => {
        if (!isOverlayFrozen(doc)) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        performFrozenCopy(doc, affordance, copyValue);
    });
}

/**
 * Make an element copy its `data-sd-copy` value when the overlay is frozen.
 * Used where a clipboard icon would not fit (box-model diagram labels).
 */
export function attachFrozenCopyTarget(target: HTMLElement): void {
    const doc = target.ownerDocument;
    target.classList.add(COPY_TARGET_CLASS);
    applyCopyGroupAccessibility(target, isOverlayFrozen(doc));

    const copyFromDataset = (): void => {
        const copyValue = target.dataset.sdCopy;
        if (copyValue === undefined || copyValue === '') return;
        void copyTextToClipboard(copyValue).then(
            () => {
                notifyCopy(`Copied "${copyValue}" to clipboard`, 'success');
            },
            () => {
                notifyCopy('Could not copy to clipboard', 'default');
            },
        );
    };

    target.addEventListener('click', (e) => {
        if (!isOverlayFrozen(doc)) return;
        e.preventDefault();
        e.stopPropagation();
        copyFromDataset();
    });

    target.addEventListener('keydown', (e) => {
        if (!isOverlayFrozen(doc)) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        copyFromDataset();
    });
}

/** Update the clipboard payload for a frozen copy target. */
export function setCopyTargetValue(target: HTMLElement, copyValue: string): void {
    target.dataset.sdCopy = copyValue;
}

function wrapCopyableValue(doc: Document, copyValue: string): HTMLSpanElement {
    const group = doc.createElement('span');
    group.className = 'StyleDetectiveOverlay__value-group';

    const text = doc.createElement('span');
    text.className = 'StyleDetectiveOverlay__value-text';
    text.append(textWithColorSwatches(doc, copyValue));

    const affordance = copyAffordance(doc);
    group.append(text, affordance);
    attachFrozenCopy(doc, group, affordance, copyValue);

    return group;
}

/**
 * Element class attribute as a plain string. HTMLElement.className is a string,
 * but SVGElement.className is an SVGAnimatedString — never concatenate that.
 */
export function elementClassName(el: Element): string {
    return el.getAttribute('class') ?? '';
}

/**
 * Build the `<tag> #id` selector label shown in the panel header.
 * Classes live in the Classes row — omit them here so the banner stays short.
 * Text nodes only — no markup injection.
 */
export function selectorLabel(el: HTMLElement): string {
    return el.tagName + (el.id === '' ? '' : ' #' + el.id);
}

/**
 * Replace a property-value cell with a copyable value group (colon is CSS).
 * When frozen, hovering the value reveals a copy icon; clicking copies the full
 * property value string. Skips the DOM rebuild when the value is unchanged.
 */
export function setValueContent(
    target: HTMLElement,
    copyValue: string,
    options: { badge?: { text: string; tone: string } | null } = {},
): void {
    const badge = options.badge ?? null;
    const fingerprint = badge ? `${copyValue}\0${badge.tone}:${badge.text}` : copyValue;
    if (target.dataset.sdValue === fingerprint) return;

    const doc = target.ownerDocument;
    target.dataset.sdValue = fingerprint;

    const group = wrapCopyableValue(doc, copyValue);
    if (badge) {
        const pill = doc.createElement('span');
        pill.className = `StyleDetectiveOverlay__contrast-badge StyleDetectiveOverlay__contrast-badge--${badge.tone}`;
        pill.textContent = badge.text;
        pill.title = `WCAG ${badge.text}`;
        group.querySelector('.StyleDetectiveOverlay__value-text')?.append(pill);
    }

    target.replaceChildren(group);
}
