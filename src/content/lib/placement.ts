/*!
 * Style Detective — panel placement next to the pointer.
 *
 * Pure geometry (no DOM) so the rules are unit-testable. The one hard rule:
 * never park the panel under the cursor when there is room anywhere else,
 * because a panel under the cursor hides exactly what the user is aiming at.
 */

/** Which side of the pointer the panel sits on. */
export type PanelSide = 'right' | 'left' | 'below' | 'above';

export interface PanelPlacementInput {
    pointerX: number;
    pointerY: number;
    /** Natural (uncapped) panel size. */
    panelWidth: number;
    panelHeight: number;
    viewportWidth: number;
    viewportHeight: number;
    /** Side used last frame — sticky so the panel doesn't flicker at a swap point. */
    previousSide?: PanelSide;
}

export interface PanelPlacement {
    left: number;
    top: number;
    side: PanelSide;
    /** Height cap when stacked above/below the pointer; null = natural height. */
    maxHeight: number | null;
}

/** Keep clear of the viewport edges. */
export const PLACEMENT_MARGIN = 8;
/** Leave room for the browser's link-URL preview along the bottom edge. */
export const PLACEMENT_BOTTOM_MARGIN = 40;
/** Clearance from the pointer hotspot (the arrow extends right/down of it). */
const GAP_RIGHT = 20;
const GAP_LEFT = 40;
const GAP_VERTICAL = 20;
/** Extra room a side needs before the panel abandons the side it's already on. */
export const SWAP_HYSTERESIS = 40;
/** Below this height, stacking above/below is too cramped to be useful. */
export const MIN_STACKED_HEIGHT = 200;

function clamp(value: number, min: number, max: number): number {
    // `min` wins when the panel is larger than the space (pin to top/left).
    return Math.max(min, Math.min(value, max));
}

function isBeside(side: PanelSide | undefined): boolean {
    return side === 'right' || side === 'left';
}

/**
 * Place the panel beside the pointer (right preferred, then left). When the
 * viewport is too narrow for either, stack it above or below with a height
 * cap. Only when that would be uselessly short does it overlap the pointer.
 */
export function computePanelPlacement(input: PanelPlacementInput): PanelPlacement {
    const { pointerX: x, pointerY: y, panelWidth: w, panelHeight: h, previousSide } = input;
    const right = input.viewportWidth - PLACEMENT_MARGIN;
    const bottom = input.viewportHeight - PLACEMENT_BOTTOM_MARGIN;

    // Switching sides costs hysteresis; staying put (or first placement) is free.
    const slack = (side: PanelSide): number =>
        previousSide === undefined || previousSide === side ? 0 : SWAP_HYSTERESIS;
    const fitsRight = (extra: number): boolean => x + GAP_RIGHT + w <= right - extra;
    const fitsLeft = (extra: number): boolean => x - GAP_LEFT - w >= PLACEMENT_MARGIN + extra;

    const besideTop = (): number => {
        let top = y + GAP_VERTICAL;
        if (top + h > bottom) top = y - GAP_VERTICAL - h;
        return clamp(top, PLACEMENT_MARGIN, bottom - h);
    };
    const beside = (side: 'right' | 'left'): PanelPlacement => ({
        left: clamp(
            side === 'right' ? x + GAP_RIGHT : x - GAP_LEFT - w,
            PLACEMENT_MARGIN,
            right - w,
        ),
        top: besideTop(),
        side,
        maxHeight: null,
    });

    if (fitsRight(slack('right'))) return beside('right');
    if (fitsLeft(slack('left'))) return beside('left');
    // A side that fits without the slack still beats stacking — unless we're
    // already stacked, where the slack keeps us from bouncing back and forth.
    if (!previousSide || isBeside(previousSide)) {
        if (fitsRight(0)) return beside('right');
        if (fitsLeft(0)) return beside('left');
    }

    // Too narrow to sit beside the pointer: stack above or below it instead.
    const roomRight = right - (x + GAP_RIGHT);
    const roomLeft = x - GAP_LEFT - PLACEMENT_MARGIN;
    const roomBelow = bottom - (y + GAP_VERTICAL);
    const roomAbove = y - GAP_VERTICAL - PLACEMENT_MARGIN;
    const fitsBelow = h <= roomBelow;
    const fitsAbove = h <= roomAbove;

    let vertical: 'below' | 'above';
    if (fitsBelow !== fitsAbove) {
        vertical = fitsBelow ? 'below' : 'above';
    } else if (previousSide === 'below' || previousSide === 'above') {
        // Neither or both fit: stay put unless the other side is clearly roomier.
        const stay = previousSide === 'below' ? roomBelow : roomAbove;
        const other = previousSide === 'below' ? roomAbove : roomBelow;
        vertical =
            other > stay + SWAP_HYSTERESIS
                ? previousSide === 'below'
                    ? 'above'
                    : 'below'
                : previousSide;
    } else {
        vertical = roomBelow >= roomAbove ? 'below' : 'above';
    }

    const room = vertical === 'below' ? roomBelow : roomAbove;
    if (room < MIN_STACKED_HEIGHT) {
        // Last resort (tiny iframes): overlap the pointer on the roomier side.
        // The panel ignores the mouse while tracking, so this can't trap the cursor.
        return beside(roomRight >= roomLeft ? 'right' : 'left');
    }

    const height = Math.min(h, room);
    return {
        // Keep horizontal continuity with the beside placement it came from.
        left: clamp(
            roomRight >= roomLeft ? x + GAP_RIGHT : x - GAP_LEFT - w,
            PLACEMENT_MARGIN,
            right - w,
        ),
        top: vertical === 'below' ? y + GAP_VERTICAL : y - GAP_VERTICAL - height,
        side: vertical,
        maxHeight: h > room ? room : null,
    };
}
