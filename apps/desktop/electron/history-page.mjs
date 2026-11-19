// Keys arrive in sequence order without loading the message bodies. A run can span
// other runs. Only its first user message decides whether it starts a new question.
export function historyPageStart(keys) {
  const runs = new Map();
  for (const [, sequence, runId, question, bytes] of keys) {
    let run = runs.get(runId);
    if (!run) {
      run = { first: sequence, last: sequence, question: 0, count: 0, bytes: 0 };
      runs.set(runId, run);
    }
    run.last = sequence;
    run.question ||= question;
    run.count++;
    run.bytes += bytes;
  }
  const ordered = [...runs.values()];
  let first,
    firstQuestion,
    count = 0,
    bytes = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const run = ordered[i];
    if (first && (count + run.count > 1000 || bytes + run.bytes > 512 * 1024)) break;
    first = run;
    if (run.question) firstQuestion = run.question;
    count += run.count;
    bytes += run.bytes;
  }
  if (!first || firstQuestion !== 2) return first?.first;
  // The page begins within a continuation. Walk the same overlapping run ranges
  // as the service, including state readings between the question and its reply.
  let start,
    through = 0;
  for (const run of ordered) {
    if (run.first > first.first) break;
    if (start === undefined || (run.first > through && run.question === 1)) start = run.first;
    through = Math.max(through, run.last);
  }
  return start;
}
