// Real DSH + scripted model integration; use only a fresh .dsh-test-* bench.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const [name, port] = process.argv.slice(2)
if (!/^[a-z0-9-]+$/.test(name ?? '') || !/^\d+$/.test(port ?? '')) throw new Error('usage: parallel-smoke.mjs <bench-name> <port>')
const home = resolve(import.meta.dirname, '../..', `.dsh-test-${name}`)
const base = `http://127.0.0.1:${port}`
const url = readFileSync(`${home}/web.log`, 'utf8').match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
if (!url) throw new Error('Isolated bench has not started')
const login = await fetch(url, { redirect: 'manual' })
const cookie = login.headers.getSetCookie().map(entry => entry.split(';')[0]).join('; ')
async function api(endpoint, payload = {}) {
  const response = await fetch(`${base}/api/bot`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }) })
  const result = await response.json()
  if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message}`)
  return result.value
}
const state = () => api('state')
const savedTasks = botId => JSON.parse(readFileSync(`${home}/bot/state.json`, 'utf8')).bots[botId].tasks
const wait = async (label, check) => {
  const end = Date.now() + 90000
  while (Date.now() < end) {
    const value = await state()
    if (check(value)) { console.log(`ok ${label}`); return value }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timeout: ${label}`)
}
const first = await state()
assert.equal(first.parallelTasks, true)
const bot = first.bots.find(bot => bot.id === first.mainBotId)
const model = first.models.find(model => model.ref.startsWith('deepseek-official/'))
assert.ok(model)
await api('update-bot', { id: bot.id, model: model.ref, permission: 'workspace-write' })
await wait('dispatcher ready', s => !s.bots[0].waiting && !s.work.turns[bot.id])
await api('send', { sessionId: bot.id, text: '并行测试：A' })
await wait('A starts a real tool', s => s.bots[0].tasks?.some(task => task.title === '任务 A' && task.status === 'running'))
await api('send', { sessionId: bot.id, text: '并行测试：B' })
const parallel = await wait('two tasks execute at the same time', s => s.bots[0].tasks?.filter(task => task.status === 'running').length === 2)
const [a, b] = ['任务 A', '任务 B'].map(title => parallel.bots[0].tasks.find(task => task.title === title))
assert.notEqual(a.sessionId, b.sessionId)
await api('send', { sessionId: bot.id, text: '并行测试：补充 A' })
const corrected = await wait('A receives its correction without creating a third task', () => savedTasks(bot.id).find(task => task.id === a.id)?.result?.includes('parallel-correction-A accepted'))
assert.equal(corrected.bots[0].tasks.length, 2)
assert.equal(Boolean(savedTasks(bot.id).find(task => task.id === b.id).result?.includes('parallel-correction-A')), false)
assert.ok(corrected.bots[0].tasks.every(task => task.result === undefined && task.instruction === undefined))
await wait('both tasks finish', s => s.bots[0].tasks?.every(task => task.status === 'finished'))
// Repeat the same dispatch request: no duplicate task or repeated tool work.
await api('send', { sessionId: bot.id, text: '并行测试：A' })
await wait('retry settles', s => !s.work.turns[bot.id])
assert.equal((await state()).bots[0].tasks.length, 2)
// Resume both tasks with another long tool call, then cancel one and all.
for (const task of [a, b]) await api('task-update', { botId: bot.id, taskId: task.id, text: `Your task (do only this work):\nparallel-fixture-${task.id === a.id ? 'A' : 'B'}` })
await wait('both resumed tasks run', s => s.bots[0].tasks?.filter(task => task.status === 'running').length === 2)
await api('task-stop', { botId: bot.id, taskId: a.id })
const stopped = await state()
assert.equal(stopped.bots[0].tasks.find(task => task.id === a.id).status, 'stopped')
assert.equal(stopped.bots[0].tasks.find(task => task.id === b.id).status, 'running')
await api('task-stop', { botId: bot.id, taskId: 'all' })
await wait('all tasks stop', s => s.bots[0].tasks?.every(task => task.status === 'stopped'))
console.log('PASS parallel task integration')
