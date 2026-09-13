import { expect, test } from 'bun:test';
import { runChatFallback } from '../src/core/ai/chat-fallback.ts';
import { invokeAI, withAIInvocationGuard } from '../src/core/ai/invocation-guard.ts';

for (const wrapped of [false, true]) {
  test(`chat fallback preserves an invocation refusal (wrapped=${wrapped})`, async () => {
    const refusal = new Error('permission denied');
    const attempts: string[] = [];
    await expect(withAIInvocationGuard(async () => { throw refusal; }, () =>
      runChatFallback({ model: 'test:first' }, 'test:first', ['test:second'], async opts => {
        attempts.push(opts.model);
        try {
          return await invokeAI({ operation: 'test', model: opts.model, kind: 'chat' },
            async () => 'must not execute', () => null);
        } catch (error) {
          if (wrapped) throw new Error('transport error', { cause: error });
          throw error;
        }
      }),
    )).rejects.toThrow(wrapped ? 'transport error' : 'permission denied');
    expect(attempts).toEqual(['test:first']);
  });
}

test('chat fallback still recovers an ordinary provider failure', async () => {
  const attempts: string[] = [];
  const result = await runChatFallback({ model: 'test:first' }, 'test:first', ['test:second'], async opts => {
    attempts.push(opts.model);
    if (opts.model === 'test:first') throw new Error('provider unavailable');
    return 'recovered';
  });
  expect(result).toBe('recovered');
  expect(attempts).toEqual(['test:first', 'test:second']);
});
