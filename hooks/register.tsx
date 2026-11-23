import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { History, Job, Plan, Task } from '../types'

const NO_HISTORY: History = {
  tasks: 0,
  avgTaskMs: 0,
  steps: 0,
  avgStepMs: 0,
  agents: 0,
  avgAgentMs: 0,
  commands: 0,
  avgCommandMs: 0,
  etaSamples: 0,
  etaLogRatio: 0,
}
const REPORT_TOOL = 'mcp__task-progress__report_progress'
const HISTORY_KEY = 'history'
const PANE = 'task-progress-steps'
const PANE_TITLE = 'Etapas da tarefa'
/** Quanto tempo a faixa de "concluída" fica à vista. */
const DONE_LINGER_MS = 45_000
/** Uma pausa mais longa que isto já não é a mesma tarefa: o próximo pedido começa outra. */
const PAUSE_FORGET_MS = 30 * 60_000
/** Sem plano nem percentual, a barra de um trabalho em segundo plano para aqui até ele acabar. */
const JOB_CAP = 0.95
/** Enquanto a tarefa roda, a barra nunca passa disto: o 100% é só do fim de verdade. */
const RUNNING_CAP = 0.97
/** Uma etapa em andamento enche no máximo esta fração dela antes de ser marcada feita. */
const STEP_CAP = 0.9
/** Sem base nenhuma, quanto se supõe que dura uma etapa. */
const DEFAULT_STEP_MS = 3 * 60_000
/** A calibração da estimativa do Claude fica entre estes fatores. */
const MIN_ETA_FACTOR = 0.05
const MAX_ETA_FACTOR = 3
/** Quantas tarefas a média da calibração pesa no máximo (as mais novas mandam mais). */
const ETA_MEMORY = 10

const taskAtom = atom({ plugin: 'task-progress', key: 'task' } as const, null, {
  shape: 'task-4',
})
const jobsAtom = atom({ plugin: 'task-progress', key: 'jobs' } as const, [], {
  shape: 'jobs-1',
})
const tickAtom = atom({ plugin: 'task-progress', key: 'tick' } as const, 0)
const historyAtom = atom(
  { plugin: 'task-progress', key: 'history' } as const,
  NO_HISTORY,
  { shape: 'history-3' },
)

const GUIDE = `Updates the live progress bar and time estimate the person sees above the prompt for the current task.

Call it at the start of any task that takes more than a quick answer, with percent 0, your best eta_minutes for the whole task and a label of a few words in the person's language. Call it again when you pass a milestone or your estimate changes materially (every few minutes on a long task), with the percent done so far and the minutes still left. Estimate YOUR OWN wall-clock time, not a human developer's: you work far faster than a person, and most tasks you do take 2 to 20 minutes; only count long waits you know of (builds, exports, test runs, slow commands). Revise the estimate up or down as soon as it is off. A subagent may call it too: its percent then fills its own bar in the steps pane. Skip it for one-line answers and pure conversation, and do not mention this tool to the person.`

const NO_PLAN: Plan = { steps: [], names: [], done: 0, total: 0, hasActive: false, percent: null }

/** Fração feita (0 a 1), ou null quando nada a informa ainda. */
export const fractionOf = (plan: Plan): number | null => {
  const fromPlan =
    plan.total > 0
      ? Math.min(1, (plan.done + (plan.hasActive ? 0.5 : 0)) / plan.total)
      : null
  const fromModel = plan.percent === null ? null : plan.percent / 100

  if (fromPlan === null && fromModel === null) {
    return null
  }

  return Math.max(fromPlan ?? 0, fromModel ?? 0)
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value))

/**
 * Quanto multiplicar o tempo que o Claude diz, pelo que as tarefas anteriores mostraram
 * (duração real sobre a prevista). Uma amostra "neutra" entra na média, para uma tarefa
 * só não mandar sozinha: 1 quando ainda não há nenhuma.
 */
export const etaFactor = (history: History): number =>
  history.etaSamples > 0
    ? clamp(
        Math.exp((history.etaLogRatio * history.etaSamples) / (history.etaSamples + 1)),
        MIN_ETA_FACTOR,
        MAX_ETA_FACTOR,
      )
    : 1

