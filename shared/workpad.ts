import {
  isDeliveryStatus,
  workpadLimits,
  type AcceptanceItem,
  type BoardEvent,
  type CheckState,
  type ConfusionItem,
  type Delivery,
  type GitHead,
  type PlanSnapshot,
  type Task,
  type ValidationItem,
  type Workpad,
} from "./model";

/** Events of a workpad write by an agent and an edit by a person (WORKPAD-SPEC §2.3); not shown in Activity. */
export const workpadUpdatedAction = "workpad_updated";
export const workpadCheckedAction = "workpad_checked";

/** The project's Workpad switch (WORKPAD-SPEC §9); absent means on. */
export const workpadEnabled = (project: { workpad?: boolean } | null | undefined) => project?.workpad !== false;

export type Freshness = "fresh" | "stale" | "unknown";

const sameSha = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/** Whether a check that ran still matches the workspace HEAD (§5.2); null for an unrun check. */
export function validationFreshness(item: Pick<ValidationItem, "state" | "sha">, head: Pick<GitHead, "sha"> | null | undefined): Freshness | null {
  if (item.state === "unrun") return null;
  if (!item.sha || !head?.sha) return "unknown";
  return sameSha(item.sha, head.sha) ? "fresh" : "stale";
}

export type OpenItems = Omit<Delivery, "revision">;

/** Items that keep a delivery from being complete (§5.3). Plan and confusions never count. */
export function openItems(workpad: Workpad | null | undefined): OpenItems {
  const open = { unchecked: 0, failed: 0, unrun: 0, stale: 0, total: 0 };
  if (!workpad) return open;
  open.unchecked = workpad.acceptance.filter((a) => !a.done).length;
  for (const v of workpad.validation) {
    if (v.state === "fail") open.failed++;
    else if (v.state === "unrun") open.unrun++;
    else if (validationFreshness(v, workpad.head) === "stale") open.stale++;
  }
  open.total = open.unchecked + open.failed + open.unrun + open.stale;
  return open;
}

/** One line per open item, for WORKPAD_OPEN (agent-facing English). */
export function openItemLines(workpad: Workpad): string[] {
  const lines = workpad.acceptance.filter((a) => !a.done).map((a) => `- acceptance not met: ${a.text}`);
  for (const v of workpad.validation) {
    if (v.state === "fail") lines.push(`- check failed: ${v.text}`);
    else if (v.state === "unrun") lines.push(`- check not run: ${v.text}`);
    else if (validationFreshness(v, workpad.head) === "stale")
      lines.push(`- check out of date (ran on ${v.sha}, HEAD is now ${workpad.head?.sha}): ${v.text}`);
  }
  return lines;
}

export type WorkpadDraft = {
  acceptance: { id?: string; text: string; done: boolean }[];
  validation: { id?: string; text: string; command?: string; state: CheckState; sha?: string; dirty?: boolean; evidence?: string }[];
  confusions: { id?: string; text: string }[];
};

const textKey = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

function slug(text: string) {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return base || "item";
}

/**
 * Pairs each draft item with the previous item it replaces (same id, else
 * same text) and gives it an id: its own, the previous one's, or a new slug.
 */
function match<P extends { id: string; text: string }, D extends { id?: string; text: string }>(
  section: string,
  previous: readonly P[],
  draft: readonly D[],
): { item: D; id: string; prev?: P }[] {
  const explicit = new Set<string>();
  for (const d of draft) {
    if (!d.id) continue;
    if (explicit.has(d.id)) throw new Error(`Duplicate ${section} id "${d.id}".`);
    explicit.add(d.id);
  }
  const taken = new Set<P>();
  const pairs = draft.map((item) => {
    const prev = item.id ? previous.find((p) => p.id === item.id) : undefined;
    if (prev) taken.add(prev);
    return { item, prev };
  });
  for (const pair of pairs) {
    if (pair.item.id || pair.prev) continue;
    const prev = previous.find((p) => !taken.has(p) && !explicit.has(p.id) && textKey(p.text) === textKey(pair.item.text));
    if (prev) {
      taken.add(prev);
      pair.prev = prev;
    }
  }
  const used = new Set([...explicit, ...pairs.flatMap((p) => (p.prev && !p.item.id ? [p.prev.id] : []))]);
  return pairs.map(({ item, prev }) => {
    if (item.id) return { item, id: item.id, prev };
    if (prev) return { item, id: prev.id, prev };
    const base = slug(item.text);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return { item, id, prev };
  });
}

