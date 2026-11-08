import { Schema } from "effect";
import { Machine } from "../index";

export const CounterModel = Schema.Struct({ count: Schema.Number });
export const CounterMsg = Schema.Struct({
  type: Schema.Literal("UserIncremented"),
  amount: Schema.Number,
});
export const counter = Machine.make({
  model: CounterModel,
  msg: CounterMsg,
  cmds: [],
  init: (loaded) => [loaded ?? { count: 0 }, []],
  update: {
    UserIncremented: (state, msg) => [{ count: state.count + msg.amount }, []],
  },
});

export const PreferencesModel = Schema.Struct({
  selected: Schema.NullOr(Schema.String),
});
export const PreferencesMsg = Schema.Struct({
  type: Schema.Literal("UserSelectedTheme"),
  theme: Schema.String,
});
export const preferences = Machine.make({
  model: PreferencesModel,
  msg: PreferencesMsg,
  cmds: [],
  init: (loaded) => [loaded ?? { selected: null }, []],
  update: {
    UserSelectedTheme: (_state, msg) => [{ selected: msg.theme }, []],
  },
});

export const NotebookModel = Schema.Struct({
  notes: Schema.Array(Schema.String),
});
export const NotebookMsg = Schema.Struct({
  type: Schema.Literal("UserAddedNote"),
  text: Schema.String,
});
export const notebook = Machine.make({
  model: NotebookModel,
  msg: NotebookMsg,
  cmds: [],
  init: (loaded) => [loaded ?? { notes: [] }, []],
  update: {
    UserAddedNote: (state, msg) => [{ notes: [...state.notes, msg.text] }, []],
  },
});