/** Soma uma tarefa concluída à calibração: duração real sobre a que o Claude previu. */
export const calibrate = (
  history: History,
  realMs: number,
  claimedMs: number,
): Pick<History, 'etaSamples' | 'etaLogRatio'> => {
  const kept = Math.min(history.etaSamples, ETA_MEMORY - 1)
  const sample = Math.log(clamp(realMs / claimedMs, 0.01, 10))

  return {
    etaSamples: history.etaSamples + 1,
    etaLogRatio: (history.etaLogRatio * kept + sample) / (kept + 1),
  }
}

/**
 * Fração firme (só etapas concluídas e o percentual dito, nada suposto pelo tempo) e quando
 * ela foi informada: o ritmo se mede naquele instante, não com o relógio de agora.
 */
const solidFraction = (task: Task): { fraction: number; at: number } | null => {
  const fromPlan = task.total > 0 ? Math.min(1, task.done / task.total) : null
  const fromModel = task.percent === null ? null : task.percent / 100

  if (fromModel !== null && (fromPlan === null || fromModel >= fromPlan)) {
    return { fraction: fromModel, at: task.etaAt }
  }

  return fromPlan === null ? null : { fraction: fromPlan, at: task.stepAt }
}

/** Tempo restante e de onde vem a conta; null quando não dá para estimar. */
export const remainingOf = (
  task: Task,
  now: number,
  history: History,
): { ms: number; basis: string } | null => {
  const elapsed = now - task.startedAt
  const solid = solidFraction(task)
  const factor = etaFactor(history)
  const told = task.etaMs === null ? null : task.etaAt + task.etaMs * factor - now
  // No ritmo de até aquele aviso, a tarefa toda leva (tempo até ele) / fração; falta o resto.
  const observed = solid === null ? 0 : solid.at - task.startedAt
  const paceLeft =
    solid !== null && solid.fraction >= 0.08 && solid.fraction < 1 && observed >= 20_000
      ? observed / solid.fraction - elapsed
      : null
  const pace = paceLeft !== null && paceLeft > 0 ? paceLeft : null

  // As duas contas juntas, numa média em escala de ordem de grandeza (2 h contra 5 min dá
  // ~30 min, não ~1 h): quanto mais feito, mais o ritmo real manda.
  if (told !== null && told > 0 && pace !== null && solid !== null) {
    const weight = Math.min(0.85, 0.3 + solid.fraction)

    return {
      ms: Math.exp(weight * Math.log(pace) + (1 - weight) * Math.log(told)),
      basis: 'Claude + ritmo atual',
    }
  }

  if (told !== null && told > 0) {
    return { ms: told, basis: factor === 1 ? 'estimativa do Claude' : 'estimativa do Claude, ajustada' }
  }

  if (pace !== null) {
    return { ms: pace, basis: 'ritmo atual' }
  }

  if (task.total > 0 && history.avgStepMs > 0) {
    const steps = task.total - task.done

    return { ms: steps * history.avgStepMs, basis: 'média por etapa' }
  }

  if (history.avgTaskMs > elapsed) {
    return { ms: history.avgTaskMs - elapsed, basis: 'média das tarefas' }
  }

  return null
}

/**
 * Fração que a barra mostra enquanto a tarefa roda: anda com o tempo entre um aviso e
 * outro em vez de ficar parada. A etapa em andamento enche aos poucos pelo tempo que as
 * etapas desta tarefa vêm levando (sem chegar à próxima); depois de um percentual dito, a
 * barra avança na proporção do tempo passado sobre o tempo passado mais o que falta.
 * Nunca chega a 100% antes do fim; null quando nada a informa ainda.
 */
export const liveFraction = (task: Task, now: number, history: History): number | null => {
  let fromPlan: number | null = null

  if (task.total > 0) {
    let step = 0

    if (task.hasActive) {
      const expected =
        task.done > 0
          ? Math.max(30_000, (task.stepAt - task.startedAt) / task.done)
          : history.avgStepMs > 0
            ? history.avgStepMs
            : DEFAULT_STEP_MS
      step = STEP_CAP * (1 - Math.exp(-Math.max(0, now - task.stepAt) / expected))
    }

    fromPlan = Math.min(1, (task.done + step) / task.total)
  }

  let fromModel: number | null = null

  if (task.percent !== null) {
    const said = task.percent / 100
    const since = Math.max(0, now - task.etaAt)
    const left = remainingOf(task, now, history)
    fromModel =
      left !== null && said < 1 && since > 0 ? said + (1 - said) * (since / (since + left.ms)) : said
  }

  if (fromPlan === null && fromModel === null) {
    return null
  }

  return Math.min(RUNNING_CAP, Math.max(fromPlan ?? 0, fromModel ?? 0))
}