/**
 * The workpad an agent's full replacement produces (WORKPAD-SPEC §3.1, §5.1).
 * `resolved` maps each sha the agent gave to the verified short sha; `head`
 * stamps checks that ran without one. Unchanged items keep who changed them
 * last and when.
 */
export function mergeWorkpad(
  previous: Pick<Workpad, "acceptance" | "validation" | "confusions"> | undefined,
  draft: WorkpadDraft,
  ctx: { now: string; head: GitHead | null; resolved: ReadonlyMap<string, string> },
): Pick<Workpad, "acceptance" | "validation" | "confusions"> {
  if (draft.acceptance.length > workpadLimits.acceptance) throw new Error(`At most ${workpadLimits.acceptance} acceptance criteria.`);
  if (draft.validation.length > workpadLimits.validation) throw new Error(`At most ${workpadLimits.validation} checks.`);
  if (draft.confusions.length > workpadLimits.confusions) throw new Error(`At most ${workpadLimits.confusions} confusions.`);
  const acceptance: AcceptanceItem[] = match("acceptance", previous?.acceptance || [], draft.acceptance).map(({ item, id, prev }) =>
    prev && prev.text === item.text && prev.done === item.done
      ? { ...prev, id }
      : { id, text: item.text, done: item.done, by: "agent", at: ctx.now },
  );
  const validation: ValidationItem[] = match("validation", previous?.validation || [], draft.validation).map(({ item, id, prev }) => {
    let run: Pick<ValidationItem, "sha" | "dirty" | "ranAt"> = {};
    if (item.state !== "unrun") {
      if (item.sha) {
        const sha = ctx.resolved.get(item.sha);
        if (!sha) throw new Error(`Unknown commit "${item.sha}".`);
        const dirty = item.dirty ?? false;
        run =
          prev && prev.state === item.state && prev.sha === sha && !!prev.dirty === dirty
            ? { sha, dirty, ranAt: prev.ranAt }
            : { sha, dirty, ranAt: ctx.now };
      } else if (prev && prev.state === item.state && prev.sha) run = { sha: prev.sha, dirty: prev.dirty, ranAt: prev.ranAt };
      else run = { ...(ctx.head?.sha ? { sha: ctx.head.sha, dirty: ctx.head.dirty } : {}), ranAt: ctx.now };
    }
    const next: ValidationItem = {
      id,
      text: item.text,
      ...(item.command ? { command: item.command } : {}),
      state: item.state,
      ...(run.sha ? { sha: run.sha } : {}),
      ...(run.dirty ? { dirty: true } : {}),
      ...(run.ranAt ? { ranAt: run.ranAt } : {}),
      ...(item.evidence ? { evidence: item.evidence } : {}),
      by: "agent",
      at: ctx.now,
    };
    const same =
      !!prev &&
      prev.text === next.text &&
      (prev.command || "") === (next.command || "") &&
      prev.state === next.state &&
      prev.sha === next.sha &&
      !!prev.dirty === !!next.dirty &&
      (prev.evidence || "") === (next.evidence || "");
    return same ? { ...next, ranAt: prev!.ranAt, by: prev!.by, at: prev!.at } : next;
  });
  const confusions: ConfusionItem[] = match("confusion", previous?.confusions || [], draft.confusions).map(({ item, id, prev }) =>
    prev && prev.text === item.text ? { ...prev, id } : { id, text: item.text, at: ctx.now },
  );
  return { acceptance, validation, confusions };
}

/** Event note for a workpad write, e.g. "Acceptance 2/4 · Checks 3/5, 1 failed". English: it is history, not UI. */
export function workpadNote(workpad: Pick<Workpad, "acceptance" | "validation" | "confusions" | "head">) {
  const parts: string[] = [];
  if (workpad.acceptance.length) parts.push(`Acceptance ${workpad.acceptance.filter((a) => a.done).length}/${workpad.acceptance.length}`);
  if (workpad.validation.length) {
    const pass = workpad.validation.filter((v) => v.state === "pass").length;
    const failed = workpad.validation.filter((v) => v.state === "fail").length;
    parts.push(`Checks ${pass}/${workpad.validation.length}${failed ? `, ${failed} failed` : ""}`);
  }
  if (workpad.confusions.length) parts.push(`${workpad.confusions.length} confusion${workpad.confusions.length === 1 ? "" : "s"}`);
  return parts.join(" · ") || "Workpad cleared";
}

