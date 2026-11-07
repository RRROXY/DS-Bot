import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as nativeRetry from '@deepseek-ai/dsh-llm-retry'
import { install } from '../src/host/transient-retry.js'
import { output } from '../src/host/tools.js'

async function scenario(t, { failures, native = false, wait = async () => {} }) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  t.after(() => ctx.fiber.dispose())
  const requests = []
  let writes = 0
  class Adapter extends LlmAdapter {
    providerRetryPolicy() {
      return { mode: 'normal', maxRetries: 1, retryableCodes: ['SERVER'], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }
    }
    async *stream(options) {
      requests.push(options.messages)
      if (requests.length === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: 'write-once', name: 'write_receipt', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'write-once', name: 'write_receipt', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const failure = failures[requests.length - 2]
      if (failure) {
        // A failed stream can already contain a tool call. It must never execute
        // or enter the history reconstructed for the next attempt.
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: 'failed-draft', name: 'write_receipt', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'failed-draft', name: 'write_receipt', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Recovered after the saved receipt.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Recovered after the saved receipt.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new Adapter())
  if (native) await nativeRetry.apply(ctx)
  install({ ctx, config: {}, isBotSession: id => id === 'retry-bot', readOnly: () => undefined }, { wait })
  ctx.tools.register({ name: 'write_receipt', description: 'Record a side effect exactly once', parameters: { type: 'object', properties: {} }, output,
    execute: async () => { writes++; return 'receipt saved' } })
  await mountAgentLoopTestHarness(ctx)
  const agent = await ctx.agentLoop.create(SessionId('retry-bot'), { provider: 'mock', model: 'mock' })
  const idle = new Promise(resolve => {
    const off = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { off(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Save a receipt, then summarize it.' }], source: { kind: 'user' } }))
  return { ctx, agent, requests, idle, writes: () => writes }
}

const unavailable = { code: 'SERVER', status: 503, message: 'Upstream temporarily unavailable' }

test('real loop retries 503 and other in the same turn without executing the prior tool again', async t => {
  const s = await scenario(t, { failures: [unavailable, { code: 'PI_AI_ERROR', message: 'Provider finish_reason: other' }] })
  await s.idle
  assert.equal(s.writes(), 1)
  assert.equal(s.requests.length, 4)
  assert.deepEqual(s.requests[1], s.requests[2])
  assert.deepEqual(s.requests[2], s.requests[3])
  const events = s.agent.session.snapshotEvents()
  assert.equal(events.filter(event => event.type === 'turn/start').length, 1)
  assert.equal(events.filter(event => event.type === 'llm/retry').length, 2)
  assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
})

test('real native retries compose with a bounded supplement and then stop truthfully', async t => {
  const s = await scenario(t, { failures: Array(10).fill(unavailable), native: true })
  await s.idle
  assert.equal(s.writes(), 1)
  assert.equal(s.requests.length, 6) // tool request + failed request + 1 native + 3 Bot retries
  const events = s.agent.session.snapshotEvents()
  assert.equal(events.filter(event => event.type === 'llm/retry').length, 4)
  assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'error')
})

test('real loop cancellation during backoff launches no extra request', async t => {
  let ready
  const waiting = new Promise(resolve => { ready = resolve })
  const s = await scenario(t, { failures: [unavailable], wait: (_ms, _value, { signal }) => new Promise(resolve => {
    ready(); signal.addEventListener('abort', resolve, { once: true })
  }) })
  await waiting
  s.agent.cancel({ kind: 'user' })
  await s.idle
  assert.equal(s.writes(), 1)
  assert.equal(s.requests.length, 2)
  assert.equal(s.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'aborted')
})