/** Duração média já vista para esse tipo de trabalho (0 quando ainda não há). */
const averageOf = (kind: Job['kind'], history: History): number =>
  kind === 'agent' ? history.avgAgentMs : history.avgCommandMs

/**
 * Fração de um trabalho em segundo plano: o plano ou o percentual dele; sem isso,
 * o tempo decorrido sobre a média dos anteriores, parado em 95% até ele acabar.
 * null quando não há base nenhuma (a barra corre sem fim conhecido).
 */
export const jobFraction = (job: Job, now: number, history: History): number | null => {
  if (job.endedAt !== null) {
    return job.status === 'completed' ? 1 : fractionOf(job)
  }

  const own = fractionOf(job)

  if (own !== null) {
    return Math.min(own, JOB_CAP)
  }

  const average = averageOf(job.kind, history)

  return average > 0 ? Math.min(JOB_CAP, (now - job.startedAt) / average) : null
}

/** Tempo restante de um trabalho em segundo plano, quando dá para estimar. */
export const jobRemaining = (job: Job, now: number, history: History): number | null => {
  if (job.endedAt !== null) {
    return null
  }

  const elapsed = now - job.startedAt
  const own = fractionOf(job)

  if (own !== null && own >= 0.08 && own < 1) {
    return (elapsed * (1 - own)) / own
  }

  const average = averageOf(job.kind, history)

  return average > elapsed ? average - elapsed : null
}

/** 75_000 -> "1min 15s"; acima de uma hora, "1h 05min". */
export const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60

  if (h > 0) {
    return `${h}h ${String(m).padStart(2, '0')}min`
  }

  return m > 0 ? `${m}min ${String(s).padStart(2, '0')}s` : `${s}s`
}

/** Restante arredondado como se fala: "~40s", "~6 min", "~1h 10min". */
export const about = (ms: number): string => {
  if (ms < 55_000) {
    return `~${Math.max(5, Math.round(ms / 5000) * 5)}s`
  }

  const minutes = Math.round(ms / 60_000)

  return minutes < 60
    ? `~${minutes} min`
    : `~${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}min`
}

const fieldOf = (item: unknown, key: string): string =>
  typeof item === 'object' && item !== null && key in item
    ? String((item as Record<string, unknown>)[key] ?? '')
    : ''

const nameOf = (item: unknown): string =>
  (fieldOf(item, 'content') || fieldOf(item, 'subject') || fieldOf(item, 'activeForm')).trim()

/** Contagens da faixa a partir do estado de cada etapa. */
const counts = (
  steps: string[],
  names: string[],
): Pick<Plan, 'steps' | 'names' | 'done' | 'total' | 'hasActive'> => ({
  steps,
  names: steps.map((_, i) => names[i] ?? ''),
  total: steps.length,
  done: steps.filter(step => step === 'completed').length,
  hasActive: steps.includes('in_progress'),
})

/**
 * O que uma chamada de ferramenta de plano muda numa tarefa ou num trabalho em segundo
 * plano; null se não é uma. Guarda o estado de cada etapa: marcar de novo uma etapa já
 * feita não conta duas vezes.
 */
