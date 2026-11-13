import type { Ticketing, TicketingDriven } from "../ports";

export function createTicketing(driven: TicketingDriven): Ticketing {
  return { ...driven } as unknown as Ticketing;
}
