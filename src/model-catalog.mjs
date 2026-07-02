import { scanGgufModels, matchDrafter } from "./scan.mjs";
import { loadProfiles, normalizeProfile, sanitizeProfileId } from "./profiles.mjs";
import { scanManagedModels } from "./managed.mjs";
import { isProfileFileMissing } from "./model-summary.mjs";
import { backendFor } from "./backends.mjs";

export async function loadModelCatalog() {
  const [profiles, { models: ggufModels, drafters }, managedModels] = await Promise.all([
    loadProfiles(),
    scanGgufModels(),
    scanManagedModels(),
  ]);
  return normalizeCatalog({ profiles, ggufModels, drafters, managedModels });
}

export function normalizeCatalog(catalog) {
  if (catalog.newModels && catalog.managedItems) return catalog;
  const { profiles, ggufModels, drafters, managedModels } = catalog;
  const profiledPaths = new Set(profiles.map((profile) => profile.modelPath).filter(Boolean));
  const newModels = ggufModels.filter((model) => !profiledPaths.has(model.path));
  const managedItems = [];
  for (const { backendId, models, status } of managedModels) {
    if (status === "unavailable") continue;
    const profiledAliases = new Set(
      profiles
        .filter((profile) => profile.backend === backendId)
        .map((profile) => `omlx:${profile.omlxModel ?? profile.modelAlias}`),
    );
    for (const model of models) {
      if (!profiledAliases.has(`${backendId}:${model.id}`)) managedItems.push({ model, backendId });
    }
  }
  return { profiles, ggufModels, drafters, managedModels, newModels, managedItems };
}


export function itemKey(item) {
  if (item.type === "profile") return `profile:${item.profile.id}`;
  if (item.type === "new") return `new:${item.model.path}`;
  return `managed:${item.backendId}:${item.model.id}`;
}

function profileRecency(item) {
  const updated = item.profile?.updatedAt ?? item.profile?.createdAt;
  const ts = updated ? Date.parse(updated) : NaN;
  return Number.isFinite(ts) ? ts : 0;
}

function compareRecency(a, b) {
  const diff = profileRecency(b) - profileRecency(a);
  if (diff !== 0) return diff;
  return String(a.label ?? "").localeCompare(String(b.label ?? ""));
}

export function buildCatalogItems(normalized) {
  const { profiles, newModels, managedItems, drafters, ggufModels = [], managedModels = [] } = normalized;

  // Lookup maps for enriching profile items with scan data (size + context).
  const scanByPath = new Map();
  for (const m of ggufModels) scanByPath.set(m.path, m);

  const managedByKey = new Map();
  for (const { backendId, models } of managedModels) {
    for (const m of models) managedByKey.set(`${backendId}:${m.id}`, m);
  }

  const profileItems = profiles.map((profile) => {
    const item = { type: "profile", profile, label: profile.label, fileMissing: isProfileFileMissing(profile) };

    // Resolve label + quant from scan data (re-parse for consistency)
    let quant = profile.capabilities?.quant ?? null;
    if (profile.modelPath) {
      const scanModel = scanByPath.get(profile.modelPath);
      if (scanModel) {
        item.label = scanModel.label;
        if (scanModel.quant) quant = scanModel.quant;
      }
    }
    if (!quant) {
      const backend = backendFor(profile.backend);
      if (backend.type === "managed-server" && profile.omlxModel) {
        const managedModel = managedByKey.get(`${profile.backend}:${profile.omlxModel}`);
        if (managedModel) {
          item.label = managedModel.label;
          if (managedModel.quant) quant = managedModel.quant;
        }
      }
    }
    item.quant = quant;

    // Resolve size: profile.modelSizeBytes → scan lookup → managed lookup
    let sizeBytes = profile.modelSizeBytes || 0;
    if (!sizeBytes && profile.modelPath) {
      const scanModel = scanByPath.get(profile.modelPath);
      if (scanModel?.sizeBytes) sizeBytes = scanModel.sizeBytes;
    }
    if (!sizeBytes) {
      const backend = backendFor(profile.backend);
      if (backend.type === "managed-server" && profile.omlxModel) {
        const managedModel = managedByKey.get(`${profile.backend}:${profile.omlxModel}`);
        if (managedModel?.sizeBytes) sizeBytes = managedModel.sizeBytes;
      }
    }
    item.sizeBytes = sizeBytes || null;

    // Resolve context: flags.ctxSize (configured) → capabilities.ctxSize (trained) → scan → managed
    let contextLength = profile.flags?.ctxSize ?? null;
    if (!contextLength) contextLength = profile.capabilities?.ctxSize ?? null;
    if (!contextLength && profile.modelPath) {
      const scanModel = scanByPath.get(profile.modelPath);
      if (scanModel?.contextLength) contextLength = scanModel.contextLength;
    }
    if (!contextLength) {
      const backend = backendFor(profile.backend);
      if (backend.type === "managed-server" && profile.omlxModel) {
        const managedModel = managedByKey.get(`${profile.backend}:${profile.omlxModel}`);
        if (managedModel?.contextLength) contextLength = managedModel.contextLength;
      }
    }
    item.contextLength = contextLength;

    return item;
  });
  profileItems.sort(compareRecency);
  return [
    ...profileItems,
    ...newModels.map((model) => ({
      type: "new",
      model,
      label: model.label,
      drafter: matchDrafter(model.path, drafters),
      sizeBytes: model.sizeBytes || null,
      contextLength: model.contextLength ?? null,
      quant: model.quant ?? null,
    })),
    ...managedItems.map(({ model, backendId }) => ({
      type: "managed",
      model,
      backendId,
      label: model.label,
      sizeBytes: model.sizeBytes || null,
      contextLength: model.contextLength ?? null,
      quant: model.quant ?? null,
    })),
  ];
}

export function createManagedProfile(model, backendId) {
  return normalizeProfile({
    id: `${backendId}-${sanitizeProfileId(model.id)}`,
    label: model.label,
    backend: backendId,
    source: backendId,
    modelAlias: model.aliasSuggestion,
    modelSizeBytes: model.sizeBytes || 0,
    ...(backendId === "omlx" ? { omlxModel: model.id } : {}),
  });
}