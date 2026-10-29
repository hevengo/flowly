import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  board: {} as any,
  route: undefined as any,
  rpc: {} as Record<string, any>,
  queryClient: { cancelQueries: vi.fn(async () => undefined), setQueryData: vi.fn() },
  queryOptions: [] as any[],
  drawerProps: [] as any[],
}));

vi.mock("react-native", async () => ({ ...(await import("../motion/rn-motion-mock")).createReactNativeMotionMock(), View: "View", Pressable: "Pressable", Text: "Text", Platform: { OS: "web" } }));
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const React = await import("react");
  const motion = await import("../motion/rn-motion-mock");
  const Modal: any = ({ children, ...props }: any) => React.createElement("Modal", props, children);
  Modal.Content = ({ children, ...props }: any) => React.createElement("ModalContent", props, children);
  return { ...motion.createHostToastMock(), Modal, ScrollView: "ScrollView" };
});
vi.mock("@getpaseo/plugin/client", () => ({
  usePaseo: () => ({}),
  useRpc: (key: string) => fixture.rpc[key],
  useQueryClient: () => fixture.queryClient,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => fixture.queryClient,
  useQuery: (options: any) => {
    fixture.queryOptions.push(options);
    const key = options.queryKey as unknown[];
    if (key[1] === "cardLink") return { data: fixture.route, isPending: false, error: null, refetch: vi.fn() };
    if (key[1] === "board") return { data: fixture.board, isPending: false, error: null, refetch: vi.fn() };
    if (key[1] === "resources") return { data: { workspaces: [] }, isPending: false, refetch: vi.fn() };
    if (key[1] === "activity") return { data: [], isPending: false, refetch: vi.fn() };
    return { data: undefined, isPending: false, refetch: vi.fn() };
  },
}));
vi.mock("../../../../shared/rpc", () => ({ readBoard: "readBoard", listResources: "listResources", updateProject: "updateProject", updateTask: "updateTask", moveTask: "moveTask" }));
vi.mock("../../../../client/resources", () => ({ listAgents: async () => [] }));
vi.mock("../../../../client/session-reads", () => ({ useSessionReads: () => ({ query: { data: {}, isPending: false, isError: false, refetch: vi.fn() }, receipts: [] }) }));
vi.mock("../../../../shared/session-attention", () => ({ sessionAttentionSummary: () => ({}) }));
vi.mock("../../../../shared/scope", () => ({ isLegacyScope: () => false }));
vi.mock("../../../../client/forms", () => ({ ProjectForm: () => null, TaskForm: () => null }));
vi.mock("../../../../client/drawer", async () => {
  const React = await import("react");
  return { TaskDrawer: (props: any) => {
    fixture.drawerProps.push(props);
    return React.createElement("TaskDrawer", props);
  } };
});
vi.mock("../../../../client/card", async () => {
  const React = await import("react");
  return { TaskCard: (props: any) => React.createElement("TaskCard", props) };
});
vi.mock("../../../../client/columns", async () => {
  const React = await import("react");
  return { DesktopColumns: (props: any) => React.createElement("DesktopColumns", props, ...props.tasks.map((task: any) => props.renderCard(task))) };
});
vi.mock("../../../../client/resize", () => ({ ResizeGrip: () => null }));
vi.mock("../../../../client/geometry", () => ({ defaultDrawerShare: 0.5, drawerShare: (width: number, surface: number) => width / surface, drawerWidth: () => 440, isCompactLayout: () => false }));
vi.mock("../../../../client/ui", async () => {
  const React = await import("react");
  const primitive = (type: string) => ({ children, ...props }: any) => React.createElement(type, props, children);
  return {
    Theme: { Provider: ({ children }: any) => children },
    Button: primitive("Button"), Label: primitive("Label"), Field: primitive("Field"), Choices: primitive("Choices"), Notice: primitive("Notice"),
    message: (error: any) => String(error?.message ?? error),
  };
});

const rendererPath = process.env.SESSION_CHIP_RENDERER;
const renderer = rendererPath ? require(rendererPath) : null;
const { act, create } = renderer || { act: (_fn: () => unknown) => {}, create: () => undefined };
const { BoardScreen } = await import("../../../../client/board");

const project: any = { id: "project-target", title: "Target project", nativeProjectId: "native", primaryPath: "/fixture", revision: 1 };
const task: any = { id: "task-target", projectId: project.id, workspaceId: "workspace-target", title: "Target task", description: "", status: "done", priority: "normal", position: 0, revision: 1, operationId: "op", createdAt: "2026-10-14", updatedAt: "2026-10-14", archivedAt: "2026-10-14" };
const actor = (id: string) => ({ id, workspaceId: task.workspaceId });
const board: any = { projects: [project], tasks: [task], events: [] };
const params = (sessionId: string, requestId: string) => ({ taskId: task.id, sessionId, workspaceId: task.workspaceId, requestId });
const routeTarget = (sessionId: string, requestId: string) => ({ board, project, task, actor: actor(sessionId), link: params(sessionId, requestId) });
const propsFor = (screenParams?: any) => ({
  params: screenParams,
  host: { id: "synthetic-host" },
  theme: { colors: { surface0: "surface0", border: "border", foreground: "fg", foregroundMuted: "muted", accent: "accent" } },
  layout: { compact: false, platform: "desktop" },
  navigation: { openAgent: () => undefined, openWorkspace: () => undefined },
} as any);

