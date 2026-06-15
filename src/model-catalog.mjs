import { scanGgufModels, matchDrafter } from "./scan.mjs";
import { loadProfiles, normalizeProfile, sanitizeProfileId } from "./profiles.mjs";
import { scanManagedModels } from "./managed.mjs";
import { isProfileFileMissing } from "./model-summary.mjs";

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
        .map((profile) => backendId === "ollama" ? `ollama:${profile.ollamaModel ?? profile.modelAlias}` : `omlx:${profile.omlxModel ?? profile.modelAlias}`),
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
  const { profiles, newModels, managedItems, drafters } = normalized;
  const profileItems = profiles.map((profile) => ({ type: "profile", profile, label: profile.label, fileMissing: isProfileFileMissing(profile) }));
  profileItems.sort(compareRecency);
  return [
    ...profileItems,
    ...newModels.map((model) => ({ type: "new", model, label: model.label, drafter: matchDrafter(model.path, drafters) })),
    ...managedItems.map(({ model, backendId }) => ({ type: "managed", model, backendId, label: model.label })),
  ];
}

export function createManagedProfile(model, backendId) {
  return normalizeProfile({
    id: `${backendId}-${sanitizeProfileId(model.id)}`,
    label: model.label,
    backend: backendId,
    modelAlias: model.aliasSuggestion,
    ...(backendId === "ollama" ? { ollamaModel: model.id } : {}),
    ...(backendId === "omlx" ? { omlxModel: model.id } : {}),
  });
}
