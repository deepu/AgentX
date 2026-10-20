# Spike S3 · Bundled Postgres on desktop: result

**Verdict: PARTIAL.** Linux is measured and passes every criterion: start-up, size, upgrades, crash recovery, Node and Bun. macOS and Windows are wired into CI (`.github/workflows/spike-s3-postgres.yml`) and still need a green run before S3 can be called PASS.

**Recommendation:** ship real Postgres 18 on desktop, using the per-platform binary packages from `embedded-postgres` (`@embedded-postgres/<platform>`). Drive them with our own small supervisor (`lib/cluster.mjs`), not with the package's wrapper class. Keep PGlite only as a fallback. PGlite runs the same schema, but it is a single session shared by every caller. Its start-up is 3 to 25 times slower and it uses about 20 times more memory.

Spike: S3 in [17-build-plan](../../docs/memwise/17-build-plan.md). Measured on 2026-10-20 in the Linux sandbox (4 vCPU, 16 GB, Linux 6.18, Node 22.22.0, Bun 1.4.2; CI uses Bun 1.3.10). Packages: `@embedded-postgres/*@18.4.0-beta.17` (PostgreSQL 18.4) and `@electric-sql/pglite@0.5.10` (PostgreSQL 18.6).

## Measurements (Linux x64)

### Bundled Postgres (embedded-postgres binaries)

Each cell shows the Node run first, then the Bun run. A second Node run gave the same numbers to within ±10%.

| Metric | Node 22 | Bun 1.4 | Notes |
|---|---|---|---|
| Cold init (`initdb`) | 856 ms | 879 ms | Done once, on first launch. System PG16 `initdb` here: 819 ms |
| First start (`pg_ctl start -w`) | 137 ms | 137 ms | pg_ctl polls readiness every 100 ms, so the true figure is lower |
| Connect + first query | 27 ms | 41 ms | node-postgres, scram-sha-256 over 127.0.0.1 |
| Warm start ×3 | 146 / 138 / 137 ms | 131 / 138 / 138 ms | |
| Stop (`pg_ctl stop -m fast`) ×3 | 126 / 128 / 127 ms | 124 / 125 / 124 ms | |
| Start after hard kill (crash recovery) | 236 ms | 237 ms | Committed data intact: yes |
| Relaunch while the server is still running | adopted | adopted | `pg_ctl status`, then reuse it |
| Memory, idle (no clients) | 23.7 MB PSS (72 MB RSS), 9 procs | 23.8 MB PSS (76 MB RSS) | Default `shared_buffers` 128MB, mostly untouched |
| Memory, 10 open connections | 39.0 MB PSS (211 MB RSS), 19 procs | 39.0 MB PSS (215 MB RSS) | RSS counts shared memory once per process; PSS is the honest figure |
| Data dir after init / after tests | 38.6 / 38.9 MiB | same | Mostly WAL (16 MB segment) and catalogs |
| Installed size, linux-x64 | 56.5 MiB, 1,029 files | | |
| Schema checks (see below) | 8/8 pass | 8/8 pass | |
| Minor upgrade 18.1 → 18.4 | data intact, start 136 ms | same | Different binary directory, so this also covers the app moving on update |
| Major mismatch (18 binaries, 17 data dir) | refused: `database files are incompatible with server` | same | Data dir left untouched |
| Major upgrade 17.10 → 18.4 (side-by-side copy) | data intact, 85 ms | 105 ms | Toy data; see the upgrade section |

### PGlite (same schema)

| Metric | Node 22 | Bun 1.4 | Notes |
|---|---|---|---|
| Package size | 33.8 MiB (35.4 MB npm unpacked), 10.2 MB tarball | | One package for every platform (WASM) |
| Import | 48 ms | 104 ms | |
| Cold init (new data dir) | 3.5 s (4.8 s and 7.4 s in other runs) | 3.4 s | Runs initdb inside WASM |
| Warm open ×3 | 601 / 424 / 416 ms | 584 / 490 / 533 ms | 3 to 4 times slower than a real Postgres start |
| Close | 6 ms | 6 ms | |
| Process RSS: baseline / after open / after checks | 55 / 533 / 542 MB | 31 / 1,022 / 1,036 MB | In-process, defaults (`shared_buffers` 128MB, WASM heap). Not tuned |
| Data dir | 38.3 MiB | same | |
| Schema checks | 8/8 pass | 8/8 pass | |
| A query while another caller holds a transaction | waits for it (330 ms in the test) | same | Everything is serialised |
| `pglite-socket`, 2 wire connections | connect ok | ok | `maxConnections: 10` |
| Session state shared between connections | **yes** | **yes** | `set_config` on connection A is visible on connection B |
| Connection B while A has an open transaction | **blocked** (3 s timeout) | blocked | B's statements queue behind A's whole transaction |

