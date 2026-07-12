import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

export type ProjectStatus = "idle" | "running" | "failed";

export interface Project {
  id: string;
  userId: string;
  name: string;
  status: ProjectStatus;
  updatedAt: string;
}

export interface KitchenSinkStore {
  listProjects(userId: string): Project[];
  getProject(id: string, userId: string): Project | undefined;
  createProject(project: Project): Project;
  updateProject(id: string, userId: string, changes: {
    name?: string;
    status?: ProjectStatus;
    updatedAt: string;
  }): Project | undefined;
  countProjects(): number;
  ensureSeedProjects(userId: string): void;
}

type Row = Record<string, unknown>;
const SCHEMA_VERSION = 1;

function nowIso(): string {
  return new Date().toISOString();
}

function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Kitchen Sink database returned a non-text value");
  }
  return value;
}

function projectStatus(value: unknown): ProjectStatus {
  if (value === "idle" || value === "running" || value === "failed") {
    return value;
  }
  throw new Error("Kitchen Sink database returned an invalid project status");
}

function schemaVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as Row | null;
  const version = Number(row?.["user_version"] ?? 0);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`Kitchen Sink database has an invalid schema version: ${String(row?.["user_version"])}`);
  }
  return version;
}

function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kitchen_sink_projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
      updated_at TEXT NOT NULL,
      UNIQUE (id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_kitchen_sink_projects_user
      ON kitchen_sink_projects (user_id);

    CREATE TABLE IF NOT EXISTS kitchen_sink_seed_state (
      user_id TEXT PRIMARY KEY,
      seed_version INTEGER NOT NULL
    );
  `);
}

function initializeDatabase(db: Database): void {
  const migrate = db.transaction(() => {
    const currentVersion = schemaVersion(db);
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(`Kitchen Sink database schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}`);
    }
    if (currentVersion < 1) {
      createSchema(db);
      db.exec("PRAGMA user_version = 1;");
    }
  });
  migrate();
}

function mapProject(row: Row): Project {
  return {
    id: text(row["id"]),
    userId: text(row["user_id"]),
    name: text(row["name"]),
    status: projectStatus(row["status"]),
    updatedAt: text(row["updated_at"]),
  };
}

export function createKitchenSinkStore(options: { dataDir?: string } = {}): KitchenSinkStore {
  const dataDir = options.dataDir ?? "./data";
  const dbPath = join(dataDir, "kitchen-sink.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  initializeDatabase(db);

  function listProjects(userId: string): Project[] {
    return (db.query(`
      SELECT id, user_id, name, status, updated_at
      FROM kitchen_sink_projects
      WHERE user_id = ?
      ORDER BY rowid DESC
    `).all(userId) as Row[]).map(mapProject);
  }

  function getProject(id: string, userId: string): Project | undefined {
    const row = db.query(`
      SELECT id, user_id, name, status, updated_at
      FROM kitchen_sink_projects
      WHERE id = ? AND user_id = ?
    `).get(id, userId) as Row | null;
    return row ? mapProject(row) : undefined;
  }

  function createProject(project: Project): Project {
    db.query(`
      INSERT INTO kitchen_sink_projects (id, user_id, name, status, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(project.id, project.userId, project.name, project.status, project.updatedAt);
    const created = getProject(project.id, project.userId);
    if (!created) {
      throw new Error("Created Kitchen Sink project could not be reloaded");
    }
    return created;
  }

  function updateProject(
    id: string,
    userId: string,
    changes: {
      name?: string;
      status?: ProjectStatus;
      updatedAt: string;
    },
  ): Project | undefined {
    const result = db.query(`
      UPDATE kitchen_sink_projects
      SET name = COALESCE(?, name),
          status = COALESCE(?, status),
          updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      changes.name ?? null,
      changes.status ?? null,
      changes.updatedAt,
      id,
      userId,
    );
    return result.changes > 0 ? getProject(id, userId) : undefined;
  }

  function countProjects(): number {
    const row = db.query("SELECT COUNT(*) AS count FROM kitchen_sink_projects").get() as Row | null;
    return Number(row?.["count"] ?? 0);
  }

  function ensureSeedProjects(userId: string): void {
    const seed = db.transaction(() => {
      const seeded = db.query("SELECT user_id FROM kitchen_sink_seed_state WHERE user_id = ?").get(userId) as Row | null;
      if (seeded) {
        return;
      }

      const existingProject = db.query("SELECT id FROM kitchen_sink_projects WHERE user_id = ? LIMIT 1").get(userId);
      db.query("INSERT INTO kitchen_sink_seed_state (user_id, seed_version) VALUES (?, 1)").run(userId);
      if (existingProject) {
        return;
      }

      const seededAt = nowIso();
      const projects = [
        { id: `${userId}:seed:project:beta`, name: "Beta", status: "idle" },
        { id: `${userId}:seed:project:alpha`, name: "Alpha", status: "running" },
      ] as const;
      for (const project of projects) {
        db.query(`
          INSERT OR IGNORE INTO kitchen_sink_projects
            (id, user_id, name, status, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(project.id, userId, project.name, project.status, seededAt);
      }
    });
    seed();
  }

  return {
    listProjects,
    getProject,
    createProject,
    updateProject,
    countProjects,
    ensureSeedProjects,
  };
}
