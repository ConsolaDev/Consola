import { describe, expect, it } from 'vitest';
import { detectOpenTrigger, type TypeaheadTriggerConfig } from './detectOpenTrigger';
import { spliceTypeaheadSelection } from './spliceTypeaheadSelection';

const SLASH: TypeaheadTriggerConfig = { char: '/', position: 'message-start' };
const AT: TypeaheadTriggerConfig = { char: '@', position: 'word-boundary' };
const TRIGGERS = [SLASH, AT];

/** Detect at the end of `text`, which is where the caret sits while typing. */
function atEnd(text: string) {
    return detectOpenTrigger(text, text.length, TRIGGERS);
}

describe('detectOpenTrigger', () => {
    it('opens on a slash typed as the first character', () => {
        expect(atEnd('/')).toMatchObject({ query: '', start: 0 });
    });

    it('collects what has been typed after the slash', () => {
        expect(atEnd('/comm')).toMatchObject({ query: 'comm' });
    });

    it('keeps a colon-qualified plugin command open while it is typed', () => {
        expect(atEnd('/feature-dev:feat')).toMatchObject({ query: 'feature-dev:feat' });
    });

    it('stays closed for a slash inside a file path', () => {
        // The case that makes a naive "any slash" rule unusable: paths are the
        // single most common thing typed into a prompt about code.
        expect(atEnd('look at src/main')).toBeNull();
    });

    it('stays closed for a slash after other words, even at a word boundary', () => {
        expect(atEnd('run the /commit')).toBeNull();
    });

    it('stays closed once the command has been finished with a space', () => {
        expect(atEnd('/commit ')).toBeNull();
        expect(atEnd('/commit and push')).toBeNull();
    });

    it('opens on an at-sign at the start of a word', () => {
        expect(atEnd('ask @Expl')).toMatchObject({ trigger: AT, query: 'Expl' });
    });

    it('stays closed for an at-sign inside an email address', () => {
        expect(atEnd('mail someone@example')).toBeNull();
    });

    it('reads from the caret, not the end of the text', () => {
        // Editing back into an already-typed command has to reopen the menu
        // with only the part before the caret as the query.
        const text = '/commit-push-pr';
        expect(detectOpenTrigger(text, 7, TRIGGERS)).toMatchObject({ query: 'commit' });
    });

    it('treats a leading newline as message start', () => {
        expect(atEnd('\n/comm')).toMatchObject({ query: 'comm' });
    });

    it('is closed for ordinary prose', () => {
        expect(atEnd('why is this failing')).toBeNull();
        expect(atEnd('')).toBeNull();
    });
});

describe('spliceTypeaheadSelection', () => {
    it('replaces the partial token and leaves the caret past a trailing space', () => {
        const open = atEnd('/comm')!;

        const result = spliceTypeaheadSelection('/comm', open, 'commit');

        expect(result.value).toBe('/commit ');
        expect(result.caretIndex).toBe(8);
    });

    it('keeps text that was already after the caret', () => {
        const text = '/comm and then push';
        const open = detectOpenTrigger(text, 5, TRIGGERS)!;

        const result = spliceTypeaheadSelection(text, open, 'commit');

        expect(result.value).toBe('/commit  and then push');
    });

    it('splices a mention without disturbing the words around it', () => {
        const text = 'ask @Expl to look';
        const open = detectOpenTrigger(text, 9, TRIGGERS)!;

        const result = spliceTypeaheadSelection(text, open, 'Explore');

        expect(result.value).toBe('ask @Explore  to look');
        expect(result.caretIndex).toBe(13);
    });
});
