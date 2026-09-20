import { access } from "node:fs/promises";
import { win32 } from "node:path";
import process from "node:process";

export type HostProbeCommand = Readonly<{
  executable: string;
  args: ReadonlyArray<string>;
  location: string;
}>;

export type NpmProbeCommandInput = Readonly<{
  platform?: NodeJS.Platform;
  execPath?: string;
  environment?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => Promise<boolean>;
}>;

export async function resolveNpmProbeCommands(
  input: NpmProbeCommandInput = {}
): Promise<ReadonlyArray<HostProbeCommand>> {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return [
      {
        executable: "npm",
        args: ["--version"],
        location: "npm"
      }
    ];
  }

  const execPath = input.execPath ?? process.execPath;
  const environment = input.environment ?? process.env;
  const fileExists = input.fileExists ?? pathExists;
  const pathValue = windowsEnvironmentValue(
    environment,
    "PATH"
  );
  const pathDirectories =
    pathValue === undefined
      ? []
      : pathValue
          .split(win32.delimiter)
          .filter((entry) => entry.length > 0);

  const commands: HostProbeCommand[] = [];
  const seen = new Set<string>();
  const add = (command: HostProbeCommand): void => {
    const key = [
      command.executable,
      ...command.args
    ].join("\0").toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      commands.push(command);
    }
  };

  for (const directory of pathDirectories) {
    const executable = win32.join(
      directory,
      "npm.exe"
    );
    if (await fileExists(executable)) {
      add({
        executable,
        args: ["--version"],
        location: executable
      });
    }
  }

  for (const directory of pathDirectories) {
    const shim = win32.join(directory, "npm.cmd");
    if (!(await fileExists(shim))) {
      continue;
    }
    const cli = win32.join(
      directory,
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js"
    );
    if (await fileExists(cli)) {
      add({
        executable: execPath,
        args: [cli, "--version"],
        location: shim
      });
    }
  }

  const adjacentCli = win32.join(
    win32.dirname(execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  if (await fileExists(adjacentCli)) {
    add({
      executable: execPath,
      args: [adjacentCli, "--version"],
      location: adjacentCli
    });
  }

  return commands;
}

function windowsEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  const normalized = name.toUpperCase();
  for (const [key, value] of Object.entries(environment)) {
    if (
      key.toUpperCase() === normalized &&
      value !== undefined
    ) {
      return value;
    }
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
