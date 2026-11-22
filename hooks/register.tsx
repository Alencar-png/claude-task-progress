import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { History, Task } from '../types'

const NO_HISTORY: History = { tasks: 0, avgTaskMs: 0, steps: 0, avgStepMs: 0 }
const REPORT_TOOL = 'mcp__task-progress__report_progress'
const HISTORY_KEY = 'history'
/** Quanto tempo a faixa de "concluída" fica à vista. */
const DONE_LINGER_MS = 45_000
/** Uma pausa mais longa que isto já não é a mesma tarefa: o próximo pedido começa outra. */
const PAUSE_FORGET_MS = 30 * 60_000

const taskAtom = atom({ plugin: 'task-progress', key: 'task' } as const, null, {
  shape: 'task-2',
})
const tickAtom = atom({ plugin: 'task-progress', key: 'tick' } as const, 0)
const historyAtom = atom(
  { plugin: 'task-progress', key: 'history' } as const,
  NO_HISTORY,
  { shape: 'history-1' },
)

const GUIDE = `Updates the live progress bar and time estimate the person sees above the prompt for the current task.

Call it at the start of any task that takes more than a quick answer, with percent 0, your best eta_minutes for the whole task and a label of a few words in the person's language. Call it again when you pass a milestone or your estimate changes materially (every few minutes on a long task), with the percent done so far and the minutes still left. Estimate honestly: include builds, test runs and waiting, and raise the estimate as soon as it slips. Skip it for one-line answers and pure conversation, and do not mention this tool to the person.`

/** Fração feita (0 a 1), ou null quando nada a informa ainda. */
export const fractionOf = (task: Task): number | null => {
  const fromPlan =
    task.total > 0
      ? Math.min(1, (task.done + (task.hasActive ? 0.5 : 0)) / task.total)
      : null
  const fromModel = task.percent === null ? null : task.percent / 100

  if (fromPlan === null && fromModel === null) {
    return null
  }

  return Math.max(fromPlan ?? 0, fromModel ?? 0)
}

