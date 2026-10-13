import { Cmd } from "@demlik/tea/effect";
import { Schema } from "effect";

/** `fetchUser` again, with its schemas written in Effect Schema. */
export const fetchUser = Cmd.define("fetch_user", {
  input: Schema.Struct({ id: Schema.String }),
  ok: Schema.Struct({ name: Schema.String }),
  err: ["not_found"],
});
