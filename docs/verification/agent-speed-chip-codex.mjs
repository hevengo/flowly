// Fixture for the Codex half of the Speed chip live check (agent-speed-chip-shots.mjs): one temporary card in
// PROJECT (default: the Tinylink demo project) and one Codex session at Fast (service_tier "priority"), created
// WITHOUT a prompt, so no turn runs. `remove` archives the session and deletes only that card (with its own workspace).
// Usage: [PROJECT=<title>] node docs/verification/agent-speed-chip-codex.mjs setup|remove   (ids: /tmp/flowly-speed-chip.json)
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';

export const CARD_TITLE = 'Speed chip check (temp)';
const idsFile = '/tmp/flowly-speed-chip.json';
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `verify-${randomUUID()}`, clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client);
const rpc = (m, i) => client.invokePluginRpc('flowly', m, i);
const save = (fx) => writeFileSync(idsFile, JSON.stringify(fx, null, 2));
try {
  await client.connect();
  if (process.argv[2] === 'remove') {
    const fx = JSON.parse(readFileSync(idsFile, 'utf8'));
    const board = await rpc('board.read', {});
    const card = board.tasks.find((t) => t.id === fx.card && t.title === CARD_TITLE);
    if (card) {
      // Archives the card's sessions and its own workspace, then deletes the card.
      console.log('delete', JSON.stringify(await rpc('tasks.delete', { id: card.id, revision: card.revision, archive: true, acknowledgeWarnings: true })));
    } else console.log('card already gone', fx.card);
    const after = await rpc('board.read', {});
    console.log('card on board after remove:', after.tasks.some((t) => t.id === fx.card));
    if (fx.session) {
      const snap = await api.agents.ref(fx.session).refresh().catch(() => null);
      console.log('session archivedAt:', snap?.agent?.archivedAt ?? '(not found)');
    }
    rmSync(idsFile, { force: true });
  } else {
    if (existsSync(idsFile)) throw new Error(`${idsFile} exists: run remove first.`);
    const board = await rpc('board.read', {});
    const title = process.env.PROJECT || 'Tinylink';
    const project = board.projects.find((p) => p.title === title && !p.archivedAt);
    if (!project) throw new Error(`Project ${title} not found.`);
    const fx = { project: project.id, projectTitle: title };
    save(fx);
    const card = await rpc('tasks.create', {
      projectId: project.id, operationId: `verify-speed-${randomUUID()}`, title: CARD_TITLE,
      description: 'Temporary fixture for the composer Speed chip live check. Removed by agent-speed-chip-codex.mjs remove.',
      status: 'todo', priority: 'low', type: 'chore', mode: 'directory',
    });
    fx.card = card.id; fx.workspace = card.workspaceId; save(fx);
    const prep = await rpc('tools.prepare-session', { id: card.id, operationId: `verify-speed-session-${randomUUID()}` });
    fx.session = prep.agentId; save(fx);
    const s = await api.workspaces.ref(card.workspaceId).agents.create({
      agentId: prep.agentId, idempotencyKey: `verify-speed:${prep.agentId}`, title: 'Codex · Speed chip check',
      labels: { 'flowly-task': card.id },
      config: { provider: 'codex/gpt-6.1-sol', featureValues: { service_tier: 'priority' } },
    });
    fx.session = s.id; save(fx);
    const snap = await api.agents.ref(s.id).refresh();
    console.log(JSON.stringify({ ...fx, status: snap?.agent?.status, features: snap?.agent?.features }, null, 1));
  }
} finally { await api.dispose().catch(() => {}); await client.close().catch(() => {}); }
