import type { RuntimeDistribution } from "./specs.js";

/** Release-owned Server Host artifact. Paired Hosts continue to use ACP Registry releases. */
export const SERVER_OPENCODE_RELEASE: {
  version: string;
  distribution: RuntimeDistribution;
} = {
  version: "1.18.31",
  distribution: {
    kind: "binary",
    platforms: {
      "linux-aarch64": {
        archive: "https://github.com/anomalyco/opencode/releases/download/v1.18.31/opencode-linux-arm64.tar.gz",
        cmd: "./opencode",
        args: ["acp"],
        sha256: "d4e332f46b227448582c0d9fc75f6f826dfe95c9f751bc2011fc4d937a042be6",
        env: {},
      },
      "linux-x86_64": {
        archive: "https://github.com/anomalyco/opencode/releases/download/v1.18.31/opencode-linux-x64.tar.gz",
        cmd: "./opencode",
        args: ["acp"],
        sha256: "e9312be75ed803b7415fc2aeabda1f4fe938912a39673762dc0c38c0e11ebde4",
        env: {},
      },
    },
  },
};
