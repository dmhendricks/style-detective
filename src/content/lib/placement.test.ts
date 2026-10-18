import { describe, expect, it } from 'vitest';
import {
    computePanelPlacement,
    PLACEMENT_BOTTOM_MARGIN,
    PLACEMENT_MARGIN,
    type PanelPlacement,
    type PanelPlacementInput,
    type PanelSide,
} from './placement';

function place(overrides: Partial<PanelPlacementInput>): PanelPlacement {
    return computePanelPlacement({
        pointerX: 100,
        pointerY: 100,
        panelWidth: 440,
        panelHeight: 600,
        viewportWidth: 1280,
        viewportHeight: 800,
        ...overrides,
    });
}

/** True when the pointer hotspot lands inside the panel box as rendered. */
function coversPointer(p: PanelPlacement, input: PanelPlacementInput): boolean {
    const height = Math.min(input.panelHeight, p.maxHeight ?? Infinity);
    return (
        input.pointerX >= p.left &&
        input.pointerX <= p.left + input.panelWidth &&
        input.pointerY >= p.top &&
        input.pointerY <= p.top + height
    );
}

/** Move the pointer across the viewport, feeding each side back like core.ts. */
function sweep(
    base: Omit<PanelPlacementInput, 'pointerX' | 'pointerY' | 'previousSide'>,
    points: Array<[number, number]>,
): Array<{ input: PanelPlacementInput; placement: PanelPlacement }> {
    let previousSide: PanelSide | undefined;
    return points.map(([pointerX, pointerY]) => {
        const input = { ...base, pointerX, pointerY, previousSide };
        const placement = computePanelPlacement(input);
        previousSide = placement.side;
        return { input, placement };
    });
}

describe('computePanelPlacement', () => {
    it('sits right of the pointer when there is room', () => {
        expect(place({ pointerX: 100, pointerY: 100 })).toEqual({
            left: 120,
            top: 120,
            side: 'right',
            maxHeight: null,
        });
    });

    it('flips left near the right edge instead of sliding under the pointer', () => {
        // Regression: the old flip test ignored the 20px gap, so here the panel
        // was nudged back over the cursor and stopped following it.
        const pointerX = 1280 - 440 - 4;
        const p = place({ pointerX });
        expect(p.side).toBe('left');
        expect(p.left + 440).toBeLessThan(pointerX);
    });

    it('goes above the pointer when it would run off the bottom', () => {
        const p = place({ pointerY: 700, panelHeight: 300 });
        expect(p.top + 300).toBeLessThan(700);
    });

    it('never covers the pointer on a viewport wide enough for either side', () => {
        const base = {
            panelWidth: 440,
            panelHeight: 760,
            viewportWidth: 1280,
            viewportHeight: 800,
        };
        const xs = Array.from({ length: 1281 }, (_, i) => i);
        const right = xs.map((x): [number, number] => [x, 400]);
        const back = [...xs].reverse().map((x): [number, number] => [x, 400]);
        for (const { input, placement } of sweep(base, [...right, ...back])) {
            expect(coversPointer(placement, input), `x=${input.pointerX}`).toBe(false);
            expect(placement.left).toBeGreaterThanOrEqual(PLACEMENT_MARGIN);
            expect(placement.left + 440).toBeLessThanOrEqual(1280 - PLACEMENT_MARGIN);
        }
    });

    it('does not flicker between sides when jittering at the swap point', () => {
        // Right stops fitting at x = 1280 - 8 - 440 - 20 = 812.
        const base = {
            panelWidth: 440,
            panelHeight: 600,
            viewportWidth: 1280,
            viewportHeight: 800,
        };
        const sides = sweep(base, [
            [813, 400],
            [811, 400],
            [813, 400],
            [800, 400],
        ]).map((s) => s.placement.side);
        expect(sides).toEqual(['left', 'left', 'left', 'left']);
        // Clearly back in right territory → returns to the preferred side.
        expect(
            computePanelPlacement({ ...base, pointerX: 760, pointerY: 400, previousSide: 'left' })
                .side,
        ).toBe('right');
    });

    // 900px wide, 440px panel: right fits up to x=432, left from x=488.
    it('stacks below with a height cap when too narrow for either side', () => {
        const p = place({ pointerX: 460, pointerY: 150, viewportWidth: 900, panelHeight: 760 });
        expect(p.side).toBe('below');
        expect(p.top).toBe(170);
        expect(p.maxHeight).toBe(800 - PLACEMENT_BOTTOM_MARGIN - 170);
    });

    it('stacks above when the pointer is low on a narrow viewport', () => {
        const p = place({ pointerX: 460, pointerY: 650, viewportWidth: 900, panelHeight: 760 });
        expect(p.side).toBe('above');
        expect(p.maxHeight).toBe(650 - 20 - PLACEMENT_MARGIN);
        expect(p.top).toBe(PLACEMENT_MARGIN);
    });

    it('skips the cap when the panel already fits above or below', () => {
        const p = place({ pointerX: 460, pointerY: 100, viewportWidth: 900, panelHeight: 300 });
        expect(p).toMatchObject({ side: 'below', top: 120, maxHeight: null });
    });

    it('never covers the pointer on a narrow viewport', () => {
        const base = { panelWidth: 440, panelHeight: 760, viewportWidth: 900, viewportHeight: 800 };
        const points: Array<[number, number]> = [];
        for (let y = 0; y <= 800; y += 25) {
            for (let x = 0; x <= 900; x += 15) points.push([x, y]);
        }
        for (const { input, placement } of sweep(base, points)) {
            expect(coversPointer(placement, input), `${input.pointerX},${input.pointerY}`).toBe(
                false,
            );
        }
    });

    it('overlaps rather than shrinking to a sliver in a tiny frame', () => {
        const p = place({
            pointerX: 150,
            pointerY: 75,
            panelWidth: 260,
            panelHeight: 400,
            viewportWidth: 300,
            viewportHeight: 150,
        });
        expect(p.maxHeight).toBeNull();
        expect(p.left).toBeGreaterThanOrEqual(PLACEMENT_MARGIN);
        expect(p.top).toBe(PLACEMENT_MARGIN);
    });
});
