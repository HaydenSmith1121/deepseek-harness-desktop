'use strict';

/**
 * Simple concurrency-limited task runner.
 * Tasks are functions returning promises; they must not reject
 * (callers handle their own errors inside the task).
 */
async function runWithConcurrency(tasks, limit, opts = {}) {
  const { signal, onTaskDone } = opts;
  // fill() avoids sparse-array holes which Array methods (some/map/filter) skip
  const results = new Array(tasks.length).fill(undefined);
  const size = Math.max(1, Math.min(Number(limit) || 1, tasks.length || 1));
  let next = 0;
  let completed = 0;

  const worker = async () => {
    while (true) {
      if (signal && signal.aborted) return;
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
      completed++;
      if (onTaskDone) {
        try {
          onTaskDone(completed, tasks.length, i);
        } catch {
          /* progress callback must not break the run */
        }
      }
    }
  };

  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

module.exports = { runWithConcurrency };
