import { expect, test } from 'claude-code/testing'

import type { History, Job, Task } from '../types'
import { about, calibrate, clock, endedTasks, etaFactor, fractionOf, hasWorkLeft, jobFraction, liveFraction, planChange, remainingOf } from './register'

const NONE: History = { tasks: 0, avgTaskMs: 0, steps: 0, avgStepMs: 0, agents: 0, avgAgentMs: 0, commands: 0, avgCommandMs: 0, etaSamples: 0, etaLogRatio: 0 }
const task = (over: Partial<Task>): Task => ({
  title: 'Corrigir os testes',
  startedAt: 0,
  finishedAt: null,
  pausedAt: null,
  stopped: false,
  steps: [],
  names: [],
  done: 0,
  total: 0,
  hasActive: false,
  percent: null,
  etaMs: null,
  etaAt: 0,
  label: '',
  tools: 0,
  stepAt: 0,
  claimedMs: null,
  ...over,
})

test('the plan sets the fraction, an active step counting as half', async () => {
  expect(fractionOf(task({}))).toBe(null)
  expect(fractionOf(task({ done: 2, total: 4 }))).toBe(0.5)
  expect(fractionOf(task({ done: 1, total: 4, hasActive: true }))).toBe(0.375)
  expect(fractionOf(task({ done: 1, total: 4, percent: 60 }))).toBe(0.6)
})

test('the remaining time follows the best signal there is', async () => {
  // O Claude informou 10 min há 4 min, sem percentual: faltam 6.
  const told = task({ etaMs: 600_000, etaAt: 60_000, percent: 0 })
  expect(remainingOf(told, 300_000, NONE)).toEqual({
    ms: 360_000,
    basis: 'estimativa do Claude',
  })

  // Com percentual, o ritmo de até aquele aviso entra na conta (10% em 1 min: 9 min de
  // tarefa toda, faltam 5) e as duas contas se misturam entre 5 e 6 min.
  const mixed = remainingOf(task({ etaMs: 600_000, etaAt: 60_000, percent: 10 }), 300_000, NONE)
  expect(mixed?.basis).toBe('Claude + ritmo atual')
  expect((mixed?.ms ?? 0) > 300_000 && (mixed?.ms ?? 0) < 360_000).toBe(true)

  // Estimativa vencida: volta ao ritmo atual (25% em 5 min -> faltam 15).
  const late = task({ etaMs: 60_000, etaAt: 0, done: 1, total: 4, stepAt: 300_000 })
  expect(remainingOf(late, 300_000, NONE)).toEqual({
    ms: 900_000,
    basis: 'ritmo atual',
  })

  // Sem nada feito ainda: média por etapa das tarefas anteriores.
  const fresh = task({ total: 5 })
  const past: History = { ...NONE, tasks: 3, avgTaskMs: 400_000, steps: 12, avgStepMs: 90_000 }
  expect(remainingOf(fresh, 10_000, past)).toEqual({
    ms: 450_000,
    basis: 'média por etapa',
  })

  expect(remainingOf(task({}), 10_000, NONE)).toBe(null)
})

test('plan tools of the desktop app and the terminal are both read', async () => {
  const items = [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'pending' },
  ]
  const listed = planChange('mcp__ccd_turn__update_plan', { items }, task({}))
  expect([listed?.total, listed?.done, listed?.hasActive]).toEqual([3, 1, true])
  const advanced = planChange('mcp__ccd_turn__update_plan', { advance: true }, task({ ...listed }))
  expect(advanced?.steps).toEqual(['completed', 'completed', 'in_progress'])
  expect([advanced?.done, advanced?.hasActive]).toEqual([2, true])
  const todos = planChange('TodoWrite', { todos: items }, task({}))
  expect([todos?.total, todos?.done]).toEqual([3, 1])
  expect(planChange('Bash', { command: 'ls' }, task({}))).toBe(null)
})

test('marking a finished step again does not count it twice', async () => {
  const start = task({ ...planChange('x__update_plan', {
    items: [{ status: 'completed' }, { status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }],
  }, task({})) })
  const again = planChange('x__update_plan', { done: [1, 2], start: 3 }, start)
  expect([again?.done, again?.total]).toEqual([2, 4])
  const out = planChange('x__update_plan', { done: [3], start: 4 }, task({ ...again }))
  expect(out?.steps).toEqual(['completed', 'completed', 'completed', 'in_progress'])
})

test('the wrap-up of the desktop app finishes the plan', async () => {
  const open = task({ steps: ['completed', 'completed', 'in_progress'], names: ['a', 'b', 'c'], done: 2, total: 3, hasActive: true, percent: 80 })
  const closed = task({ ...open, ...planChange('mcp__ccd_turn__wrap_up', { recap: 'ok' }, open) })
  expect([closed.done, closed.total, closed.hasActive, closed.percent]).toEqual([3, 3, false, 100])
  expect(hasWorkLeft(closed)).toBe(false)
})

test('a turn that ends with work left pauses instead of showing 100%', async () => {
  expect(hasWorkLeft(task({ percent: 95 }))).toBe(true)
  expect(hasWorkLeft(task({ done: 3, total: 4 }))).toBe(true)
  expect(hasWorkLeft(task({ percent: 100, done: 4, total: 4 }))).toBe(false)
  // Sem sinal nenhum (resposta curta), o fim do turno é o fim da tarefa.
  expect(hasWorkLeft(task({}))).toBe(false)
})