### Schema checks (identical SQL on both: `lib/schema.mjs`)

All of these pass on both engines:

- `pgcrypto` and `pg_trgm` extensions
- `digest()` and `gen_random_uuid()`
- a BEFORE UPDATE trigger
- RLS driven by a session setting (`memwise.workspace`, with FORCE RLS and a `memwise_app` role): reads are filtered and a cross-workspace insert is rejected
- jsonb `@>` and path queries
- trigram fuzzy search
- full-text search with non-ASCII text
- LISTEN/NOTIFY from a trigger (on a second connection for Postgres, `db.listen` for PGlite)

### Package size per platform (npm registry, `18.4.0-beta.17`)

| Package | Unpacked | Tarball | What's inside |
|---|---|---|---|
| `@embedded-postgres/darwin-arm64` | 147.7 MB, 1,027 files | 55.2 MB | **Universal** (x86_64 + arm64) Mach-O. Identical to darwin-x64. `lipo -thin` would roughly halve it (estimate, not tested) |
| `@embedded-postgres/darwin-x64` | 147.7 MB | 55.2 MB | Same universal build |
| `@embedded-postgres/windows-x64` | 109.3 MB, 1,502 files | 40.6 MB | Includes 14 MB of wxWidgets DLLs (pgAdmin leftovers) and 23.5 MB of message translations. Pruned estimate: about 72 MB |
| `@embedded-postgres/linux-x64` | 59.2 MB, 1,029 files | 23.7 MB | 26 MB of that is ICU data. Needs glibc 2.27+; libs found via `$ORIGIN` |
| `@electric-sql/pglite` | 35.4 MB, 308 files | 10.2 MB | All platforms |

The app already ships the roughly 210 MB `claude` binary per platform, so adding 60 to 150 MB (25 to 55 MB compressed) is noticeable but not dominant.

Every Postgres package contains only `initdb`, `pg_ctl` and `postgres`, plus libraries, share files and the contrib extensions. There is **no `psql`, `pg_dump`, `pg_restore` or `pg_upgrade`**, and no `pgvector`.

## Findings

1. **Start-up is fast enough.** First launch takes about 1 s (initdb plus start). Every later launch takes about 140 ms to start and about 30 ms to the first query. Stop takes about 125 ms. These match the system's own Postgres 16.
2. **Node and Bun behave the same.** The supervisor is only `child_process` plus `pg`, so the Electron main process (Node) or the Bun host can own it.
3. **The data dir survives app upgrades.** It lives in `~/.memwise/…`, outside the app bundle, and records no binary path. The binaries are relocatable (`$ORIGIN` / `@loader_path`), and a different minor version opened the old dir with no extra step. A server orphaned by an app crash is adopted on relaunch. A hard kill recovers in about 240 ms with committed data intact.
4. **Major versions need a migration step.** New binaries refuse an old data dir cleanly, and nothing is damaged. `pg_upgrade` and `pg_dump` aren't shipped, so the tested path is: run old and new side by side, apply our migrations to the new cluster, then copy the rows (about 10 lines in `measure.mjs`).
5. **Locale independent of the OS.** `initdb --locale-provider=builtin --builtin-locale=C.UTF-8 --locale=C` (PG 17+) works. Collation then never depends on glibc, ICU or Windows locale versions, so an OS update can't silently corrupt indexes. Upper-casing and full-text search on non-ASCII text still work.
6. **Extensions.** `pgcrypto` and `pg_trgm` work on both engines (the zonky builds ship all of contrib). For `pgvector`:
   - **PGlite:** has it as `@electric-sql/pglite-pgvector` (67 kB).
   - **Bundled Postgres:** the zonky builds have no headers, so we'd compile pgvector per platform against the matching PG 18 source, ship `vector.{so,dylib,dll}` plus its control and SQL files, and sign them on macOS.
