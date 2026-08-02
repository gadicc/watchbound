import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyContainerEvidence,
  evaluateQualification,
} from "../capabilities.js";

const missing = Object.freeze({ availability: "missing", content: null });
const unavailable = Object.freeze({ availability: "unavailable", content: null });
const readable = (content = "") => ({ availability: "present", content });

function completeEvidence(overrides = {}) {
  return {
    markerFiles: [missing, missing],
    systemdContainer: missing,
    cgroup: readable("0::/\n"),
    mountinfo: readable("1 0 8:1 / / rw - ext4 /dev/root rw\n"),
    environmentContainer: null,
    ...overrides,
  };
}

test("container negative evidence requires every designated probe", () => {
  assert.equal(classifyContainerEvidence(completeEvidence()), false);
  assert.equal(
    classifyContainerEvidence(completeEvidence({ mountinfo: unavailable })),
    null,
  );
  assert.equal(
    classifyContainerEvidence(completeEvidence({ cgroup: unavailable })),
    null,
  );
  assert.equal(
    classifyContainerEvidence(completeEvidence({ cgroup: missing })),
    null,
  );
  assert.equal(
    classifyContainerEvidence(completeEvidence({ mountinfo: missing })),
    null,
  );
  assert.equal(
    classifyContainerEvidence(completeEvidence({
      markerFiles: [unavailable, missing],
    })),
    null,
  );
});

test("conventional and systemd container evidence is always detected", () => {
  for (const marker of [
    "docker/012345",
    "podman-012345.scope",
    "kubepods.slice",
    "containerd.service",
    "lxc.payload.example",
    "systemd-nspawn",
    "machine.slice/machine-example.scope",
  ]) {
    assert.equal(
      classifyContainerEvidence(completeEvidence({ cgroup: readable(marker) })),
      true,
      marker,
    );
  }
  assert.equal(
    classifyContainerEvidence(completeEvidence({
      systemdContainer: readable("systemd-nspawn\n"),
    })),
    true,
  );
  assert.equal(
    classifyContainerEvidence(completeEvidence({
      markerFiles: [readable(), unavailable],
      mountinfo: unavailable,
    })),
    true,
  );
});

test("incomplete container evidence cannot produce aggregate qualification", () => {
  const container = classifyContainerEvidence(
    completeEvidence({ mountinfo: unavailable }),
  );
  const result = evaluateQualification({
    runtime: {
      kernel: "5.15.0",
      libc: { family: "glibc", version: "2.35" },
    },
    currentRuntime: {
      packagedTargetId: "linux-x64-gnu",
      runtimeMatchesPackagedTarget: true,
      qualification: "supported",
    },
    target: {
      kernelMinimum: "5.15",
      libc: { maximumRequiredSymbolVersion: "2.35" },
    },
    evidence: {
      wsl: false,
      container,
      root: {
        availability: "available",
        directory: true,
        lexicalPath: "/workspace",
        lexicalPathBytes: Uint8Array.from(Buffer.from("/workspace")),
        physicalPath: "/workspace",
        physicalPathBytes: Uint8Array.from(Buffer.from("/workspace")),
        filesystem: { kind: "ordinary-local", magic: "0xef53" },
      },
    },
  });
  assert.equal(container, null);
  assert.equal(result.state, "unknown");
  assert.equal(result.host.container.state, "unknown");
  assert.ok(result.reasons.includes("container-unknown"));
});
