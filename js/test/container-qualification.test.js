import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyContainerEvidence,
  evaluateQualification,
} from "../capabilities.js";

const missing = Object.freeze({ availability: "missing", content: null });
const unavailable = Object.freeze({ availability: "unavailable", content: null });
const readable = (content = "") => ({ availability: "present", content });

const HOST_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-codex.scope\n";
const MEBIBYTE = 1024 * 1024;
const HOST_SUBORDINATE_MOUNTS = [
  "41 36 0:42 /@docker /var/lib/docker rw,nosuid,nodev shared:2 - btrfs /dev/mapper/vg-root rw,subvol=/@docker",
  "42 41 0:51 / /var/lib/docker/overlay2/abc/merged rw,relatime - overlay overlay rw,lowerdir=/var/lib/containerd/snapshots/1/fs,upperdir=/var/lib/docker/overlay2/abc/diff,workdir=/var/lib/docker/overlay2/abc/work",
  "43 41 8:3 /docker-volume /var/lib/docker/volumes/example/_data rw,relatime - ext4 /dev/mapper/vg-data rw",
  "44 36 0:5 net:[4026533987] /run/docker/netns/abc rw - nsfs nsfs rw",
  "45 36 0:48 / /run/containerd/io.containerd.runtime.v2.task/default/abc rw,nosuid,nodev - tmpfs tmpfs rw",
].join("\n");

function hostMountinfo(rootMount) {
  return `${rootMount}\n${HOST_SUBORDINATE_MOUNTS}\n`;
}

function completeEvidence(overrides = {}) {
  return {
    markerFiles: [missing, missing],
    systemdContainer: missing,
    cgroup: readable(HOST_CGROUP),
    mountinfo: readable(
      "36 25 8:2 / / rw,relatime shared:1 - ext4 /dev/mapper/vg-root rw,errors=remount-ro\n",
    ),
    environmentContainer: null,
    ...overrides,
  };
}

test("host Docker and containerd mounts do not describe the process root", () => {
  const roots = [
    "36 25 8:2 / / rw,relatime shared:1 - ext4 /dev/mapper/vg-root rw,errors=remount-ro",
    "36 25 0:36 /@ / rw,noatime shared:1 - btrfs /dev/mapper/vg-root rw,compress=zstd:3,subvol=/@",
  ];
  for (const root of roots) {
    assert.equal(
      classifyContainerEvidence(completeEvidence({
        mountinfo: readable(hostMountinfo(root)),
      })),
      false,
      root,
    );
  }
});

test("ambiguous container-like root mounts cannot produce negative evidence", () => {
  const rootMounts = [
    "100 99 0:84 / / rw,relatime - overlay overlay rw,lowerdir=/layers/base,upperdir=/layers/diff,workdir=/layers/work",
    "100 99 0:84 / / rw,relatime - fuse.fuse-overlayfs fuse-overlayfs rw,user_id=1000,group_id=1000",
    "100 99 0:84 / / rw,relatime - fuse.overlayfs overlayfs rw,user_id=1000,group_id=1000",
    "100 99 0:84 / / rw,relatime - fuse-overlayfs fuse-overlayfs rw,user_id=1000,group_id=1000",
    "36 25 253:0 / / rw,relatime - ext4 /dev/mapper/docker-root rw,errors=remount-ro",
    "36 25 0:36 /@docker / rw,noatime - btrfs /dev/mapper/vg-root rw,subvol=/@docker",
  ];
  for (const rootMount of rootMounts) {
    assert.equal(
      classifyContainerEvidence(completeEvidence({
        cgroup: readable("0::/\n"),
        mountinfo: readable(`${rootMount}\n`),
      })),
      null,
      rootMount,
    );
  }
});

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

test("missing or malformed root-mount and cgroup evidence stays unknown", () => {
  const malformedMountinfo = [
    "41 36 0:42 / /var/lib/docker rw - btrfs /dev/root rw",
    "36 25 8:2 / / rw,relatime ext4 /dev/mapper/vg-root rw",
  ].join("\n");
  for (const mountinfo of [
    `${HOST_SUBORDINATE_MOUNTS}\n`,
    `${malformedMountinfo}\n`,
    "36 25 8:2 / / rw - ext4 /dev/root rw\n37 36 8:3 / / rw - ext4 /dev/other rw\n",
    "36 25 8:2 / / rw - ext4 /dev/root rw unexpected\n",
    "36 25 8:2 / / rw bad::value - ext4 /dev/root rw\n",
    "36 25 8:2 /  / rw - ext4 /dev/root rw\n",
    "36 25 8:2 /bad\\999 / rw - ext4 /dev/root rw\n",
    "36 25 8:2 / / rw - ext4 /dev/root rw",
    "36 25 8:2 / / rw - ext4 /dev/root rw\0\n",
  ]) {
    assert.equal(
      classifyContainerEvidence(completeEvidence({ mountinfo: readable(mountinfo) })),
      null,
      mountinfo,
    );
  }
  for (const cgroup of [
    "not-a-cgroup-record\n",
    "not-a-cgroup-record docker\n",
    "",
    "0:cpu:/\n",
    "1::/\n",
    "0::/\n0::/duplicate\n",
    "0::/bad\0path\n",
    "0::/\n\n1:name=systemd:/\n",
    "0::/",
  ]) {
    assert.equal(
      classifyContainerEvidence(completeEvidence({ cgroup: readable(cgroup) })),
      null,
      cgroup,
    );
  }
});

