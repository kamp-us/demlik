import { run } from "@demlik/tea/promise";
import { profile } from "./profile-lookup";

/** Where names come from. Swap in your real client. */
export interface Directory {
  readonly nameOf: (id: string) => Promise<string | undefined>;
}

/** Boot the profile machine on the Promise engine. */
export function runProfile(directory: Directory) {
  return run(profile, {
    interpret: {
      fetch_user: async (cmd, { ok, err }) => {
        const name = await directory.nameOf(cmd.id);
        return name === undefined ? err({ _tag: "not_found" }) : ok({ name });
      },
    },
  });
}

/** Look one user up and read the state it settles in. */
export async function lookUp(directory: Directory, id: string) {
  const runtime = await runProfile(directory).ready;
  try {
    await runtime.dispatch({ type: "look_up", id });
    return runtime.getState();
  } finally {
    await runtime.stop();
  }
}
