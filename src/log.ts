const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").trim().toLowerCase();
  return LEVELS[raw as Level] ?? LEVELS.info;
}

function emit(level: Level, scope: string, args: unknown[]): void {
  if (LEVELS[level] < threshold()) return;
  const prefix = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  stream(prefix, ...args);
}

export type Logger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export function createLogger(scope: string): Logger {
  return {
    debug: (...args) => emit("debug", scope, args),
    info: (...args) => emit("info", scope, args),
    warn: (...args) => emit("warn", scope, args),
    error: (...args) => emit("error", scope, args),
  };
}
