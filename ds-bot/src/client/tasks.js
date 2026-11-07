import { createElement as h, useEffect, useRef, useState } from 'react'
import { t, hostText } from './i18n.js'
import { CloseIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'

export const runningTask = task => ['starting', 'running', 'waiting', 'uncertain'].includes(task.status)
const labels = { uncertain: 'Unknown', starting: 'Starting', running: 'Running', waiting: 'Waiting for you', finished: 'Finished', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' }

export function TaskDock({ sessionId, useRoster, actions }) {
  const bot = useRoster(value => value.byId[sessionId])
  if (!bot?.taskId) return null
  return h('div', { className: 'bt-task-status' },
    h('button', { type: 'button', className: 'bt-task-summary', onClick: () => actions.openSession(bot.id) }, t('Back to main chat')))
}

export function TaskDialog({ bot, actions, leaving = false }) {
  const [removed, setRemoved] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const dialog = useRef(null)
  const closeButton = useRef(null)
  useEscape(actions.closeTasks)
  useEffect(() => {
    const previous = document.activeElement
    closeButton.current?.focus()
    return () => { if (previous?.isConnected) previous.focus?.() }
  }, [])
  const all = bot.tasks ?? []
  const shown = all.filter(task => Boolean(task.archivedAt) === removed)
    .sort((a, b) => Number(runningTask(b)) - Number(runningTask(a)) || b.updatedAt - a.updatedAt)
  useEffect(() => {
    if (document.activeElement === document.body) closeButton.current?.focus()
  }, [shown.length])
  const run = async action => {
    setPending(true); setError('')
    try { await action() } catch (failure) { setError(hostText(failure.message)) }
    finally { setPending(false) }
  }
  const keepFocus = event => {
    if (event.key !== 'Tab') return
    const nodes = [...dialog.current.querySelectorAll('button:not(:disabled),[href],[tabindex="0"]')]
    const first = nodes[0]; const last = nodes.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return h('div', { className: 'bt-mem-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim bt-mem-scrim', onMouseDown: () => actions.closeTasks() }),
    h('div', { ref: dialog, className: 'bt-mem bt-task-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('Bot tasks'), onKeyDown: keepFocus },
      h('div', { className: 'bt-mem-head' },
        h('h2', null, t('Bot tasks')), h('span', { className: 'bt-note' }, bot.name), h('span', { className: 'bt-mem-head-gap' }),
        h('button', { ref: closeButton, type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), onClick: () => actions.closeTasks() }, h(CloseIcon))),
      h('div', { className: 'bt-task-controls' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-pressed': removed, onClick: () => setRemoved(value => !value) }, t(removed ? 'Current tasks' : 'Removed tasks')),
        !removed && shown.some(task => !runningTask(task)) ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: pending, onClick: () => { void run(() => actions.archiveTask(bot.id, 'all')) } }, t('Clear finished tasks')) : null,
        all.some(runningTask) ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: pending, onClick: () => { void run(() => actions.stopTask(bot.id, 'all')) } }, t('Stop all tasks')) : null),
      h('div', { className: 'bt-task-list' },
        shown.length ? shown.map(task => h('div', { className: 'bt-task-row', key: task.id },
          h('button', { type: 'button', className: 'bt-task-open', onClick: () => { actions.closeTasks(); actions.openSession(task.sessionId) }, title: task.title }, task.title),
          h('span', { className: 'bt-note' }, t(labels[task.status] ?? 'Unknown')),
          runningTask(task) ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: pending, onClick: () => { void run(() => actions.stopTask(bot.id, task.id)) } }, t('Stop'))
            : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: pending, onClick: () => { void run(() => actions.archiveTask(bot.id, task.id, removed)) } }, t(removed ? 'Restore task' : 'Remove'))))
          : h('p', { className: 'bt-note' }, t(removed ? 'No removed tasks' : 'No tasks to show'))),
      h('p', { className: 'bt-task-help bt-note' }, t('Removing a task keeps its conversation. Restore it from Removed tasks.')),
      error ? h('p', { role: 'alert', className: 'bt-side-fail' }, error) : null))
}

export const TASK_CSS = `
.bt-task-status{display:flex;align-items:center;justify-content:flex-end;gap:12px;padding:0 12px 4px;color:var(--bt-ink-2)}
.bt-task-summary{display:inline-flex;align-items:center;gap:4px;background:none;border:0;color:inherit;font:inherit;font-size:12px;line-height:20px;padding:2px 4px;cursor:pointer;border-radius:6px}
.bt-task-summary:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-mem.bt-task-dialog{height:auto;max-height:min(640px,80dvh)}
.bt-task-controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 20px}
.bt-task-list{overflow:auto;padding:0 20px;min-height:60px}.bt-task-row{display:flex;align-items:center;gap:10px;min-height:48px;border-bottom:1px solid var(--bt-line)}
.bt-task-open{flex:1;min-width:0;text-align:left;background:none;border:0;color:var(--bt-ink);font:inherit;cursor:pointer;padding:8px 0;overflow-wrap:anywhere}
.bt-task-open:hover{color:var(--bt-accent)}.bt-task-row>.bt-note{flex:none}.bt-task-help{padding:12px 20px;margin:0}
`
