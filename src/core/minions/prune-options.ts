import type { MinionJobStatus } from './types.ts';

export interface PruneCliOptions {
  olderThan: Date;
  days: number;
  status?: MinionJobStatus[];
  statusLabel: string;
  dryRun: boolean;
}

/** Parse the destructive prune surface without touching the queue. */
export function parsePruneCliOptions(args: string[], now = Date.now()): PruneCliOptions {
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const days = parseInt(value('--older-than') ?? '30d', 10);
  if (isNaN(days) || days <= 0) {
    throw new Error('--older-than must be a positive number (days). Example: --older-than 30d');
  }
  const raw = value('--status');
  const terminal: MinionJobStatus[] = ['completed', 'failed', 'dead', 'cancelled'];
  if (raw && !terminal.includes(raw as MinionJobStatus)) {
    throw new Error('--status must be one of completed, failed, dead, cancelled');
  }
  return {
    olderThan: new Date(now - days * 86_400_000),
    days,
    status: raw ? [raw as MinionJobStatus] : undefined,
    statusLabel: raw ? ` ${raw}` : '',
    dryRun: args.includes('--dry-run'),
  };
}
