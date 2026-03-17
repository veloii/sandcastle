import { Effect } from "effect";
import { exec } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FilesystemSandbox } from "./FilesystemSandbox.js";
import { syncIn } from "./SyncService.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const getHead = async (dir: string) => {
  const { stdout } = await execAsync("git rev-parse HEAD", { cwd: dir });
  return stdout.trim();
};

const setup = async () => {
  const hostDir = await mkdtemp(join(tmpdir(), "host-"));
  const sandboxDir = await mkdtemp(join(tmpdir(), "sandbox-"));
  const sandboxRepoDir = join(sandboxDir, "repo");
  const layer = FilesystemSandbox.layer(sandboxDir);
  return { hostDir, sandboxDir, sandboxRepoDir, layer };
};

describe("syncIn", () => {
  it("clean repo syncs correctly — sandbox HEAD matches host HEAD", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    expect(await getHead(sandboxRepoDir)).toBe(await getHead(hostDir));

    const content = await readFile(join(sandboxRepoDir, "hello.txt"), "utf-8");
    expect(content).toBe("hello");
  });

  it("repo with unpushed commits — bundle captures them", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "a.txt", "a", "first");
    await commitFile(hostDir, "b.txt", "b", "second");
    await commitFile(hostDir, "c.txt", "c", "third");

    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    expect(await getHead(sandboxRepoDir)).toBe(await getHead(hostDir));
    expect(await readFile(join(sandboxRepoDir, "a.txt"), "utf-8")).toBe("a");
    expect(await readFile(join(sandboxRepoDir, "b.txt"), "utf-8")).toBe("b");
    expect(await readFile(join(sandboxRepoDir, "c.txt"), "utf-8")).toBe("c");

    // Verify commit history is preserved
    const { stdout } = await execAsync("git log --oneline", {
      cwd: sandboxRepoDir,
    });
    expect(stdout.trim().split("\n")).toHaveLength(3);
  });

  it("repo with uncommitted changes — sandbox gets committed state only", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "committed.txt", "committed", "initial");

    // Add uncommitted changes on host
    await writeFile(join(hostDir, "untracked.txt"), "untracked");
    await writeFile(join(hostDir, "committed.txt"), "modified but uncommitted");

    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    // Sandbox has committed state only
    const content = await readFile(
      join(sandboxRepoDir, "committed.txt"),
      "utf-8",
    );
    expect(content).toBe("committed");

    // Untracked file should not exist in sandbox
    const { stdout } = await execAsync("ls", { cwd: sandboxRepoDir });
    expect(stdout).not.toContain("untracked.txt");
  });

  it("re-sync after sandbox has diverged — sandbox resets to host state", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "original.txt", "original", "initial");

    // First sync
    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    // Configure git in sandbox for committing
    await execAsync('git config user.email "test@test.com"', {
      cwd: sandboxRepoDir,
    });
    await execAsync('git config user.name "Test"', { cwd: sandboxRepoDir });

    // Make divergent changes in sandbox
    await commitFile(
      sandboxRepoDir,
      "sandbox-only.txt",
      "sandbox",
      "sandbox commit",
    );
    await writeFile(join(sandboxRepoDir, "untracked.txt"), "untracked");

    // Add new commit on host
    await commitFile(hostDir, "host-new.txt", "new", "host new commit");

    // Re-sync
    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    // Sandbox HEAD matches host
    expect(await getHead(sandboxRepoDir)).toBe(await getHead(hostDir));

    // Host's new file is present
    expect(await readFile(join(sandboxRepoDir, "host-new.txt"), "utf-8")).toBe(
      "new",
    );

    // Sandbox-only file and untracked file are gone
    const { stdout: status } = await execAsync("git status --porcelain", {
      cwd: sandboxRepoDir,
    });
    expect(status.trim()).toBe("");

    const { stdout: files } = await execAsync("ls", { cwd: sandboxRepoDir });
    expect(files).not.toContain("sandbox-only.txt");
    expect(files).not.toContain("untracked.txt");
  });
});
