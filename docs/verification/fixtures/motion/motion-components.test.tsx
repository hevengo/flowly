import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { motionMockState } from "./rn-motion-mock";

const fixture = vi.hoisted(() => ({
  board: undefined as any,
  resources: undefined as any,
  agents: [] as any[],
  updateTask: vi.fn(async () => undefined),
  queryOptions: [] as any[],
  columnProps: undefined as any,
}));

vi.mock("react-native", async () => ({
  ...(await import("./rn-motion-mock")).createReactNativeMotionMock(),
  View: "View", Text: "Text", Pressable: "Pressable", PanResponder: { create: () => ({ panHandlers: {} }) },
}));
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const React = await import("react");
  const host = (type: string) => ({ children, ...props }: any) => React.createElement(type, props, children);
  const Modal: any = host("Modal");
  Modal.Content = host("ModalContent");
  return { ...(await import("./rn-motion-mock")).createHostToastMock(), Icon: "Icon", ScrollView: "ScrollView", TextInput: "TextInput", Modal };
});
vi.mock("@getpaseo/plugin/client", () => ({
  usePaseo: () => ({ agents: { ref: () => ({ refresh: vi.fn(), timeline: { subscribe: vi.fn() } }) } }),
  useRpc: (key: string) => key === "updateTask" ? fixture.updateTask : vi.fn(async () => ({})),
}));
vi.mock("@tanstack/react-query", async () => {
  const React = await import("react");
  return {
    useQueryClient: () => ({ cancelQueries: vi.fn(), setQueryData: vi.fn() }),
    useQuery: (options: any) => {
      fixture.queryOptions.push(options);
      const key = options.queryKey as unknown[];
      if (key[1] === "board") return { data: fixture.board, isPending: false, isError: false, refetch: vi.fn() };
      if (key[1] === "resources") return { data: fixture.resources, isPending: false, isError: false, refetch: vi.fn() };
      if (key[1] === "activity") return { data: fixture.agents, isPending: false, isError: false, refetch: vi.fn() };
      return { data: undefined, isPending: false, isError: false, refetch: vi.fn() };
    },
  };
});
vi.mock("../../../../shared/rpc", () => ({ readBoard: "readBoard", listResources: "listResources", updateProject: "updateProject", updateTask: "updateTask", moveTask: "moveTask", readSessionReceipts: "readSessionReceipts" }));
vi.mock("../../../../client/resources", () => ({ listAgents: vi.fn(async () => fixture.agents) }));
vi.mock("../../../../client/session-reads", () => ({ useSessionReads: () => ({ query: { data: { receipts: [] }, isPending: false, isError: false, refetch: vi.fn() }, receipts: [] }) }));
vi.mock("../../../../client/ui", async () => {
  const React = await import("react");
  const host = (type: string) => ({ children, ...props }: any) => React.createElement(type, props, children);
  return {
    Theme: React.createContext(null), Button: host("Button"), Label: host("Label"), Field: host("Field"), Choices: host("Choices"), Notice: host("Notice"),
    useTheme: () => ({ colors: { accent: "accent", border: "border", surface0: "surface", surface1: "surface1", surface2: "surface2", foreground: "fg", foregroundMuted: "muted" } }),
    message: (error: any) => String(error?.message ?? error), basename: (path: string) => path.split("/").at(-1),
  };
});
vi.mock("../../../../client/forms", () => ({ ProjectForm: () => null, TaskForm: () => null }));
vi.mock("../../../../client/drawer", async () => {
  const React = await import("react");
  return { TaskDrawer: (props: any) => React.createElement("Drawer", { active: props.active, width: props.width }, React.createElement("Button", { onPress: props.onClose }, "Close drawer")) };
});
vi.mock("../../../../client/resize", async () => {
  const React = await import("react");
  return { ResizeGrip: (props: any) => React.createElement("Grip", { width: props.width }) };
});
vi.mock("../../../../client/card", async () => {
  const React = await import("react");
  return { TaskCard: (props: any) => React.createElement("Card", { onOpen: props.onOpen, title: props.task.title }, props.task.title) };
});
vi.mock("../../../../client/columns", async () => {
  const React = await import("react");
  return { DesktopColumns: (props: any) => {
    fixture.columnProps = props;
    return React.createElement("Columns", null,
      ...props.tasks.map((task: any) => props.renderCard(task)),
      React.createElement("Drop", { onPress: () => props.onDrop({ id: "task-1", revision: 4, status: "development" }) }, "drop"));
  } };
});
vi.mock("../../../../client/geometry", () => ({ defaultDrawerShare: 0.5, drawerShare: (width: number, surface: number) => width / surface, drawerWidth: (preferred: number) => preferred, isCompactLayout: () => false }));
vi.mock("../../../../client/session-link", () => ({ parseSessionLink: () => null, resolveSessionLink: vi.fn(), sessionLinkKey: vi.fn(), }));

