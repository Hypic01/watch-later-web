import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconSizes = [16, 48, 128];

describe("extension store build", () => {
  let workspace;
  let extensionDir;
  let zipPath;

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "wll-extension-build-"));
    extensionDir = path.join(workspace, "extension");
    zipPath = path.join(extensionDir, "watch-later-librarian-sync-1.0.0.zip");

    await Promise.all([
      cp(path.join(root, "extension"), extensionDir, { recursive: true }),
      cp(path.join(root, "collector"), path.join(workspace, "collector"), { recursive: true }),
      cp(path.join(root, "package.json"), path.join(workspace, "package.json")),
    ]);
    await symlink(path.join(root, "node_modules"), path.join(workspace, "node_modules"), "dir");

    const result = spawnSync(process.execPath, [path.join(extensionDir, "build-extension.js")], {
      cwd: workspace,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`Extension build failed:\n${result.stdout}\n${result.stderr}`);
    }
  });

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("ships the 1.0.0 production manifest with only the production origin", async () => {
    const manifest = JSON.parse(await readFile(path.join(extensionDir, "dist", "manifest.json"), "utf8"));

    expect(manifest.version).toBe("1.0.0");
    expect(manifest.permissions).toEqual(["scripting", "storage", "alarms"]);
    expect(manifest.host_permissions).toEqual(["https://www.youtube.com/*"]);
    expect(manifest.externally_connectable.matches).toEqual([
      "https://watch-later-web.vercel.app/*",
    ]);
  });

  it("copies every provided icon into dist", async () => {
    for (const size of iconSizes) {
      const source = await readFile(path.join(extensionDir, "icons", `${size}.png`));
      const built = await readFile(path.join(extensionDir, "dist", "icons", `${size}.png`));
      expect(built.equals(source)).toBe(true);
    }
  });

  it("puts the icons in the store zip without local or private files", () => {
    const entries = execFileSync("/usr/bin/unzip", ["-Z1", zipPath], { encoding: "utf8" })
      .trim()
      .split("\n");
    const expectedEntries = [
      "background.js",
      "collector-driver.main.js",
      "icons/",
      ...iconSizes.map((size) => `icons/${size}.png`),
      "manifest.json",
      "popup.html",
      "popup.js",
      "relay.js",
    ];
    const zippedManifest = JSON.parse(
      execFileSync("/usr/bin/unzip", ["-p", zipPath, "manifest.json"], { encoding: "utf8" }),
    );

    expect(entries.sort()).toEqual(expectedEntries.sort());
    expect(entries.some((entry) => entry.endsWith(".pem"))).toBe(false);
    expect(entries.some((entry) => entry.endsWith(".map"))).toBe(false);
    expect(entries).not.toContain("dev-key.pem");
    expect(zippedManifest.externally_connectable.matches).toEqual([
      "https://watch-later-web.vercel.app/*",
    ]);
    expect(JSON.stringify(zippedManifest)).not.toContain("localhost");
    // The Web Store rejects manifests containing "key" (it assigns the public
    // ID itself); the key must survive only in dist for the unpacked dev ID.
    expect(zippedManifest.key).toBeUndefined();
  });

  it("keeps the pinned dev key in dist even though the zip is keyless", async () => {
    const distManifest = JSON.parse(
      await readFile(path.join(extensionDir, "dist", "manifest.json"), "utf8"),
    );
    expect(typeof distManifest.key).toBe("string");
    expect(distManifest.key.length).toBeGreaterThan(100);
  });

  it("fails clearly when a required icon is missing", async () => {
    await rm(path.join(extensionDir, "icons", "48.png"));

    const result = spawnSync(process.execPath, [path.join(extensionDir, "build-extension.js")], {
      cwd: workspace,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Missing required extension icon: icons/48.png",
    );
  });
});
