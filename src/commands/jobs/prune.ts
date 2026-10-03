/** `gbrain jobs prune` — bounded age/status filters and a non-mutating preview. */
import { type JobsCommandContext } from './shared.ts';
import { parsePruneCliOptions } from '../../core/minions/prune-options.ts';

export async function runJobsPrune({ args, queue }: JobsCommandContext): Promise<void> {
  let opts;
  try { opts = parsePruneCliOptions(args); }
  catch (e) { console.error(`Error: ${(e as Error).message}`); process.exit(1); }
  try { await queue.ensureSchema(); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
  const count = await queue.prune({ olderThan: opts.olderThan, status: opts.status, dryRun: opts.dryRun });
  const suffix = `${opts.statusLabel} jobs older than ${opts.days} days.`;
  console.log(opts.dryRun ? `[dry-run] Would prune ${count}${suffix} Nothing deleted.` : `Pruned ${count}${suffix}`);
}
