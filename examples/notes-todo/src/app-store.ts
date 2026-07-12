import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

export interface Section {
  id: string;
  userId: string;
  title: string;
  parentId?: string;
}

export interface Note {
  id: string;
  userId: string;
  sectionId: string;
  title: string;
  body: string;
  updatedAt: string;
}

export type TodoPriority = "low" | "normal" | "high";

export interface Todo {
  id: string;
  userId: string;
  sectionId: string;
  title: string;
  completed: boolean;
  priority: TodoPriority;
  updatedAt: string;
}

export interface NotesTodoStore {
  listSections(userId: string): Section[];
  listNotes(userId: string): Note[];
  listTodos(userId: string): Todo[];
  getSection(id: string, userId: string): Section | undefined;
  getNote(id: string, userId: string): Note | undefined;
  getTodo(id: string, userId: string): Todo | undefined;
  createSection(section: Section): Section;
  createNote(note: Note): Note;
  createTodo(todo: Todo): Todo;
  updateNote(id: string, userId: string, changes: {
    title?: string;
    body?: string;
    sectionId?: string;
    updatedAt: string;
  }): Note | undefined;
  updateTodo(id: string, userId: string, changes: {
    title?: string;
    completed?: boolean;
    priority?: TodoPriority;
    sectionId?: string;
    updatedAt: string;
  }): Todo | undefined;
  deleteNote(id: string, userId: string): boolean;
  deleteTodo(id: string, userId: string): boolean;
  ensureSeedData(userId: string): void;
  ensureInbox(userId: string): Section;
}

type Row = Record<string, unknown>;
const SCHEMA_VERSION = 1;

function nowIso(): string {
  return new Date().toISOString();
}

function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Notes TODO database returned a non-text value");
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function todoPriority(value: unknown): TodoPriority {
  if (value === "low" || value === "normal" || value === "high") {
    return value;
  }
  throw new Error("Notes TODO database returned an invalid todo priority");
}

function completed(value: unknown): boolean {
  const numeric = Number(value);
  if (numeric !== 0 && numeric !== 1) {
    throw new Error("Notes TODO database returned an invalid todo completion value");
  }
  return numeric === 1;
}

function schemaVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as Row | null;
  const version = Number(row?.["user_version"] ?? 0);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`Notes TODO database has an invalid schema version: ${String(row?.["user_version"])}`);
  }
  return version;
}

