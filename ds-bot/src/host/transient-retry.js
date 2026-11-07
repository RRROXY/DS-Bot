import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export const RETRY_DELAYS = [10000, 30000, 60000]
const POLICY = 'ds-bot/transient-request/v1'
const PERMANENT = new Set(['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_SIGNED_OUT', 'ACCOUNT_TOKEN_INVALID', 'QUOTA_EXCEEDED', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED'])

export function transientFailure(failure) {
  if (!failure || PERMANENT.has(failure.code) || [400, 401, 402, 403, 404, 413, 422].includes(failure.status)) return false
  if (['SERVER', 'TIMEOUT', 'TRANSPORT', 'RATE_LIMIT'].includes(failure.code)) return true
  if ([500, 502, 503, 504, 529].includes(failure.status)) return true
  if (!['PI_AI_ERROR', 'UNKNOWN', 'overloaded_error'].includes(failure.code)) return false
  // "other" has no success semantics. Only retry this exact provider failure,
  // never turn an unknown terminal reason into a completed response.
  return failure.code === 'overloaded_error' || /^Provider finish_reason: other\s*$/.test(failure.message ?? '')
    || /^(?:Command Code: )?Upstream model provider is temporarily unavailable\./i.test(failure.message ?? '')
}

export function install(rt, { wait = delay } = {}) {
  const { ctx } = rt
  const lifetime = new AbortController()
  const active = new Set()

  async function recover(payload, next) {
    const { agent, turn, step, provider, failure, signal } = payload
    const cancelled = () => lifetime.signal.aborted || signal.aborted
    if (cancelled()) return undefined
    // Let native retries and context recovery finish first, regardless of the
    // profile's plugin order. Their budgets and provider policies stay intact.
    const decision = await next()
    if (cancelled()) return undefined
    if (decision !== undefined) return decision
    if (rt.config.transientRetry === false || !rt.isBotSession(agent.id)
      || rt.readOnly() !== undefined || !transientFailure(failure)) return undefined

    // Read the receipt from the public log so a plugin reload cannot reset the
    // retry allowance of a still-open step. No prompts or tool results change.
    const previous = agent.session.snapshotEvents().findLast(event => event.type === 'llm/retry'
      && event.data.policyKey === POLICY && event.data.turn === turn && event.data.step === step)?.data
    const retry = (previous?.retry ?? 0) + 1
    if (retry > RETRY_DELAYS.length) return undefined
    const requested = failure.providerRetryAfterMs
    if (Number.isFinite(requested) && requested > RETRY_DELAYS.at(-1)) return undefined
    const delayMs = Math.max(RETRY_DELAYS[retry - 1], Number.isFinite(requested) && requested > 0 ? requested : 0)
    const retryId = previous?.retryId ?? randomUUID()
    const fused = AbortSignal.any([signal, lifetime.signal])
    agent.session.append('llm/retry', {
      retryId, turn, step, provider, policyKey: POLICY, mode: 'normal', retry,
      maxRetries: RETRY_DELAYS.length, delayMs,
      failure: { code: failure.code, message: 'The upstream model request is temporarily unavailable.', ...(failure.status === undefined ? {} : { status: failure.status }) },
    })
    await ctx.sessions.flush(agent.session)
    try { await wait(delayMs, undefined, { signal: fused }) }
    catch (error) { if (!fused.aborted) throw error }
    if (cancelled() || rt.readOnly() !== undefined) return undefined
    agent.session.append('llm/retry-started', { retryId, turn, step, retry })
    return { kind: 'retry' }
  }

  ctx.on('agent/request-error', (payload, next) => {
    const pending = recover(payload, next).finally(() => active.delete(pending))
    active.add(pending)
    return pending
  }, { prepend: true })
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled(active)
  }, 'ds-bot: transient request recovery')
}
