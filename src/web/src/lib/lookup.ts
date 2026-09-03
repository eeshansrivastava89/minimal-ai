// Entity lookups — everything hangs off the model (profile).
// A sweep, a benchmark run, a config change are all CHILDREN of a model.

import { HUB_DATA } from "@/data/data";
import { RUNS } from "@/data/runs";
import type { AutotuneRun, Profile, Run } from "@/data/types";

// All the names a profile goes by across backends and run metadata.
function profileIds(p: Profile): Set<string> {
  return new Set(
    [p.modelAlias, p.omlxModel, p.ollamaModel, p.label].filter(Boolean) as string[]
  );
}

export function profileById(id: string | undefined): Profile | undefined {
  return HUB_DATA.profiles.find((p) => p.id === id);
}

export function backendVersion(id: string): string | undefined {
  return HUB_DATA.backends.find((b) => b.id === id)?.version;
}

/** Saved profile for a backend model id (or its own profile id), if any. */
export function profileForModel(id: string): Profile | undefined {
  return HUB_DATA.profiles.find(
    (p) => p.id === id || p.modelAlias === id || p.omlxModel === id || p.ollamaModel === id
  );
}

export function runsForProfile(p: Profile): Run[] {
  const ids = profileIds(p);
  return RUNS.filter(
    (r) => (r.model && ids.has(r.model)) || (r.modelDisplay && ids.has(r.modelDisplay))
  );
}

export function profileForRun(r: Run): Profile | undefined {
  return HUB_DATA.profiles.find((p) => {
    const ids = profileIds(p);
    return (r.model && ids.has(r.model)) || (r.modelDisplay && ids.has(r.modelDisplay));
  });
}

export function autotuneForProfile(p: Profile): AutotuneRun | undefined {
  return HUB_DATA.autotune.find((a) => a.profileId === p.id || a.modelId === p.modelAlias);
}