function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes_todo_sections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      parent_id TEXT,
      UNIQUE (id, user_id),
      FOREIGN KEY (parent_id, user_id)
        REFERENCES notes_todo_sections (id, user_id)
        ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_notes_todo_sections_user
      ON notes_todo_sections (user_id);

    CREATE TABLE IF NOT EXISTS notes_todo_notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (section_id, user_id)
        REFERENCES notes_todo_sections (id, user_id)
        ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_notes_todo_notes_user
      ON notes_todo_notes (user_id);
    CREATE INDEX IF NOT EXISTS idx_notes_todo_notes_section
      ON notes_todo_notes (user_id, section_id);

    CREATE TABLE IF NOT EXISTS notes_todo_todos (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      title TEXT NOT NULL,
      completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
      priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
      updated_at TEXT NOT NULL,
      FOREIGN KEY (section_id, user_id)
        REFERENCES notes_todo_sections (id, user_id)
        ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_notes_todo_todos_user
      ON notes_todo_todos (user_id);
    CREATE INDEX IF NOT EXISTS idx_notes_todo_todos_section
      ON notes_todo_todos (user_id, section_id);

    CREATE TABLE IF NOT EXISTS notes_todo_seed_state (
      user_id TEXT PRIMARY KEY,
      seed_version INTEGER NOT NULL
    );
  `);
}

function initializeDatabase(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON;");
  const migrate = db.transaction(() => {
    const currentVersion = schemaVersion(db);
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(`Notes TODO database schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}`);
    }
    if (currentVersion < 1) {
      createSchema(db);
      db.exec("PRAGMA user_version = 1;");
    }
  });
  migrate();
}

function mapSection(row: Row): Section {
  return {
    id: text(row["id"]),
    userId: text(row["user_id"]),
    title: text(row["title"]),
    ...(optionalText(row["parent_id"]) ? { parentId: optionalText(row["parent_id"]) } : {}),
  };
}

function mapNote(row: Row): Note {
  return {
    id: text(row["id"]),
    userId: text(row["user_id"]),
    sectionId: text(row["section_id"]),
    title: text(row["title"]),
    body: text(row["body"]),
    updatedAt: text(row["updated_at"]),
  };
}

function mapTodo(row: Row): Todo {
  return {
    id: text(row["id"]),
    userId: text(row["user_id"]),
    sectionId: text(row["section_id"]),
    title: text(row["title"]),
    completed: completed(row["completed"]),
    priority: todoPriority(row["priority"]),
    updatedAt: text(row["updated_at"]),
  };
}

export function createNotesTodoStore(options: { dataDir?: string } = {}): NotesTodoStore {
  const dataDir = options.dataDir ?? "./data";
  const dbPath = join(dataDir, "notes-todo.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  initializeDatabase(db);

  function listSections(userId: string): Section[] {
    return (db.query(`
      SELECT id, user_id, title, parent_id
      FROM notes_todo_sections
      WHERE user_id = ?
      ORDER BY rowid ASC
    `).all(userId) as Row[]).map(mapSection);
  }

  function listNotes(userId: string): Note[] {
    return (db.query(`
      SELECT id, user_id, section_id, title, body, updated_at
      FROM notes_todo_notes
      WHERE user_id = ?
      ORDER BY rowid DESC
    `).all(userId) as Row[]).map(mapNote);
  }

  function listTodos(userId: string): Todo[] {
    return (db.query(`
      SELECT id, user_id, section_id, title, completed, priority, updated_at
      FROM notes_todo_todos
      WHERE user_id = ?
      ORDER BY rowid DESC
    `).all(userId) as Row[]).map(mapTodo);
  }

  function getSection(id: string, userId: string): Section | undefined {
    const row = db.query(`
      SELECT id, user_id, title, parent_id
      FROM notes_todo_sections
      WHERE id = ? AND user_id = ?
    `).get(id, userId) as Row | null;
    return row ? mapSection(row) : undefined;
  }

  function getNote(id: string, userId: string): Note | undefined {
    const row = db.query(`
      SELECT id, user_id, section_id, title, body, updated_at
      FROM notes_todo_notes
      WHERE id = ? AND user_id = ?
    `).get(id, userId) as Row | null;
    return row ? mapNote(row) : undefined;
  }

  function getTodo(id: string, userId: string): Todo | undefined {
    const row = db.query(`
      SELECT id, user_id, section_id, title, completed, priority, updated_at
      FROM notes_todo_todos
      WHERE id = ? AND user_id = ?
    `).get(id, userId) as Row | null;
    return row ? mapTodo(row) : undefined;
  }

  function createSection(section: Section): Section {
    db.query(`
      INSERT INTO notes_todo_sections (id, user_id, title, parent_id)
      VALUES (?, ?, ?, ?)
    `).run(section.id, section.userId, section.title, section.parentId ?? null);
    const created = getSection(section.id, section.userId);
    if (!created) {
      throw new Error("Created Notes TODO section could not be reloaded");
    }
    return created;
  }

  function createNote(note: Note): Note {
    db.query(`
      INSERT INTO notes_todo_notes (id, user_id, section_id, title, body, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(note.id, note.userId, note.sectionId, note.title, note.body, note.updatedAt);
    const created = getNote(note.id, note.userId);
    if (!created) {
      throw new Error("Created Notes TODO note could not be reloaded");
    }
    return created;
  }

  function createTodo(todo: Todo): Todo {
    db.query(`
      INSERT INTO notes_todo_todos
        (id, user_id, section_id, title, completed, priority, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(todo.id, todo.userId, todo.sectionId, todo.title, todo.completed ? 1 : 0, todo.priority, todo.updatedAt);
    const created = getTodo(todo.id, todo.userId);
    if (!created) {
      throw new Error("Created Notes TODO todo could not be reloaded");
    }
    return created;
  }

  function updateNote(
    id: string,
    userId: string,
    changes: {
      title?: string;
      body?: string;
      sectionId?: string;
      updatedAt: string;
    },
  ): Note | undefined {
    const result = db.query(`
      UPDATE notes_todo_notes
      SET title = COALESCE(?, title),
          body = COALESCE(?, body),
          section_id = COALESCE(?, section_id),
          updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      changes.title ?? null,
      changes.body ?? null,
      changes.sectionId ?? null,
      changes.updatedAt,
      id,
      userId,
    );
    return result.changes > 0 ? getNote(id, userId) : undefined;
  }

  function updateTodo(
    id: string,
    userId: string,
    changes: {
      title?: string;
      completed?: boolean;
      priority?: TodoPriority;
      sectionId?: string;
      updatedAt: string;
    },
  ): Todo | undefined {
    const result = db.query(`
      UPDATE notes_todo_todos
      SET title = COALESCE(?, title),
          completed = COALESCE(?, completed),
          priority = COALESCE(?, priority),
          section_id = COALESCE(?, section_id),
          updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      changes.title ?? null,
      changes.completed === undefined ? null : changes.completed ? 1 : 0,
      changes.priority ?? null,
      changes.sectionId ?? null,
      changes.updatedAt,
      id,
      userId,
    );
    return result.changes > 0 ? getTodo(id, userId) : undefined;
  }

  function deleteNote(id: string, userId: string): boolean {
    return db.query("DELETE FROM notes_todo_notes WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  }

  function deleteTodo(id: string, userId: string): boolean {
    return db.query("DELETE FROM notes_todo_todos WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  }

  function ensureSeedData(userId: string): void {
    const seed = db.transaction(() => {
      const seeded = db.query("SELECT user_id FROM notes_todo_seed_state WHERE user_id = ?").get(userId) as Row | null;
      if (seeded) {
        return;
      }

      const existingSection = db.query("SELECT id FROM notes_todo_sections WHERE user_id = ? LIMIT 1").get(userId);
      db.query("INSERT INTO notes_todo_seed_state (user_id, seed_version) VALUES (?, 1)").run(userId);
      if (existingSection) {
        return;
      }

      const inboxId = `${userId}:inbox`;
      const workId = `${userId}:work`;
      const sprintId = `${userId}:sprint`;
      const productId = `${userId}:product`;
      const personalId = `${userId}:personal`;
      db.query(`
        INSERT OR IGNORE INTO notes_todo_sections (id, user_id, title, parent_id)
        VALUES (?, ?, ?, ?)
      `).run(inboxId, userId, "Inbox", null);
      db.query(`
        INSERT OR IGNORE INTO notes_todo_sections (id, user_id, title, parent_id)
        VALUES (?, ?, ?, ?)
      `).run(workId, userId, "Work", null);
      db.query(`
        INSERT OR IGNORE INTO notes_todo_sections (id, user_id, title, parent_id)
        VALUES (?, ?, ?, ?)
      `).run(sprintId, userId, "Sprint planning", workId);
      db.query(`
        INSERT OR IGNORE INTO notes_todo_sections (id, user_id, title, parent_id)
        VALUES (?, ?, ?, ?)
      `).run(productId, userId, "Product ideas", workId);
      db.query(`
        INSERT OR IGNORE INTO notes_todo_sections (id, user_id, title, parent_id)
        VALUES (?, ?, ?, ?)
      `).run(personalId, userId, "Personal", null);

      const seededAt = nowIso();
      const notes = [
        {
          id: `${userId}:seed:note:migration-checklist`,
          sectionId: sprintId,
          title: "Migration checklist",
          body: "Start with user-owned data boundaries, then move UI routes and realtime events.",
        },
        {
          id: `${userId}:seed:note:app-shell`,
          sectionId: productId,
          title: "App shell notes",
          body: "Use sidebar item actions, header actions, pins, scoped settings, and user-owned routes.",
        },
      ];
      for (const note of notes) {
        db.query(`
          INSERT OR IGNORE INTO notes_todo_notes
            (id, user_id, section_id, title, body, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(note.id, userId, note.sectionId, note.title, note.body, seededAt);
      }

      const todos = [
        { id: `${userId}:seed:todo:buy-coffee`, sectionId: personalId, title: "Buy coffee", completed: 1, priority: "low" },
        { id: `${userId}:seed:todo:visual-baseline`, sectionId: sprintId, title: "Compare screenshots with the visual baseline", completed: 0, priority: "normal" },
        { id: `${userId}:seed:todo:auth-tests`, sectionId: sprintId, title: "Write auth security tests", completed: 0, priority: "high" },
        { id: `${userId}:seed:todo:triage-ideas`, sectionId: inboxId, title: "Triage incoming ideas", completed: 0, priority: "normal" },
      ] as const;
      for (const todo of todos) {
        db.query(`
          INSERT OR IGNORE INTO notes_todo_todos
            (id, user_id, section_id, title, completed, priority, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(todo.id, userId, todo.sectionId, todo.title, todo.completed, todo.priority, seededAt);
      }
    });
    seed();
  }

  function ensureInbox(userId: string): Section {
    const ensure = db.transaction(() => {
      db.query(`
        INSERT OR IGNORE INTO notes_todo_sections (id, user_id, title, parent_id)
        VALUES (?, ?, ?, ?)
      `).run(`${userId}:inbox`, userId, "Inbox", null);
      const inbox = db.query(`
        SELECT id, user_id, title, parent_id
        FROM notes_todo_sections
        WHERE id = ? AND user_id = ?
      `).get(`${userId}:inbox`, userId) as Row | null;
      if (!inbox) {
        throw new Error("Notes TODO inbox could not be created");
      }
      return mapSection(inbox);
    });
    return ensure();
  }

  return {
    listSections,
    listNotes,
    listTodos,
    getSection,
    getNote,
    getTodo,
    createSection,
    createNote,
    createTodo,
    updateNote,
    updateTodo,
    deleteNote,
    deleteTodo,
    ensureSeedData,
    ensureInbox,
  };
}
