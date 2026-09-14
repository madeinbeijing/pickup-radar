/**
 * Service health, derived from every component's own snapshot.
 *
 * Two tiers, because they call for different reactions:
 *
 * - `down` (HTTP 503): the radar cannot currently detect an arrival. The scheduler is
 *   stalled, the upstream breaker is open, or consecutive rounds resolved no watch at all.
 *   One failed round is tolerated — a single blip should not flap a probe.
 *
 * - `degraded` (HTTP 200): arrivals are still detected and pushed right now, but something
 *   will bite later — state or statistics cannot be persisted, a round was only partly
 *   resolved, or a notification recently exhausted its retries. Returning 503 for these
 *   would tell a supervisor to restart a process that is doing its main job.
 *
 * Every reason is listed, so a green status is never an unexplained one.
 */

const DEAD_LETTER_WINDOW_MS = 60 * 60_000;
const FAILED_ROUNDS_DOWN = 2;

export function assessHealth({ inventory, monitor, state, stats, notifications, now = Date.now() }) {
  const problems = [];
  const warnings = [];

  if (inventory.circuit.state !== 'closed') problems.push(`circuit-${inventory.circuit.state}`);
  // A deliberate pause is not an outage: 503 would tell a supervisor to restart a process
  // that is doing exactly what it was told. Round signals are frozen history while paused.
  if (monitor.paused) warnings.push('monitor-paused');
  else {
    if (monitor.stalled) problems.push('monitor-stalled');
    if (monitor.lastError) problems.push('monitor-error');
    if (monitor.failedRounds >= FAILED_ROUNDS_DOWN) problems.push('rounds-failing');
  }

  if (state?.failing) warnings.push('state-persist-failing');
  if (stats?.writeFailing) warnings.push('stats-write-failing');
  if (!monitor.paused && monitor.lastRound?.errored && monitor.failedRounds < FAILED_ROUNDS_DOWN) warnings.push('round-partially-failed');
  if (inventory.upstream?.lastContractWarning) warnings.push('contract-partial');
  const deadAt = Date.parse(notifications?.lastDeadLetterAt || '');
  if (Number.isFinite(deadAt) && now - deadAt < DEAD_LETTER_WINDOW_MS) warnings.push('notification-dead-lettered');

  const status = problems.length ? 'down' : warnings.length ? 'degraded' : 'ok';
  return { status, httpStatus: status === 'down' ? 503 : 200, problems, warnings };
}
