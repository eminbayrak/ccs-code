import { spawn } from "child_process";

export function openInDefaultBrowser(targetPath: string): Promise<void> {
  const platform = process.platform;
  const command = platform === "win32" ? "cmd"
    : platform === "darwin" ? "open"
    : "xdg-open";
  const args = platform === "win32"
    ? ["/c", "start", "", targetPath]
    : [targetPath];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
