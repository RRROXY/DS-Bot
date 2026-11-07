import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, RETRY_DELAYS, transientFailure } from '../src/host/transient-retry.js'
import { fakeContext } from './fake-ctx.js'

function setup({ wait, config = {} } = {}) {
  const ctx = fakeContext()
  const events = []
  const waits = []
  let flushed = 0
  ctx.sessions = { flush: async () => { flushed++ } }
  const rt = { ctx, config, isBotSession: id => id === 'bot', readOnly: () => undefined }
  install(rt, { wait: wait ?? (async ms => { waits.push(ms); assert.ok(flushed > 0) }) })
  const controller = new AbortController()
  const agent = { id: 'bot', session: { snapshotEvents: () => events, append: (type, data) => events.push({ type, data }) } }
  const payload = { agent, turn: 1, step: 2, provider: 'test', failure: { code: 'SERVER', status: 503, message: 'unavailable' }, signal: controller.signal }
  const listener = ctx.listeners.get('agent/request-error')[0]
  return { ctx, rt, events, waits, payload, controller, run: (more = {}, next = async () => undefined) => listener({ ...payload, ...more }, next) }
}

test('temporary failures qualify; auth, quota, bad requests and other unknown errors do not', () => {
  for (const failure of [{ code: 'SERVER', status: 503 }, { code: 'TIMEOUT' }, { code: 'TRANSPORT' }, { code: 'RATE_LIMIT' },
    { code: 'PI_AI_ERROR', message: 'Provider finish_reason: other' }, { code: 'overloaded_error' },
    { code: 'UNKNOWN', message: 'Command Code: Upstream model provider is temporarily unavailable. Please try again in a moment.' }]) assert.equal(transientFailure(failure), true)
  for (const failure of [{ code: 'AUTH', status: 503 }, { code: 'INVALID_CREDENTIAL', status: 503 }, { code: 'QUOTA_EXCEEDED' }, { code: 'INVALID_REQUEST' }, { code: 'SERVER', status: 403 },
    { code: 'CONTEXT_WINDOW_EXCEEDED' }, { code: 'ABORTED' }, { code: 'PI_AI_ERROR', message: 'Provider finish_reason: content_filter' },
    { code: 'PI_AI_ERROR', message: 'arbitrary failure' }]) assert.equal(transientFailure(failure), false)
})

test('native recovery wins, then exactly three durable supplemental retries in the same step', async () => {
  const s = setup()
  assert.deepEqual(await s.run({}, async () => ({ kind: 'retry' })), { kind: 'retry' })
  assert.equal(s.events.length, 0)
  for (let i = 0; i < 3; i++) assert.deepEqual(await s.run(), { kind: 'retry' })
  assert.equal(await s.run(), undefined)
  assert.deepEqual(s.waits, RETRY_DELAYS)
  assert.deepEqual(s.events.map(event => event.type), Array.from({ length: 3 }, () => ['llm/retry', 'llm/retry-started']).flat())
  assert.equal(new Set(s.events.map(event => event.data.retryId)).size, 1)
  assert.ok(s.events.every(event => event.data.turn === 1 && event.data.step === 2))
  assert.deepEqual(await s.run({ step: 3 }), { kind: 'retry' })
})

test('reload uses durable allowance; unrelated sessions and disabled/read-only mode are left alone', async () => {
  const s = setup()
  for (let i = 0; i < 3; i++) await s.run()
  const reloaded = setup()
  assert.equal(await reloaded.run({ agent: s.payload.agent }), undefined)
  assert.equal(await s.run({ agent: { id: 'ordinary' } }), undefined)
  assert.equal(await setup({ config: { transientRetry: false } }).run(), undefined)
  const locked = setup(); locked.rt.readOnly = () => 'locked'
  assert.equal(await locked.run(), undefined)
})

test('user stop aborts backoff without starting another request', async () => {
  let scheduled
  const ready = new Promise(resolve => { scheduled = resolve })
  const s = setup({ wait: (_ms, _value, { signal }) => new Promise(resolve => {
    scheduled(); signal.addEventListener('abort', resolve, { once: true })
  }) })
  const recovery = s.run()
  await ready
  s.controller.abort()
  assert.equal(await recovery, undefined)
  assert.deepEqual(s.events.map(event => event.type), ['llm/retry'])
})

test('plugin disposal cancels backoff and captured listeners fail closed', async () => {
  let scheduled
  const ready = new Promise(resolve => { scheduled = resolve })
  const s = setup({ wait: (_ms, _value, { signal }) => new Promise(resolve => {
    scheduled(); signal.addEventListener('abort', resolve, { once: true })
  }) })
  const recovery = s.run()
  await ready
  await s.ctx.dispose()
  assert.equal(await recovery, undefined)
  assert.equal(await s.run({}, async () => assert.fail('disposed recovery delegated')), undefined)
  assert.equal(s.events.length, 1)
})

test('honors bounded Retry-After and does not retry earlier than a longer provider delay', async () => {
  const s = setup()
  assert.deepEqual(await s.run({ failure: { code: 'SERVER', providerRetryAfterMs: 45000 } }), { kind: 'retry' })
  assert.equal(s.waits[0], 45000)
  assert.equal(await s.run({ failure: { code: 'SERVER', providerRetryAfterMs: 120000 } }), undefined)
})

test('failed receipt flush and aborted delegation cannot launch another attempt', async () => {
  const s = setup(); s.ctx.sessions.flush = async () => { throw new Error('disk full') }
  await assert.rejects(s.run(), /disk full/)
  assert.equal(s.waits.length, 0)
  const cancelled = setup()
  assert.equal(await cancelled.run({}, async () => { cancelled.controller.abort() }), undefined)
  assert.equal(cancelled.events.length, 0)
})