7. **The `embedded-postgres` wrapper class isn't fit for the desktop app** (from reading its code; it wasn't run).
   - It spawns `postgres` directly. On Windows that refuses to run as an administrator; pg_ctl avoids this with a restricted token.
   - On Windows, `stop()` is `taskkill /f /t`: a hard kill, so every start would run crash recovery.
   - It detects readiness by matching an English log line.
   - It kills the server from an exit hook.

   We use only the binary packages and about 150 lines of our own (`lib/cluster.mjs`).
8. **PGlite's limits are structural.** It is one Postgres backend in-process.
   - Over `pglite-socket`, every client shares one session: a `SET`/`set_config` on one connection leaks to the others. That breaks the plan of passing the RLS workspace or step token through a session setting.
   - One open transaction blocks all other clients.
   - DBOS expects a real pool and a dedicated LISTEN connection.
   - Cold start is 3.5 to 7 s, warm start about 0.5 s.
   - Memory is 0.5 to 1 GB RSS untuned.
   - The data dir is tied to PGlite's own PG build, so upgrades are dump and restore through `@electric-sql/pglite-tools`.

   It would work for one process with serialised access, which doesn't fit the host plus workers plus DBOS shape.
9. **Packaging notes.**
   - The platform packages hydrate their `.so` symlinks in a postinstall script. Bun skips dependency postinstall scripts unless they are in `trustedDependencies`. `lib/binaries.mjs` recreates the links itself either way.
   - Ship the binaries the way the Claude SDK binary is shipped today: copy `node_modules/@embedded-postgres/<platform>/native` with `extraResources` into each per-platform artifact, and exclude the others.

## macOS code signing and notarisation (from documentation, not tested)

- Notarisation needs **every** Mach-O file in the app signed with our Developer ID, the hardened runtime and a secure timestamp. That covers `postgres`, `initdb`, `pg_ctl`, about 20 dylibs in `lib/` and about 90 extension `.dylib`s in `lib/postgresql/`. electron-builder (`@electron/osx-sign`) walks the bundle and signs nested binaries, including `extraResources`. The app already does this for the bundled `bun` and `uv`.
- With hardened runtime, `dlopen` of extension libraries requires the same Team ID (which re-signing everything gives us) or `com.apple.security.cs.disable-library-validation`. `build/entitlements.mac.plist`, which is also `entitlementsInherit`, already grants the latter.
- No JIT entitlement is needed for Postgres: the builds have no `llvmjit`.
- The packages ship universal binaries. Per-arch DMGs should `lipo -thin` them before signing to save about 70 MB.
- Files fetched by npm carry no quarantine attribute. In the shipped app they're covered by the app's notarisation ticket. Don't download Postgres binaries at runtime: they would be quarantined and unsigned.
- **Windows:** the binaries are unsigned. Sign `postgres.exe`, `pg_ctl.exe` and `initdb.exe` with the app's certificate to reduce Defender/SmartScreen friction. Listening only on 127.0.0.1 doesn't trigger the Windows Firewall prompt.

## Recommendation for MemWise

1. **Desktop uses a real Postgres 18 from `@embedded-postgres/<platform>`, with exact versions pinned.**
   - Bundle `native/` per platform, pruning the Windows wx DLLs and translations and thinning macOS to one arch.
   - Keep the data in `~/.memwise/postgres/data`.
   - Start it from the host with a supervisor like `lib/cluster.mjs`:
     - `initdb` with the builtin locale and scram auth, the secret stored with mode 0600;
     - `pg_ctl start -w`, adopting a server that is already running, then a connect-and-`SELECT 1` loop before reporting ready (on Windows `pg_ctl -w` can return early after a crash; see Caveats);
     - `pg_ctl stop -m fast` on quit;
     - loopback only, on a port chosen at first init and saved in `postgresql.auto.conf`. On macOS and Linux, prefer a Unix socket in `~/.memwise/postgres/run`.
2. **Minor updates:** just ship new binaries. The data dir is compatible; tested 18.1 → 18.4.
3. **Major updates (rare: PG 18 is supported to Nov 2030):**
   - One transition release ships the previous major's `postgres`/`pg_ctl`/`initdb` as well (+60 to 75 MB once).
   - On first launch it: starts the old cluster on a spare port; `initdb`s the new one; runs our migrations on it; copies every table in dependency order (`COPY … TO STDOUT` into `COPY … FROM STDIN`, with `session_replication_role = replica`, then resets the sequences). DBOS's system schema is copied too.
   - It renames the old dir to `data.pg17.bak` and deletes it after a successful launch.
   - Alternative: build our own binaries with `pg_upgrade --link` (minutes become seconds for large data dirs), at the cost of owning a cross-platform Postgres build.
