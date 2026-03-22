const sharedBuildLabel = "shared-smoke";

export function buildMessage(name: string): string {
  return `${name}:${sharedBuildLabel}`;
}
