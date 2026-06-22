import { useCallback, useEffect, useState } from "react";
import { Badge, Button, DataList, DataListRow, EmptyState, EntityHeader, FormActions, Panel, SelectField, TextAreaField, TextField, WebAppRoot, renderWebApp, useRealtimeRefresh, type ActionMenuItem, type SidebarNode, type WebAppRoute } from "@pablozaiden/webapp/web";
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

function needsAuthentication(config: { passkeyAuth: { enabled: boolean; bootstrapRequired: boolean; ownerPasskeySetupRequired: boolean; passkeyRequired: boolean; authenticated: boolean } }): boolean {
  return config.passkeyAuth.enabled && (config.passkeyAuth.bootstrapRequired || config.passkeyAuth.ownerPasskeySetupRequired || (config.passkeyAuth.passkeyRequired && !config.passkeyAuth.authenticated));
}

function routeToHash(route: WebAppRoute): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(route)) {
    if (key !== "view" && value !== undefined) params.set(key, String(value));
  }
  return `#/${route.view}${params.size ? `?${params.toString()}` : ""}`;
}

function navigateTo(route: WebAppRoute) {
  window.location.hash = routeToHash(route);
}

function sectionTitle(sections: Section[], sectionId: string): string {
  return sections.find((section) => section.id === sectionId)?.title ?? "Unknown list";
}

function todoBadge(todo: Todo) {
  if (todo.completed) return <Badge variant="success">done</Badge>;
  return <Badge variant={todo.priority === "high" ? "error" : todo.priority === "low" ? "disabled" : "warning"}>{todo.priority}</Badge>;
}

function Dashboard({ sections, notes, todos }: { sections: Section[]; notes: Note[]; todos: Todo[] }) {
  const openTodos = todos.filter((todo) => !todo.completed);
  const highPriority = openTodos.filter((todo) => todo.priority === "high");
  return (
    <div className="notes-stack">
      <EntityHeader
        eyebrow="Example app"
        title="Notes TODO"
        description="A realistic multi-user workspace with nested lists, item actions, pins, header actions and scoped realtime."
      />
      <div className="notes-grid">
        <Panel title="Focus" description="Open work across all lists.">
          <DataList empty={<EmptyState title="No open tasks" />}>
            {openTodos.slice(0, 5).map((todo) => (
              <DataListRow
                key={todo.id}
                title={todo.title}
                description={sectionTitle(sections, todo.sectionId)}
                badge={todoBadge(todo)}
                onClick={() => navigateTo({ view: "todo", todoId: todo.id })}
              />
            ))}
          </DataList>
        </Panel>
        <Panel title="Recent notes" description="Knowledge captured in lists.">
          <DataList empty={<EmptyState title="No notes yet" />}>
            {notes.slice(0, 5).map((note) => (
              <DataListRow
                key={note.id}
                title={note.title}
                description={sectionTitle(sections, note.sectionId)}
                meta={new Date(note.updatedAt).toLocaleString()}
                onClick={() => navigateTo({ view: "note", noteId: note.id })}
              />
            ))}
          </DataList>
        </Panel>
        <Panel title="Workspace">
          <div className="notes-stats">
            <span><strong>{sections.length}</strong><small>lists</small></span>
            <span><strong>{notes.length}</strong><small>notes</small></span>
            <span><strong>{openTodos.length}</strong><small>open tasks</small></span>
            <span><strong>{highPriority.length}</strong><small>high priority</small></span>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function SectionView({ route, sections, notes, todos }: { route: WebAppRoute; sections: Section[]; notes: Note[]; todos: Todo[] }) {
  const sectionId = String(route.sectionId ?? sections[0]?.id ?? "");
  const section = sections.find((item) => item.id === sectionId);
  if (!section) return <EmptyState title="List not found" />;

  const sectionNotes = notes.filter((note) => note.sectionId === section.id);
  const sectionTodos = todos.filter((todo) => todo.sectionId === section.id);
  const openTodos = sectionTodos.filter((todo) => !todo.completed);
  return (
    <div className="notes-stack">
      <EntityHeader
        eyebrow="List"
        title={section.title}
        description={`${openTodos.length} open tasks · ${sectionNotes.length} notes`}
      />
      <Panel title="Tasks" description="Task rows use framework data-list styling.">
        <DataList empty={<EmptyState title="No tasks in this list" description="Use the title-bar action menu to create a task in this list." />}>
          {sectionTodos.map((todo) => (
            <DataListRow
              key={todo.id}
              title={todo.title}
              description={todo.completed ? "Completed" : "Open"}
              badge={todoBadge(todo)}
              onClick={() => navigateTo({ view: "todo", todoId: todo.id })}
            />
          ))}
        </DataList>
      </Panel>
      <Panel title="Notes">
        <DataList empty={<EmptyState title="No notes in this list" description="Use the title-bar action menu to create a note in this list." />}>
          {sectionNotes.map((note) => (
            <DataListRow key={note.id} title={note.title} description={note.body || "Empty note"} onClick={() => navigateTo({ view: "note", noteId: note.id })} />
          ))}
        </DataList>
      </Panel>
    </div>
  );
}

function TasksView({ route, sections, todos }: { route: WebAppRoute; sections: Section[]; todos: Todo[] }) {
  const filter = String(route.filter ?? "open");
  const filtered = todos.filter((todo) => {
    if (filter === "high") return !todo.completed && todo.priority === "high";
    if (filter === "completed") return todo.completed;
    return !todo.completed;
  });
  return (
    <Panel title={filter === "high" ? "High priority tasks" : filter === "completed" ? "Completed tasks" : "Open tasks"}>
      <DataList empty={<EmptyState title="No matching tasks" />}>
        {filtered.map((todo) => (
          <DataListRow
            key={todo.id}
            title={todo.title}
            description={sectionTitle(sections, todo.sectionId)}
            badge={todoBadge(todo)}
            onClick={() => navigateTo({ view: "todo", todoId: todo.id })}
          />
        ))}
      </DataList>
    </Panel>
  );
}

function NotesView({ sections, notes }: { sections: Section[]; notes: Note[] }) {
  return (
    <Panel title="All notes" description="A flat note index backed by the same list-owned data.">
      <DataList empty={<EmptyState title="No notes yet" />}>
        {notes.map((note) => (
          <DataListRow
            key={note.id}
            title={note.title}
            description={sectionTitle(sections, note.sectionId)}
            meta={new Date(note.updatedAt).toLocaleString()}
            onClick={() => navigateTo({ view: "note", noteId: note.id })}
          />
        ))}
      </DataList>
    </Panel>
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
    <Panel title="Edit note" description="The active note actions are also available from the title bar menu.">
      <div className="notes-form">
        <TextField label="Title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
        <SelectField label="List" value={sectionId} onChange={(event) => setSectionId(event.currentTarget.value)}>
          {sections.map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}
        </SelectField>
        <TextAreaField label="Body" value={body} onChange={(event) => setBody(event.currentTarget.value)} />
        <FormActions>
          <Button type="button" variant="primary" onClick={() => void api(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ title, body, sectionId }) }).then(refresh)}>Save note</Button>
        </FormActions>
      </div>
    </Panel>
  );
}

