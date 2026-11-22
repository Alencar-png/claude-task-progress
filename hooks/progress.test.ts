import { expect, test } from 'claude-code/testing'

import type { History, Task } from '../types'
import { about, clock, fractionOf, planChange, remainingOf } from './register'

const NONE: History = { tasks: 0, avgTaskMs: 0, steps: 0, avgStepMs: 0 }
const task = (over: Partial<Task>): Task => ({
  title: 'Corrigir os testes',
  startedAt: 0,
  finishedAt: null,
  done: 0,
  total: 0,
  hasActive: false,
  percent: null,
  etaMs: null,
  etaAt: 0,
  label: '',
  tools: 0,
  ...over,
})

test('the plan sets the fraction, an active step counting as half', async () => {
  expect(fractionOf(task({}))).toBe(null)
  expect(fractionOf(task({ done: 2, total: 4 }))).toBe(0.5)
  expect(fractionOf(task({ done: 1, total: 4, hasActive: true }))).toBe(0.375)
  expect(fractionOf(task({ done: 1, total: 4, percent: 60 }))).toBe(0.6)
})

test('the remaining time follows the best signal there is', async () => {
  // O Claude informou 10 min há 4 min: faltam 6.
  const told = task({ etaMs: 600_000, etaAt: 60_000, percent: 10 })
  expect(remainingOf(told, 300_000, NONE)).toEqual({
    ms: 360_000,
    basis: 'estimativa do Claude',
  })

  // Estimativa vencida: volta ao ritmo atual (25% em 5 min -> faltam 15).
  const late = task({ etaMs: 60_000, etaAt: 0, done: 1, total: 4 })
  expect(remainingOf(late, 300_000, NONE)).toEqual({
    ms: 900_000,
    basis: 'ritmo atual',
  })

  // Sem nada feito ainda: média por etapa das tarefas anteriores.
  const fresh = task({ total: 5 })
  const past: History = { tasks: 3, avgTaskMs: 400_000, steps: 12, avgStepMs: 90_000 }
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
  expect(planChange('mcp__ccd_turn__update_plan', { items }, task({}))).toEqual({
    total: 3,
    done: 1,
    hasActive: true,
  })
  expect(
    planChange('mcp__ccd_turn__update_plan', { advance: true }, task({ done: 1, total: 3 })),
  ).toEqual({ done: 2, hasActive: true })
  expect(planChange('TodoWrite', { todos: items }, task({}))).toEqual({
    total: 3,
    done: 1,
    hasActive: true,
  })
  expect(planChange('Bash', { command: 'ls' }, task({}))).toBe(null)
})

test('times read as a person says them', async () => {
  expect(clock(75_000)).toBe('1min 15s')
  expect(clock(3_900_000)).toBe('1h 05min')
  expect(about(42_000)).toBe('~40s')
  expect(about(360_000)).toBe('~6 min')
  expect(about(4_200_000)).toBe('~1h 10min')
})
