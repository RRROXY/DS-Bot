import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/tasks.js'
import { fakeContext } from './fake-ctx.js'

function setup({ tasks = [], enabled = true } = {}) {
  const ctx = fakeContext()
  const bot = { id: 'chief', name: 'Chief', tasks, model: 'mock/test', permission: 'read-only' }
  const made = []
  const agents = new Map()
  const parent = { id: 'chief', session: {
    id: 'chief', seq: 1, inheritedEventCount: 0, requestHeader: () => ({}), toolHistory: () => [], snapshotEvents: () => [],
    deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Write a report' }, { type: 'file', attachment: { attachmentId: 'file1', name: 'brief.txt', bytes: 3 } }] }],
  }, followup: message => made.push(['notice', message]) }
  agents.set('chief', parent)
  ctx.sessions = { flush: async () => {} }
  const rt = {
    ctx, config: { parallelTasks: enabled }, state: { bots: { chief: bot }, questions: {} }, teamTools: [],
    chatOwners: new Map([['chief', 'chief']]), taskOwners: new Map(),
    botOf: id => id === 'chief' ? bot : undefined,
    selfOf: id => id === 'chief' ? 'chief' : rt.taskOwners.get(id), chatOf: id => id,
    load: async () => {}, readOnly: () => undefined, warn: () => {},
    save: async () => { for (const task of bot.tasks) rt.taskOwners.set(task.sessionId, 'chief') },
    sessionFolder: () => '/test/work',
    createSession: async (_title, options) => {
      const id = `task-${agents.size}`
      agents.set(id, { id, session: { id }, inbox: { clear: () => made.push(['clear', id]) },
        followup: message => made.push(['start', id, message]), steer: message => made.push(['steer', id, message]), cancel: cause => made.push(['cancel', id, cause]) })
      made.push(['create', id, options]); return id
    },
    resolveAgent: async id => agents.get(id), desiredModel: async () => 'mock/test', desiredEffort: async () => 'high',
    selectSessionModel: async (id, route) => made.push(['model', id, route]),
    applyPermission: async (b, id) => made.push(['permission', id, b.permission]), ensureCapabilities: async id => made.push(['capabilities', id]),
  }
  install(rt)
  rt.interruptSavedTasks()
  const start = (request_id = 'report', more = {}) => rt.startBotTask('chief', { title: request_id, instruction: `Do ${request_id}`, request_id, ...more }, parent)
  const event = async (id, type, data = {}) => {
    for (const fn of ctx.listeners.get('session/event') ?? []) fn({ id }, { type, data })
    await new Promise(resolve => setImmediate(resolve))
  }
  return { rt, bot, parent, made, ctx, start, event }
}

test('same Bot starts independent Sessions, inheriting folder, route, permissions and attachments', async () => {
  const s = setup(); const [a, b] = await Promise.all([s.start('report'), s.start('spreadsheet')])
  assert.notEqual(a.sessionId, b.sessionId)
  assert.equal(s.made.filter(row => row[0] === 'start').length, 2)
  assert.equal(s.rt.selfOf(a.sessionId), 'chief')
  assert.deepEqual(s.made.find(row => row[0] === 'create')[2], { dir: '/test/work' })
  assert.deepEqual(s.made.find(row => row[0] === 'model')[2], { provider: 'mock', model: 'test', reasoningEffort: 'high' })
  assert.equal(s.made.find(row => row[0] === 'permission')[2], 'read-only')
  assert.equal(s.made.find(row => row[0] === 'start')[2].content[1].attachment.attachmentId, 'file1')
})

test('a supplement steers only the selected task and creates no new task', async () => {
  const s = setup(); const a = await s.start('a'); const b = await s.start('b')
  await s.rt.updateBotTask('chief', a.id, 'Change the title')
  assert.equal(s.bot.tasks.length, 2)
  assert.equal(s.made.find(row => row[0] === 'steer')[1], a.sessionId)
  assert.equal(s.made.some(row => row[0] === 'steer' && row[1] === b.sessionId), false)
})

test('duplicate simultaneous admissions start once; changed payload under the same id is refused', async () => {
  const s = setup(); const [a, b] = await Promise.all([s.start(), s.start()])
  assert.equal(a.id, b.id); assert.equal(s.made.filter(row => row[0] === 'start').length, 1)
  await assert.rejects(s.start('report', { instruction: 'Different work' }), /already names/)
})