function TodoEditor({ route, todos, sections, refresh }: { route: WebAppRoute; todos: Todo[]; sections: Section[]; refresh: () => Promise<void> }) {
  const todo = todos.find((item) => item.id === route.todoId);
  const [title, setTitle] = useState(todo?.title ?? "");
  const [sectionId, setSectionId] = useState(todo?.sectionId ?? sections[0]?.id ?? "");
  const [priority, setPriority] = useState<Todo["priority"]>(todo?.priority ?? "normal");
  useEffect(() => {
    setTitle(todo?.title ?? "");
    setSectionId(todo?.sectionId ?? sections[0]?.id ?? "");
    setPriority(todo?.priority ?? "normal");
  }, [todo, sections]);
  if (!todo) return <EmptyState title="Task not found" />;
  return (
    <Panel title="Edit task" description={todo.completed ? "This task is completed." : "This task is open."}>
      <div className="notes-form">
        <TextField label="Title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
        <SelectField label="List" value={sectionId} onChange={(event) => setSectionId(event.currentTarget.value)}>
          {sections.map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}
        </SelectField>
        <SelectField label="Priority" value={priority} onChange={(event) => setPriority(event.currentTarget.value as Todo["priority"])}>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </SelectField>
        <FormActions>
          <Button type="button" variant="primary" onClick={() => void api(`/api/todos/${todo.id}`, { method: "PATCH", body: JSON.stringify({ title, sectionId, priority }) }).then(refresh)}>Save task</Button>
        </FormActions>
      </div>
    </Panel>
  );
}

