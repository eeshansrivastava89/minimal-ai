// The job queue's SQLite store — the ONLY thing SQLite owns in the hub
// (plan: files remain the source of truth for durable artifacts). One
// `jobs` table, WAL mode. Boot recovery lives here: any row still marked
// `running` at open time belongs to a dead process — flip it to
// `interrupted`; jobs are never auto-resumed.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "../../config.mjs";

export type JobType =
  | "download"
  | "setup"
  | "start"
  | "benchmark"
  | "capture"
  | "score"
  | "comparison-video"
  | "export"
  | "autotune";
export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface Job {
  id: string;
  type: JobType;
  ref: string | null; // ModelRef of the parent model, when the job has one (spine)
  title: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  progress: number; // 0–100, or -1 = indeterminate (spinner, not a bar)
  message: string | null;
  logPath: string | null;
  metrics: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// What the API exposes — logPath stays internal (log content is streamed).
// Payload rides along so clients can map a job to its target (run slot,
// model) for live status; payloads are ids/flags only, never secrets.
export interface JobDto {
  id: string;
  type: JobType;
  ref: string | null;
  title: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  progress: number | null; // null = indeterminate — no fake bars
  message: string | null;
  error: string | null;
  metrics: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function toJobDto(job: Job): JobDto {
  const { logPath: _logPath, progress, ...dto } = job;
  return { ...dto, progress: progress < 0 ? null : progress };
}

export const JOBS_DIR = join(DATA_DIR, "hub");
export const JOBS_LOG_DIR = join(JOBS_DIR, "logs");
export const JOBS_DB_PATH = join(JOBS_DIR, "jobs.db");

export function newJobId(type: string): string {
  return `${type}-${randomUUID().slice(0, 8)}`;
}

interface Row {
  id: string;
  type: string;
  ref: string | null;
  title: string;
  payload: string;
  status: string;
  progress: number;
  message: string | null;
  log_path: string | null;
  metrics: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function rowToJob(r: Row): Job {
  return {
    id: r.id,
    type: r.type as JobType,
    ref: r.ref,
    title: r.title,
    payload: JSON.parse(r.payload),
    status: r.status as JobStatus,
    progress: r.progress,
    message: r.message,
    logPath: r.log_path,
    metrics: r.metrics ? JSON.parse(r.metrics) : null,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

const SQL_COLUMNS =
  "id, type, ref, title, payload, status, progress, message, log_path, metrics, error, created_at, started_at, finished_at";

export class JobStore {
  private db: DatabaseSync;

  constructor(dbPath: string = JOBS_DB_PATH, logDir: string = JOBS_LOG_DIR) {
    mkdirSync(logDir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        ref TEXT,
        title TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        progress INTEGER NOT NULL DEFAULT 0,
        message TEXT,
        log_path TEXT,
        metrics TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      )
    `);
    // Boot recovery: the child of any `running` row from a previous hub
    // process is gone. One honest state beats a resume engine.
    this.db
      .prepare(
        "UPDATE jobs SET status = 'interrupted', finished_at = ?, message = 'hub restarted — job not resumed' WHERE status = 'running'"
      )
      .run(new Date().toISOString());
  }

  insert(job: Omit<Job, "logPath" | "metrics" | "error" | "startedAt" | "finishedAt" | "progress" | "message" | "status"> &
    Partial<Pick<Job, "status" | "progress" | "message">>): Job {
    const full: Job = {
      status: "queued",
      progress: 0,
      message: null,
      logPath: null,
      metrics: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      ...job,
    };
    this.db
      .prepare(
        `INSERT INTO jobs (${SQL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        full.id,
        full.type,
        full.ref,
        full.title,
        JSON.stringify(full.payload),
        full.status,
        full.progress,
        full.message,
        full.logPath,
        null,
        full.error,
        full.createdAt,
        full.startedAt,
        full.finishedAt
      );
    return full;
  }

  get(id: string): Job | null {
    const r = this.db.prepare(`SELECT ${SQL_COLUMNS} FROM jobs WHERE id = ?`).get(id) as unknown as Row | undefined;
    return r ? rowToJob(r) : null;
  }

  list(): Job[] {
    // Bounded: the Jobs page is a live queue view, not an audit log (logs
    // persist on disk). Unbounded growth made every SSE tick serialize the
    // entire job history.
    const rows = this.db
      .prepare(
        `SELECT ${SQL_COLUMNS} FROM jobs ORDER BY created_at DESC, id DESC LIMIT 200`
      )
      .all() as unknown as Row[];
    return rows.map(rowToJob);
  }

  /** All queued jobs in FIFO order — the runner's pump source. Unbounded on
   *  purpose: a queued job must never fall outside the window `list()` caps. */
  queued(): Job[] {
    const rows = this.db
      .prepare(`SELECT ${SQL_COLUMNS} FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC`)
      .all() as unknown as Row[];
    return rows.map(rowToJob);
  }

  update(
    id: string,
    patch: Partial<Pick<Job, "status" | "progress" | "message" | "metrics" | "error" | "startedAt" | "finishedAt" | "logPath">>
  ): Job | null {
    const current = this.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        "UPDATE jobs SET status = ?, progress = ?, message = ?, metrics = ?, error = ?, started_at = ?, finished_at = ?, log_path = ? WHERE id = ?"
      )
      .run(
        next.status,
        next.progress,
        next.message,
        next.metrics === null ? null : JSON.stringify(next.metrics),
        next.error,
        next.startedAt,
        next.finishedAt,
        next.logPath,
        id
      );
    return next;
  }
}