let invocationCount = 0;

export function buildMessage(name: string): string {
	invocationCount += 1;
	return `${name}:${invocationCount}`;
}
