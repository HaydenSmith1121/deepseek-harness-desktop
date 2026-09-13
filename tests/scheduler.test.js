'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runWithConcurrency } = require('../main/scheduler');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('runs all tasks and preserves order of results', async () => {
  const tasks = [1, 2, 3, 4, 5].map((n) => async () => {
    await delay(Math.random() * 10);
    return n * 10;
  });
  const results = await runWithConcurrency(tasks, 2);
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
});

test('respects the concurrency limit', async () => {
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 8 }, () => async () => {
    running++;
    peak = Math.max(peak, running);
    await delay(20);
    running--;
    return true;
  });
  await runWithConcurrency(tasks, 3);
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded 3`);
  assert.ok(peak >= 2, 'tasks appear to have run serially');
});

test('reports progress after each task', async () => {
  const seen = [];
  const tasks = Array.from({ length: 4 }, () => async () => 'x');
  await runWithConcurrency(tasks, 2, { onTaskDone: (done, total) => seen.push([done, total]) });
  assert.equal(seen.length, 4);
  assert.deepEqual(seen[3], [4, 4]);
});

test('stops dispatching new tasks once aborted', async () => {
  const controller = new AbortController();
  let started = 0;
  const tasks = Array.from({ length: 10 }, () => async () => {
    started++;
    await delay(15);
    return started;
  });
  setTimeout(() => controller.abort(), 25);
  const results = await runWithConcurrency(tasks, 1, { signal: controller.signal });
  assert.ok(started < 10, `started ${started} tasks despite abort`);
  assert.ok(results.some((r) => r === undefined));
});

test('handles empty task list', async () => {
  const results = await runWithConcurrency([], 4);
  assert.deepEqual(results, []);
});