const rendererPath = process.env.MOTION_TEST_RENDERER;
const renderer = rendererPath ? require(rendererPath) : null;
const { act, create } = renderer || { act: (fn: () => unknown) => fn(), create: () => undefined };
const { BoardScreen } = await import("../../../../client/board");

const task: any = { id: "task-1", projectId: "project-1", workspaceId: "workspace-1", sourcePath: "/fixture", repoPaths: ["/fixture"], title: "Fixture task", description: "", status: "todo", priority: "normal", position: 0, revision: 4, operationId: "op-1", createdAt: "2026-10-14", updatedAt: "2026-10-14", archivedAt: null };
const project: any = { id: "project-1", nativeProjectId: "native-project", title: "Fixture project", primaryPath: "/fixture", revision: 1 };
const theme: any = { colors: { accent: "accent", accentForeground: "white", border: "border", foreground: "fg", foregroundMuted: "muted", surface0: "surface", surface1: "surface1", surface2: "surface2" } };
const props: any = { host: { id: "host-fixture" }, theme, layout: { compact: false, platform: "web" }, navigation: {} };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };
const strings = (node: any): string => typeof node === "string" ? node : Array.isArray(node) ? node.map(strings).join(" ") : node?.children ? node.children.map(strings).join(" ") : "";

beforeEach(() => {
  motionMockState.reset();
  fixture.board = { projects: [project], tasks: [task], events: [] };
  fixture.resources = { workspaces: [{ id: task.workspaceId }] };
  fixture.agents = [];
  fixture.queryOptions = [];
  fixture.columnProps = undefined;
  fixture.updateTask = vi.fn(async () => undefined);
  motionMockState.toastShow = vi.fn();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => vi.clearAllMocks());

describe.skipIf(!rendererPath)("board motion focused renderer", () => {
  test("status drop uses native success toast only; failure has actionable error and no toast", async () => {
    let tree: any;
    await act(async () => { tree = create(<BoardScreen {...props} />); await flush(); });
    await act(async () => { tree.root.findByType("Drop").props.onPress(); await flush(); });
    expect(motionMockState.toastShow).toHaveBeenCalledWith("Moved to In progress", { variant: "success" });
    expect(tree.root.findAllByType("Label").map((n: any) => strings(n))).not.toContain("Moved to In progress");
    expect(tree.root.findAllByType("Notice")).toHaveLength(0);

    fixture.updateTask.mockRejectedValueOnce(new Error("Revision is stale; refresh and try again."));
    await act(async () => { tree.root.findByType("Drop").props.onPress(); await flush(); });
    expect(motionMockState.toastShow).toHaveBeenCalledTimes(1);
    expect(tree.root.findAllByType("Notice").map((n: any) => strings(n)).join(" ")).toContain("Revision is stale");
    tree.unmount();
  });

  test("drawer uses resize-grip width and retains its inert shell and grip until exit completes", async () => {
    let tree: any;
    await act(async () => { tree = create(<BoardScreen {...props} />); await flush(); });
    await act(async () => { tree.root.findByType("Card").props.onOpen(); await flush(); });
    let shell = tree.root.findByProps({ testID: "task-drawer-motion" });
    expect(shell.props.style.width).toBe(452);
    expect(tree.root.findByType("Grip").props.width).toBe(440);
    expect(shell.props.pointerEvents).toBe("auto");

    await act(async () => { tree.root.findByType("Drawer").findByType("Button").props.onPress(); await flush(); });
    shell = tree.root.findByProps({ testID: "task-drawer-motion" });
    expect(shell.props.pointerEvents).toBe("none");
    expect(shell.props.accessibilityElementsHidden).toBe(true);
    expect(tree.root.findByType("Drawer").props.active).toBe(false);
    expect(tree.root.findByType("Grip")).toBeTruthy();
    expect(motionMockState.animations.some((animation) => animation.config.duration === 160)).toBe(true);
    tree.unmount();
  });
});