test("valid cgroup v1, v2, hybrid, and unusual paths remain complete evidence", () => {
  const cgroups = [
    "0::/init.scope\n",
    "12:cpuset,cpu,cpuacct:/\n11:name=systemd:/init.scope\n",
    "12:cpuset,cpu:/\n11:name=systemd:/init.scope\n0::/init.scope\n",
    "0::/odd:component with space\rname (deleted)\n",
    "0::/odd\u2028name\u2029component\n",
    "1:name=containerd:/\n",
  ];
  for (const cgroup of cgroups) {
    assert.equal(
      classifyContainerEvidence(completeEvidence({ cgroup: readable(cgroup) })),
      false,
      cgroup,
    );
  }
});

test("escaped mountinfo fields and unknown optional fields remain valid", () => {
  assert.equal(
    classifyContainerEvidence(completeEvidence({
      mountinfo: readable(
        "36 25 0:36 /@root\\040snapshot / rw,noatime shared:1 future:42 - btrfs /dev/mapper/vg\\040root rw,compress=zstd:3,subvol=/@root\\040snapshot\n",
      ),
    })),
    false,
  );
});

test("container evidence inputs are size bounded", () => {
  assert.equal(
    classifyContainerEvidence(completeEvidence({
      cgroup: readable(`0::/${"a".repeat(64 * 1024)}\n`),
    })),
    null,
  );
  assert.equal(
    classifyContainerEvidence(completeEvidence({
      mountinfo: readable("x".repeat(16 * MEBIBYTE + 1)),
    })),
    null,
  );
});

test("Docker, Podman, Kubernetes, systemd-nspawn, and LXC evidence remains detected", () => {
  const cgroups = [
    "0::/docker/012345\n",
    "0::/user.slice/user-1000.slice/user@1000.service/podman-012345.scope\n",
    "0::/kubepods.slice/kubepods-burstable.slice/pod012345\n",
    "0::/system.slice/containerd.service/012345\n",
    "0::/lxc.payload.example\n",
    "0::/machine.slice/machine-example.scope\n",
    "0::/systemd-nspawn/example\n",
    "12:cpuset,cpu:/docker/012345\n11:name=systemd:/\n",
    "0::/user.slice/libpod-012345.scope\n",
  ];
  for (const cgroup of cgroups) {
    assert.equal(
      classifyContainerEvidence(completeEvidence({ cgroup: readable(cgroup) })),
      true,
      cgroup,
    );
  }
  assert.equal(
    classifyContainerEvidence(completeEvidence({
      systemdContainer: readable("systemd-nspawn\n"),
      mountinfo: unavailable,
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
  assert.equal(
    classifyContainerEvidence(completeEvidence({
      environmentContainer: "podman",
      cgroup: unavailable,
      mountinfo: unavailable,
    })),
    true,
  );
});

test("validated positive evidence overrides malformed evidence from another probe", () => {
  assert.equal(
    classifyContainerEvidence(completeEvidence({
      cgroup: readable("0::/docker/012345\n"),
      mountinfo: readable("not-mountinfo\n"),
    })),
    true,
  );
  assert.equal(
    classifyContainerEvidence(completeEvidence({
      markerFiles: [readable(), unavailable],
      cgroup: readable("not-a-cgroup-record\n"),
      mountinfo: readable("not-mountinfo\n"),
    })),
    true,
  );
  assert.equal(
    classifyContainerEvidence(completeEvidence({
      systemdContainer: readable("systemd-nspawn\n"),
      cgroup: readable("not-a-cgroup-record\n"),
      mountinfo: readable("not-mountinfo\n"),
    })),
    true,
  );
  assert.equal(
    classifyContainerEvidence(completeEvidence({
      cgroup: readable("not-a-cgroup-record\n"),
      mountinfo: readable(
        "100 99 0:84 / / rw - overlay overlay rw,lowerdir=/base\n",
      ),
    })),
    null,
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
