# Migrate runtime qualification

The `capabilities.support.currentRuntime.supported` field has been removed. Its
name could be read as full host or watched-root support even though it described
only loader-selected packaged-target compatibility.

Use the replacement surfaces for their separate decisions:

1. require `capabilities.support.currentRuntime.targetCompatible` before using
   the selected native artifact;
2. call `qualifyRoot(root)` for the actual subscription root; and
3. enable Watchbound only when that result has `state === "qualified"`.

```js
import { capabilities, qualifyRoot } from "watchbound";

if (!capabilities.support.currentRuntime.targetCompatible) {
  throw new Error("The packaged Watchbound target is incompatible");
}

const qualification = qualifyRoot(workspaceRoot);
if (qualification.state !== "qualified") {
  console.warn("Watchbound is not qualified for this root", qualification.reasons);
  // Keep the existing fallback watcher active.
}
```

`targetCompatible` covers platform, architecture, libc family, target triple,
and the packaged target's exact-commit status. It deliberately does not enforce
the host kernel or glibc floors and does not decide WSL, container, or root
filesystem evidence. `qualifyRoot(root)` performs that second, point-in-time
decision and preserves `unknown` separately from `unqualified`; consumers must
not coerce either state into support.

Capability schema 8 also makes non-UTF-8 physical delivery explicit. A
`ChangeBatch` with `pathEncoding === "bytes-only"` has authoritative
`invalidatedPathBytes` and intentionally empty `invalidatedPaths`. It must not
be remapped through the lexical root alias.
