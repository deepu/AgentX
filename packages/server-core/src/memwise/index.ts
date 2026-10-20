/**
 * MemWise kernel hosting (19 §9). `startMemwiseService` loads the kernel packages lazily, so
 * importing this module costs nothing until the service is started.
 */
export {
  getMemwiseService, getMemwiseHostStatus, onMemwiseChange, emitMemwiseChange, resetMemwiseHost,
  type MemwiseHostStatus, type MemwisePhase,
} from './host'
export type { MemwiseService, MemwiseServiceOptions, ClientIdentity, PersonActor, MemwiseLogger } from './service'
export type { ModelResolver, ResolvedModels } from './models'

/** Starts the service; resolves to null (and reports through the status) when it can't start. */
export async function startMemwiseService(
  opts: import('./service').MemwiseServiceOptions,
): Promise<import('./service').MemwiseService | null> {
  const { startMemwiseService: start } = await import('./service')
  return start(opts)
}

/** Stops the running service, if any (kernel shutdown, then the bundled database). */
export async function stopMemwiseService(): Promise<void> {
  const { getMemwiseService } = await import('./host')
  await getMemwiseService()?.stop()
}

/** Whether this process should host the kernel: on a server only when asked. */
export function memwiseKernelRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.MEMWISE_DATABASE_URL || env.MEMWISE_KERNEL === '1' || env.MEMWISE_KERNEL === 'true'
}
