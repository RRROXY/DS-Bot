// A Bot's private chat dispatches work into independent root Sessions. These
// are visible, durable tasks, not DSH subagents or an alternate agent loop.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { snapshotOf } from './btw.js'
import { textOf } from './text.js'

const ACTIVE = new Set(['starting', 'running', 'waiting', 'uncertain'])
const CONTROL = new Set(['start_bot_task', 'update_bot_task', 'list_bot_tasks', 'stop_bot_task', 'ask_user', 'list_bots', 'create_bot', 'update_bot', 'create_group', 'update_group', 'message_bot', 'post_to_group', 'read_own_chat', 'read_group_chat'])
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
const required = description => ({ type: 'string', required: true, description })

export function install(rt) {
  const { ctx } = rt
  const enabled = rt.config.parallelTasks === true
  const operations = new Map()
  let disposed = false
  const tasks = botId => rt.botOf(botId)?.tasks ?? []
  const taskOf = id => {
    const botId = rt.taskOwners?.get(id)
    return botId === undefined ? undefined : tasks(botId).find(task => task.sessionId === id)
  }
  const controller = id => enabled && rt.chatOwners.has(id) && !rt.isLocalAgentSession?.(id)
  const view = task => ({ id: task.id, sessionId: task.sessionId, title: task.title, status: task.status, result: task.result, updatedAt: task.updatedAt })
  const visible = (botId, includeResults = false) => [...tasks(botId).filter(task => ACTIVE.has(task.status)), ...tasks(botId).filter(task => !task.archivedAt && !ACTIVE.has(task.status)).slice(-10)].map(task => {
    const { result, ...metadata } = view(task)
    return includeResults ? { ...metadata, result: result?.slice(-2000) } : metadata
  })
  const save = () => rt.save({ required: true })
  const guard = () => {
    if (disposed) throw new Error('Task dispatcher stopped.')
    const reason = rt.readOnly()
    if (reason !== undefined) throw new Error(reason)
  }
  // Serialize admissions and cancellation, never the execution of two tasks.
  const serial = (botId, fn) => {
    const previous = operations.get(botId) ?? Promise.resolve()
    const run = previous.then(() => { guard(); return fn() })
    const tail = run.catch(() => {})
    operations.set(botId, tail)
    void tail.then(() => { if (operations.get(botId) === tail) operations.delete(botId) })
    return run
  }
  const owned = (botId, taskId) => {
    const task = tasks(botId).find(entry => entry.id === taskId)
    if (!task) throw new Error('Unknown task for this Bot.')
    return task
  }
  const contentFrom = (agent, instruction) => {
    const snapshot = snapshotOf(agent.session, ctx.get?.('sessionProjections'))
    const recent = snapshot.messages.filter(message => message.role === 'assistant' || (message.role === 'user' && message.source?.kind === 'user')).slice(-6)
    const context = recent.map(message => `${message.role}: ${textOf(message.content)}`).join('\n\n').slice(-6000)
    const seen = new Set()
    const attachments = recent.filter(message => message.role === 'user').flatMap(message => message.content ?? [])
      .filter(block => (block.type === 'image' || block.type === 'file') && block.attachment !== undefined)
      .filter(block => {
        const key = block.attachment.attachmentId
        if (!key) return true
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    return [{ type: 'text', text: `Background context only; do not resume other tasks:\n${context}\n\nYour task (do only this work):\n${instruction}` }, ...attachments]
  }
  async function start(botId, { title, instruction, request_id }, parent) {
    return serial(botId, async () => {
      const bot = rt.botOf(botId)
      if (!bot || rt.selfOf(parent?.id) !== botId || !controller(parent?.id)) throw new Error('Start tasks from this Bot’s main chat.')
      if (![title, instruction, request_id].every(value => typeof value === 'string' && value.trim() !== '')) throw new Error('Task title, instruction and request_id are required.')
      if (title.length > 160 || request_id.length > 160 || instruction.length > 64000) throw new Error('Task request is too long.')
      const existing = tasks(botId).find(task => task.requestId === request_id)
      if (existing) {
        if (existing.instruction !== instruction || existing.title !== title) throw new Error('request_id already names a different task. Use update_bot_task for a correction.')
        return view(existing)
      }
      if (tasks(botId).filter(task => ACTIVE.has(task.status)).length >= 4) throw new Error('This Bot already has four active tasks. Finish or stop one before starting another.')
      const content = contentFrom(parent, instruction)
      const sessionId = await rt.createSession(`${bot.name} · ${title}`, { dir: rt.sessionFolder(parent.session) })
      const task = { id: randomUUID(), sessionId, title, instruction, requestId: request_id, status: 'starting', updatedAt: Date.now() }
      bot.tasks = [...tasks(botId), task]
      let admitted = false
      try {
        // Ownership and the receipt exist durably before any tools can run.
        await save()
        const agent = await rt.resolveAgent(sessionId)
        const ref = await rt.desiredModel(bot)
        if (!ref) throw new Error('Choose a model for this Bot first.')
        const slash = ref.indexOf('/')
        const effort = await rt.desiredEffort(bot, ref)
        await rt.selectSessionModel(sessionId, { provider: ref.slice(0, slash), model: ref.slice(slash + 1), ...(effort ? { reasoningEffort: effort } : {}) })
        await rt.applyPermission(bot, sessionId)
        await rt.ensureCapabilities(sessionId)
        guard()
        agent.followup(createUserMessage({ content, source: { kind: 'user', rpcId: task.id } }))
        admitted = true
        await ctx.sessions.flush(agent.session)
        return view(task)
      } catch (error) {
        task.status = admitted ? 'uncertain' : 'failed'
        task.result = 'Task admission failed. Inspect its conversation before retrying; it may have been accepted.'
        task.updatedAt = Date.now()
        await save().catch(() => {})
        throw error
      }
    })
  }
  async function update(botId, taskId, text, parent) {
    return serial(botId, async () => {
      const task = owned(botId, taskId)
      if (!ACTIVE.has(task.status) && tasks(botId).filter(entry => ACTIVE.has(entry.status)).length >= 4) throw new Error('This Bot already has four active tasks. Finish or stop one before continuing another.')
      if (typeof text !== 'string' || text.trim() === '' || text.length > 64000) throw new Error('Write a task update (up to 64000 characters).')
      const agent = await rt.resolveAgent(task.sessionId)
      await rt.ensureCapabilities(task.sessionId)
      guard()
      // A completed task may be explicitly continued; it keeps its own context.
      task.status = 'running'
      delete task.archivedAt
      delete rt.state.questions[task.sessionId]
      task.updatedAt = Date.now()
      delete task.result
      await save()
      const attachments = parent ? snapshotOf(parent.session, ctx.get?.('sessionProjections')).messages
        .filter(message => message.role === 'user' && message.source?.kind === 'user').at(-1)?.content?.filter(block => (block.type === 'image' || block.type === 'file') && block.attachment !== undefined) ?? [] : []
      agent.steer(createUserMessage({ content: [{ type: 'text', text }, ...attachments], source: { kind: 'user', rpcId: randomUUID() } }))
      await ctx.sessions.flush(agent.session)
      return view(task)
    })
  }
  async function stop(botId, taskId) {
    return serial(botId, async () => {
      const selected = taskId === 'all' ? tasks(botId) : [owned(botId, taskId)]
      for (const task of selected) {
        if (!ACTIVE.has(task.status)) continue
        const agent = await rt.resolveAgent(task.sessionId)
        agent.inbox?.clear()
        agent.cancel({ kind: 'user' })
        task.status = 'stopped'
        task.updatedAt = Date.now()
        await ctx.sessions.flush(agent.session)
      }
      await save()
      return selected.map(view)
    })
  }
  async function archive(botId, taskId, restore = false) {
    return serial(botId, async () => {
      if (!rt.botOf(botId)) throw new Error('Unknown Bot.')
      const selected = taskId === 'all' ? tasks(botId).filter(task => !ACTIVE.has(task.status) && !task.archivedAt) : [owned(botId, taskId)]
      if (selected.some(task => ACTIVE.has(task.status))) throw new Error('Stop the task before removing it.')
      const previous = selected.map(task => task.archivedAt)
      for (const task of selected) {
        if (restore) delete task.archivedAt
        else task.archivedAt = Date.now()
      }
      try { await save() }
      catch (error) {
        selected.forEach((task, index) => { if (previous[index] === undefined) delete task.archivedAt; else task.archivedAt = previous[index] })
        throw error
      }
      return selected.map(view)
    })
  }
  if (enabled) {
    for (const [name, description, parameters, run] of [
      ['start_bot_task', 'Start independent work as this same Bot in a visible task conversation. Returns immediately; never wait for it. Reuse request_id only for an identical retry. Put corrections in update_bot_task.', { title: required('Short task name'), instruction: required('Complete task, constraints and relevant file paths'), request_id: required('Stable unique name for this request') }, (botId, args, exec) => start(botId, args, exec.agent)],
      ['update_bot_task', 'Send a supplement or correction to an existing task at its next step. Does not cancel or duplicate the task.', { task_id: required('Task id from list_bot_tasks'), text: required('Exact supplement or correction') }, (botId, args, exec) => update(botId, args.task_id, args.text, exec.agent)],
      ['list_bot_tasks', 'Read recent task results when needed. Current task ids, titles and statuses are already in your system context; do not query again just to route a message.', {}, async botId => visible(botId, true)],
      ['stop_bot_task', 'Stop one task, or all this Bot’s tasks when the user says stop without a narrower target.', { task_id: required('Task id, or all') }, (botId, args) => stop(botId, args.task_id)],
    ]) rt.teamTools.push(defineTool({ name, description, parameters, output, async execute(args, exec) {
      await rt.load()
      if (!controller(exec.agent?.id)) throw new Error('Task routing tools are only available in this Bot’s main chat.')
      return JSON.stringify(await run(rt.selfOf(exec.agent.id), args, exec))
    } }))
    ctx.tools.guard(exec => controller(exec.agent?.id) && !CONTROL.has(exec.name)
      ? 'Keep the main chat available: use start_bot_task for work, update_bot_task for corrections, and stop_bot_task to stop. Do not execute work in the dispatcher.' : undefined)
  }
  // The store calls this after loading the ledger and before resolving workers.
  const interruptSavedTasks = () => {
    let changed = false
    for (const bot of Object.values(rt.state.bots)) for (const task of bot.tasks ?? []) {
      if (ACTIVE.has(task.status)) {
        task.status = 'interrupted'
        task.result = 'Host restarted. Inspect the task before continuing.'
        task.updatedAt = Date.now()
        changed = true
      }
    }
    return changed
  }
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const task = taskOf(agent?.id)
    if (task && ['interrupted', 'stopped'].includes(task.status)) return { kind: 'reject' }
    return next()
  })
  const texts = new Map()
  ctx.on('session/event', (session, event) => {
    const task = taskOf(session?.id)
    if (!task || disposed) return
    if (event.type === 'turn/start') {
      if (!['interrupted', 'stopped'].includes(task.status)) task.status = 'running'
      texts.set(session.id, [])
    }
    else if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text) texts.set(session.id, [text.slice(-12000)])
      return
    } else if (event.type === 'turn/end') {
      const reason = event.data?.reason?.kind
      task.status = task.status === 'interrupted' || reason === 'interrupted' || event.data?.reason?.reason?.kind === 'disposed' ? 'interrupted'
        : task.status === 'stopped' || reason === 'aborted' ? 'stopped'
          : reason !== 'completed' ? 'failed' : rt.state.questions[session.id] ? 'waiting' : 'finished'
      task.result = (texts.get(session.id) ?? []).join('\n\n').slice(-12000)
      texts.delete(session.id)
    } else return
    task.updatedAt = Date.now()
    const ended = { ...task }
    void save().then(async () => {
      if (event.type !== 'turn/end' || disposed || ['stopped', 'interrupted'].includes(ended.status)) return
      const botId = rt.taskOwners.get(session.id)
      if (!botId) return
      // Results wake the dispatcher to summarize; a task result cannot create a
      // task unless the dispatcher finds a fresh, explicit user request for it.
      const parent = await rt.resolveAgent(rt.chatOf(botId))
      parent.followup(createUserMessage({ content: [{ type: 'text', text: `${ended.title}: ${ended.status}\n\n${ended.result || 'No final text. Open the task to inspect its state.'}\n\n[Task update: ${ended.id}] Give the user the actual result or deliverable concisely. For waiting, ask the necessary question; for failure, say what remains incomplete. Do not narrate internal steps, task ids or routing. This is a result, not a request to start or repeat work.` }], source: { kind: 'bot-task', form: 'notice', summary: `${ended.title}: ${ended.status}`.slice(0, 120), taskId: ended.id } }))
      await ctx.sessions.flush(parent.session)
    }).catch(error => rt.warn('ds-bot: task status save failed: %s', error?.message))
  })
  ctx.effect(() => () => { disposed = true }, 'ds-bot: task dispatcher')
  Object.assign(rt, {
    taskOf, interruptSavedTasks, taskSessionsOf: botId => tasks(botId).map(task => task.sessionId),
    parallelTasksEnabled: enabled, isTaskController: controller, startBotTask: start, updateBotTask: update, stopBotTask: stop, archiveBotTask: archive,
    taskPrompt(id) {
      const task = taskOf(id)
      if (task) return `\n## Independent task\nYou are working only on task "${task.title}" (${task.id}) for this Bot. Complete its work using your tools. The user wants results, not a work diary: do not narrate steps or send routine progress updates. Your final answer should give the deliverable, its location and only material limitations. Ask only when user input is necessary. Other tasks run separately. Do not resume unrelated work from background context. Do not create nested tasks. Your final answer and questions are reported to the main chat. Shared files and browser state are not isolated: do not overwrite another task's changes; use distinct output files and report conflicts. Never claim success without verification.`
      if (!enabled && rt.chatOwners.has(id) && rt.config.directSteering === true) return '\n## Direct conversation\nWork directly in this chat using your tools. Independent Bot tasks are disabled; earlier messages about a task dispatcher no longer apply. Do not create or automatically resume separate task conversations. New user messages during work are supplements or corrections to the current request unless the user clearly changes the goal. Apply them at your next step, preserve the original objective and do not repeat completed actions. Give results and necessary questions, without routine progress narration. Ask for credentials only through request_secret here; never ask the user to paste a secret into chat or save it to a file as a workaround.'
      if (!controller(id)) return ''
      return '\n## Responsive task dispatcher\nKeep this main chat available for new messages. Do not do tool-based work here. Route messages using Current tasks below. Call list_bot_tasks only when the user needs a previous result; do not query it routinely or on result notifications. Combine consecutive related messages into the same request. Send supplements, corrections, or answers to the matching existing task with update_bot_task; include every relevant detail. Start each independent new task with start_bot_task and return at most one brief acknowledgement immediately, without tool names, internal task ids or a plan. The user wants results, not progress narration. Do not wait or poll for completion. Simple conversational answers need no task. If the target is ambiguous, ask one concise clarifying question before routing. Never infer a new task from a task result. When the user says stop, call stop_bot_task (all unless they named a task). Carry file paths and constraints into the task instruction. Parallel tasks share files and browsers: serialize work on the same mutable resource by waiting to start dependent work until its predecessor finishes. Task status and results will arrive here; report failures and interruptions as such.\nCurrent tasks: ' + JSON.stringify(visible(rt.selfOf(id)))
    },
  })
}
