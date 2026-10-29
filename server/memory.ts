import { mkdir, readFile, writeFile, rename, copyFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { LocaleCode } from "../shared/i18n";
import { isDeliveryStatus, type Board, type Project, type Task } from "../shared/model";
import { SUMMARIZER_LABELS, summaryModelsOf, type SummarySettings } from "../shared/summary";
import {
  RETRO_DELAY_MS,
  RETRO_LABEL,
  RETRO_SUMMARY_WAIT_MS,
  RETRO_TIMEOUT_MS,
  CODEX_ANSWERS_PREFIX,
  answerText,
  clueText,
  containsSecret,
  emptyMemoryState,
  fitCandidate,
  memoryContextLines,
  memoryForTask,
  memoryLimits,
  memoryStateSchema,
  noteUse,
  parseRetroOutput,
  questionAnswers,
  recallMemory,
  recallTotals,
  retroJsonSchema,
  retroMaterial,
  retroPrompt,
  titleKey,
  trimClues,
  type MemoryClue,
  type MemoryEntry,
  type MemoryKind,
  type MemoryState,
  type MemoryView,
  type TurnItem,
} from "../shared/memory";
import type { BoardStore } from "./store";
import type { SummaryStore } from "./summaries";
import { runSummaryModels } from "./summary-models";
import { backgroundWorkspaces, type BackgroundWorkspaces } from "./background-workspace";
import { daemonRemoveAgent, type RemoveAgent } from "./summarizer-remove";
import { logFailure } from "./error-report";

const DAY_MS = 86_400_000;

/** `memory.json` (PROJECT-MEMORY-SPEC §3.1): serialized writes, backup, atomic replacement; invalid data is preserved. */
export class MemoryStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "memory.json");
  }
  private async load(): Promise<MemoryState> {
    try {
      return memoryStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyMemoryState();
      throw new Error(`Project memory data is invalid; preserved at ${this.path}. Restore a valid backup before continuing.`);
    }
  }
  async read() {
    await this.tail;
    return this.load();
  }
  update<T>(operation: (state: MemoryState) => Promise<{ value: T; changed: boolean }> | { value: T; changed: boolean }): Promise<T> {
    const job = this.tail.then(async () => {
      const state = await this.load();
      const { value, changed } = await operation(state);
      if (!changed) return value;
      state.revision++;
      memoryStateSchema.parse(state);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
        try {
          await copyFile(this.path, `${this.path}.bak`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rename(temporary, this.path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      return value;
    });
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
}

/** One store per data directory, so every writer shares one queue. */
const stores = new Map<string, MemoryStore>();
export function memoryStore(directory: string) {
  let store = stores.get(directory);
  if (!store) stores.set(directory, (store = new MemoryStore(directory)));
  return store;
}

/** The block of a card's first instructions and the entries it shows (§6.1). */
export async function memoryContext(directory: string, task: Task, project: Project, board: Board): Promise<{ lines: string[]; ids: string[] }> {
  if (!memoryOn(project)) return { lines: [], ids: [] };
  const state = await memoryStore(directory).read().catch(() => null);
  if (!state) return { lines: [], ids: [] };
  const titleOf = (id: string | undefined) => (id && id !== task.id ? board.tasks.find((t) => t.id === id)?.title : undefined);
  const selection = memoryForTask(
    state.entries.filter((e) => e.projectId === project.id),
    { title: task.title, description: task.description, tags: (task.tags || []).map((t) => t.tag) },
    titleOf,
  );
  return { lines: memoryContextLines(selection, titleOf), ids: selection.entries.map((e) => e.id) };
}

/** Settings → AI features → Project memory (ONBOARDING-SETUP-SPEC §6); kept current by the plugin's settings subscription. */
let memoryEverywhere = true;
export function setMemoryEverywhere(on: boolean) {
  memoryEverywhere = on;
}

export const memoryOn = (project: Pick<Project, "memory"> | undefined) => memoryEverywhere && !!project && project.memory !== false;

/** A refusal an agent tool turns into its error code (§4.1). */
export class MemoryError extends Error {
  constructor(
    readonly code: "MEMORY_DISABLED" | "MEMORY_DUPLICATE" | "MEMORY_LIMIT" | "MEMORY_SECRET" | "MEMORY_CONFLICT" | "MEMORY_FULL" | "INVALID_INPUT" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

export type Proposal = {
  projectId: string;
  taskId?: string;
  agentId?: string;
  eventId?: string;
  by: "agent" | "retro";
  kind: MemoryKind;
  title: string;
  body: string;
  tags: string[];
  keywords: string[];
  supersedes?: string;
  evidence?: string;
};

/** Duplicate, limit, secret and supersedes checks of a new candidate (§4.1). */
export function checkProposal(state: MemoryState, p: Omit<Proposal, "by" | "eventId" | "agentId">) {
  if (containsSecret(`${p.title}\n${p.body}\n${p.keywords.join(" ")}`))
    throw new MemoryError("MEMORY_SECRET", "This looks like it contains a secret (token, key or password). Memory never stores credentials: describe where it is kept instead.");
  const own = state.entries.filter((e) => e.projectId === p.projectId);
  const same = own.find((e) => (e.status === "candidate" || e.status === "active") && titleKey(e.title) === titleKey(p.title));
  if (same) throw new MemoryError("MEMORY_DUPLICATE", `This project already has a memory with that title (${same.id}). To replace it, propose a new one with supersedes=${same.id}.`);
  if (p.supersedes && !own.some((e) => e.id === p.supersedes && e.status === "active"))
    throw new MemoryError("INVALID_INPUT", "supersedes must be the id of one of this project's active memories (see flowly_get_task memory or flowly_recall).");
  if (own.filter((e) => e.status === "candidate").length >= memoryLimits.candidatesPerProject)
    throw new MemoryError("MEMORY_LIMIT", `This project already has ${memoryLimits.candidatesPerProject} memories waiting for review. Stop proposing until the user reviews some.`);
  if (p.taskId && own.filter((e) => e.status === "candidate" && e.source.taskId === p.taskId).length >= memoryLimits.openPerTask)
    throw new MemoryError("MEMORY_LIMIT", `This card already has ${memoryLimits.openPerTask} memories waiting for review. Stop proposing until the user reviews them.`);
}

type HumanInput = { kind: MemoryKind; title: string; body: string; tags: string[]; keywords: string[] };

/** AGENTS.md and CLAUDE.md at the project root (a CLAUDE.md that repeats AGENTS.md counts once); missing files are skipped. */
async function instructionFiles(root: string) {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const text = (await readFile(join(root, name), "utf8").catch(() => "")).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push(`## ${name}\n${text}`);
  }
  return parts.join("\n\n");
}

export class MemoryService {
  readonly store: MemoryStore;
  /** Cards whose review is running or waiting (shown as "Reviewing…"). */
  private running = new Set<string>();
  /** One review at a time per project (§4.2). */
  private queues = new Map<string, Promise<unknown>>();
  private paseo?: PaseoApi;
  constructor(
    readonly board: BoardStore,
    readonly summaries: SummaryStore,
    readonly summarySettings: () => Promise<SummarySettings>,
    readonly language: () => Promise<LocaleCode>,
    /** Resolves when a card's progress summary is not running (TASK-SUMMARY-SPEC §2). */
    readonly summarySettled: (taskId: string) => Promise<void> = async () => undefined,
    private now = () => Date.now(),
    private delayMs = RETRO_DELAY_MS,
    private timeoutMs = RETRO_TIMEOUT_MS,
    /** Hard-deletes the review's child session when done; archives it if that fails (AGENTS.md exception, §4.2). */
    private removeAgent: RemoveAgent = daemonRemoveAgent(),
    /** Where the review runs: the project's background workspace, never a card's (§4.2). */
    private background: BackgroundWorkspaces = backgroundWorkspaces(board.directory),
  ) {
    this.store = memoryStore(board.directory);
  }
  attach(paseo: PaseoApi) {
    this.paseo = paseo;
  }
  private iso() {
    return new Date(this.now()).toISOString();
  }

  // ---- Reads ----------------------------------------------------------------------

  async view(projectId: string): Promise<MemoryView> {
    const [state, board, settings] = await Promise.all([this.store.read(), this.board.read(), this.summarySettings()]);
    const project = board.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("Project not found.");
    return {
      entries: state.entries.filter((e) => e.projectId === projectId),
      errors: state.errors.filter((e) => e.projectId === projectId),
      running: [...this.running].filter((id) => board.tasks.some((t) => t.id === id && t.projectId === projectId)),
      recall: recallTotals(state.recallStats[projectId], this.now()),
      enabled: memoryOn(project),
      retroEnabled: settings.retroEnabled,
    };
  }
  /** Candidates waiting per project, for the overview chip (§5.1). */
  async counts(): Promise<Record<string, number>> {
    const state = await this.store.read();
    const out: Record<string, number> = {};
    for (const e of state.entries) if (e.status === "candidate") out[e.projectId] = (out[e.projectId] || 0) + 1;
    return out;
  }
  /** flowly_get_task `memory` (§6.3). */
  async taskContext(task: Task, project: Project) {
    if (!memoryOn(project)) return { enabled: false, total: 0, entries: [], candidates: [] };
    const state = await this.store.read();
    const own = state.entries.filter((e) => e.projectId === project.id);
    const selection = memoryForTask(own, { title: task.title, description: task.description, tags: (task.tags || []).map((t) => t.tag) });
    return {
      enabled: true,
      total: selection.total,
      entries: selection.entries.map(agentEntry),
      candidates: own
        .filter((e) => e.source.taskId === task.id && e.source.by !== "human")
        .slice(-20)
        .map((e) => ({ id: e.id, title: e.title, status: e.status })),
    };
  }
  /** flowly_recall (§6.4). Counts the query; an empty result counts as a miss. */
  async recall(project: Project, taskId: string, input: { query: string; kind?: MemoryKind; limit?: number }) {
    if (!memoryOn(project)) throw new MemoryError("MEMORY_DISABLED", "Project memory is turned off for this project.");
    const state = await this.store.read();
    const found = recallMemory(state.entries.filter((e) => e.projectId === project.id), input);
    void this.recordRecall(project.id, taskId, found.entries.map((e) => e.id)).catch(() => undefined);
    return { entries: found.entries.map(agentEntry), total: found.total };
  }
  private recordRecall(projectId: string, taskId: string, ids: string[]) {
    const at = this.iso();
    const day = at.slice(0, 10);
    return this.store.update((state) => {
      const stats = (state.recallStats[projectId] ||= { days: {} });
      const today = (stats.days[day] ||= { queries: 0, empty: 0 });
      today.queries++;
      if (!ids.length) today.empty++;
      for (const d of Object.keys(stats.days)) if (Date.parse(at) - Date.parse(`${d}T00:00:00Z`) > 31 * DAY_MS) delete stats.days[d];
      for (const e of state.entries) if (ids.includes(e.id)) noteUse(e, taskId, at);
      return { value: undefined, changed: true };
    });
  }
  /** Session creation: the injected entries count as used by this card, at most once an hour (§3.2). */
  markUsed(ids: readonly string[], taskId: string) {
    if (!ids.length) return Promise.resolve();
    const at = this.iso();
    return this.store.update((state) => {
      let changed = false;
      for (const e of state.entries) {
        if (!ids.includes(e.id)) continue;
        const last = e.usedBy?.find((u) => u.taskId === taskId);
        if (last && Date.parse(at) - Date.parse(last.at) < 3_600_000) continue;
        noteUse(e, taskId, at);
        changed = true;
      }
      return { value: undefined, changed };
    });
  }

  // ---- Agent proposals (§4.1) -----------------------------------------------------

  /** Before the card write: refusals that should not leave a receipt. */
  async precheck(project: Project, taskId: string, input: Omit<Proposal, "by" | "projectId" | "taskId">) {
    if (!memoryOn(project)) throw new MemoryError("MEMORY_DISABLED", "Project memory is turned off for this project. Mention what is worth remembering in your reply instead.");
    checkProposal(await this.store.read(), { ...input, projectId: project.id, taskId });
  }
  /** Stores a candidate; the same card event never stores twice (a replay heals a lost write). */
  propose(p: Proposal): Promise<MemoryEntry> {
    return this.store.update((state) => {
      const existing = p.eventId ? state.entries.find((e) => e.source.eventId === p.eventId) : undefined;
      if (existing) return { value: existing, changed: false };
      checkProposal(state, p);
      const at = this.iso();
      const entry: MemoryEntry = {
        id: randomUUID(),
        projectId: p.projectId,
        kind: p.kind,
        title: p.title.trim(),
        body: p.body.trim(),
        tags: p.tags,
        keywords: p.keywords,
        pinned: false,
        status: "candidate",
        ...(p.supersedes ? { supersedes: p.supersedes } : {}),
        ...(p.evidence ? { evidence: p.evidence } : {}),
        source: { by: p.by, ...(p.taskId ? { taskId: p.taskId } : {}), ...(p.agentId ? { agentId: p.agentId } : {}), ...(p.eventId ? { eventId: p.eventId } : {}) },
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      state.entries.push(entry);
      return { value: entry, changed: true };
    });
  }

  // ---- Human edits (§5.1) ---------------------------------------------------------

  private async project(projectId: string) {
    const project = (await this.board.read()).projects.find((p) => p.id === projectId);
    if (!project) throw new Error("Project not found.");
    if (project.archivedAt) throw new Error("This project is archived; its memory is read-only.");
    return project;
  }
  /** Runs `edit` on one entry after the revision check; `edit` returns false for "no change". */
  private async edit(id: string, revision: number, edit: (entry: MemoryEntry, state: MemoryState, at: string) => boolean | void) {
    const before = (await this.store.read()).entries.find((e) => e.id === id);
    if (!before) throw new MemoryError("NOT_FOUND", "This memory no longer exists. Reload to see the latest.");
    await this.project(before.projectId);
    return this.store.update((state) => {
      const entry = state.entries.find((e) => e.id === id);
      if (!entry) throw new MemoryError("NOT_FOUND", "This memory no longer exists. Reload to see the latest.");
      if (entry.revision !== revision) throw new MemoryError("MEMORY_CONFLICT", "This memory changed elsewhere. Reload to see the latest.");
      const at = this.iso();
      if (edit(entry, state, at) === false) return { value: entry, changed: false };
      entry.revision++;
      entry.updatedAt = at;
      return { value: entry, changed: true };
    });
  }
  async create(input: HumanInput & { projectId: string; pinned: boolean }) {
    await this.project(input.projectId);
    return this.store.update((state) => {
      const own = state.entries.filter((e) => e.projectId === input.projectId);
      checkHumanText(input);
      if (own.some((e) => (e.status === "candidate" || e.status === "active") && titleKey(e.title) === titleKey(input.title)))
        throw new MemoryError("MEMORY_DUPLICATE", "This project already has a memory with that title.");
      checkRoom(own, input.pinned);
      const at = this.iso();
      const entry: MemoryEntry = {
        id: randomUUID(),
        projectId: input.projectId,
        kind: input.kind,
        title: input.title.trim(),
        body: input.body.trim(),
        tags: input.tags,
        keywords: input.keywords,
        pinned: input.pinned,
        status: "active",
        source: { by: "human" },
        revision: 1,
        createdAt: at,
        updatedAt: at,
        confirmedAt: at,
      };
      state.entries.push(entry);
      return { value: entry, changed: true };
    });
  }
  update(input: { id: string; revision: number } & Partial<HumanInput & { pinned: boolean }>) {
    return this.edit(input.id, input.revision, (entry, state) => {
      const next = { ...entry, ...stripUndefined(input) };
      checkHumanText(next);
      if (
        titleKey(next.title) !== titleKey(entry.title) &&
        state.entries.some((e) => e.id !== entry.id && e.projectId === entry.projectId && (e.status === "candidate" || e.status === "active") && titleKey(e.title) === titleKey(next.title))
      )
        throw new MemoryError("MEMORY_DUPLICATE", "This project already has a memory with that title.");
      if (next.pinned && !entry.pinned) {
        if (entry.status !== "active") throw new Error("Only confirmed memories can be pinned.");
        if (state.entries.filter((e) => e.projectId === entry.projectId && e.status === "active" && e.pinned).length >= memoryLimits.pinnedPerProject)
          throw new Error(`A project can pin at most ${memoryLimits.pinnedPerProject} memories. Unpin one first.`);
      }
      const changed = (["kind", "title", "body", "pinned"] as const).some((k) => next[k] !== entry[k]) || next.tags.join("\n") !== entry.tags.join("\n") || next.keywords.join("\n") !== entry.keywords.join("\n");
      if (!changed) return false;
      Object.assign(entry, { kind: next.kind, title: next.title.trim(), body: next.body.trim(), tags: next.tags, keywords: next.keywords, pinned: next.pinned });
    });
  }
  confirm(input: { id: string; revision: number; edits?: Partial<HumanInput> }) {
    return this.edit(input.id, input.revision, (entry, state, at) => {
      if (entry.status !== "candidate") throw new Error("Only memories waiting for review can be confirmed.");
      const next = { ...entry, ...stripUndefined(input.edits || {}) };
      checkHumanText(next);
      const own = state.entries.filter((e) => e.projectId === entry.projectId && e.id !== entry.id);
      if (own.some((e) => (e.status === "candidate" || e.status === "active") && titleKey(e.title) === titleKey(next.title)))
        throw new MemoryError("MEMORY_DUPLICATE", "This project already has a memory with that title.");
      const replaced = entry.supersedes ? own.find((e) => e.id === entry.supersedes && e.status === "active") : undefined;
      // The entry it replaces leaves in the same write, so it does not take a place.
      checkRoom(replaced ? own.filter((e) => e !== replaced) : own, false);
      Object.assign(entry, { kind: next.kind, title: next.title.trim(), body: next.body.trim(), tags: next.tags, keywords: next.keywords, status: "active", confirmedAt: at });
      if (replaced) {
        replaced.status = "archived";
        replaced.archivedReason = "superseded";
        replaced.revision++;
        replaced.updatedAt = at;
      }
    });
  }
  dismiss(input: { id: string; revision: number }) {
    return this.edit(input.id, input.revision, (entry, state, at) => {
      if (entry.status !== "candidate") throw new Error("Only memories waiting for review can be dismissed.");
      entry.status = "dismissed";
      entry.updatedAt = at;
      pruneClosed(state, entry.projectId);
    });
  }
  restore(input: { id: string; revision: number }) {
    return this.edit(input.id, input.revision, (entry, state) => {
      const own = state.entries.filter((e) => e.projectId === entry.projectId && e.id !== entry.id);
      if (own.some((e) => (e.status === "candidate" || e.status === "active") && titleKey(e.title) === titleKey(entry.title)))
        throw new MemoryError("MEMORY_DUPLICATE", "This project already has a memory with that title.");
      if (entry.status === "dismissed") {
        if (own.filter((e) => e.status === "candidate").length >= memoryLimits.candidatesPerProject)
          throw new Error(`This project already has ${memoryLimits.candidatesPerProject} memories waiting for review.`);
        entry.status = "candidate";
      } else if (entry.status === "archived") {
        checkRoom(own, false);
        entry.status = "active";
        entry.pinned = false;
        delete entry.archivedReason;
      } else return false;
    });
  }
  archive(input: { id: string; revision: number; reason: "retired" | "promoted" }) {
    return this.edit(input.id, input.revision, (entry, state, at) => {
      if (entry.status !== "active") throw new Error("Only confirmed memories can be archived.");
      entry.status = "archived";
      entry.archivedReason = input.reason;
      entry.pinned = false;
      entry.updatedAt = at;
      pruneClosed(state, entry.projectId);
    });
  }
  async remove(input: { id: string; revision: number }) {
    const before = (await this.store.read()).entries.find((e) => e.id === input.id);
    if (!before) throw new MemoryError("NOT_FOUND", "This memory no longer exists. Reload to see the latest.");
    await this.project(before.projectId);
    return this.store.update(async (state) => {
      const entry = state.entries.find((e) => e.id === input.id);
      if (!entry) throw new MemoryError("NOT_FOUND", "This memory no longer exists. Reload to see the latest.");
      if (entry.revision !== input.revision) throw new MemoryError("MEMORY_CONFLICT", "This memory changed elsewhere. Reload to see the latest.");
      await this.backup(`memory-${entry.id}`, { entries: [entry] });
      state.entries = state.entries.filter((e) => e !== entry);
      return { value: { id: entry.id }, changed: true };
    });
  }
  /** Archive all stale (§6.5): one write; entries edited meanwhile are skipped. */
  archiveMany(input: { projectId: string; ids: { id: string; revision: number }[] }) {
    return this.store.update((state) => {
      const at = this.iso();
      let n = 0;
      for (const { id, revision } of input.ids) {
        const e = state.entries.find((x) => x.id === id && x.projectId === input.projectId);
        if (!e || e.revision !== revision || e.status !== "active") continue;
        Object.assign(e, { status: "archived", archivedReason: "retired", pinned: false, revision: e.revision + 1, updatedAt: at });
        n++;
      }
      if (n) pruneClosed(state, input.projectId);
      return { value: { archived: n }, changed: n > 0 };
    });
  }

  private async backup(name: string, content: unknown) {
    const folder = join(this.board.directory, "removed");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const at = this.iso();
    const path = join(folder, `${name}-${at.replace(/[:.]/g, "-")}.json`);
    await writeFile(path, JSON.stringify({ removedAt: at, ...(content as object) }, null, 2), { mode: 0o600, flag: "wx" });
    return path;
  }
  /** Card deleted (§5.3): its candidates, dismissed entries and clues go (backed up); confirmed knowledge stays. */
  removeTask(taskId: string) {
    return this.store.update(async (state) => {
      const entries = state.entries.filter((e) => e.source.taskId === taskId && (e.status === "candidate" || e.status === "dismissed"));
      const clues = state.clues.filter((c) => c.taskId === taskId);
      const errors = state.errors.filter((e) => e.taskId === taskId);
      if (!entries.length && !clues.length && !errors.length && !state.retros.some((r) => r.taskId === taskId)) return { value: null, changed: false };
      if (entries.length || clues.length) await this.backup(`task-${taskId}-memory`, { entries, clues });
      state.entries = state.entries.filter((e) => !entries.includes(e));
      state.clues = state.clues.filter((c) => c.taskId !== taskId);
      state.errors = state.errors.filter((e) => e.taskId !== taskId);
      state.retros = state.retros.filter((r) => r.taskId !== taskId);
      return { value: null, changed: true };
    });
  }
  /** Project Remove (§10): everything of the project, backed up first. */
  removeProject(projectId: string, taskIds: ReadonlySet<string>) {
    return this.store.update(async (state) => {
      const entries = state.entries.filter((e) => e.projectId === projectId);
      const clues = state.clues.filter((c) => c.projectId === projectId);
      const errors = state.errors.filter((e) => e.projectId === projectId);
      const retros = state.retros.filter((r) => taskIds.has(r.taskId));
      if (!entries.length && !clues.length && !errors.length && !retros.length && !state.recallStats[projectId]) return { value: null, changed: false };
      await this.backup(`${projectId}-memory`, { entries, clues, errors, retros });
      state.entries = state.entries.filter((e) => e.projectId !== projectId);
      state.clues = state.clues.filter((c) => c.projectId !== projectId);
      state.errors = state.errors.filter((e) => e.projectId !== projectId);
      state.retros = state.retros.filter((r) => !taskIds.has(r.taskId));
      delete state.recallStats[projectId];
      return { value: null, changed: true };
    });
  }

  // ---- Clues (§4.0) ----------------------------------------------------------------

  /**
   * After a managed session's turn: the user's own message that started it, tagged
   * as an answer (to the agent's question), feedback (on a delivery) or a message.
   * `before` is the board as it was when the turn started being recorded.
   */
  async recordTurn(identity: { taskId: string; agentId: string }, timeline: readonly TurnItem[], board: Board) {
    const task = board.tasks.find((t) => t.id === identity.taskId);
    const project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || !project || !memoryOn(project)) return;
    const at = this.iso();
    const clues: MemoryClue[] = [];
    // Answers given through a native question tool (AskUserQuestion, Codex request_user_input).
    for (const qa of questionAnswers(timeline)) {
      const text = answerText(qa.text);
      if (text) clues.push({ id: `${identity.agentId}:${qa.id}`, taskId: task.id, projectId: project.id, at, kind: "answer", ask: qa.ask.slice(0, memoryLimits.clueText), text });
    }
    const first = timeline.find((i) => i.type === "user_message" && typeof i.text === "string");
    const own = first && !String(first.text).trimStart().startsWith(CODEX_ANSWERS_PREFIX) ? this.messageClue(identity, String(first.text), board, task.id) : null;
    if (own) clues.push({ id: randomUUID(), taskId: task.id, projectId: project.id, at, ...own });
    if (!clues.length) return;
    await this.store.update((state) => {
      const known = new Set(state.clues.map((c) => c.id));
      const fresh = clues.filter((c) => !known.has(c.id));
      if (!fresh.length) return { value: undefined, changed: false };
      state.clues.push(...fresh);
      state.clues = trimClues(state.clues, task.id);
      return { value: undefined, changed: true };
    });
  }
  /** The turn's opening message as an answer (to a kind=question report), feedback (on a delivery) or a message; null when it is not the user's own words. */
  private messageClue(identity: { agentId: string }, message: string, board: Board, taskId: string): Pick<MemoryClue, "kind" | "ask" | "text"> | null {
    const events = board.events.filter((e) => e.taskId === taskId);
    // The board events of this turn begin at its turn_started; what came before tells the situation.
    let start = events.length;
    for (let i = events.length - 1; i >= 0; i--)
      if (events[i].agentId === identity.agentId && events[i].action === "agent.turn_started") {
        start = i;
        break;
      }
    const before = events.slice(0, start);
    const picked = before.filter((e) => e.action === "next_moves_suggested" && e.moves).flatMap((e) => e.moves!.flatMap((m) => (m.prompt ? [m.prompt] : [])));
    const ideaTexts = board.ideas.filter((i) => i.taskId === taskId).flatMap((i) => [i.detail, `${i.title}\n\n${i.detail}`]);
    const value = clueText(message, [...picked, ...ideaTexts]);
    if (!value || value.startsWith("Good idea — go ahead with it in this task:")) return null;
    const lastReport = [...before].reverse().find((e) => e.agentId === identity.agentId && e.actor === "agent" && (e.action === "progress_reported" || e.action === "status_changed"));
    const question = lastReport?.reportKind === "question" ? lastReport : undefined;
    const lastStatus = [...before].reverse().find((e) => e.action === "status_changed" && e.to);
    return {
      kind: question ? "answer" : isDeliveryStatus(lastStatus?.to) ? "feedback" : "message",
      ...(question?.note ? { ask: question.note.slice(0, memoryLimits.clueText) } : {}),
      text: value,
    };
  }

  // ---- Finished-card review (§4.2) -------------------------------------------------

  isRunning(taskId: string) {
    return this.running.has(taskId);
  }
  /** A card moved into Done: review it after a short wait, once its summary has settled. */
  afterDone(taskId: string, paseo: PaseoApi) {
    this.attach(paseo);
    void (async () => {
      const settings = await this.summarySettings();
      if (!settings.retroEnabled) return;
      const board = await this.board.read();
      const task = board.tasks.find((t) => t.id === taskId);
      if (!task || !memoryOn(board.projects.find((p) => p.id === task.projectId))) return;
      this.running.add(taskId);
      try {
        await sleep(this.delayMs);
        await Promise.race([this.summarySettled(taskId), sleep(RETRO_SUMMARY_WAIT_MS)]);
        const now = (await this.board.read()).tasks.find((t) => t.id === taskId);
        if (now?.status !== "done") return;
        await this.review(taskId, paseo, false);
      } finally {
        this.running.delete(taskId);
      }
    })().catch(logError("review"));
  }
  /** Find memories (§4.2): ignores the skip rules. */
  async manual(taskId: string, paseo: PaseoApi) {
    this.attach(paseo);
    const board = await this.board.read();
    const task = board.tasks.find((t) => t.id === taskId);
    const project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || !project) throw new Error("Task not found.");
    if (!memoryOn(project)) throw new Error("Project memory is turned off for this project.");
    if (task.status !== "done" && task.status !== "cancelled") throw new Error("Only finished cards are reviewed for memories.");
    this.running.add(taskId);
    void this.review(taskId, paseo, true)
      .catch(logError("review"))
      .finally(() => this.running.delete(taskId));
    return { queued: true };
  }
  /** Reviews run one at a time per project; a failure is recorded on the card (§8). */
  private async review(taskId: string, paseo: PaseoApi, manual: boolean) {
    const projectId = (await this.board.read()).tasks.find((t) => t.id === taskId)?.projectId || "";
    const previous = this.queues.get(projectId) || Promise.resolve();
    const run = previous.then(() => this.execute(taskId, paseo, manual)).catch(async (e) => {
      await this.setError(projectId, taskId, e instanceof Error ? e.message : String(e)).catch(() => undefined);
    });
    this.queues.set(projectId, run);
    await run;
    if (this.queues.get(projectId) === run) this.queues.delete(projectId);
  }
  private setError(projectId: string, taskId: string, message: string) {
    return this.store.update((state) => {
      state.errors = state.errors.filter((e) => e.taskId !== taskId);
      state.errors.push({ taskId, projectId, at: this.iso(), message: message.slice(0, 500) });
      return { value: undefined, changed: true };
    });
  }
  /** The review's material for one card; null when there is nothing to learn from. */
  async material(taskId: string) {
    const [board, state, history] = await Promise.all([this.board.read(), this.store.read(), this.summaries.history(taskId)]);
    const task = board.tasks.find((t) => t.id === taskId);
    const project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || !project) return null;
    const versions = [...history].reverse(); // oldest first
    const latest = versions[versions.length - 1];
    const recapLines = [...new Set(versions.flatMap((v) => v.recap.split("\n").map((l) => l.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean)))];
    const pad = board.workpads.find((w) => w.taskId === taskId);
    const clues = state.clues.filter((c) => c.taskId === taskId);
    const reports = board.events
      .filter((e) => e.taskId === taskId && e.actor === "agent" && (e.reportKind === "question" || e.reportKind === "blocker" || e.reportKind === "result") && e.note)
      .slice(-10)
      .map((e) => `${e.reportKind}: ${e.note}`);
    const confusions = (pad?.confusions || []).map((c) => c.text);
    const failedChecks = (pad?.validation || []).filter((v) => v.state === "fail").map((v) => `${v.text}${v.evidence ? ` (${v.evidence})` : ""}`);
    if (!latest && !clues.length && !confusions.length && !reports.length) return null;
    const instructions = await instructionFiles(project.primaryPath);
    return {
      task,
      project,
      latestId: latest?.id,
      clueAt: clues[clues.length - 1]?.at,
      text: retroMaterial({
        project: project.title,
        card: { title: task.title, type: task.type, tags: (task.tags || []).map((t) => t.tag), description: task.description },
        clues,
        summary: latest ? { target: latest.target, recap: latest.recap, next: latest.next } : undefined,
        recapLines,
        states: versions.slice(-6, -1).map((v) => v.state),
        confusions,
        failedChecks,
        reports,
        existing: state.entries.filter((e) => e.projectId === project.id && e.status === "active").slice(-100).map((e) => ({ id: e.id, kind: e.kind, title: e.title })),
        waiting: state.entries.filter((e) => e.projectId === project.id && e.status === "candidate").map((e) => ({ kind: e.kind, title: e.title })),
        // What the user turned down teaches the review this project's bar (§4.2).
        dismissed: state.entries
          .filter((e) => e.projectId === project.id && e.status === "dismissed")
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
          .slice(0, 30)
          .map((e) => ({ kind: e.kind, title: e.title })),
        instructions,
      }),
    };
  }
  private async execute(taskId: string, paseo: PaseoApi, manual: boolean) {
    const m = await this.material(taskId);
    const state = await this.store.read();
    const last = state.retros.find((r) => r.taskId === taskId);
    if (!m) {
      if (manual) await this.recordRetro(m, taskId, []);
      return;
    }
    if (!manual && last && last.summaryId === m.latestId && last.clueAt === m.clueAt) return;
    const models = summaryModelsOf(await this.summarySettings());
    const prompt = retroPrompt(m.text, await this.language());
    const { output } = await this.background.use(m.project, paseo, (workspaceId) => runSummaryModels(paseo, models, {
      create: (model) => paseo.workspaces.ref(workspaceId).agents.create({
        config: { provider: model },
        title: `Flowly memory review · ${m.task.title}`.slice(0, 120),
        labels: { ...SUMMARIZER_LABELS, "flowly-project": m.project.id, "flowly-task": m.task.id, ...RETRO_LABEL },
        prompt,
        outputSchema: retroJsonSchema as unknown as Record<string, unknown>,
      }),
      parse: (text) => parseRetroOutput(text).map(fitCandidate),
      remove: this.removeAgent,
      timeoutMs: this.timeoutMs,
    }));
    await this.recordRetro(m, taskId, output);
  }

  private async recordRetro(m: Awaited<ReturnType<MemoryService["material"]>>, taskId: string, candidates: ReturnType<typeof fitCandidate>[]) {
    const added: MemoryEntry[] = [];
    const dropped: string[] = [];
    for (const c of candidates) {
      if (!m) break;
      try {
        added.push(await this.propose({ ...c, projectId: m.project.id, taskId, by: "retro", evidence: c.evidence || undefined }));
      } catch (e) {
        if (e instanceof MemoryError && e.code === "MEMORY_DUPLICATE") continue;
        dropped.push(e instanceof Error ? e.message : String(e));
      }
    }
    await this.store.update((state) => {
      state.retros = state.retros.filter((r) => r.taskId !== taskId);
      state.retros.push({ taskId, at: this.iso(), ...(m?.latestId ? { summaryId: m.latestId } : {}), ...(m?.clueAt ? { clueAt: m.clueAt } : {}) });
      state.errors = state.errors.filter((e) => e.taskId !== taskId);
      if (dropped.length && m) state.errors.push({ taskId, projectId: m.project.id, at: this.iso(), message: `${dropped.length} suggestion(s) not kept: ${dropped[0]}`.slice(0, 500) });
      // Clues stay 30 days after a review, for a rerun.
      const cutoff = this.now() - memoryLimits.clueDays * DAY_MS;
      const reviewed = new Set(state.retros.filter((r) => Date.parse(r.at) < cutoff).map((r) => r.taskId));
      state.clues = state.clues.filter((c) => !reviewed.has(c.taskId));
      return { value: undefined, changed: true };
    });
    if (added.length && m)
      await this.board
        .mutate((board) => {
          if (board.tasks.some((t) => t.id === taskId))
            this.board.event(board, { taskId, actor: "system", action: "memory_proposed", note: added.map((e) => e.title).join(" · ").slice(0, 1000) });
        })
        .catch(logError("event"));
  }
}

/** What agents see of an entry (§6.3). */
function agentEntry(e: MemoryEntry) {
  return {
    id: e.id,
    kind: e.kind,
    title: e.title,
    body: e.body,
    tags: e.tags,
    pinned: e.pinned,
    ...(e.source.taskId ? { sourceTaskId: e.source.taskId } : {}),
    ...(e.confirmedAt ? { confirmedAt: e.confirmedAt } : {}),
  };
}

function checkHumanText(input: { title: string; body: string; keywords: string[] }) {
  if (!input.title.trim()) throw new Error("A memory needs a title.");
  if (containsSecret(`${input.title}\n${input.body}\n${input.keywords.join(" ")}`))
    throw new MemoryError("MEMORY_SECRET", "This looks like it contains a secret (token, key or password). Memory never stores credentials; write where it is kept instead.");
}
/** Room for one more active (or pinned) entry (§6.5): the user decides what goes. */
function checkRoom(own: readonly MemoryEntry[], pinned: boolean) {
  if (own.filter((e) => e.status === "active").length >= memoryLimits.activePerProject)
    throw new MemoryError("MEMORY_FULL", `This project already has ${memoryLimits.activePerProject} memories. Archive one to make room.`);
  if (pinned && own.filter((e) => e.status === "active" && e.pinned).length >= memoryLimits.pinnedPerProject)
    throw new Error(`A project can pin at most ${memoryLimits.pinnedPerProject} memories. Unpin one first.`);
}
/** Dismissed and archived entries beyond 200 per project: the oldest go (§3.3). */
function pruneClosed(state: MemoryState, projectId: string) {
  const closed = state.entries.filter((e) => e.projectId === projectId && (e.status === "dismissed" || e.status === "archived"));
  const excess = closed.length - memoryLimits.closedPerProject;
  if (excess <= 0) return;
  const drop = new Set([...closed].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, excess));
  state.entries = state.entries.filter((e) => !drop.has(e));
}
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());
const logError = (what: string) => (e: unknown) => logFailure(`Flowly project memory ${what} failed:`, e);