test('times read as a person says them', async () => {
  expect(clock(75_000)).toBe('1min 15s')
  expect(clock(3_900_000)).toBe('1h 05min')
  expect(about(42_000)).toBe('~40s')
  expect(about(360_000)).toBe('~6 min')
  expect(about(4_200_000)).toBe('~1h 10min')
})

const job = (over: Partial<Job>): Job => ({
  steps: [],
  names: [],
  done: 0,
  total: 0,
  hasActive: false,
  percent: null,
  id: 'a1',
  kind: 'agent',
  title: 'Revisar o código',
  startedAt: 0,
  endedAt: null,
  status: 'running',
  tools: 0,
  ...over,
})

test('the plan keeps the name of each step', async () => {
  const items = [
    { content: 'Ler o código', status: 'completed' },
    { content: 'Corrigir', status: 'in_progress' },
  ]
  expect(planChange('x__update_plan', { items }, task({}))?.names).toEqual(['Ler o código', 'Corrigir'])
  const created = planChange('TaskCreate', { subject: 'Testar' }, task({ steps: ['completed'], names: ['Ler'] }))
  expect(created?.names).toEqual(['Ler', 'Testar'])
})

test('each background job fills its own bar', async () => {
  const seen: History = { ...NONE, agents: 2, avgAgentMs: 200_000 }
  // Sem plano: o tempo sobre a média dos anteriores, parado em 95% até acabar.
  expect(jobFraction(job({}), 100_000, seen)).toBe(0.5)
  expect(jobFraction(job({}), 900_000, seen)).toBe(0.95)
  expect(jobFraction(job({}), 100_000, NONE)).toBe(null)
  // O plano do próprio subagente manda na barra dele.
  expect(jobFraction(job({ done: 1, total: 4 }), 100_000, seen)).toBe(0.25)
  expect(jobFraction(job({ endedAt: 5, status: 'completed' }), 100_000, NONE)).toBe(1)
})

test('a task notice ends the commands it names', async () => {
  const text = '<task-notification><task-id>b1x</task-id><status>completed</status></task-notification>' +
    '<task-notification><task-id>b2y</task-id><status>failed</status></task-notification>'
  expect(endedTasks(text)).toEqual([
    { id: 'b1x', status: 'completed' },
    { id: 'b2y', status: 'failed' },
  ])
  expect(endedTasks('nada aqui')).toEqual([])
})

test('the bar keeps moving between reports instead of freezing', async () => {
  // 1 de 4 etapas feita em 2 min, a segunda em andamento desde então.
  const busy = task({ steps: ['completed', 'in_progress', 'pending', 'pending'], done: 1, total: 4, hasActive: true, stepAt: 120_000 })
  const early = liveFraction(busy, 130_000, NONE) ?? 0
  const later = liveFraction(busy, 300_000, NONE) ?? 0
  expect(early > 0.25 && early < 0.3).toBe(true)
  expect(later > early).toBe(true)
  // A etapa em andamento nunca chega à próxima sozinha.
  expect((liveFraction(busy, 10_000_000, NONE) ?? 0) < 0.5).toBe(true)

  // Depois de um percentual dito, a barra anda pelo tempo que falta.
  const said = task({ percent: 30, etaMs: 300_000, etaAt: 60_000 })
  const after = liveFraction(said, 210_000, NONE) ?? 0
  expect(after > 0.5 && after < 0.8).toBe(true)
  // Nunca 100% antes do fim.
  expect((liveFraction(task({ percent: 100 }), 0, NONE) ?? 0) < 1).toBe(true)
})

test('a wild estimate from Claude gives way to the real pace', async () => {
  // Disse 2 h no começo; em 4 min fez 3 de 4 etapas.
  const wild = task({ etaMs: 7_200_000, etaAt: 0, steps: ['completed', 'completed', 'completed', 'in_progress'], done: 3, total: 4, hasActive: true, stepAt: 240_000 })
  const left = remainingOf(wild, 240_000, NONE)
  expect(left?.basis).toBe('Claude + ritmo atual')
  expect((left?.ms ?? 0) < 20 * 60_000).toBe(true)
})

test('estimates are calibrated by how long tasks really took', async () => {
  expect(etaFactor(NONE)).toBe(1)
  // Previu 2 h, levou 5 min, três vezes seguidas: a próxima previsão encolhe muito.
  let seen = NONE
  for (let i = 0; i < 3; i += 1) seen = { ...seen, ...calibrate(seen, 300_000, 7_200_000) }
  expect(etaFactor(seen) < 0.15).toBe(true)
  const told = task({ etaMs: 7_200_000, etaAt: 0 })
  expect(remainingOf(told, 10_000, seen)?.basis).toBe('estimativa do Claude, ajustada')
  expect((remainingOf(told, 10_000, seen)?.ms ?? 0) < 20 * 60_000).toBe(true)
  // Uma tarefa só não manda sozinha.
  const once = { ...NONE, ...calibrate(NONE, 300_000, 7_200_000) }
  expect(etaFactor(once) > 0.15).toBe(true)
})
