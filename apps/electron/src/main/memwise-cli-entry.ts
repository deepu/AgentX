/**
 * Entry of the bundled `memwise` CLI (dist/memwise-cli.mjs), which the kernel's TestRunner runs
 * with Electron as Node to check a draft's example cases out of process (docs/memwise/20 §5):
 * DBOS is process-wide, so the app's own kernel can't host the throwaway ones. Built by
 * scripts/electron-build-main.ts; found through MEMWISE_CLI_JS (main/memwise-kernel.ts).
 */
import { main } from '../../../../packages/runtime/src/cli'

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err))
    process.exit(1)
  },
)
