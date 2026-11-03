export type ProjectStatus = "idle" | "running" | "failed";
export interface Project { id: string; name: string; status: ProjectStatus; updatedAt: string }

/** Deliberately ephemeral: this core-only example has no persistence adapter. */
export function createKitchenSinkStore() {
  const projects = new Map<string, Project>([
    ["alpha", { id: "alpha", name: "Alpha", status: "running", updatedAt: new Date().toISOString() }],
    ["beta", { id: "beta", name: "Beta", status: "idle", updatedAt: new Date().toISOString() }],
  ]);
  return {
    listProjects: () => [...projects.values()].map(project => ({ ...project })),
    getProject: (id: string) => projects.get(id),
    createProject(project: Project) { projects.set(project.id, project); return { ...project }; },
    updateProject(id: string, changes: { name?: string; status?: ProjectStatus; updatedAt: string }) {
      const project = projects.get(id);
      if (!project) return undefined;
      if (changes.name !== undefined) project.name = changes.name;
      if (changes.status !== undefined) project.status = changes.status;
      project.updatedAt = changes.updatedAt;
      return { ...project };
    },
  };
}
export type KitchenSinkStore = ReturnType<typeof createKitchenSinkStore>;
