import path from "node:path";

export function backendBinaryPath(
  backendDir: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
) {
  return path.join(backendDir, "bin", `${name}${platform === "win32" ? ".exe" : ""}`);
}
