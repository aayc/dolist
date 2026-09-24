import pkg from "../package.json" with { type: "json" };

export const DAEMON_VERSION: string = pkg.version;
