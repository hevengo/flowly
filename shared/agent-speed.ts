/**
 * Model speed as Paseo offers it (AGENT-SPEED-SPEC): not a model field but a
 * provider feature. Codex lists a `service_tier` select ("Speed": Normal plus
 * the model's faster tiers), Claude a `fast_mode` toggle ("Fast", Opus only).
 * Other features (Codex Plan, ACP auto-accept) are not speeds.
 */

/** A provider feature as `providers.listFeatures` and agent snapshots carry it. */
export type ProviderFeature = {
  type: string;
  id: string;
  label: string;
  description?: string;
  value?: unknown;
  options?: readonly { id: string; label: string; description?: string; isDefault?: boolean }[];
};

export type SpeedOption = { id: string; label: string; description?: string };

/** The speed choice of one provider/model: the faster options; normal speed is "" and sends nothing. */
export type SpeedFeature = {
  featureId: string;
  kind: "toggle" | "select";
  /** The provider's own name for its normal speed, when it has one. */
  normalLabel?: string;
  options: SpeedOption[];
};

const TIER = "service_tier";
const FAST = "fast_mode";
/** Option id of the Claude toggle; the same id as Codex's fast tier. */
export const FAST_SPEED = "fast";

function find(features: readonly ProviderFeature[] | null | undefined) {
  const select = features?.find((f) => f.type === "select" && f.id === TIER && Array.isArray(f.options));
  if (select) return select;
  return features?.find((f) => f.type === "toggle" && f.id === FAST);
}

/** The speed choice in `features`, or null when the model offers none. */
export function speedFeature(features: readonly ProviderFeature[] | null | undefined): SpeedFeature | null {
  const feature = find(features);
  if (!feature) return null;
  if (feature.type === "toggle")
    return { featureId: feature.id, kind: "toggle", options: [{ id: FAST_SPEED, label: feature.label, description: feature.description }] };
  const all = feature.options || [];
  const options = all
    .filter((o) => !o.isDefault)
    .map((o) => ({ id: o.id, label: o.label, description: o.description || feature.description }));
  if (!options.length) return null;
  const normalLabel = all.find((o) => o.isDefault)?.label;
  return { featureId: feature.id, kind: "select", ...(normalLabel ? { normalLabel } : {}), options };
}

/** `featureValues` for a new session at `speed`; undefined for normal speed or a speed the model does not offer. */
export function speedFeatureValues(feature: SpeedFeature | null | undefined, speed: string): Record<string, unknown> | undefined {
  if (!feature || !speed || !feature.options.some((o) => o.id === speed)) return undefined;
  return { [feature.featureId]: feature.kind === "toggle" ? true : speed };
}

/** The speed a session runs at, from its snapshot's features; "" for normal speed or none. */
export function sessionSpeed(features: readonly ProviderFeature[] | null | undefined): string {
  const feature = find(features);
  if (!feature) return "";
  if (feature.type === "toggle") return feature.value === true ? FAST_SPEED : "";
  const value = typeof feature.value === "string" ? feature.value : "";
  return value && !feature.options?.find((o) => o.id === value)?.isDefault ? value : "";
}

/** Codex's Fast tier: `priority` in the current daemon; `fast` where a daemon names it so. */
const CODEX_FAST = ["priority", FAST_SPEED];

/** Suggested speed; an explicit normal selection (empty string) is preserved. For Codex, its Fast tier among `offered`. */
export function suggestedSpeed(provider: string, remembered?: string, offered: readonly { id: string }[] = []): string {
  if (remembered !== undefined) return remembered;
  if (provider !== "codex") return "";
  return CODEX_FAST.find((id) => offered.some((o) => o.id === id)) ?? FAST_SPEED;
}
