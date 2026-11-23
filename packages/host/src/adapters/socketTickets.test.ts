import { describe, expect, it } from 'vite-plus/test';
import { MAX_TICKETS, makeSocketTickets, TICKET_LIFETIME_MS } from './socketTickets.ts';

const NOW_MS = 1_800_000_000_000;
/** A pass that expires in five minutes. */
const PASS_EXP = NOW_MS / 1000 + 300;

describe('makeSocketTickets', () => {
  it('issues a random ticket that opens one socket, once', () => {
    const tickets = makeSocketTickets();
    const issued = tickets.issue(PASS_EXP, NOW_MS);
    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tickets.issue(PASS_EXP, NOW_MS).ticket).not.toBe(issued.ticket);
    expect(tickets.redeem(issued.ticket, NOW_MS + 1)).toEqual({ passExpiresAtSeconds: PASS_EXP });
    expect(tickets.redeem(issued.ticket, NOW_MS + 2)).toBeNull();
  });

  it('lasts TICKET_LIFETIME_MS, or until its pass expires when that comes first', () => {
    const tickets = makeSocketTickets();
    const issued = tickets.issue(PASS_EXP, NOW_MS);
    expect(issued.expiresAtMs).toBe(NOW_MS + TICKET_LIFETIME_MS);
    expect(tickets.redeem(issued.ticket, NOW_MS + TICKET_LIFETIME_MS)).toBeNull();
    const late = tickets.issue(PASS_EXP, NOW_MS);
    expect(tickets.redeem(late.ticket, NOW_MS + TICKET_LIFETIME_MS - 1)).not.toBeNull();

    const shortPass = NOW_MS / 1000 + 5;
    const soon = tickets.issue(shortPass, NOW_MS);
    expect(soon.expiresAtMs).toBe(shortPass * 1000);
    expect(tickets.redeem(soon.ticket, shortPass * 1000)).toBeNull();
  });

  it('opens nothing for a ticket it never issued, or for the empty one', () => {
    const tickets = makeSocketTickets();
    tickets.issue(PASS_EXP, NOW_MS);
    expect(tickets.redeem('a-ticket-nobody-issued', NOW_MS)).toBeNull();
    expect(tickets.redeem('', NOW_MS)).toBeNull();
  });

  it(`holds at most ${MAX_TICKETS}, dropping the oldest first`, () => {
    const tickets = makeSocketTickets();
    const first = tickets.issue(PASS_EXP, NOW_MS);
    const rest = Array.from({ length: MAX_TICKETS }, () => tickets.issue(PASS_EXP, NOW_MS));
    expect(tickets.redeem(first.ticket, NOW_MS)).toBeNull();
    for (const issued of rest) expect(tickets.redeem(issued.ticket, NOW_MS)).not.toBeNull();
  });
});
