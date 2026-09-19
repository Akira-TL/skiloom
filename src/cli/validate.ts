import {
  lstat,
  readFile,
  readdir
} from "node:fs/promises";
import {
  basename,
  join,
  relative,
  resolve,
  sep
} from "node:path";

import {
  type ProductError,
  type Result,
  productError
} from "../domain/errors/index.js";
import {
  parsePackageMetadata,
  type PackageMetadataError
} from "../domain/package/index.js";
import {
  discoverRepositorySkills,
  parseRepositoryMetadata,
  type RepositoryDiscoveryError,
  type RepositoryFileFact,
  type RepositoryMetadataError
} from "../domain/discovery/index.js";

export type ValidateLocalPathUnavailable = ProductError<
  "ValidateLocalPathUnavailable",
  Readonly<{
    path: string;
    reason: "not-found" | "not-directory" | "io";
  }>
>;

export type ValidateLocalPathError =
  | ValidateLocalPathUnavailable
  | RepositoryDiscoveryError
  | PackageMetadataError
  | RepositoryMetadataError;

export type ParseCliValidateResult =
  | Readonly<{
      ok: true;
      value: Readonly<{
        path: string;
        json: boolean;
      }>;
    }>
  | Readonly<{
      ok: false;
      reason: string;
    }>;

export function parseCliValidateArguments(
  argv: ReadonlyArray<string>,
  cwd: string,
  json: boolean
): ParseCliValidateResult {
  const option = argv.find((argument) =>
    argument.startsWith("-")
  );
  if (option !== undefined) {
    return {
      ok: false,
      reason: `unknown option: ${option}`
    };
  }
  if (argv.length > 1) {
    return {
      ok: false,
      reason: "validate accepts at most one path"
    };
  }
  return {
    ok: true,
    value: {
      path: argv[0] ?? cwd,
      json
    }
  };
}

export type ValidateLocalPathResult = Readonly<{
  path: string;
  repository: Readonly<{
    include: ReadonlyArray<string>;
    exclude: ReadonlyArray<string>;
  }>;
  packages: ReadonlyArray<
    Readonly<{
      name: string;
      description: string;
      packageRoot: string;
      dependencies: Readonly<Record<string, string>>;
      software: Readonly<Record<string, string>>;
    }>
  >;
}>;

export async function validateLocalPath(
  inputPath: string
): Promise<Result<ValidateLocalPathResult, ValidateLocalPathError>> {
  const path = resolve(inputPath);

  const directory = await validateDirectory(path);
  if (!directory.ok) {
    return directory;
  }

  const repositoryMetadataSource = await readOptionalUtf8(
    join(path, "skiloom-repo.toml")
  );
  if (!repositoryMetadataSource.ok) {
    return unavailable(path, "io");
  }
  const repository = parseRepositoryMetadata(
    repositoryMetadataSource.value
  );
  if (!repository.ok) {
    return repository;
  }

  const files = await collectSkillFiles(path);
  if (!files.ok) {
    return files;
  }
  const discovered = discoverRepositorySkills({
    repositoryRootBasename: basename(path),
    repositoryMetadata: repositoryMetadataSource.value,
    files: files.value
  });
  if (!discovered.ok) {
    return discovered;
  }

  const packages: ValidateLocalPathResult["packages"][number][] = [];
  for (const skill of discovered.value) {
    const manifestPath = join(
      path,
      skill.packageRoot === "." ? "" : skill.packageRoot,
      "skiloom-package.toml"
    );
    const packageMetadataSource = await readOptionalUtf8(
      manifestPath
    );
    if (!packageMetadataSource.ok) {
      return unavailable(path, "io");
    }
    const packageMetadata = parsePackageMetadata(
      packageMetadataSource.value
    );
    if (!packageMetadata.ok) {
      return packageMetadata;
    }
    packages.push({
      name: skill.name,
      description: skill.description,
      packageRoot: skill.packageRoot,
      dependencies: packageMetadata.value.dependencies,
      software: packageMetadata.value.software
    });
  }

  return {
    ok: true,
    value: {
      path,
      repository: repository.value,
      packages
    }
  };
}

async function validateDirectory(
  path: string
): Promise<Result<void, ValidateLocalPathUnavailable>> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    return unavailable(
      path,
      isNodeError(error) && error.code === "ENOENT"
        ? "not-found"
        : "io"
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return unavailable(path, "not-directory");
  }
  return { ok: true, value: undefined };
}

async function collectSkillFiles(
  root: string
): Promise<
  Result<ReadonlyArray<RepositoryFileFact>, ValidateLocalPathUnavailable>
> {
  const pending = [root];
  const files: RepositoryFileFact[] = [];

  try {
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) {
        continue;
      }
      const entries = await readdir(directory, {
        withFileTypes: true
      });
      entries.sort((left, right) =>
        compareUtf8(left.name, right.name)
      );

      for (const entry of entries) {
        const absolutePath = join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(absolutePath);
          continue;
        }
        if (!entry.isFile() || entry.name !== "SKILL.md") {
          continue;
        }
        files.push({
          path: repositoryPath(root, absolutePath),
          content: await readFile(absolutePath, "utf8")
        });
      }
    }
  } catch {
    return unavailable(root, "io");
  }

  files.sort((left, right) =>
    compareUtf8(left.path, right.path)
  );
  return { ok: true, value: files };
}

function repositoryPath(
  root: string,
  absolutePath: string
): string {
  return relative(root, absolutePath)
    .split(sep)
    .join("/");
}

type OptionalTextResult =
  | Readonly<{ ok: true; value: string | undefined }>
  | Readonly<{ ok: false }>;

async function readOptionalUtf8(
  path: string
): Promise<OptionalTextResult> {
  try {
    return {
      ok: true,
      value: await readFile(path, "utf8")
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { ok: true, value: undefined };
    }
    return { ok: false };
  }
}

function unavailable(
  path: string,
  reason: ValidateLocalPathUnavailable["facts"]["reason"]
): Result<never, ValidateLocalPathUnavailable> {
  return {
    ok: false,
    error: productError("ValidateLocalPathUnavailable", {
      path,
      reason
    })
  };
}

function compareUtf8(
  left: string,
  right: string
): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}

function isNodeError(
  error: unknown
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