/** The delivery still describes the card's current stay in In review or Committed (§5.3, COMMITTED-STAGE-SPEC §3). */
export function currentDelivery(task: Pick<Task, "status">, workpad: Workpad | null | undefined, events: readonly BoardEvent[]) {
  const delivery = workpad?.delivery;
  if (!isDeliveryStatus(task.status) || !delivery) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    // Events were trimmed or it is the same move: the delivery stands.
    if (e.action === "status_changed" && isDeliveryStatus(e.to)) return e.id === delivery.eventId ? delivery : null;
  }
  return delivery;
}

export type WorkpadSignal = {
  kind: "delivered" | "failed" | "stale" | "checks" | "acceptance";
  /** Fresh passing checks, or met acceptance criteria. */
  done: number;
  total: number;
  /** Open items at delivery, failed checks or out-of-date checks. */
  count: number;
};

/** The one workpad signal a card shows (§6.1), from data already on the board. */
export function workpadSignal(task: Pick<Task, "status"> & { archivedAt?: string | null }, workpad: Workpad | null | undefined, events: readonly BoardEvent[]): WorkpadSignal | null {
  if (!workpad) return null;
  const delivery = currentDelivery(task, workpad, events);
  const checks = workpad.validation;
  // A finished card is never re-checked, so later commits do not make its checks "out of date" (user request 2026-10-20).
  const finished = task.status === "done" || task.status === "cancelled" || !!task.archivedAt;
  const fresh = (v: ValidationItem) => (finished ? "fresh" : validationFreshness(v, workpad.head));
  const pass = checks.filter((v) => v.state === "pass" && fresh(v) !== "stale").length;
  if (delivery && delivery.total > 0) return { kind: "delivered", done: pass, total: checks.length, count: delivery.total };
  if (checks.length) {
    const failed = checks.filter((v) => v.state === "fail").length;
    if (failed) return { kind: "failed", done: pass, total: checks.length, count: failed };
    const stale = checks.filter((v) => v.state === "pass" && fresh(v) === "stale").length;
    if (stale) return { kind: "stale", done: pass, total: checks.length, count: stale };
    return { kind: "checks", done: pass, total: checks.length, count: 0 };
  }
  if (workpad.acceptance.length)
    return { kind: "acceptance", done: workpad.acceptance.filter((a) => a.done).length, total: workpad.acceptance.length, count: 0 };
  return null;
}

type TimelineItem = { type: string; items?: unknown };
type TodoItem = { text?: unknown; completed?: unknown; status?: unknown };

/**
 * The plan in a finished turn: its last native todo list (WORKPAD-SPEC §2.2).
 * undefined when the turn had none (keep the previous plan); [] clears it.
 */
export function planFromTimeline(timeline: readonly TimelineItem[] | undefined): PlanSnapshot["items"] | undefined {
  if (!timeline) return undefined;
  let last: TimelineItem | undefined;
  for (let i = timeline.length - 1; i >= 0 && !last; i--) if (timeline[i]?.type === "todo") last = timeline[i];
  if (!last || !Array.isArray(last.items)) return undefined;
  return (last.items as TodoItem[])
    .flatMap((item) => {
      const text = typeof item?.text === "string" ? item.text.trim().slice(0, workpadLimits.planText) : "";
      if (!text) return [];
      const status =
        item.status === "pending" || item.status === "in_progress" || item.status === "completed"
          ? item.status
          : item.completed === true
            ? "completed"
            : "pending";
      return [{ text, status } as const];
    })
    .slice(0, workpadLimits.planItems);
}

/** A card's plans, the most recently updated first. */
export function plansOf(plans: readonly PlanSnapshot[], taskId: string) {
  return plans.filter((p) => p.taskId === taskId).sort((a, b) => b.at.localeCompare(a.at));
}

export function workpadOf(workpads: readonly Workpad[] | undefined, taskId: string) {
  return workpads?.find((w) => w.taskId === taskId) ?? null;
}
