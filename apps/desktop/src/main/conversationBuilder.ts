import type { ConversationEntry, ConversationRecord } from '../shared/conversation';

export const MAX_CONVERSATION_ENTRIES = 2000;
export const MAX_ENTRY_CHARS = 20_000;

/** One entry's text, cut to `MAX_ENTRY_CHARS`. */
export function capText(text: string): string {
  return text.length > MAX_ENTRY_CHARS ? text.slice(0, MAX_ENTRY_CHARS - 1) + '…' : text;
}

/**
 * A `ConversationRecord` built one entry at a time, oldest first, by any
 * driver reading its own CLI's transcript.
 *
 * Past `MAX_CONVERSATION_ENTRIES` the middle is dropped: the leading
 * prompt(s) are kept, then a sliding window of the newest entries — what a
 * conversation was for, and where it ended up, are what a reader needs.
 */
export class ConversationBuilder {
  private readonly head: ConversationEntry[] = [];
  private readonly tail: ConversationEntry[] = [];
  private truncated = false;

  public add(entry: ConversationEntry): void {
    if (this.tail.length === 0 && entry.kind === 'prompt') {
      this.head.push(entry);
      return;
    }
    this.tail.push(entry);
    if (this.head.length + this.tail.length > MAX_CONVERSATION_ENTRIES) {
      this.tail.shift();
      this.truncated = true;
    }
  }

  public build(): ConversationRecord {
    return { entries: [...this.head, ...this.tail], truncated: this.truncated };
  }
}
