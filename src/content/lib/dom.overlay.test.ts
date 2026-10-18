import { describe, expect, it } from 'vitest';
import { deepElementFromPoint, isInvisibleOverlayStyle, type OverlayPseudoStyle } from './dom';

const NO_PSEUDO: OverlayPseudoStyle = {
    content: 'none',
    position: 'static',
    backgroundImage: 'none',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    opacity: '1',
};

// Typical stretched-link ::after: empty, transparent, `inset: 0` over its container.
const STRETCHED_LINK: OverlayPseudoStyle = {
    content: '""',
    position: 'absolute',
    backgroundImage: 'none',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    opacity: '1',
};

describe('isInvisibleOverlayStyle', () => {
    it('matches an empty, transparent, absolutely positioned pseudo-element', () => {
        expect(isInvisibleOverlayStyle(STRETCHED_LINK)).toBe(true);
        expect(isInvisibleOverlayStyle({ ...STRETCHED_LINK, position: 'fixed' })).toBe(true);
    });

    it('treats a light tint as see-through', () => {
        expect(
            isInvisibleOverlayStyle({ ...STRETCHED_LINK, backgroundColor: 'rgba(0, 0, 0, 0.1)' }),
        ).toBe(true);
    });

    it('ignores pseudo-elements that are not generated', () => {
        expect(isInvisibleOverlayStyle(NO_PSEUDO)).toBe(false);
        expect(isInvisibleOverlayStyle({ ...NO_PSEUDO, position: 'absolute', opacity: '0' })).toBe(
            false,
        );
    });

    it('keeps pseudo-elements that paint something visible', () => {
        expect(isInvisibleOverlayStyle({ ...STRETCHED_LINK, content: '"→"' })).toBe(false);
        expect(isInvisibleOverlayStyle({ ...STRETCHED_LINK, content: 'url("icon.svg")' })).toBe(
            false,
        );
        expect(
            isInvisibleOverlayStyle({ ...STRETCHED_LINK, backgroundColor: 'rgb(255, 0, 0)' }),
        ).toBe(false);
        expect(
            isInvisibleOverlayStyle({ ...STRETCHED_LINK, backgroundImage: 'url("badge.png")' }),
        ).toBe(false);
    });

    it('requires out-of-flow positioning', () => {
        expect(isInvisibleOverlayStyle({ ...STRETCHED_LINK, position: 'relative' })).toBe(false);
    });

    it('treats opacity 0 as invisible even with content', () => {
        expect(isInvisibleOverlayStyle({ ...STRETCHED_LINK, content: '"x"', opacity: '0' })).toBe(
            true,
        );
    });
});

describe('deepElementFromPoint with stretched links', () => {
    type Box = { left: number; top: number; right: number; bottom: number };

    // A container (y 0–100) holding a label (y 0–20) above a wrapped link
    // (y 30–60) whose ::after is stretched over the whole container.
    function makeContainer(afterStyle: OverlayPseudoStyle) {
        const view = {
            getComputedStyle: (el: { after?: OverlayPseudoStyle }, pseudo?: string) =>
                pseudo === '::after' && el.after ? el.after : NO_PSEUDO,
        };
        const doc = { defaultView: view } as unknown as Document;
        const make = (name: string, boxes: Box[], after?: OverlayPseudoStyle) =>
            ({
                name,
                after,
                shadowRoot: null,
                ownerDocument: doc,
                getClientRects: () => boxes,
            }) as unknown as Element;

        const container = make('container', [{ left: 0, top: 0, right: 300, bottom: 100 }]);
        const label = make('label', [{ left: 10, top: 0, right: 120, bottom: 20 }]);
        const link = make(
            'link',
            [
                { left: 10, top: 30, right: 290, bottom: 45 },
                { left: 10, top: 45, right: 150, bottom: 60 },
            ],
            afterStyle,
        );

        const stackAt = (x: number, y: number): Element[] => {
            const inside = (el: Element) =>
                [...el.getClientRects()].some(
                    (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
                );
            // The link's ::after (z-index 1) sits on top everywhere in the container.
            return [link, ...[label, container].filter(inside)];
        };
        Object.assign(doc, {
            elementFromPoint: (x: number, y: number) => stackAt(x, y)[0] ?? null,
            elementsFromPoint: stackAt,
        });
        return { doc, container, label, link };
    }

    it('looks through the overlay to the element underneath', () => {
        const { doc, label } = makeContainer(STRETCHED_LINK);
        expect(deepElementFromPoint(20, 10, doc)).toBe(label);
    });

    it('still returns the link over its own text, including wrapped lines', () => {
        const { doc, link } = makeContainer(STRETCHED_LINK);
        expect(deepElementFromPoint(200, 35, doc)).toBe(link);
        expect(deepElementFromPoint(100, 50, doc)).toBe(link);
    });

    it('falls through to the container in empty space beside a wrapped line', () => {
        const { doc, container } = makeContainer(STRETCHED_LINK);
        expect(deepElementFromPoint(250, 50, doc)).toBe(container);
    });

    it('keeps the link when its pseudo-element is visible', () => {
        const { doc, link } = makeContainer({ ...STRETCHED_LINK, backgroundColor: 'rgb(0, 0, 0)' });
        expect(deepElementFromPoint(20, 10, doc)).toBe(link);
    });
});
