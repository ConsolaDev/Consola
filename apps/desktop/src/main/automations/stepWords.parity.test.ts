import { describe, expect, it } from 'vitest';
import { WAITING_FOR_CHECKOUT } from '@consola/automation-engine';
import { CHECKOUT_WAIT } from '../../renderer/components/Automations/presentation';

/**
 * The renderer recognises some of the engine's words by their text, and may
 * not import the engine to read them (it takes the engine's types only). Main
 * may, so this is what keeps each pair one string.
 */
describe('words the renderer reads from the engine', () => {
    it("the checkout wait a run's row shows is the summary the engine gives it", () => {
        expect(WAITING_FOR_CHECKOUT).toBe("waiting for this item's checkout");
        expect(CHECKOUT_WAIT).toBe(WAITING_FOR_CHECKOUT);
    });
});