/** Tempo restante e de onde vem a conta; null quando não dá para estimar. */
export const remainingOf = (
  task: Task,
  now: number,
  history: History,
): { ms: number; basis: string } | null => {
  const elapsed = now - task.startedAt
  const fraction = fractionOf(task)

  if (task.etaMs !== null) {
    const left = task.etaAt + task.etaMs - now

    if (left > 0) {
      return { ms: left, basis: 'estimativa do Claude' }
    }
  }

  if (fraction !== null && fraction >= 0.08 && fraction < 1) {
    return { ms: (elapsed * (1 - fraction)) / fraction, basis: 'ritmo atual' }
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

const statusOf = (item: unknown): string =>
  typeof item === 'object' && item !== null && 'status' in item
    ? String((item as { status: unknown }).status)
    : ''

/** Contagens da faixa a partir do estado de cada etapa. */
const counts = (steps: string[]): Pick<Task, 'steps' | 'done' | 'total' | 'hasActive'> => ({
  steps,
  total: steps.length,
  done: steps.filter(step => step === 'completed').length,
  hasActive: steps.includes('in_progress'),
})

/**
 * O que uma chamada de ferramenta de plano muda na tarefa; null se não é uma.
 * Guarda o estado de cada etapa: marcar de novo uma etapa já feita não conta duas vezes.
 */
export const planChange = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
  task: Task,
): Partial<Task> | null => {
  const list = Array.isArray(input.items)
    ? input.items
    : Array.isArray(input.todos)
      ? input.todos
      : null
  const steps = [...task.steps]

  if (tool.endsWith('update_plan') || tool === 'TodoWrite') {
    if (list !== null) {
      return counts(list.map(item => statusOf(item) || 'pending'))
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

    return changed ? counts(steps) : null
  }

  if (tool === 'TaskCreate') {
    return counts([...steps, 'pending'])
  }

  if (tool === 'TaskUpdate') {
    const status = String(input.status ?? '')
    const active = steps.indexOf('in_progress')
    const index = active >= 0 ? active : steps.indexOf('pending')

    if (index < 0 || (status !== 'completed' && status !== 'in_progress')) {
      return null
    }

    steps[index] = status

    return counts(steps)
  }

  return null
}

/** Ao fim de um turno, ainda há trabalho? Percentual abaixo de 100 ou etapas pendentes. */
export const hasWorkLeft = (task: Task): boolean =>
  (task.percent !== null && task.percent < 100) || (task.total > 0 && task.done < task.total)

const titleOf = (text: string): string => {
  const line = text.trim().split('\n')[0] ?? ''

  return line.length > 56 ? `${line.slice(0, 55).trimEnd()}…` : line
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
    const isTask = e.command === undefined && e.text.trim() !== ''
    const now = await $.clock.now()
    const current = await read($, taskAtom)
    // Uma pergunta durante a pausa ("terminou?") continua a mesma tarefa.
    const isPaused = current !== null && current.pausedAt !== null && now - current.pausedAt < PAUSE_FORGET_MS

    // Um recado enviado no meio do trabalho não recomeça a contagem.
    if (isTask && !isRunning && !isPaused) {
      const task: Task = {
        title: titleOf(e.text),
        startedAt: now,
        finishedAt: null,
        pausedAt: null,
        stopped: false,
        steps: [],
        done: 0,
        total: 0,
        hasActive: false,
        percent: null,
        etaMs: null,
        etaAt: now,
        label: '',
        tools: 0,
      }
      await update($, taskAtom, () => task)
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

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Readonly<Record<string, unknown>>

    if (input.agentId === undefined) {
      const tool = String(e.tool)
      await update($, taskAtom, task => {
        if (task === null || task.finishedAt !== null) {
          return task
        }

        const change = tool === REPORT_TOOL ? null : planChange(tool, input, task)

        return { ...task, ...change, tools: task.tools + 1 }
      })
    }

    return next(e)
  })

  on('tool.run', { tool: REPORT_TOOL }, async ($, e) => {
    const input = e as unknown as Readonly<Record<string, unknown>>
    const percent = Math.min(100, Math.max(0, Number(input.percent)))
    const minutes = Number(input.eta_minutes)
    const now = await $.clock.now()

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

    if (fields.agentId === undefined) {
      isRunning = false
      const now = await $.clock.now()
      const task = await read($, taskAtom)

      // O turno acabou, mas o trabalho não (subagentes ou tarefas em segundo plano seguem):
      // a faixa fica em pausa onde estava, com o relógio andando, em vez de mostrar 100%.
      if (task !== null && task.finishedAt === null && e.reason === 'answer' && hasWorkLeft(task)) {
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
            tasks,
            avgTaskMs: (old.avgTaskMs * old.tasks + took) / tasks,
            steps,
            avgStepMs:
              task.done > 0 && steps > 0
                ? (old.avgStepMs * old.steps + took) / steps
                : old.avgStepMs,
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

    const { Box, Progress, Text } = $.ui.resolve(e)
    const history = await read($, historyAtom)
    const isDone = task.finishedAt !== null
    const isComplete = isDone && !task.stopped
    const now = task.finishedAt ?? (await $.clock.now())
    const elapsed = now - task.startedAt
    // Só a tarefa concluída de verdade enche a barra; interrompida ou em pausa fica onde estava.
    const fraction = isComplete ? 1 : fractionOf(task)
    const left = isDone ? null : remainingOf(task, now, history)
    const steps = task.total > 0 ? ` · ${task.done}/${task.total} etapas` : ''
    const percent = fraction === null ? '' : ` · ${Math.round(fraction * 100)}%`
    const what = task.label === '' ? task.title : task.label
    const estimate = left === null ? 'estimando…' : `faltam ${about(left.ms)} (${left.basis})`
    const tail = isComplete
      ? `Concluída em ${clock(elapsed)}`
      : isDone
        ? `Interrompida após ${clock(elapsed)}`
        : task.pausedAt !== null
          ? `Em pausa: aguardando trabalho em segundo plano · ${clock(elapsed)} decorridos · ${estimate}`
          : `${clock(elapsed)} decorridos · ${estimate}`

    return (
      <Box flexDirection="column">
        <Progress
          label={`${what}${percent}${steps}`}
          value={fraction ?? undefined}
          max={1}
        />
        <Text dimColor>{tail}</Text>
      </Box>
    )
  })
}
