import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, EmptyState, Panel, SelectField, TextAreaField, TextField, Toolbar, WebAppRoot, useRealtimeRefresh, type SidebarNode, type WebAppRoute } from "@pablozaiden/webapp/web";
import "@pablozaiden/webapp/web/styles.css";
import "./styles.css";

interface Section {
  id: string;
  title: string;
  parentId?: string;
}

interface Note {
  id: string;
  sectionId: string;
  title: string;
  body: string;
  updatedAt: string;
}

interface Todo {
  id: string;
  sectionId: string;
  title: string;
  completed: boolean;
  priority: "low" | "normal" | "high";
  updatedAt: string;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as T;
}

function Dashboard({ sections, notes, todos }: { sections: Section[]; notes: Note[]; todos: Todo[] }) {
  return (
    <div className="notes-grid">
      <Panel title="Notes" description="Recent notes across all sections.">
        {notes.length ? notes.slice(0, 5).map((note) => <div className="notes-row" key={note.id}><strong>{note.title}</strong><small>{note.updatedAt}</small></div>) : <EmptyState title="No notes yet" />}
      </Panel>
      <Panel title="TODOs" description="Open work grouped by section.">
        {todos.filter((todo) => !todo.completed).length ? todos.filter((todo) => !todo.completed).slice(0, 5).map((todo) => <div className="notes-row" key={todo.id}><strong>{todo.title}</strong><small>{todo.priority}</small></div>) : <EmptyState title="No open TODOs" />}
      </Panel>
      <Panel title="Sections">
        <div className="notes-stat">{sections.length}</div>
      </Panel>
    </div>
  );
}

function SectionView({ route, sections, notes, todos, refresh }: { route: WebAppRoute; sections: Section[]; notes: Note[]; todos: Todo[]; refresh: () => Promise<void> }) {
  const sectionId = String(route.sectionId ?? sections[0]?.id ?? "");
  const section = sections.find((item) => item.id === sectionId);
  const sectionNotes = notes.filter((note) => note.sectionId === sectionId);
  const sectionTodos = todos.filter((todo) => todo.sectionId === sectionId);
  const [todoTitle, setTodoTitle] = useState("");
  const [noteTitle, setNoteTitle] = useState("");

  async function addTodo() {
    if (!todoTitle.trim()) return;
    await api("/api/todos", { method: "POST", body: JSON.stringify({ title: todoTitle, sectionId }) });
    setTodoTitle("");
    await refresh();
  }

  async function addNote() {
    if (!noteTitle.trim()) return;
    await api("/api/notes", { method: "POST", body: JSON.stringify({ title: noteTitle, body: "", sectionId }) });
    setNoteTitle("");
    await refresh();
  }

  if (!section) return <EmptyState title="Section not found" />;

  return (
    <div className="notes-stack">
      <Toolbar>
        <div>
          <h2>{section.title}</h2>
          <p className="notes-muted">{sectionNotes.length} notes · {sectionTodos.length} TODOs</p>
        </div>
      </Toolbar>
      <Panel title="New TODO">
        <div className="notes-inline-form">
          <TextField label="Title" value={todoTitle} onChange={(event) => setTodoTitle(event.currentTarget.value)} />
          <Button type="button" variant="primary" onClick={() => void addTodo()}>Add TODO</Button>
        </div>
      </Panel>
      <Panel title="TODOs">
        {sectionTodos.length ? sectionTodos.map((todo) => (
          <label className="notes-check-row" key={todo.id}>
            <input type="checkbox" checked={todo.completed} onChange={(event) => void api(`/api/todos/${todo.id}`, { method: "PATCH", body: JSON.stringify({ completed: event.currentTarget.checked }) }).then(refresh)} />
            <span><strong>{todo.title}</strong><small>{todo.priority}</small></span>
          </label>
        )) : <EmptyState title="No TODOs in this section" />}
      </Panel>
      <Panel title="New note">
        <div className="notes-inline-form">
          <TextField label="Title" value={noteTitle} onChange={(event) => setNoteTitle(event.currentTarget.value)} />
          <Button type="button" variant="primary" onClick={() => void addNote()}>Add note</Button>
        </div>
      </Panel>
      <Panel title="Notes">
        {sectionNotes.length ? sectionNotes.map((note) => <div className="notes-row" key={note.id}><strong>{note.title}</strong><small>{note.body || "Empty note"}</small></div>) : <EmptyState title="No notes in this section" />}
      </Panel>
    </div>
  );
}

