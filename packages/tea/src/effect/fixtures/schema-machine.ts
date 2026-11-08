import { Schema } from "effect";
import { Cmd, Machine } from "../index";

export const Ticket = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
});
export const DeskModel = Schema.Struct({
  tickets: Schema.Array(Ticket),
  selected: Schema.NullOr(Schema.String),
  log: Schema.Array(Schema.String),
});
export const DeskMsg = Schema.Union([
  Schema.Struct({ type: Schema.Literal("UserRequestedTickets") }),
  Schema.Struct({
    type: Schema.Literal("UserSelectedTicket"),
    id: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("UserRequestedClose"),
    id: Schema.String,
  }),
]);

export const loadTickets = Cmd.make("LoadTickets", {
  input: Schema.Struct({}),
  ok: Schema.Array(Ticket),
  err: ["offline"],
});
export const readTicket = Cmd.make("ReadTicket", {
  input: Schema.Struct({ id: Schema.String }),
  ok: Ticket,
  err: ["unknown"],
});
export const closeTicket = Cmd.make("CloseTicket", {
  input: Schema.Struct({ id: Schema.String }),
  ok: Schema.Struct({ id: Schema.String }),
  err: ["locked"],
});

export const desk = Machine.make({
  model: DeskModel,
  msg: DeskMsg,
  cmds: [loadTickets, readTicket, closeTicket],
  init: (loaded) => [loaded ?? { tickets: [], selected: null, log: [] }, []],
  update: {
    UserRequestedTickets: (state) => [state, [loadTickets({})]],
    UserSelectedTicket: (state, msg) => [
      { ...state, selected: msg.id },
      [readTicket({ id: msg.id })],
    ],
    UserRequestedClose: (state, msg) => [state, [closeTicket({ id: msg.id })]],
    LoadTickets_ok: (state, msg) => [
      {
        ...state,
        tickets: msg.value,
        log: [...state.log, `loaded ${msg.value.length}`],
      },
      [],
    ],
    LoadTickets_err: (state, msg) => [
      { ...state, log: [...state.log, `load: ${msg.error._tag}`] },
      [],
    ],
    ReadTicket_ok: (state, msg) => [
      {
        ...state,
        selected: msg.value.id,
        log: [...state.log, `read ${msg.cmd.id}: ${msg.value.title}`],
      },
      [],
    ],
    ReadTicket_err: (state, msg) => [
      {
        ...state,
        selected: null,
        log: [...state.log, `read ${msg.cmd.id}: ${msg.error._tag}`],
      },
      [],
    ],
    CloseTicket_ok: (state, msg) => [
      {
        ...state,
        tickets: state.tickets.filter((ticket) => ticket.id !== msg.value.id),
        selected: state.selected === msg.value.id ? null : state.selected,
        log: [...state.log, `closed ${msg.cmd.id}`],
      },
      [],
    ],
    CloseTicket_err: (state, msg) => [
      {
        ...state,
        log: [...state.log, `close ${msg.cmd.id}: ${msg.error._tag}`],
      },
      [],
    ],
  },
});
