type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',  // gray
  info: '\x1b[36m',   // cyan
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
};

const RESET = '\x1b[0m';

class Logger {
  private minLevel: number;
  private context: string;

  constructor(context: string = 'app', level: string = 'info') {
    this.context = context;
    this.minLevel = LOG_LEVELS[level as LogLevel] ?? LOG_LEVELS.info;
  }

  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < this.minLevel) return;

    const timestamp = this.formatTimestamp();
    const color = LOG_COLORS[level];
    const prefix = `${color}[${timestamp}] [${level.toUpperCase()}] [${this.context}]${RESET}`;

    if (data) {
      console.log(`${prefix} ${message}`, JSON.stringify(data, null, 2));
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  child(context: string): Logger {
    return new Logger(`${this.context}:${context}`, this.levelName());
  }

  private levelName(): string {
    const entry = Object.entries(LOG_LEVELS).find(([, v]) => v === this.minLevel);
    return entry ? entry[0] : 'info';
  }
}

export function createLogger(context: string, level?: string): Logger {
  return new Logger(context, level ?? process.env.LOG_LEVEL ?? 'info');
}

export type { Logger };