beforeEach(() => {
  fixture.board = board;
  fixture.route = undefined;
  fixture.queryOptions = [];
  fixture.drawerProps = [];
  fixture.queryClient.cancelQueries.mockClear();
  fixture.queryClient.setQueryData.mockClear();
  fixture.rpc = { readBoard: vi.fn(async () => board), listResources: vi.fn(async () => ({ workspaces: [] })), updateProject: vi.fn(), updateTask: vi.fn(), moveTask: vi.fn() };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => vi.clearAllMocks());

describe.skipIf(!rendererPath)("BoardScreen linked-session entry", () => {
  test("fresh request enters exact archived/finished target; close and manual reopen stay at task details until a new request", async () => {
    let tree: any;
    await act(async () => { tree = create(<BoardScreen {...propsFor()} />); });
    const openFilters = () => tree.root.findAllByType("Button").find((item: any) => item.props.label === "Task filters");
    await act(async () => { openFilters().props.onPress(); });
    const search = tree.root.findAllByType("Field").find((item: any) => item.props.title === "Search tasks");
    const priority = tree.root.findAllByType("Choices").find((item: any) => item.props.title === "Priority");
    act(() => { search.props.onChange("hide target"); priority.props.onChange("high"); });
    await act(async () => { tree.root.findAllByType("Button").find((item: any) => String(item.props.children).includes("Done"))?.props.onPress(); });

    fixture.route = routeTarget("session-a", "nonce-a");
    await act(async () => { tree.update(<BoardScreen {...propsFor(params("session-a", "nonce-a"))} />); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fixture.queryClient.cancelQueries).toHaveBeenCalledWith({ queryKey: ["ultra", "board"], exact: true });
    expect(fixture.queryClient.setQueryData).toHaveBeenCalledWith(["ultra", "board"], board);
    let drawer = tree.root.findByType("TaskDrawer");
    expect(fixture.drawerProps.find((props) => props.sessionEntry?.requestId === "nonce-a")?.sessionEntry).toEqual({ taskId: task.id, sessionId: "session-a", requestId: "nonce-a" });
    await act(async () => { drawer.props.onSessionEntryConsumed("nonce-a"); });
    const columns = tree.root.findByType("DesktopColumns");
    expect(columns.props.statuses).toContain("done");
    expect(columns.props.tasks).toContain(task);
    await act(async () => { openFilters().props.onPress(); });
    expect(tree.root.findAllByType("Field").find((item: any) => item.props.title === "Search tasks")?.props.value).toBe("");
    expect(tree.root.findAllByType("Choices").find((item: any) => item.props.title === "Priority")?.props.value).toBe("all");
    expect(tree.root.findAllByType("Button").some((item: any) => String(item.props.children).includes("Hide archived"))).toBe(true);
    expect(tree.root.findAllByType("Button").some((item: any) => String(item.props.children).includes("Hide finished"))).toBe(true);
    await act(async () => { tree.root.findAllByType("Button").find((item: any) => String(item.props.children).includes("Done"))?.props.onPress(); });

    await act(async () => { drawer.props.onClose(); });
    expect(tree.root.findAllByType("TaskDrawer")).toHaveLength(0);
    expect(tree.root.findByType("DesktopColumns").props.tasks).toContain(task);
    await act(async () => { tree.update(<BoardScreen {...propsFor(params("session-a", "nonce-a"))} />); });
    expect(tree.root.findAllByType("TaskDrawer")).toHaveLength(0);

    const card = tree.root.findByType("TaskCard");
    await act(async () => { card.props.onOpen(); });
    drawer = tree.root.findByType("TaskDrawer");
    expect(drawer.props.sessionEntry).toBeUndefined();
    expect(drawer.props.task.id).toBe(task.id);

    fixture.route = routeTarget("session-a", "nonce-b");
    await act(async () => { tree.update(<BoardScreen {...propsFor(params("session-a", "nonce-b"))} />); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    drawer = tree.root.findByType("TaskDrawer");
    expect(fixture.drawerProps.find((props) => props.sessionEntry?.requestId === "nonce-b")?.sessionEntry).toEqual({ taskId: task.id, sessionId: "session-a", requestId: "nonce-b" });
    tree.unmount();
  });

  test("same nonce with a different session replaces the entry and stale consume callback cannot clear it", async () => {
    let tree: any;
    fixture.route = routeTarget("session-a", "shared-nonce");
    await act(async () => { tree = create(<BoardScreen {...propsFor(params("session-a", "shared-nonce"))} />); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const oldDrawer = fixture.drawerProps.find((props) => props.sessionEntry?.sessionId === "session-a");
    fixture.route = routeTarget("session-b", "shared-nonce");
    await act(async () => { tree.update(<BoardScreen {...propsFor(params("session-b", "shared-nonce"))} />); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const newDrawer = tree.root.findByType("TaskDrawer");
    expect(fixture.drawerProps.filter((props) => props.sessionEntry?.sessionId === "session-b").at(-1)?.sessionEntry).toEqual({ taskId: task.id, sessionId: "session-b", requestId: "shared-nonce" });
    await act(async () => { oldDrawer.onSessionEntryConsumed("shared-nonce"); });
    expect(tree.root.findByType("TaskDrawer").props.sessionEntry).toEqual({ taskId: task.id, sessionId: "session-b", requestId: "shared-nonce" });
    tree.unmount();
  });
});
