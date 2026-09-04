// The job runner — one typed queue over the SQLite store. Serial execution
// (one job at a time): every job touches the same GPU box, and a download
// hogging bandwidth mid-launch is worse than a short queue wait.
// ponytail: serial queue; add worker concurrency only if waits hurt.
//
// Child-process ownership is the read-back: jobs that spawn (download,
// launch) register the child here; cancel aborts the executor's signal AND
// kills the child (SIGTERM → SIGKILL after grace). "Is it running?" is the
// row status — never a heuristic.

import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { type Job, JobStore, type JobType, JOBS_LOG_DIR, newJobId, toJobDto, type JobDto } from "./store.ts";

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export interface JobContext {
  job: Job;
  signal: AbortSignal;
  /** Append a line to the job log (timestamped) and notify log subscribers. */
  log(line: string): void;
  progress(pct: number, message?: string): void;
  /** Spawn a child owned by the runner — cancelled with the job. */
  spawnOwned(cmd: string, argv: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<SpawnResult>;
  /** Enqueue a follow-up job (benchmark chaining: launch → capture/score). */
  enqueue(input: EnqueueInput): Promise<Job>;
  /** Publish partial metrics mid-run (live sweep matrix rides the jobs SSE). */
  setMetrics(metrics: Record<string, unknown>): void;
}

export type Executor = (ctx: JobContext) => Promise<Record<string, unknown> | void>;

export interface EnqueueInput {
  type: JobType;
  ref?: string | null;
  title: string;
  payload?: Record<string, unknown>;
}

type JobsListener = (jobs: JobDto[]) => void;
type LogListener = (line: string) => void;

export class JobRunner {
  private store: JobStore;
  private logDir: string;
  private executors: Record<string, Executor>;
  private running: string | null = null;
  private controllers = new Map<string, AbortController>();
  private children = new Map<string, ChildProcess>();
  private jobsListeners = new Set<JobsListener>();
  private logListeners = new Map<string, Set<LogListener>>();

  constructor(opts: { store?: JobStore; logDir?: string; executors?: Record<string, Executor> } = {}) {
    this.store = opts.store ?? new JobStore();
    this.logDir = opts.logDir ?? JOBS_LOG_DIR;
    this.executors = opts.executors ?? {};
  }

  registerExecutor(type: string, executor: Executor) {
    this.executors[type] = executor;
  }

  store_(): JobStore {
    return this.store;
  }

  async enqueue(input: EnqueueInput): Promise<Job> {
    const job = this.store.insert({
      id: newJobId(input.type),
      type: input.type,
      ref: input.ref ?? null,
      title: input.title,
      payload: input.payload ?? {},
      createdAt: new Date().toISOString(),
    });
    this.emitJobs();
    this.pump();
    return job;
  }

  get(id: string): Job | null {
    return this.store.get(id);
  }

  list(): JobDto[] {
    return this.store.list().map(toJobDto);
  }

  /** Cancel a queued or running job. Returns false when the job can't be
   *  cancelled (already finished / unknown). */
  cancel(id: string): boolean {
    const job = this.store.get(id);
    if (!job || (job.status !== "queued" && job.status !== "running")) return false;
    if (job.status === "queued") {
      this.store.update(id, {
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        message: "cancelled before start",
      });
      this.emitJobs();
      return true;
    }
    // Running: abort the executor and kill its child; run() records the
    // final state when the executor unwinds.
    this.controllers.get(id)?.abort();
    const child = this.children.get(id);
    if (child?.pid) {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 3000).unref?.();
    }
    return true;
  }

  /** Restart: a fresh job with the same type/ref/payload — history kept. */
  async restart(id: string): Promise<Job | null> {
    const job = this.store.get(id);
    if (!job) return null;
    return this.enqueue({ type: job.type, ref: job.ref, title: job.title, payload: job.payload });
  }

  async readLog(id: string): Promise<string | null> {
    const job = this.store.get(id);
    if (!job?.logPath) return null;
    return readFile(job.logPath, "utf8").catch(() => null);
  }

  /** Jobs-list change notifications (SSE backing). Returns unsubscribe. */
  onJobs(listener: JobsListener): () => void {
    this.jobsListeners.add(listener);
    return () => this.jobsListeners.delete(listener);
  }

  /** Live log tail for one job. Sends the existing log first, then lines
   *  as they are written. Returns unsubscribe. */
  async onLog(id: string, listener: LogListener): Promise<() => void> {
    let set = this.logListeners.get(id);
    if (!set) {
      set = new Set();
      this.logListeners.set(id, set);
    }
    set.add(listener);
    const existing = await this.readLog(id);
    if (existing) for (const line of existing.split("\n")) listener(line);
    return () => {
      set?.delete(listener);
    };
  }

  private emitJobs() {
    const snapshot = this.list();
    for (const l of this.jobsListeners) l(snapshot);
  }

  private logPathFor(id: string): string {
    return join(this.logDir, `${id}.log`);
  }

  /** Run queued jobs serially until the queue is empty. */
  private pump() {
    if (this.running) return;
    const next = this.store
      .list()
      .filter((j) => j.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return;
    this.running = next.id;
    this.run(next.id)
      .catch((err) => console.error("[hub:jobs]", err))
      .finally(() => {
        this.running = null;
        this.pump();
      });
  }

  private async run(id: string) {
    const executor = this.executors[String(this.store.get(id)?.type)];
    const logPath = this.logPathFor(id);
    await mkdir(this.logDir, { recursive: true });
    this.store.update(id, {
      status: "running",
      startedAt: new Date().toISOString(),
      logPath,
      progress: 0,
      message: null,
    });
    this.emitJobs();

    const controller = new AbortController();
    this.controllers.set(id, controller);
    const startedMs = Date.now();
    const notify = (line: string) => {
      const set = this.logListeners.get(id);
      if (set) for (const l of set) l(line);
    };
    const ctx: JobContext = {
      job: this.store.get(id)!,
      signal: controller.signal,
      enqueue: (input) => this.enqueue(input),
      setMetrics: (metrics) => {
        this.store.update(id, { metrics });
        this.emitJobs();
      },
      log: (line) => {
        void appendFile(logPath, `${line}\n`).catch(() => {});
        notify(line);
      },
      progress: (pct, message) => {
        this.store.update(id, { progress: Math.max(0, Math.min(100, Math.round(pct))), message: message ?? null });
        this.emitJobs();
      },
      spawnOwned: (cmd, argv, opts) =>
        new Promise<SpawnResult>((resolve, reject) => {
          const t0 = Date.now();
          const child = spawn(cmd, argv, {
            cwd: opts?.cwd,
            env: opts?.env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          this.children.set(id, child);
          const done = (code: number | null, signal: NodeJS.Signals | null) => {
            this.children.delete(id);
            resolve({ code, signal, durationMs: Date.now() - t0 });
          };
          child.on("error", (err) => {
            this.children.delete(id);
            reject(err);
          });
          child.on("exit", done);
          const pipe = (stream: NodeJS.ReadableStream | null, prefix: string) => {
            if (!stream) return;
            let buf = "";
            stream.on("data", (chunk: Buffer) => {
              buf += chunk.toString("utf8");
              const lines = buf.split("\n");
              buf = lines.pop() ?? "";
              for (const line of lines) if (line.trim()) ctx.log(prefix ? `${prefix} ${line}` : line);
            });
          };
          pipe(child.stdout, "");
          pipe(child.stderr, "");
        }),
    };

    try {
      if (!executor) throw new Error(`no executor registered for job type "${ctx.job.type}"`);
      if (controller.signal.aborted) throw new CancelledError();
      const metrics = (await executor(ctx)) ?? undefined;
      if (controller.signal.aborted) throw new CancelledError();
      this.store.update(id, {
        status: "completed",
        progress: 100,
        metrics: metrics ?? null,
        finishedAt: new Date().toISOString(),
        message: metrics && typeof metrics.message === "string" ? metrics.message : null,
      });
    } catch (err) {
      const cancelled = controller.signal.aborted || err instanceof CancelledError;
      this.store.update(id, {
        status: cancelled ? "cancelled" : "failed",
        error: cancelled ? null : String((err as Error)?.message ?? err),
        finishedAt: new Date().toISOString(),
      });
    } finally {
      this.controllers.delete(id);
      this.children.delete(id);
      this.emitJobs();
      const elapsed = Math.round((Date.now() - startedMs) / 100) / 10;
      ctx.log(`[hub] job ${this.store.get(id)?.status} after ${elapsed}s`);
    }
  }
}