test('stop one leaves the other running; stop all clears and cancels the rest', async () => {
  const s = setup(); const a = await s.start('a'); const b = await s.start('b')
  await s.rt.stopBotTask('chief', a.id)
  assert.equal(s.bot.tasks[0].status, 'stopped'); assert.equal(s.bot.tasks[1].status, 'starting')
  await s.rt.stopBotTask('chief', 'all')
  assert.deepEqual(s.made.filter(row => row[0] === 'cancel').map(row => row[1]), [a.sessionId, b.sessionId])
  assert.equal(s.made.filter(row => row[0] === 'clear').length, 2)
})

test('completion, failure and max-tokens have distinct truthful statuses', async () => {
  for (const [reason, status] of [['completed', 'finished'], ['error', 'failed'], ['max-tokens', 'failed']]) {
    const s = setup(); const a = await s.start()
    await s.event(a.sessionId, 'turn/start')
    await s.event(a.sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: 'Result' }] } })
    await s.event(a.sessionId, 'turn/end', { reason: { kind: reason } })
    assert.equal(s.bot.tasks[0].status, status)
    assert.equal(s.bot.tasks[0].result, 'Result')
    assert.equal(s.made.find(row => row[0] === 'notice')[1].source.kind, 'bot-task')
    assert.match(s.made.find(row => row[0] === 'notice')[1].content[0].text, new RegExp(status))
  }
})

test('interrupted work is blocked until explicit continuation', async () => {
  const s = setup(); const a = await s.start(); s.bot.tasks[0].status = 'interrupted'
  const hook = s.ctx.listeners.get('agent/pre-step')[0]
  assert.deepEqual(await hook({ agent: { id: a.sessionId } }, () => assert.fail()), { kind: 'reject' })
  await s.rt.updateBotTask('chief', a.id, 'Continue after inspecting outputs')
  assert.equal(await hook({ agent: { id: a.sessionId } }, () => 'enter'), 'enter')
  assert.equal(setup({ tasks: [{ id: 'x', sessionId: 'x', status: 'running' }] }).bot.tasks[0].status, 'interrupted')
})

test('ownership and recursion guards; main chat cannot run work tools', async () => {
  const s = setup(); const a = await s.start()
  await assert.rejects(s.rt.updateBotTask('someone-else', a.id, 'change'), /Unknown task/)
  await assert.rejects(s.rt.startBotTask('chief', { title: 'nested', instruction: 'nested', request_id: 'nested' }, { id: a.sessionId }), /main chat/)
  assert.match(s.ctx.guards[0]({ agent: { id: 'chief' }, name: 'bash' }), /Keep the main chat/)
  assert.equal(s.ctx.guards[0]({ agent: { id: a.sessionId }, name: 'bash' }), undefined)
  assert.equal(s.ctx.guards[0]({ agent: { id: 'chief' }, name: 'start_bot_task' }), undefined)
})

test('failed durable admission never starts a worker', async () => {
  const s = setup(); s.rt.save = async () => { throw new Error('disk full') }
  await assert.rejects(s.start(), /disk full/)
  assert.equal(s.made.some(row => row[0] === 'start'), false)
  assert.equal(s.bot.tasks[0].status, 'failed')
})

test('four-task limit and disabled mode', async () => {
  const s = setup()
  for (let i = 0; i < 4; i++) await s.start(String(i))
  await assert.rejects(s.start('fifth'), /four active tasks/)
  assert.equal(setup({ enabled: false }).rt.isTaskController('chief'), false)
})

test('accepted work with a failed flush stays stoppable and counts towards capacity', async () => {
  const s = setup(); s.ctx.sessions.flush = async () => { throw new Error('flush failed') }
  await assert.rejects(s.start(), /flush failed/)
  assert.equal(s.bot.tasks[0].status, 'uncertain')
  s.ctx.sessions.flush = async () => {}
  await s.rt.stopBotTask('chief', 'all')
  assert.equal(s.bot.tasks[0].status, 'stopped')
})


test('background context excludes injected instructions and keeps real user attachments', async () => {
  const s = setup()
  const original = s.parent.session.deriveMessages()
  s.parent.session.deriveMessages = () => [...original, { role: 'user', source: { kind: 'workspace-context' }, content: [{ type: 'text', text: 'INJECTED-CONTEXT' }] }]
  const a = await s.start()
  assert.doesNotMatch(s.made.find(row => row[0] === 'start')[2].content[0].text, /INJECTED-CONTEXT/)
  await s.rt.updateBotTask('chief', a.id, 'Use the attached brief', s.parent)
  assert.equal(s.made.find(row => row[0] === 'steer')[2].content[1].attachment.attachmentId, 'file1')
})