function NoteEditor({ route, notes, sections, refresh }: { route: WebAppRoute; notes: Note[]; sections: Section[]; refresh: () => Promise<void> }) {
  const note = notes.find((item) => item.id === route.noteId);
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.body ?? "");
  const [sectionId, setSectionId] = useState(note?.sectionId ?? sections[0]?.id ?? "");
  useEffect(() => {
    setTitle(note?.title ?? "");
    setBody(note?.body ?? "");
    setSectionId(note?.sectionId ?? sections[0]?.id ?? "");
  }, [note, sections]);
  if (!note) return <EmptyState title="Note not found" />;
  return (
    <Panel title="Edit note">
      <div className="notes-stack">
        <TextField label="Title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
        <SelectField label="Section" value={sectionId} onChange={(event) => setSectionId(event.currentTarget.value)}>
          {sections.map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}
        </SelectField>
        <TextAreaField label="Body" value={body} onChange={(event) => setBody(event.currentTarget.value)} />
        <div><Button type="button" variant="primary" onClick={() => void api(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ title, body, sectionId }) }).then(refresh)}>Save note</Button></div>
      </div>
    </Panel>
  );
}

function NotesTodoApp() {
  const [sections, setSections] = useState<Section[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);

  const refresh = useCallback(async () => {
    const [nextSections, nextNotes, nextTodos] = await Promise.all([
      api<Section[]>("/api/sections"),
      api<Note[]>("/api/notes"),
      api<Todo[]>("/api/todos"),
    ]);
    setSections(nextSections);
    setNotes(nextNotes);
    setTodos(nextTodos);
  }, []);

  useEffect(() => void refresh(), [refresh]);
  useRealtimeRefresh({ resources: ["sections", "notes", "todos"], refresh: () => refresh() });

  const sidebarNodes = useCallback(({ search }: { search: string }): SidebarNode[] => {
    const query = search.trim().toLowerCase();
    const matches = (value: string) => !query || value.toLowerCase().includes(query);
    const childSections = (parentId?: string): SidebarNode[] => sections
      .filter((section) => section.parentId === parentId && matches(section.title))
      .map((section) => ({
        type: "item",
        id: `section:${section.id}`,
        title: section.title,
        route: { view: "section", sectionId: section.id },
        badge: String(todos.filter((todo) => todo.sectionId === section.id && !todo.completed).length || ""),
        badgeVariant: "info",
        children: [
          ...notes.filter((note) => note.sectionId === section.id && matches(note.title)).map((note) => ({ type: "item" as const, id: `note:${note.id}`, title: note.title, route: { view: "note", noteId: note.id } })),
          ...childSections(section.id),
        ],
      }));
    return [
      {
        type: "section",
        id: "notes",
        title: "Notes",
        action: { id: "new-note", title: "New note", label: "New", route: { view: "section", sectionId: sections[0]?.id } },
        children: childSections(),
      },
      {
        type: "section",
        id: "todos",
        title: "TODOs",
        action: { id: "new-todo", title: "New TODO", label: "New", route: { view: "section", sectionId: sections[0]?.id } },
        children: sections.filter((section) => matches(section.title)).map((section) => ({
          type: "item",
          id: `todo-section:${section.id}`,
          title: section.title,
          route: { view: "section", sectionId: section.id },
          badge: String(todos.filter((todo) => todo.sectionId === section.id && !todo.completed).length || ""),
          badgeVariant: "warning",
        })),
      },
      {
        type: "section",
        id: "archive",
        title: "Archive",
        defaultCollapsed: true,
        children: todos.filter((todo) => todo.completed).map((todo) => ({ type: "item", id: `done:${todo.id}`, title: todo.title, subtitle: "Completed" })),
      },
    ];
  }, [notes, sections, todos]);

  return (
    <WebAppRoot
      appName="Notes TODO"
      homeRoute={{ view: "home" }}
      sidebar={{
        topActions: [{ id: "new", title: "New item", route: { view: "section", sectionId: sections[0]?.id }, icon: "+" }],
        getNodes: sidebarNodes,
      }}
      routes={{
        home: <Dashboard sections={sections} notes={notes} todos={todos} />,
        section: (route) => <SectionView route={route} sections={sections} notes={notes} todos={todos} refresh={refresh} />,
        note: (route) => <NoteEditor route={route} notes={notes} sections={sections} refresh={refresh} />,
      }}
      settings={{
        sections: [
          {
            id: "notes",
            title: "Notes TODO",
            render: () => <p className="notes-muted">Sections: {sections.length}. Open TODOs: {todos.filter((todo) => !todo.completed).length}.</p>,
          },
        ],
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<NotesTodoApp />);
