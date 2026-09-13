const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const active = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
const pretty = process.env.LOG_FORMAT !== 'json' && process.stdout.isTTY;

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const COLOR = { debug: '\x1b[2m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

function format(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function emit(level, message, fields) {
  if (LEVELS[level] < active) return;
  const time = new Date().toISOString();
  if (!pretty) {
    process.stdout.write(`${JSON.stringify({ time, level, msg: message, ...fields })}\n`);
    return;
  }
  const extra = fields && Object.keys(fields).length
    ? ' ' + Object.entries(fields).map(([k, v]) => `${DIM}${k}=${RESET}${format(v)}`).join(' ')
    : '';
  process.stdout.write(`${DIM}${time.slice(11, 23)}${RESET} ${COLOR[level]}${level.padEnd(5)}${RESET} ${message}${extra}\n`);
}

function bind(bound) {
  return {
    debug: (m, f) => emit('debug', m, { ...bound, ...f }),
    info: (m, f) => emit('info', m, { ...bound, ...f }),
    warn: (m, f) => emit('warn', m, { ...bound, ...f }),
    error: (m, f) => emit('error', m, { ...bound, ...f }),
    child: (next) => bind({ ...bound, ...next })
  };
}

export const logger = bind({});