function NewSectionView({ route, sections, refresh }: { route: WebAppRoute; sections: Section[]; refresh: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const parentId = String(route.parentId ?? "");
  async function submit() {
    if (!title.trim()) return;
    const section = await api<Section>("/api/sections", { method: "POST", body: JSON.stringify({ title, parentId: parentId || undefined }) });
    await refresh();
    navigateTo({ view: "section", sectionId: section.id });
  }
  return (
    <Panel title="New list" description="Lists can be nested and every list item can expose contextual actions.">
      <div className="notes-form">
        <TextField label="List name" value={title} onChange={(event) => setTitle(event.currentTarget.value)} autoFocus />
        <SelectField label="Parent list" value={parentId} onChange={(event) => navigateTo({ view: "new-section", parentId: event.currentTarget.value || undefined })}>
          <option value="">Top level</option>
          {sections.map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}
        </SelectField>
        <FormActions><Button type="button" variant="primary" disabled={!title.trim()} onClick={() => void submit()}>Create list</Button></FormActions>
      </div>
    </Panel>
  );
}

function NewNoteView({ route, sections, refresh }: { route: WebAppRoute; sections: Section[]; refresh: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sectionId, setSectionId] = useState(String(route.sectionId ?? sections[0]?.id ?? ""));
  async function submit() {
    if (!title.trim() || !sectionId) return;
    const note = await api<Note>("/api/notes", { method: "POST", body: JSON.stringify({ title, body, sectionId }) });
    await refresh();
    navigateTo({ view: "note", noteId: note.id });
  }
  return (
    <Panel title="New note" description="Dedicated creation flow for notes.">
      <div className="notes-form">
        <TextField label="Title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} autoFocus />
        <SelectField label="List" value={sectionId} onChange={(event) => setSectionId(event.currentTarget.value)}>
          {sections.map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}
        </SelectField>
        <TextAreaField label="Body" value={body} onChange={(event) => setBody(event.currentTarget.value)} />
        <FormActions><Button type="button" variant="primary" disabled={!title.trim() || !sectionId} onClick={() => void submit()}>Create note</Button></FormActions>
      </div>
    </Panel>
  );
}

function NewTodoView({ route, sections, refresh }: { route: WebAppRoute; sections: Section[]; refresh: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [sectionId, setSectionId] = useState(String(route.sectionId ?? sections[0]?.id ?? ""));
  const [priority, setPriority] = useState<Todo["priority"]>("normal");
  async function submit() {
    if (!title.trim() || !sectionId) return;
    const todo = await api<Todo>("/api/todos", { method: "POST", body: JSON.stringify({ title, sectionId, priority }) });
    await refresh();
    navigateTo({ view: "todo", todoId: todo.id });
  }
  return (
    <Panel title="New task" description="Dedicated creation flow for tasks.">
      <div className="notes-form">
        <TextField label="Title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} autoFocus />
        <SelectField label="List" value={sectionId} onChange={(event) => setSectionId(event.currentTarget.value)}>
          {sections.map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}
        </SelectField>
        <SelectField label="Priority" value={priority} onChange={(event) => setPriority(event.currentTarget.value as Todo["priority"])}>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </SelectField>
        <FormActions><Button type="button" variant="primary" disabled={!title.trim() || !sectionId} onClick={() => void submit()}>Create task</Button></FormActions>
      </div>
    </Panel>
  );
}

function NotesTodoApp() {
  const [sections, setSections] = useState<Section[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);

  const refresh = useCallback(async () => {
    const config = await api<{ passkeyAuth: { enabled: boolean; bootstrapRequired: boolean; ownerPasskeySetupRequired: boolean; passkeyRequired: boolean; authenticated: boolean } }>("/api/config");
    if (needsAuthentication(config)) return;
    const [nextSections, nextNotes, nextTodos] = await Promise.all([
      api<Section[]>("/api/sections"),
      api<Note[]>("/api/notes"),
      api<Todo[]>("/api/todos"),
    ]);
    setSections(nextSections);
    setNotes(nextNotes);
    setTodos(nextTodos);
  }, []);

  useEffect(() => void refresh().catch(() => undefined), [refresh]);
  useRealtimeRefresh({ resources: ["sections", "notes", "todos"], refresh: () => refresh() });

  const patchTodo = useCallback(async (todo: Todo, patch: Partial<Todo>) => {
    await api(`/api/todos/${todo.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    await refresh();
  }, [refresh]);

  const deleteTodo = useCallback(async (todo: Todo) => {
    await api(`/api/todos/${todo.id}`, { method: "DELETE" });
    await refresh();
  }, [refresh]);

  const deleteNote = useCallback(async (note: Note) => {
    await api(`/api/notes/${note.id}`, { method: "DELETE" });
    await refresh();
  }, [refresh]);

  const sectionActions = useCallback((section: Section): ActionMenuItem[] => [
    { id: "new-task", label: "New task in list", onAction: () => navigateTo({ view: "new-todo", sectionId: section.id }) },
    { id: "new-note", label: "New note in list", onAction: () => navigateTo({ view: "new-note", sectionId: section.id }) },
    { id: "new-child-list", label: "New child list", onAction: () => navigateTo({ view: "new-section", parentId: section.id }) },
  ], []);

  const noteActions = useCallback((note: Note): ActionMenuItem[] => [
    { id: "open-note", label: "Open note", onAction: () => navigateTo({ view: "note", noteId: note.id }) },
    { id: "delete-note", label: "Delete note", destructive: true, onAction: () => void deleteNote(note) },
  ], [deleteNote]);

  const todoActions = useCallback((todo: Todo): ActionMenuItem[] => [
    { id: "toggle-task", label: todo.completed ? "Mark open" : "Mark completed", onAction: () => void patchTodo(todo, { completed: !todo.completed }) },
    { id: "high-priority", label: "Mark high priority", disabled: todo.priority === "high", onAction: () => void patchTodo(todo, { priority: "high" }) },
    { id: "delete-task", label: "Delete task", destructive: true, onAction: () => void deleteTodo(todo) },
  ], [deleteTodo, patchTodo]);

  const sidebarNodes = useCallback(({ search }: { search: string }): SidebarNode[] => {
    const query = search.trim().toLowerCase();
    const matches = (value: string | undefined) => !query || (value ?? "").toLowerCase().includes(query);
    const sectionsByParent = new Map<string, Section[]>();
    for (const section of sections) {
      const key = section.parentId ?? "";
      sectionsByParent.set(key, [...(sectionsByParent.get(key) ?? []), section]);
    }
    const openCount = (sectionId: string) => todos.filter((todo) => todo.sectionId === sectionId && !todo.completed).length;
    const buildSectionNode = (section: Section): SidebarNode | undefined => {
      const children = (sectionsByParent.get(section.id) ?? []).map(buildSectionNode).filter(Boolean) as SidebarNode[];
      const shouldShow = matches(section.title) || children.length > 0;
      if (!shouldShow) return undefined;
      const count = openCount(section.id);
      return {
        type: "item",
        id: `section:${section.id}`,
        title: section.title,
        subtitle: `${notes.filter((note) => note.sectionId === section.id).length} notes`,
        route: { view: "section", sectionId: section.id },
        pinnable: true,
        pinId: `section:${section.id}`,
        badge: count ? String(count) : undefined,
        badgeVariant: count ? "warning" : "disabled",
        actions: sectionActions(section),
        children,
      };
    };

    const openTodos = todos.filter((todo) => !todo.completed && (matches(todo.title) || matches(sectionTitle(sections, todo.sectionId))));
    const completedTodos = todos.filter((todo) => todo.completed && (matches(todo.title) || matches(sectionTitle(sections, todo.sectionId))));
    const noteItems = notes
      .filter((note) => matches(note.title) || matches(note.body) || matches(sectionTitle(sections, note.sectionId)))
      .slice(0, query ? notes.length : 8)
      .map((note) => ({
        type: "item" as const,
        id: `note:${note.id}`,
        title: note.title,
        subtitle: sectionTitle(sections, note.sectionId),
        route: { view: "note", noteId: note.id },
        pinnable: true,
        pinId: `note:${note.id}`,
        actions: noteActions(note),
      }));
    const todoItems = openTodos.slice(0, query ? openTodos.length : 8).map((todo) => ({
      type: "item" as const,
      id: `todo:${todo.id}`,
      title: todo.title,
      subtitle: sectionTitle(sections, todo.sectionId),
      route: { view: "todo", todoId: todo.id },
      pinnable: true,
      pinId: `todo:${todo.id}`,
      badge: todo.priority === "high" ? "high" : undefined,
      badgeVariant: "error" as const,
      actions: todoActions(todo),
    }));
    const completedTodoItems = completedTodos.slice(0, query ? completedTodos.length : 5).map((todo) => ({
      type: "item" as const,
      id: `todo:${todo.id}`,
      title: todo.title,
      subtitle: `${sectionTitle(sections, todo.sectionId)} · completed`,
      route: { view: "todo", todoId: todo.id },
      pinnable: true,
      pinId: `todo:${todo.id}`,
      badge: "done",
      badgeVariant: "success" as const,
      actions: todoActions(todo),
    }));

    return [
      {
        type: "section",
        id: "lists",
        title: "Lists",
        children: (sectionsByParent.get("") ?? []).map(buildSectionNode).filter(Boolean) as SidebarNode[],
      },
      {
        type: "section",
        id: "notes",
        title: "Notes",
        children: noteItems,
      },
      {
        type: "section",
        id: "tasks",
        title: "Tasks",
        children: [
          { type: "item", id: "tasks:open", title: "Open", subtitle: "Smart view", route: { view: "tasks", filter: "open" }, pinnable: true, badge: String(openTodos.length || ""), badgeVariant: "warning" },
          { type: "item", id: "tasks:high", title: "High priority", subtitle: "Smart view", route: { view: "tasks", filter: "high" }, pinnable: true, badge: String(openTodos.filter((todo) => todo.priority === "high").length || ""), badgeVariant: "error" },
          { type: "item", id: "tasks:completed", title: "Completed", subtitle: "Smart view", route: { view: "tasks", filter: "completed" }, pinnable: true, badge: String(completedTodos.length || ""), badgeVariant: "success" },
          ...todoItems,
          ...completedTodoItems,
        ],
      },
    ];
  }, [noteActions, notes, sectionActions, sections, todoActions, todos]);

  const headerActions = useCallback(({ route }: { route: WebAppRoute; defaultTitle: string }): ActionMenuItem[] => {
    if (route.view === "home") {
      return [
        { id: "new-task", label: "New task", onAction: () => navigateTo({ view: "new-todo", sectionId: sections[0]?.id }) },
        { id: "new-note", label: "New note", onAction: () => navigateTo({ view: "new-note", sectionId: sections[0]?.id }) },
        { id: "new-list", label: "New list", onAction: () => navigateTo({ view: "new-section" }) },
      ];
    }
    if (route.view === "tasks") {
      return [{ id: "new-task", label: "New task", onAction: () => navigateTo({ view: "new-todo", sectionId: sections[0]?.id }) }];
    }
    if (route.view === "notes") {
      return [{ id: "new-note", label: "New note", onAction: () => navigateTo({ view: "new-note", sectionId: sections[0]?.id }) }];
    }
    if (route.view === "section") {
      const section = sections.find((item) => item.id === route.sectionId);
      return section ? sectionActions(section) : [];
    }
    if (route.view === "note") {
      const note = notes.find((item) => item.id === route.noteId);
      return note ? noteActions(note) : [];
    }
    if (route.view === "todo") {
      const todo = todos.find((item) => item.id === route.todoId);
      return todo ? todoActions(todo) : [];
    }
    return [];
  }, [noteActions, notes, sectionActions, sections, todoActions, todos]);

  const renderTitle = useCallback(({ route, defaultTitle }: { route: WebAppRoute; defaultTitle: string }) => {
    if (route.view === "section") return sections.find((item) => item.id === route.sectionId)?.title ?? "List";
    if (route.view === "note") return notes.find((item) => item.id === route.noteId)?.title ?? "Note";
    if (route.view === "todo") return todos.find((item) => item.id === route.todoId)?.title ?? "Task";
    if (route.view === "new-section") return "New list";
    if (route.view === "new-note") return "New note";
    if (route.view === "new-todo") return "New task";
    if (route.view === "tasks") return route.filter === "high" ? "High priority" : route.filter === "completed" ? "Completed" : "Open tasks";
    if (route.view === "notes") return "All notes";
    return defaultTitle;
  }, [notes, sections, todos]);

  return (
    <WebAppRoot
      appName="Notes TODO"
      homeRoute={{ view: "home" }}
      sidebar={{
        getNodes: sidebarNodes,
      }}
      routes={{
        home: <Dashboard sections={sections} notes={notes} todos={todos} />,
        section: (route) => <SectionView route={route} sections={sections} notes={notes} todos={todos} />,
        tasks: (route) => <TasksView route={route} sections={sections} todos={todos} />,
        notes: <NotesView sections={sections} notes={notes} />,
        note: (route) => <NoteEditor route={route} notes={notes} sections={sections} refresh={refresh} />,
        todo: (route) => <TodoEditor route={route} todos={todos} sections={sections} refresh={refresh} />,
        "new-section": (route) => <NewSectionView route={route} sections={sections} refresh={refresh} />,
        "new-note": (route) => <NewNoteView route={route} sections={sections} refresh={refresh} />,
        "new-todo": (route) => <NewTodoView route={route} sections={sections} refresh={refresh} />,
      }}
      header={{
        renderTitle,
        getActions: headerActions,
      }}
      settings={{
        sections: [
          {
            id: "notes",
            title: "Notes TODO",
            scope: "user",
            rows: [
              { id: "lists", title: "Lists", description: `${sections.length} user-owned lists with nested sidebar items.` },
              { id: "content", title: "Content", description: `${notes.length} notes and ${todos.filter((todo) => !todo.completed).length} open tasks.` },
            ],
          },
        ],
      }}
    />
  );
}

renderWebApp(<NotesTodoApp />);
