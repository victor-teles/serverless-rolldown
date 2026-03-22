import { buildMessage } from "./shared";

export async function handler() {
  return buildMessage("goodbye");
}
