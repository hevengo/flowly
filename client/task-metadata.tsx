import type { ReactNode } from "react";
import { View } from "react-native";
import { taskTypeLabels, type Task, type Project } from "../shared/model";
import { Section } from "./disclosure";
import { Button, Label, Notice, basename, font, space } from "./ui";
import { priorityLabels, workspaceLabels } from "./status";
import type { CardWorkspace } from "../shared/card-display";
import { formatLocale, t } from "../shared/i18n";

function MetaRow({ label, value, mono = false, trailing }: { label: string; value: string; mono?: boolean; trailing?: ReactNode }) {
  return <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[3], minWidth: 0 }}>
    <View style={{ width: 96 }}><Label muted size={font.sm}>{label}</Label></View>
    <View style={{ flex: 1, minWidth: 0 }}><Label selectable size={mono ? font.sm : font.md} mono={mono}>{value}</Label></View>
    {trailing}
  </View>;
}

export function TaskMetadata({ task, project, open, onToggle, summary, legacy,
  workspaceName, workspaceDirectory, workspaceStatus, owner, directories, place, onSwitch,
}: {
  task: Task;
  project: Project;
  open: boolean;
  onToggle(): void;
  summary?: string;
  legacy: boolean;
  workspaceName?: string;
  workspaceDirectory?: string;
  workspaceStatus: string;
  owner?: string;
  directories: { repo: string; directory: string }[];
  /** Worktree or local (CARD-DISPLAY-SPEC §8); unknown without a live workspace. */
  place?: CardWorkspace | null;
  /** Opens the workspace switch (WORKSPACE-SWITCH-SPEC §3.1); absent when the card can't switch. */
  onSwitch?: () => void;
}) {
  return <Section id={task.id} title={t("Details & workspace")} summary={summary} open={open} onToggle={onToggle}>
    <MetaRow label={t("Type")} value={task.type ? taskTypeLabels[task.type] : "None"} />
    <MetaRow label={t("Priority")} value={priorityLabels[task.priority]} />
    {!!task.tags?.length && <MetaRow label={t("Tags")} value={task.tags.map((x) => x.tag).join(", ")} />}
    <MetaRow label={t("Project")} value={project.title} />
    <MetaRow label={t("Project root")} value={project.primaryPath} mono />
    <MetaRow
      label={t("Workspace")}
      value={place ? `${workspaceName || task.workspaceId} · ${workspaceLabels[place]}` : workspaceName || task.workspaceId}
      trailing={onSwitch && place ? (
        <Button small icon={place === "worktree" ? "Folder" : "GitBranch"} onPress={onSwitch}>
          {place === "worktree" ? t("Switch to local…") : t("Switch to worktree…")}
        </Button>
      ) : undefined}
    />
    <MetaRow label={t("Workspace ID")} value={task.workspaceId} mono />
    <MetaRow label={t("Directory")} value={workspaceDirectory || task.sourcePath} mono />
    <MetaRow label={t("Execution")} value={workspaceStatus} />
    <MetaRow label={t("Native owner")} value={owner || t("Checking…")} />
    <MetaRow label={t("Created")} value={new Date(task.createdAt).toLocaleString(formatLocale())} />
    <MetaRow label={t("Updated")} value={new Date(task.updatedAt).toLocaleString(formatLocale())} />
    {legacy && <>
      <Notice tone="info">{t("Legacy card scope is preserved. Its saved directories and workspace stay linked.")}</Notice>
      {directories.map((path) => <MetaRow key={path.repo} label={basename(path.repo)} value={path.directory} mono />)}
    </>}
  </Section>;
}
