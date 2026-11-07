import { createElement as h, useState } from 'react'
import { t, hostText } from './i18n.js'

const running = status => ['starting', 'running', 'waiting', 'uncertain'].includes(status)
const labels = { uncertain: 'Unknown', starting: 'Starting', running: 'Running', waiting: 'Waiting for you', finished: 'Finished', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' }

export function TaskDock({ sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const bot = roster.byId[sessionId]
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  if (!bot || !(bot.tasks?.length > 0)) return null
  const all = bot.tasks
  const recent = [...all.filter(task => running(task.status)), ...all.filter(task => !running(task.status)).slice(-5)]
  const stop = async (taskId) => {
    setPending(true)
    setError('')
    try { await actions.stopTask(bot.id, taskId) } catch (failure) { setError(hostText(failure.message)) }
    finally { setPending(false) }
  }
  return h('section', { className: 'bt-task-dock', 'aria-label': t('Bot tasks') },
    h('div', { className: 'bt-task-head' },
      h('strong', null, t('Bot tasks')),
      bot.taskId ? h('button', { className: 'bt-soft bt-soft-sm', onClick: () => actions.openSession(bot.id) }, t('Back to main chat')) : null,
      all.some(task => running(task.status)) ? h('button', { className: 'bt-soft bt-soft-sm', disabled: pending, onClick: () => { void stop('all') } }, t('Stop all tasks')) : null),
    h('div', { className: 'bt-task-list' }, recent.map(task => h('div', { className: 'bt-task-row', key: task.id },
      h('button', { className: 'bt-task-open', onClick: () => actions.openSession(task.sessionId), title: task.title }, task.title),
      h('span', { className: 'bt-note' }, t(labels[task.status] ?? 'Unknown')),
      running(task.status) ? h('button', { className: 'bt-soft bt-soft-sm', disabled: pending, onClick: () => { void stop(task.id) } }, t('Stop')) : null))),
    error ? h('p', { role: 'alert', className: 'bt-side-fail' }, error) : null)
}

export const TASK_CSS = `
.bt-task-dock{padding:8px 12px;background:var(--bt-card);border:1px solid var(--bt-line);border-radius:12px;color:var(--bt-ink);font-size:12px;line-height:18px}
.bt-task-head,.bt-task-row{display:flex;align-items:center;gap:8px}
.bt-task-head{padding-bottom:4px}.bt-task-head strong{flex:1;font-weight:600}
.bt-task-list{max-height:132px;overflow:auto}.bt-task-row{min-height:28px}
.bt-task-open{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;background:none;border:0;color:var(--bt-ink);font:inherit;cursor:pointer;padding:4px 0}
.bt-task-open:hover{color:var(--bt-accent)}
`
