export type ForClosingTickets = (id: string) => Promise<void>;
export type ForNotifying = (id: string) => Promise<void>;
export type ForKeeping = (id: string) => Promise<void>;

type TicketIntents = { open(id: string): Promise<void> };
export type Ticketing = TicketIntents & { close: ForClosingTickets };
export interface TicketingDriven {
  notify: ForNotifying;
}
export interface TicketingDriven {
  keep: ForKeeping;
}