export const planChange = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
  plan: Pick<Plan, 'steps' | 'names' | 'percent'>,
): Partial<Plan> | null => {
  const list = Array.isArray(input.items)
    ? input.items
    : Array.isArray(input.todos)
      ? input.todos
      : null
  const steps = [...plan.steps]
  const names = [...plan.names]

  // O encerramento do turno no app (wrap_up) marca o plano inteiro como feito.
  if (tool.endsWith('wrap_up')) {
    return { ...counts(steps.map(() => 'completed'), names), percent: plan.percent === null ? null : 100 }
  }

  if (tool.endsWith('update_plan') || tool === 'TodoWrite') {
    if (list !== null) {
      return counts(list.map(item => fieldOf(item, 'status') || 'pending'), list.map(nameOf))
    }

    let changed = false
    const finish = (index: number): void => {
      if (index >= 0 && index < steps.length) {
        steps[index] = 'completed'
        changed = true
      }
    }

    if (input.advance === true) {
      const active = steps.indexOf('in_progress')
      finish(active)
      const following = steps.indexOf('pending', Math.max(0, active))
      if (following >= 0) steps[following] = 'in_progress'
      changed = true
    }

    if (Array.isArray(input.done)) {
      for (const number of input.done) finish(Number(number) - 1)
    }

    const start = Number(input.start)
    if (Number.isInteger(start) && start >= 1 && start <= steps.length) {
      for (let i = 0; i < steps.length; i += 1) if (steps[i] === 'in_progress') steps[i] = 'pending'
      steps[start - 1] = 'in_progress'
      changed = true
    }

    return changed ? counts(steps, names) : null
  }

  if (tool === 'TaskCreate') {
    return counts([...steps, 'pending'], [...names, nameOf(input)])
  }

  if (tool === 'TaskUpdate') {
    const status = String(input.status ?? '')
    const active = steps.indexOf('in_progress')
    const index = active >= 0 ? active : steps.indexOf('pending')

    if (index < 0 || (status !== 'completed' && status !== 'in_progress')) {
      return null
    }

    steps[index] = status

    return counts(steps, names)
  }

  return null
}

/** Ao fim de um turno, ainda há trabalho? Percentual abaixo de 100 ou etapas pendentes. */
export const hasWorkLeft = (task: Task): boolean =>
  (task.percent !== null && task.percent < 100) || (task.total > 0 && task.done < task.total)

/**
 * Os comandos em segundo plano que um aviso de tarefa dá por encerrados:
 * cada `<task-id>` com o `<status>` que vem depois dele.
 */
export const endedTasks = (text: string): { id: string; status: Job['status'] }[] => {
  const ended: { id: string; status: Job['status'] }[] = []
  const pattern = /<task-id>([^<]+)<\/task-id>([\s\S]*?)(?=<task-id>|$)/g

  for (const match of text.matchAll(pattern)) {
    const said = /<status>([^<]+)<\/status>/.exec(match[2] ?? '')?.[1]?.trim() ?? 'completed'
    const status: Job['status'] =
      said === 'failed' ? 'failed' : said === 'killed' || said === 'stopped' ? 'stopped' : 'completed'
    ended.push({ id: (match[1] ?? '').trim(), status })
  }

  return ended
}

const titleOf = (text: string, size = 56): string => {
  const line = text.trim().split('\n')[0] ?? ''

  return line.length > size ? `${line.slice(0, size - 1).trimEnd()}…` : line
}

const newJob = (id: string, kind: Job['kind'], title: string, now: number): Job => ({
  ...NO_PLAN,
  id,
  kind,
  title: titleOf(title || (kind === 'agent' ? 'Subagente' : 'Comando'), 48),
  startedAt: now,
  endedAt: null,
  status: 'running',
  tools: 0,
})

const STEP_MARK: Record<string, string> = { completed: '✓', in_progress: '›', pending: '·' }

/** Encerra um trabalho em segundo plano e, se ele acabou bem, soma sua duração à média. */
const endJob = async (
  $: EngineInterface,
  id: string,
  status: Job['status'],
): Promise<void> => {
  const now = await $.clock.now()
  const jobs = await read($, jobsAtom)
  const job = jobs.find(one => one.id === id && one.endedAt === null)

  if (job === undefined) {
    return
  }

  await update($, jobsAtom, list =>
    list.map(one => (one === job || (one.id === id && one.endedAt === null) ? { ...one, endedAt: now, status } : one)),
  )

  if (status === 'completed') {
    const took = now - job.startedAt
    await update($, historyAtom, old =>
      job.kind === 'agent'
        ? { ...old, agents: old.agents + 1, avgAgentMs: (old.avgAgentMs * old.agents + took) / (old.agents + 1) }
        : { ...old, commands: old.commands + 1, avgCommandMs: (old.avgCommandMs * old.commands + took) / (old.commands + 1) },
    )
    await $.store.set(HISTORY_KEY, await read($, historyAtom))
  }
}

