#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const desktopRoot = path.resolve(__dirname, "..");
const engineDest = path.resolve(
  process.env.NANOBOT_ENGINE_DEST ?? path.join(desktopRoot, "resources", "nanobot-engine"),
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function walk(dir, matches = []) {
  for (const entry of await readdir(dir)) {
    const fullPath = path.join(dir, entry);
    const info = await stat(fullPath);
    if (info.isDirectory()) {
      await walk(fullPath, matches);
    } else if (entry === "python3" || entry === "python") {
      matches.push(fullPath);
    }
  }
  return matches;
}

async function findStandaloneRoot(extractDir) {
  const candidates = await walk(extractDir);
  for (const candidate of candidates) {
    const normalized = candidate.split(path.sep).join("/");
    if (normalized.endsWith("/install/bin/python3")) {
      return path.dirname(path.dirname(candidate));
    }
  }
  for (const candidate of candidates) {
    const parent = path.dirname(candidate);
    if (path.basename(parent) === "bin") {
      return path.dirname(parent);
    }
  }
  throw new Error("could not find python-build-standalone bin/python3 in extracted archive");
}

async function tarSupportsZstd() {
  const result = spawnSync("tar", ["--help"], { encoding: "utf8" });
  return `${result.stdout}\n${result.stderr}`.includes("zstd");
}

async function extractArchive(archive, destination) {
  await mkdir(destination, { recursive: true });
  if (archive.endsWith(".tar.zst") && !(await tarSupportsZstd())) {
    throw new Error("tar.zst archives require a tar build with zstd support");
  }
  run("tar", ["-xf", archive, "-C", destination]);
}

async function resolveArchive() {
  const localArchive = process.env.PYTHON_STANDALONE_TARBALL;
  if (localArchive) return path.resolve(localArchive);

  const url = process.env.PYTHON_STANDALONE_URL;
  if (!url) {
    throw new Error(
      "Set PYTHON_STANDALONE_TARBALL or PYTHON_STANDALONE_URL to a macOS python-build-standalone archive.",
    );
  }
  const downloadPath = path.join(tmpdir(), `nanobot-python-${Date.now()}${path.extname(url)}`);
  await download(url, downloadPath);
  return downloadPath;
}

async function installNanobot(pythonPath) {
  run(pythonPath, ["-m", "ensurepip", "--upgrade"]);
  run(pythonPath, ["-m", "pip", "install", "--upgrade", "pip"]);

  const installArgs = ["-m", "pip", "install", "--upgrade"];
  const wheelhouse = process.env.NANOBOT_WHEELHOUSE;
  if (wheelhouse) {
    installArgs.push("--no-index", "--find-links", path.resolve(wheelhouse));
  }
  installArgs.push(`${repoRoot}[api]`);
  run(pythonPath, installArgs);
}

async function writeManifest(pythonPath) {
  const version = spawnSync(pythonPath, ["--version"], { encoding: "utf8" });
  const pyproject = await readFile(path.join(repoRoot, "pyproject.toml"), "utf8");
  const match = pyproject.match(/^version\s*=\s*"([^"]+)"/m);
  await writeFile(
    path.join(engineDest, "nanobot-engine.json"),
    JSON.stringify(
      {
        python: version.stdout.trim() || version.stderr.trim(),
        nanobot_version: match?.[1] ?? "unknown",
        prepared_at: new Date().toISOString(),
        source: "python-build-standalone",
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function main() {
  const archive = await resolveArchive();
  const extractDir = path.join(tmpdir(), `nanobot-engine-${Date.now()}`);
  await rm(extractDir, { recursive: true, force: true });
  await extractArchive(archive, extractDir);

  const standaloneRoot = await findStandaloneRoot(extractDir);
  await rm(engineDest, { recursive: true, force: true });
  await mkdir(path.dirname(engineDest), { recursive: true });
  await cp(standaloneRoot, engineDest, { recursive: true });

  const pythonPath = path.join(engineDest, "bin", "python3");
  await installNanobot(pythonPath);
  await writeManifest(pythonPath);
  await writeFile(path.join(engineDest, ".gitkeep"), "", "utf8");
  console.log(`Prepared nanobot desktop engine at ${engineDest}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
