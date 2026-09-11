export async function yieldToUi(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  signal?.throwIfAborted();
}
