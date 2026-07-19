const LOADERS = {
  watchbound: () => import("./watchbound.mjs"),
  "codex-js": () => import("./codex-js.mjs"),
  "parcel-watcher": () => import("./parcel-watcher.mjs"),
};

export const adapterIds = Object.freeze(Object.keys(LOADERS));

export async function loadAdapter(id) {
  const loadModule = LOADERS[id];
  if (!loadModule) {
    return { id, available: false, reason: `Unknown adapter: ${id}` };
  }
  const adapterModule = await loadModule();
  return adapterModule.loadAdapter();
}
