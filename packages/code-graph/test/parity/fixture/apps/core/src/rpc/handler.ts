import { db } from "drizzle-orm";
import { defineRpc, eager } from "./define-rpc";
export const createProject = defineRpc({
  parameters: {},
  execute: async (p: object) => {
    db.insert("projects");
    return p;
  },
});
export const methodShaped = defineRpc({
  parameters: {},
  async execute(p: object) { return p; },
});
export const setupOnly = eager({ setup() {}, execute() {} });
