import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "./modal";
import { CheckRow } from "./wrapup";
import type { Task } from "../shared/model";
import * as rpc from "../shared/rpc";
import { Actions, Button, Field, Label, Notice, Theme, font, message, monoFont, radius, relativeTime, space, toneColor, useTheme } from "./ui";
import { t, tn } from "../shared/i18n";

export type SwitchDirection = "to_worktree" | "to_local";
export type SwitchDone = { text: string; warnings: string[] };

const operationId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** A fresh operation per opening: a retry of the same opening reuses it (WORKSPACE-SWITCH-SPEC §3.3). */
function useOperation(open: boolean, prefix: string) {
  const [id, setId] = useState(() => operationId(prefix));
  useEffect(() => {
    if (open) setId(operationId(prefix));
  }, [open]);
  return id;
}

type Compare = rpc.SwitchCompare;
type Folder = Compare["folders"][number];
const FIRST_ROWS = 40;

/** How many files of a folder changed on one side (§9.1). */
const filesText = (count: number) => (count ? tn(count, "{n} file", "{n} files") : "—");

/** One side of Switch to local: branch, commits the other side lacks, the last commits. */
function BranchColumn({ title, icon, side, other }: { title: string; icon: string; side: Compare["worktree"]; other: string }) {
  const { colors } = useTheme();
  const small = { fontSize: font.xs, lineHeight: Math.round(font.xs * 1.45) };
  return (
    <View style={{ flexGrow: 1, flexBasis: 220, minWidth: 0, gap: space[1.5], borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: space[3] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
        <Icon name={icon} size={14} color={colors.foregroundMuted} />
        <Label medium size={font.sm}>
          {title}
        </Label>
      </View>
      <Label mono size={font.sm} lines={1} selectable>
        {side.branch}
      </Label>
      {!!side.notInOther && (
        <Label muted size={font.xs}>
          {tn(side.notInOther, "{n} commit not in {branch}", "{n} commits not in {branch}", { branch: other })}
        </Label>
      )}
      {side.commits.map((c) => (
        <View key={c.sha} style={{ flexDirection: "row", gap: space[1.5] }}>
          <Text style={{ ...small, fontFamily: monoFont, color: colors.foregroundMuted }}>{c.sha.slice(0, 7)}</Text>
          <Text numberOfLines={1} style={{ ...small, flex: 1, minWidth: 0, color: colors.foreground }}>
            {c.subject}
          </Text>
          <Text style={{ ...small, color: colors.foregroundMuted }}>{relativeTime(c.at)}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The worktree and the main checkout side by side (§9.1): branches, and the
 * changes per folder (first two levels) to show what kind of changes they are.
 */
function CompareView({ compare }: { compare: Compare }) {
  const { colors } = useTheme();
  const [all, setAll] = useState(false);
  const rows = all ? compare.folders : compare.folders.slice(0, FIRST_ROWS);
  const outcomes = compare.folders.some((f) => f.apply || f.present || f.conflicts);
  const small = { fontSize: font.xs, lineHeight: Math.round(font.xs * 1.45) };
  const outcome = (f: Folder) =>
    f.conflicts
      ? { text: tn(f.conflicts, "{n} conflict", "{n} conflicts"), color: toneColor(colors, "danger") }
      : f.apply
        ? { text: t("copies"), color: toneColor(colors, "success") }
        : f.present
          ? { text: t("already there"), color: colors.foregroundMuted }
          : { text: "", color: colors.foregroundMuted };
  const line = (cells: { text: string; color: string; mono?: boolean }[], key: string, first: boolean) => (
    <View
      key={key}
      style={{ flexDirection: "row", gap: space[2], paddingHorizontal: space[2], paddingVertical: space[1], borderTopWidth: first ? 0 : 1, borderColor: colors.border }}
    >
      {cells.map((cell, i) => (
        <Text
          key={i}
          numberOfLines={1}
          ellipsizeMode={i === 0 ? "head" : "tail"}
          selectable={i === 0}
          style={{ ...small, color: cell.color, fontFamily: cell.mono ? monoFont : undefined, ...(i === 0 ? { flex: 1, minWidth: 0 } : { width: i === 3 ? 84 : 76 }) }}
        >
          {cell.text}
        </Text>
      ))}
    </View>
  );
  return (
    <View style={{ gap: space[3] }}>
      <View style={{ gap: space[2] }}>
        <Label medium size={font.sm} muted>
          {t("Branches")}
        </Label>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
          <BranchColumn title={t("Worktree")} icon="GitBranch" side={compare.worktree} other={compare.main.branch} />
          <BranchColumn title={t("Main checkout")} icon="Folder" side={compare.main} other={compare.worktree.branch} />
        </View>
      </View>
      {compare.totals.files > 0 && (
        <View style={{ gap: space[2] }}>
          <Label medium size={font.sm} muted>
            {t("Changed files")}
          </Label>
          <Label muted size={font.sm}>
            {t("Changed files: {worktree} in the worktree, {main} in the main checkout, {both} in both.", compare.totals)}
          </Label>
          <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden" }}>
            {line(
              [
                { text: t("Folder"), color: colors.foregroundMuted },
                { text: t("Worktree"), color: colors.foregroundMuted },
                { text: t("Main checkout"), color: colors.foregroundMuted },
                ...(outcomes ? [{ text: "", color: colors.foregroundMuted }] : []),
              ],
              "header",
              true,
            )}
            {rows.map((folder) =>
              line(
                [
                  { text: folder.path, color: colors.foreground, mono: true },
                  { text: filesText(folder.worktree), color: folder.worktree ? colors.foreground : colors.foregroundMuted },
                  { text: filesText(folder.main), color: folder.main ? colors.foreground : colors.foregroundMuted },
                  ...(outcomes ? [outcome(folder)] : []),
                ],
                folder.path,
                false,
              ),
            )}
          </View>
          {!all && compare.folders.length > FIRST_ROWS && (
            <View style={{ flexDirection: "row" }}>
              <Button small quiet onPress={() => setAll(true)}>
                {t("Show all ({n})", { n: compare.folders.length })}
              </Button>
            </View>
          )}
          {compare.totals.folders > compare.folders.length && (
            <Label muted size={font.xs}>
              {t("Showing {shown} of {total}.", { shown: compare.folders.length, total: compare.totals.folders })}
            </Label>
          )}
        </View>
      )}
    </View>
  );
}

type Choice = "copy" | "overwrite" | "discard";

/**
 * Switch a card between the main checkout and its own worktree
 * (WORKSPACE-SWITCH-SPEC §3.1, §9): preflight, optional handover request, run.
 * Switching to local with uncommitted worktree changes offers Copy, Overwrite
 * and Discard next to the side-by-side comparison (§9.1).
 */
export function SwitchModal({
  task,
  direction,
  open,
  onClose,
  onDone,
}: {
  task: Task;
  direction: SwitchDirection;
  open: boolean;
  onClose(): void;
  onDone(result: SwitchDone): void;
}) {
  const theme = useTheme();
  const checkRead = useRpc(rpc.switchCheck),
    runSwitch = useRpc(rpc.switchWorkspace),
    ask = useRpc(rpc.askHandover);
  const [pending, setPending] = useState<Choice | "switch" | null>(null),
    [error, setError] = useState(""),
    [branch, setBranch] = useState(""),
    [asked, setAsked] = useState("");
  const busy = pending !== null;
  const op = useOperation(open, "switch");
  useEffect(() => {
    if (open) {
      setBranch("");
      setAsked("");
      setError("");
    }
  }, [open]);
  const check = useQuery({
    queryKey: ["flowly", "switch", task.id, task.revision, direction],
    queryFn: () => checkRead({ id: task.id, direction }),
    enabled: open,
    gcTime: 0,
    staleTime: 0,
    // A handover requested from here arrives while the dialog is open.
    refetchInterval: asked ? 5000 : false,
  });
  const data = check.data;
  const blocked = !data || data.blockers.length > 0;
  const warned = !!data?.warnings.length;
  const toWorktree = direction === "to_worktree";
  // Uncommitted worktree changes (to_local, §9): copy, overwrite or discard them.
  const uncommitted = !toWorktree ? data?.worktree?.uncommitted ?? 0 : 0;
  const copyBack = !toWorktree ? data?.worktree?.copyBack ?? null : null;
  const conflicts = copyBack?.conflicts.length ?? 0;
  const off = blocked || busy || check.isFetching;
  async function confirm(choice: Choice | "switch") {
    if (!data || busy) return;
    setPending(choice);
    setError("");
    try {
      const result = await runSwitch({
        id: task.id,
        revision: data.revision,
        operationId: op,
        direction,
        ...(toWorktree && branch.trim() ? { branchName: branch.trim() } : {}),
        ...(choice !== "switch" ? { uncommitted: choice } : {}),
      });
      onDone({
        text: toWorktree
          ? t("Card moved to worktree {branch}. Start a session to continue.", { branch: result.branch || "" })
          : t("Card moved to the main checkout. Start a session to continue."),
        warnings: result.warnings,
      });
    } catch (e) {
      setError(message(e));
      void check.refetch();
    } finally {
      setPending(null);
    }
  }
  async function askHandover(agentId: string, title: string) {
    setError("");
    try {
      await ask({ id: task.id, agentId });
      setAsked(t("Asked {session} for a handover.", { session: title }));
    } catch (e) {
      setError(message(e));
    }
  }
  const files = data?.copy ? data.copy.tracked + data.copy.untracked : 0;
  const label = (choice: Choice | "switch", text: string) => (pending === choice ? t("Switching…") : text);
  return (
    <Modal
      open={open}
      title={toWorktree ? t("Switch to worktree") : t("Switch to local")}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          <Label size={font.base}>
            {toWorktree
              ? t("Copies every uncommitted change of the main checkout into a new worktree for this card. The main checkout is not changed until you release.")
              : t("Moves the card back to the main checkout. Archives the worktree workspace and its sessions; Paseo may remove the worktree folder, the branch is kept.")}
          </Label>
          {check.isPending ? (
            <Label muted>{t("Checking…")}</Label>
          ) : check.error ? (
            <Notice>{message(check.error)}</Notice>
          ) : data ? (
            <View style={{ gap: space[3] }}>
              {toWorktree && (
                <Field title={t("New branch (optional)")} value={branch} onChange={setBranch} placeholder={data.branchName} editable={!busy} />
              )}
              <View style={{ gap: space[2] }}>
                {data.blockers.map((text) => (
                  <CheckRow key={text} tone="block" text={text} />
                ))}
                {data.warnings.map((text) => (
                  <CheckRow key={text} tone="warn" text={text} />
                ))}
                {toWorktree && data.mainBranch && data.base && (
                  <CheckRow tone="ok" text={t("Base: {branch} at {commit}", { branch: data.mainBranch, commit: data.base.slice(0, 7) })} />
                )}
                {toWorktree && data.copy && (
                  <CheckRow tone="ok" text={files ? tn(files, "{n} file to copy", "{n} files to copy") : t("Nothing uncommitted to copy.")} />
                )}
                {toWorktree && data.handover && (
                  <CheckRow tone="ok" text={tn(data.handover.files, "Handover from {session}: {n} file", "Handover from {session}: {n} files", { session: data.handover.session })} />
                )}
                <CheckRow
                  tone="ok"
                  text={
                    data.archiveWorkspace
                      ? tn(data.sessions, "Archives the current workspace and its {n} session.", "Archives the current workspace and its {n} sessions.")
                      : tn(data.sessions, "Archives this card's {n} session in the current workspace.", "Archives this card's {n} sessions in the current workspace.")
                  }
                />
                {copyBack && (
                  <CheckRow
                    tone="warn"
                    text={tn(uncommitted, "The worktree has {n} uncommitted change (staged, unstaged or untracked).", "The worktree has {n} uncommitted changes (staged, unstaged or untracked).")}
                  />
                )}
                {!!conflicts && (
                  <CheckRow tone="warn" text={tn(conflicts, "{n} file has changes in both that don't fit together.", "{n} files have changes in both that don't fit together.")} />
                )}
                {copyBack?.busy && <CheckRow tone="block" text={t("Can't copy while the main checkout is in the middle of a {operation}.", { operation: copyBack.busy })} />}
              </View>
              {!toWorktree && data.compare && <CompareView compare={data.compare} />}
              {copyBack && (
                <View style={{ gap: space[1] }}>
                  <Label muted size={font.sm}>
                    {t("Copy: adds the worktree's changes and new files to the main checkout as unstaged changes; only possible when nothing conflicts.")}
                  </Label>
                  <Label muted size={font.sm}>
                    {t("Overwrite: copies too, and where both changed a file in ways that don't fit together, the worktree's version replaces the main checkout's (which is saved in the handoff folder first).")}
                  </Label>
                  <Label muted size={font.sm}>
                    {t("Discard: nothing reaches the main checkout; the changes stay in the archived worktree, which Paseo may remove.")}
                  </Label>
                  <Label muted size={font.sm}>
                    {t("Either way a patch of the worktree's changes is kept in the handoff folder.")}
                  </Label>
                </View>
              )}
              {toWorktree && !!data.idleSessions.length && (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
                  {data.idleSessions.slice(0, 3).map((s) => (
                    <Button key={s.id} small icon="MessageSquareText" disabled={busy} onPress={() => void askHandover(s.id, s.title)}>
                      {t("Ask {session} for a handover", { session: s.title })}
                    </Button>
                  ))}
                </View>
              )}
              {!!asked && <Notice tone="info">{asked}</Notice>}
            </View>
          ) : null}
          {!!error && <Notice>{error}</Notice>}
          <Actions>
            <Button quiet disabled={busy} onPress={onClose}>
              {t("Cancel")}
            </Button>
            {copyBack ? (
              <>
                <Button icon="Trash2" disabled={off} onPress={() => void confirm("discard")}>
                  {label("discard", t("Discard changes and switch"))}
                </Button>
                <Button danger icon="RefreshCw" disabled={off || !!copyBack.busy} onPress={() => void confirm("overwrite")}>
                  {label("overwrite", t("Overwrite changes and switch"))}
                </Button>
                <Button primary icon="Copy" disabled={off || !!copyBack.busy || !!conflicts} onPress={() => void confirm("copy")}>
                  {label("copy", t("Copy changes and switch"))}
                </Button>
              </>
            ) : (
              <Button primary={!warned} danger={warned} icon={toWorktree ? "GitBranch" : "Folder"} disabled={off} onPress={() => void confirm("switch")}>
                {label("switch", warned ? t("Switch anyway") : toWorktree ? t("Switch to worktree") : t("Switch to local"))}
              </Button>
            )}
          </Actions>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/** Release from main (WORKSPACE-SWITCH-SPEC §5): the files, warnings, then the checked removal. */
export function ReleaseModal({ task, open, onClose, onDone }: { task: Task; open: boolean; onClose(): void; onDone(text: string): void }) {
  const theme = useTheme();
  const checkRead = useRpc(rpc.releaseCheck),
    runRelease = useRpc(rpc.releaseChanges);
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const op = useOperation(open, "release");
  const check = useQuery({
    queryKey: ["flowly", "release", task.id, task.revision],
    queryFn: () => checkRead({ id: task.id }),
    enabled: open,
    gcTime: 0,
    staleTime: 0,
  });
  const data = check.data;
  const blocked = !data || data.blockers.length > 0;
  const warned = !!data?.warnings.length;
  async function confirm() {
    if (!data || pending) return;
    setPending(true);
    setError("");
    try {
      const result = await runRelease({ id: task.id, revision: data.revision, operationId: op, patchHash: data.patchHash, acknowledgeWarnings: warned });
      onDone(tn(result.files, "Released {n} file from the main checkout.", "Released {n} files from the main checkout."));
    } catch (e) {
      setError(message(e));
      void check.refetch();
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      open={open}
      title={t("Release from main")}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          <Label size={font.base}>{t("Removes exactly these changes from the main checkout. A backup is kept.")}</Label>
          {check.isPending ? (
            <Label muted>{t("Checking…")}</Label>
          ) : check.error ? (
            <Notice>{message(check.error)}</Notice>
          ) : data ? (
            <View style={{ gap: space[3] }}>
              {!!data.files.length && (
                <View style={{ gap: space[1], borderRadius: radius.md, borderWidth: 1, borderColor: theme.colors.border, padding: space[3] }}>
                  {data.files.slice(0, 100).map((f) => (
                    <Label key={f.path} mono size={font.sm} selectable>
                      {`${f.path}  +${f.added} −${f.removed}`}
                    </Label>
                  ))}
                </View>
              )}
              <View style={{ gap: space[2] }}>
                {data.blockers.map((text) => (
                  <CheckRow key={text} tone="block" text={text} />
                ))}
                {data.warnings.map((text) => (
                  <CheckRow key={text} tone="warn" text={text} />
                ))}
              </View>
            </View>
          ) : null}
          {!!error && <Notice>{error}</Notice>}
          <Actions>
            <Button quiet disabled={pending} onPress={onClose}>
              {t("Cancel")}
            </Button>
            <Button primary={!warned} danger={warned} icon="GitPullRequestArrow" disabled={blocked || pending || check.isFetching} onPress={() => void confirm()}>
              {pending ? t("Releasing…") : warned ? t("Release anyway") : t("Release")}
            </Button>
          </Actions>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/** The card sidebar's notice while the main checkout still holds the card's copied changes (§5.1). */
export function ReleaseNotice({ onRelease, disabled }: { onRelease(): void; disabled?: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        gap: space[2],
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        borderRadius: radius.lg,
        padding: space[3],
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <Icon name="GitBranch" size={16} color={colors.statusWarning} />
        <Label medium>{t("Release pending")}</Label>
      </View>
      <Label muted size={font.sm}>
        {t("The main checkout still holds a copy of this card's changes. Trim the worktree to this card's changes, then release them from main.")}
      </Label>
      <View style={{ flexDirection: "row" }}>
        <Button small icon="GitPullRequestArrow" disabled={disabled} onPress={onRelease}>
          {t("Release from main…")}
        </Button>
      </View>
    </View>
  );
}
