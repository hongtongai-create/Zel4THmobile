import { readFileSync } from "node:fs";
import { createRemoteShellTools } from "../.shared/remote-shell.mjs";

const manifest = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8"));

export const tools = createRemoteShellTools(manifest.config ?? {});