4. **Supply chain:** the npm packages are maintained by one person, use repackaged zonky "test" builds, and are labelled `beta` forever.
   - Pin the versions and record checksums.
   - Plan to mirror or rebuild in our own CI if the upstream stalls; the same CI would build pgvector.
5. **PGlite stays the documented fallback** for a platform where the bundled server fails (for example a locked-down Windows). It isn't the default because of its single session, serialised transactions, slower start and higher memory.

## Exact commands

```bash
cd spikes/s3-bundled-postgres
npm ci                                   # npm, not bun: this is outside the Bun workspaces
node measure.mjs                         # Node run; prints the tables, writes results/results-<platform>-node.json
SKIP_REGISTRY=1 bun measure.mjs          # Bun run
```

In this sandbox the shell is root, and Postgres refuses to run as root, so the runs used a normal user:

```bash
runuser -u ubuntu -- env HOME=/home/ubuntu PATH=/home/ubuntu/bin:$PATH \
  RESULTS_DIR=/home/ubuntu/s3-results SKIP_REGISTRY=1 node measure.mjs
runuser -u ubuntu -- env HOME=/home/ubuntu PATH=/home/ubuntu/bin:$PATH \
  RESULTS_DIR=/home/ubuntu/s3-results SKIP_REGISTRY=1 bun measure.mjs   # bun copied to /home/ubuntu/bin
npm view @embedded-postgres/<darwin-arm64|darwin-x64|windows-x64|linux-x64>@18.4.0-beta.17 dist.unpackedSize dist.fileCount
```

- **Ports:** 54323 (current cluster), 54326 (old major during the copy), 54327 (pglite-socket).
- **Data:** goes under `$MEMWISE_HOME/spike-s3` (default `~/.memwise/spike-s3`) and is wiped at the start of each run.
- **CI:** `.github/workflows/spike-s3-postgres.yml` runs both runtimes on ubuntu-latest, macos-latest and windows-latest. The tables go to the job summary and the JSON is uploaded as an artifact.

## Files

| Path | Contents |
|---|---|
| `lib/binaries.mjs` | Finds the platform package and rehydrates library symlinks |
| `lib/cluster.mjs` | The supervisor: init, start, adopt, stop, hard kill, memory |
| `lib/schema.mjs` | Shared schema and feature checks |
| `measure.mjs` | Orchestration and report |
| `pglite-probe.mjs` | PGlite, run in a child process for clean memory numbers |

Older builds come in as npm aliases in `optionalDependencies` (`pg-18-1-*` and `pg-17-*`), so the upgrade tests need no download code.

## Caveats

- **Only Linux measured.** macOS and Windows numbers wait on the CI run. The Windows-specific paths are untested: restricted token under an admin runner, `taskkill` hard kill, PowerShell memory probe, PGlite with backslash paths. So is macOS shared memory.
- **`pg_ctl -w` is not a readiness check on Windows.** pg_ctl there can't match the postmaster's PID, so it accepts any `postmaster.pid` marked ready whose start time is within 2 s of its own. After a hard kill, the dead server's pid file passes and pg_ctl returns before the new server listens. The first Windows CI run hit this as `ECONNREFUSED` straight after the crash restart; `LocalPostgres.start()` now also waits for a real connection.
- **Measured in a sandbox VM.** Desktop disks, antivirus (Windows Defender scanning the data dir) and cold file caches will make the first `initdb` slower.
- **Memory is untuned.** Neither engine was tuned; for desktop, Postgres could use `shared_buffers=32MB` and `max_connections=40`. On macOS and Windows the script reports summed RSS or working set, which overcounts shared memory.
- **The major-upgrade copy is a toy.** It moved one table of a few rows via `json_populate_recordset`. A real one has to copy every schema (including DBOS's) with COPY and reset sequences. It is quick, but the time grows with data size, so it needs a progress UI.
- **PGlite memory and start time** are with defaults. `initialMemory` and server settings could reduce memory; not explored.
- **Untested:** non-ASCII Windows usernames in the data dir path, and data dirs on synced folders (iCloud/OneDrive). Keep `~/.memwise` out of synced folders.
- **macOS signing** comes from documentation, not a signed build.
