// @effect-diagnostics nodeBuiltinImport:off - A ticket is random bytes from node:crypto.
/**
 * The tickets the host issues for its socket (`hostHttp.ts`, `POST /api/auth/websocket-ticket/rpc`)
 * in exchange for a verified pass, which t3's client then opens the socket with (`wsTicket`). A
 * ticket is never the pass: it is 32 random bytes, held in memory alone, opens one socket once,
 * and lasts `TICKET_LIFETIME_MS` (or until its pass expires, if that comes first). So what a
 * socket's URL carries, which a browser's developer tools and a proxy's logs show, opens nothing
 * once it has been used or a moment has passed, and the pass travels only in a header.
 */
import { randomBytes } from 'node:crypto';

/** How long a ticket lasts: time enough for t3's client to open the socket it asked it for. */
export const TICKET_LIFETIME_MS = 30_000;

/**
 * The most tickets held at once. Past it the oldest is dropped, so a client holding a pass cannot
 * fill the host's memory by asking for tickets it never uses.
 */
export const MAX_TICKETS = 64;

/** A ticket as issued, and when it stops opening anything (epoch milliseconds). */
export type IssuedTicket = { readonly ticket: string; readonly expiresAtMs: number };

export type SocketTickets = {
  /** A new ticket for a pass that was just verified, which expires at `passExpiresAtSeconds`. */
  readonly issue: (passExpiresAtSeconds: number, nowMs: number) => IssuedTicket;
  /**
   * Takes a ticket: the expiry of the pass it was issued for, once, while the ticket lasts; null
   * for one never issued, used already, or expired. A ticket is gone once it is asked about.
   */
  readonly redeem: (
    ticket: string,
    nowMs: number,
  ) => { readonly passExpiresAtSeconds: number } | null;
};

type Held = { readonly expiresAtMs: number; readonly passExpiresAtSeconds: number };

export const makeSocketTickets = (): SocketTickets => {
  // A Map keeps the order tickets were issued in, so its first key is the oldest.
  const held = new Map<string, Held>();
  const dropExpired = (nowMs: number) => {
    for (const [ticket, entry] of held) if (entry.expiresAtMs <= nowMs) held.delete(ticket);
  };
  return {
    issue: (passExpiresAtSeconds, nowMs) => {
      dropExpired(nowMs);
      while (held.size >= MAX_TICKETS) {
        const oldest = held.keys().next();
        if (oldest.done === true) break;
        held.delete(oldest.value);
      }
      const ticket = randomBytes(32).toString('base64url');
      const expiresAtMs = Math.min(nowMs + TICKET_LIFETIME_MS, passExpiresAtSeconds * 1000);
      held.set(ticket, { expiresAtMs, passExpiresAtSeconds });
      return { ticket, expiresAtMs };
    },
    redeem: (ticket, nowMs) => {
      const entry = held.get(ticket);
      if (entry === undefined) return null;
      held.delete(ticket);
      return entry.expiresAtMs > nowMs
        ? { passExpiresAtSeconds: entry.passExpiresAtSeconds }
        : null;
    },
  };
};