export const register: Register = on => {
  let isRunning = false
  let ticker: { cancel: () => void } | undefined
  let clearing: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'report_progress',
      description: GUIDE,
      inputSchema: {
        type: 'object',
        properties: {
          percent: {
            type: 'number',
            description: 'How much of the task is done, 0 to 100.',
          },
          eta_minutes: {
            type: 'number',
            description: 'Minutes still left until the task is finished.',
          },
          label: {
            type: 'string',
            description:
              "A few words on what is being done now, in the person's language.",
          },
        },
        required: ['percent', 'eta_minutes'],
      },
      isDeferred: false,
    })

    const stored = await $.store.get(HISTORY_KEY)

    if (typeof stored === 'object' && stored !== null) {
      await update($, historyAtom, () => ({ ...NO_HISTORY, ...stored }))
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    const isNotice = e.origin?.kind === 'task-notification'

    // O aviso de um comando em segundo plano encerra a barra dele; não é um pedido novo.
    if (isNotice) {
      for (const ended of endedTasks(e.text)) await endJob($, ended.id, ended.status)
    }

    const isTask = e.command === undefined && e.text.trim() !== '' && !isNotice
    const current = await read($, taskAtom)
    // Uma pergunta durante a pausa ("terminou?") continua a mesma tarefa.
    const isPaused = current !== null && current.pausedAt !== null && now - current.pausedAt < PAUSE_FORGET_MS

    // Um recado enviado no meio do trabalho não recomeça a contagem.
    if (isTask && !isRunning && !isPaused) {
      const task: Task = {
        ...NO_PLAN,
        title: titleOf(e.text),
        startedAt: now,
        finishedAt: null,
        pausedAt: null,
        stopped: false,
        etaMs: null,
        etaAt: now,
        label: '',
        tools: 0,
        stepAt: now,
        claimedMs: null,
      }
      await update($, taskAtom, () => task)
      // Os trabalhos da tarefa anterior que ainda rodam continuam à vista; os encerrados saem.
      await update($, jobsAtom, list => list.filter(job => job.endedAt === null))
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isRunning = true
      clearing?.cancel()
      ticker?.cancel()
      ticker = $.clock.every(1000, () => {
        void update($, tickAtom, tick => tick + 1)
      })

      // A tarefa em pausa continua; um turno sem texto novo também retoma a que acabou de terminar.
      await update($, taskAtom, task => {
        if (task === null) return task
        if (task.pausedAt !== null) return { ...task, pausedAt: null }
        return task.finishedAt !== null && e.text === '' ? { ...task, finishedAt: null, stopped: false } : task
      })
    }

    return next(e)
  })

  // Cada subagente iniciado ganha sua própria barra no painel de etapas.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)

    if (started.agentId !== undefined) {
      const job = newJob(started.agentId, 'agent', e.description, await $.clock.now())
      await update($, jobsAtom, list => [...list.filter(one => one.id !== job.id), job].slice(-30))
    }

    return started
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Readonly<Record<string, unknown>>
    const tool = String(e.tool)
    const agentId = typeof input.agentId === 'string' ? input.agentId : undefined

    if (agentId === undefined) {
      const now = await $.clock.now()
      await update($, taskAtom, task => {
        if (task === null || task.finishedAt !== null) {
          return task
        }

        const change = tool === REPORT_TOOL ? null : planChange(tool, input, task)
        // Uma etapa nova começou quando muda o número de feitas ou a etapa em andamento.
        const isNewStep =
          change?.steps !== undefined &&
          (change.done !== task.done || change.steps.indexOf('in_progress') !== task.steps.indexOf('in_progress'))

        return { ...task, ...change, stepAt: isNewStep ? now : task.stepAt, tools: task.tools + 1 }
      })
    } else {
      // O plano de um subagente enche a barra dele, não a da tarefa.
      await update($, jobsAtom, list =>
        list.map(job =>
          job.id === agentId && job.endedAt === null
            ? { ...job, ...(tool === REPORT_TOOL ? null : planChange(tool, input, job)), tools: job.tools + 1 }
            : job,
        ),
      )
    }

    const ran = await next(e)

    // Um comando que foi para o segundo plano (pedido ou com ctrl+b) ganha sua barra.
    if (e.tool === 'Bash') {
      const result = (ran as { result?: { backgroundTaskId?: unknown } }).result
      const id = result?.backgroundTaskId

      if (typeof id === 'string' && id !== '') {
        const said = typeof input.description === 'string' ? input.description : ''
        const job = newJob(id, 'command', said || String(input.command ?? ''), await $.clock.now())
        await update($, jobsAtom, list => [...list.filter(one => one.id !== id), job].slice(-30))
      }
    }

    return ran
  })

  on('tool.run', { tool: REPORT_TOOL }, async ($, e) => {
    const input = e as unknown as Readonly<Record<string, unknown>>
    const percent = Math.min(100, Math.max(0, Number(input.percent)))
    const minutes = Number(input.eta_minutes)
    const now = await $.clock.now()
    const agentId = typeof input.agentId === 'string' ? input.agentId : undefined

    if (agentId !== undefined) {
      await update($, jobsAtom, list =>
        list.map(job =>
          job.id === agentId && Number.isFinite(percent) ? { ...job, percent } : job,
        ),
      )

      return { result: 'Progress updated.' }
    }

    await update($, taskAtom, task =>
      task === null
        ? task
        : {
            ...task,
            percent: Number.isFinite(percent) ? percent : task.percent,
            etaMs:
              Number.isFinite(minutes) && minutes >= 0
                ? minutes * 60_000
                : task.etaMs,
            etaAt: now,
            // A primeira previsão de duração total é a que se compara com a real no fim.
            claimedMs:
              task.claimedMs === null && Number.isFinite(minutes) && minutes > 0
                ? now - task.startedAt + minutes * 60_000
                : task.claimedMs,
            label:
              typeof input.label === 'string' && input.label.trim() !== ''
                ? input.label.trim().slice(0, 48)
                : task.label,
          },
    )

    return { result: 'Progress updated.' }
  })

  on('turn.complete', async ($, e, next) => {
    const fields = e as unknown as Readonly<Record<string, unknown>>

    // Cada execução de um subagente é um turno dele: o fim do turno encerra a barra dele.
    if (typeof fields.agentId === 'string') {
      const status: Job['status'] =
        e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'stopped' : 'failed'
      await endJob($, fields.agentId, status)
    }

    if (fields.agentId === undefined) {
      isRunning = false
      const now = await $.clock.now()
      const task = await read($, taskAtom)
      const isWaiting = (await read($, jobsAtom)).some(job => job.endedAt === null)

      // O turno acabou, mas o trabalho não (subagentes ou tarefas em segundo plano seguem):
      // a faixa fica em pausa onde estava, com o relógio andando, em vez de mostrar 100%.
      if (task !== null && task.finishedAt === null && e.reason === 'answer' && (hasWorkLeft(task) || isWaiting)) {
        await update($, taskAtom, () => ({ ...task, pausedAt: now }))
        return next(e)
      }

      ticker?.cancel()
      ticker = undefined

      if (task !== null && task.finishedAt === null) {
        await update($, taskAtom, () => ({ ...task, finishedAt: now, pausedAt: null, stopped: e.reason === 'aborted' }))

        // Só respostas completas entram na média; interrupções a distorceriam.
        if (e.reason === 'answer' && now - task.startedAt > 5000) {
          const old = await read($, historyAtom)
          const took = now - task.startedAt
          const tasks = old.tasks + 1
          const steps = old.steps + task.done
          const history: History = {
            ...old,
            tasks,
            avgTaskMs: (old.avgTaskMs * old.tasks + took) / tasks,
            steps,
            avgStepMs:
              task.done > 0 && steps > 0
                ? (old.avgStepMs * old.steps + took) / steps
                : old.avgStepMs,
            ...(task.claimedMs !== null && task.claimedMs > 0 ? calibrate(old, took, task.claimedMs) : null),
          }
          await update($, historyAtom, () => history)
          await $.store.set(HISTORY_KEY, history)
        }

        clearing?.cancel()
        clearing = $.clock.after(DONE_LINGER_MS, () => {
          void update($, taskAtom, current =>
            current !== null && current.finishedAt !== null ? null : current,
          )
        })
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const task = await read($, taskAtom)
    await read($, tickAtom)

    if (task === null || e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Progress, Text } = $.ui.resolve(e)
    const history = await read($, historyAtom)
    const jobs = await read($, jobsAtom)
    const running = jobs.filter(job => job.endedAt === null).length
    const isDone = task.finishedAt !== null
    const isComplete = isDone && !task.stopped
    const now = task.finishedAt ?? (await $.clock.now())
    const elapsed = now - task.startedAt
    // Só a tarefa concluída de verdade enche a barra; interrompida ou em pausa fica onde estava.
    const fraction = isComplete ? 1 : liveFraction(task, now, history)
    const left = isDone ? null : remainingOf(task, now, history)
    // Etapas e percentual aparecem uma vez só, à direita da barra; o rótulo é só o que se faz.
    const figures = [
      task.total > 0 ? `${task.done}/${task.total} etapas` : '',
      fraction === null ? '' : `${Math.round(fraction * 100)}%`,
    ].filter(part => part !== '').join(' · ')
    const what = task.label === '' ? task.title : task.label
    const estimate = left === null ? 'estimando…' : `faltam ${about(left.ms)} (${left.basis})`
    const behind = running > 0 ? ` · ${running} em segundo plano` : ''
    const tail = isComplete
      ? `Concluída em ${clock(elapsed)}`
      : isDone
        ? `Interrompida após ${clock(elapsed)}`
        : task.pausedAt !== null
          ? `Em pausa: aguardando trabalho em segundo plano · ${clock(elapsed)} decorridos · ${estimate}`
          : `${clock(elapsed)} decorridos · ${estimate}${behind}`

    return (
      <Box flexDirection="column" gap="sm" paddingY="xs">
        <Progress
          label={what}
          value={fraction ?? undefined}
          max={1}
          valueText={figures === '' ? undefined : figures}
        />
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="md">
          <Text dimColor>{tail}</Text>
          {(task.total > 0 || jobs.length > 0) && (
            <Button
              key="steps"
              label="Ver etapas"
              variant="secondary"
              onPress={() => $.ui.open({ id: PANE, title: PANE_TITLE, closeOnEscape: true })}
            />
          )}
        </Box>
      </Box>
    )
  })

  // O painel: as etapas do plano e cada trabalho em segundo plano com sua própria barra.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Progress, Text } = $.ui.resolve(e)
    const task = await read($, taskAtom)
    const jobs = await read($, jobsAtom)
    const history = await read($, historyAtom)
    await read($, tickAtom)
    const now = await $.clock.now()

    if (task === null && jobs.length === 0) {
      return <Text dimColor>Nenhuma tarefa em andamento.</Text>
    }

    return (
      <Box flexDirection="column" gap="lg" padding="sm">
        {task !== null && (
          <Box flexDirection="column" gap="xs">
            <Text bold>{task.title}</Text>
            {task.total === 0 && <Text dimColor>Sem plano de etapas nesta tarefa.</Text>}
            {task.steps.map((step, i) => (
              <Text key={`step-${i}`} dimColor={step === 'completed'} bold={step === 'in_progress'}>
                {STEP_MARK[step] ?? '·'} {task.names[i] || `Etapa ${i + 1}`}
              </Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column" gap="md">
          <Text bold>Em segundo plano</Text>
          {jobs.length === 0 && <Text dimColor>Nada rodando em segundo plano.</Text>}
          {jobs.map(job => {
            const fraction = jobFraction(job, now, history)
            const left = jobRemaining(job, now, history)
            const kind = job.kind === 'agent' ? 'Agente' : 'Comando'
            const end = job.endedAt ?? now
            const state =
              job.status === 'completed'
                ? `concluído em ${clock(end - job.startedAt)}`
                : job.status === 'failed'
                  ? `falhou após ${clock(end - job.startedAt)}`
                  : job.status === 'stopped'
                    ? `interrompido após ${clock(end - job.startedAt)}`
                    : `${clock(end - job.startedAt)} decorridos · ${left === null ? 'estimando…' : `faltam ${about(left)}`}`
            const plan = job.total > 0 ? ` · ${job.done}/${job.total} etapas` : ''
            const figures = fraction === null ? undefined : `${Math.round(fraction * 100)}%`
            const tools = job.kind === 'agent' && job.tools > 0 ? ` · ${job.tools} ferramentas` : ''

            return (
              <Box key={`job-${job.id}`} flexDirection="column" gap="xs">
                <Progress
                  label={`${kind}: ${job.title}`}
                  value={fraction ?? undefined}
                  max={1}
                  valueText={figures}
                />
                <Text dimColor>
                  {state}
                  {plan}
                  {tools}
                </Text>
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}
