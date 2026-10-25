import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { findExecutableWithoutProbing } from "../../../../executable-resolution/executable-resolution.js";
import type { OmpSessionState } from "./rpc-types.js";
import type { OmpRuntimeLaunch } from "./runtime.js";

export const OMP_QUALIFICATION_RECIPE = "omp-45c35e40-fresh-absence-v1";
const RECIPE_SOURCE_COMMIT = "45c35e40c46166dc726ccc52f5d27f40f2449f99";

type PathKind = "absent" | "present" | "symlink" | "unreadable" | "unknown";
interface AbsenceRow {
  path: string;
  kind: PathKind;
}
type ConfigRow =
  | { path: string; kind: Exclude<PathKind, "present"> }
  | {
      path: string;
      kind: "file";
      device: string;
      inode: string;
      size: string;
      mtimeNs: string;
      ctimeNs: string;
      mode: number;
      uid: number;
    };
interface DirectoryIdentity {
  device: bigint;
  inode: bigint;
}
interface InitialState {
  isStreaming: boolean;
  isCompacting: boolean;
  queuedMessageCount: number;
  hasPendingAsyncWork: boolean;
  isSettled: boolean;
  goal: null;
}
export interface QualificationTerminal {
  type: "prompt_result";
  id: string;
  agentInvoked: boolean;
  status: string;
  sessionSettled: boolean;
}
interface Activity {
  agentStarts: number;
  toolStarts: number;
  nonSelectedToolStarts: number;
  processExits: number;
  goalEvents: number;
  extensionUiRequests: number;
  prompts: number;
  ownerChanges: number;
  sessionTransitions: number;
}

// These are source locations, not caller-provided inventory or interpreted configuration.
// Pin: discovery/index, helpers.SOURCE_PATHS, custom-tools/loader, plugins/loader,
// omp-extension-roots, settings.loadGlobal/loadProject and utils/env (including Bun dotenv).
export function qualificationPaths(
  home: string,
  cwd: string,
  agentDir: string,
  boundary: "beforeLaunch" | "afterStartup",
): string[] {
  const homeRoots = [
    ".claude",
    ".claude.json",
    ".codex",
    ".gemini",
    ".cursor",
    ".config",
    ".codeium",
    ".vscode",
    ".cline",
    ".agents",
    ".ssh",
    ".bunfig.toml",
  ];
  const projectRoots = [
    ".omp",
    ".claude",
    ".codex",
    ".gemini",
    ".opencode",
    ".cursor",
    ".windsurf",
    ".vscode",
    ".github",
    ".agents",
    "opencode.json",
    "opencode.jsonc",
    "mcp.json",
    ".mcp.json",
    "bunfig.toml",
    "package.json",
  ];
  const dotenv = [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.production",
    ".env.production.local",
    ".env.test",
    ".env.test.local",
  ];
  const agentPaths = [
    "config.yaml",
    "settings.json",
    ".env",
    "tools",
    "extensions",
    "hooks",
    "plugins",
  ];
  const nativePaths =
    boundary === "beforeLaunch"
      ? [join(home, ".omp"), join(agentDir, "agent.db"), join(agentDir, "config.yml")]
      : [join(home, ".omp", "plugins"), join(home, ".omp", ".env"), join(home, ".omp", "agent")];
  return [
    ...new Set([
      ...homeRoots.map((name) => join(home, name)),
      ...projectRoots.map((name) => join(cwd, name)),
      ...dotenv.flatMap((name) => [join(home, name), join(cwd, name)]),
      ...agentPaths.map((name) => join(agentDir, name)),
      ...nativePaths,
    ]),
  ].sort();
}

function directoryIdentity(path: string): DirectoryIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (
    realpathSync(path) !== path ||
    !stat.isDirectory() ||
    stat.uid !== BigInt(process.getuid!()) ||
    (stat.mode & 0o077n) !== 0n
  ) {
    throw new Error("Qualification requires canonical private owned directories");
  }
  return { device: stat.dev, inode: stat.ino };
}

function freshDirectory(path: string, allowGit: boolean): void {
  const directory = opendirSync(path, { bufferSize: 1 });
  try {
    const first = directory.readSync();
    if (!first) return;
    if (!allowGit || first.name !== ".git" || !first.isDirectory() || directory.readSync()) {
      throw new Error("Qualification requires fresh source directories");
    }
  } finally {
    directory.closeSync();
  }
}

function pathKind(home: string, path: string): PathKind {
  const suffix = relative(home, path);
  if (!suffix || suffix.startsWith("..") || isAbsolute(suffix)) return "unknown";
  let current = home;
  const parts = suffix.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return "symlink";
      if (index < parts.length - 1 && !stat.isDirectory()) return "unknown";
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return "absent";
      return code === "EACCES" || code === "EPERM" ? "unreadable" : "unknown";
    }
  }
  return "present";
}

function configurationRow(home: string, path: string): ConfigRow {
  const kind = pathKind(home, path);
  if (kind !== "present") return { path, kind };
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) return { path, kind: "symlink" };
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.uid !== BigInt(process.getuid!()) ||
      (stat.mode & 0o022n) !== 0n ||
      stat.size > 1024n * 1024n
    )
      return { path, kind: "unknown" };
    return {
      path,
      kind: "file",
      device: String(stat.dev),
      inode: String(stat.ino),
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
      mode: Number(stat.mode & 0o777n),
      uid: Number(stat.uid),
    };
  } catch {
    return { path, kind: "unknown" };
  }
}

function launchFlags(argv: string[]) {
  let protocolMode: "rpc" | "rpc-ui" | undefined;
  let approvalMode: "yolo" | undefined;
  let extensionDiscovery: "enabled" | "disabled" = "enabled";
  let hasAppendedSystemPrompt = false;
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index]!;
    if (seen.has(flag)) throw new Error("Duplicate qualification launch flag");
    seen.add(flag);
    if (flag === "--no-extensions") {
      extensionDiscovery = "disabled";
      continue;
    }
    if (flag === "--no-session") continue;
    if (
      ![
        "--mode",
        "--approval-mode",
        "--model",
        "--thinking",
        "--smol",
        "--slow",
        "--plan",
        "--append-system-prompt",
      ].includes(flag)
    )
      throw new Error("Unsupported qualification launch flag");
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error("Missing qualification launch value");
    if (flag === "--mode") {
      if (value !== "rpc" && value !== "rpc-ui") throw new Error("Qualification requires RPC mode");
      protocolMode = value;
    }
    if (flag === "--approval-mode") {
      if (value !== "yolo") throw new Error("Qualification requires existing full/yolo policy");
      approvalMode = value;
    }
    if (flag === "--append-system-prompt") hasAppendedSystemPrompt = true;
  }
  if (!protocolMode || !approvalMode) throw new Error("Qualification launch mode is unavailable");
  return { protocolMode, approvalMode, extensionDiscovery, hasAppendedSystemPrompt };
}

function launchEnvironment(
  env: Record<string, string>,
): Pick<OmpQualification["launch"], "home" | "agentDir" | "tmpDir" | "nodeEnv"> {
  for (const key of Object.keys(env)) {
    if (!env[key] || key === "PI_CODING_AGENT_DIR" || key === "NODE_ENV") continue;
    if (
      /^(OMP_|PI_|XDG_|GIT_|BUN_|NODE_|LD_|DYLD_|CLAUDE_CONFIG_DIR$|OPENCODE_CONFIG|WSL_)/.test(key)
    )
      throw new Error("Unsupported qualification environment selector");
  }
  const nodeEnv = env.NODE_ENV || "development";
  if (nodeEnv !== "development" && nodeEnv !== "production" && nodeEnv !== "test")
    throw new Error("Unsupported qualification environment mode");
  if (!env.HOME || !env.PI_CODING_AGENT_DIR || !env.TMPDIR)
    throw new Error("Qualification directory selectors are unavailable");
  return { home: env.HOME, agentDir: env.PI_CODING_AGENT_DIR, tmpDir: env.TMPDIR, nodeEnv };
}

export class OmpQualification {
  private state: InitialState | null = null;
  private atState: AbsenceRow[] = [];
  private stateConfiguration: ConfigRow | null = null;
  private activity: Activity = this.emptyActivity();
  private readonly hostCommands = new Map<string, number>();

  private constructor(
    readonly launch: {
      command: string;
      executable: string;
      cwd: string;
      home: string;
      agentDir: string;
      tmpDir: string;
      nodeEnv: "development" | "production" | "test";
      protocolMode: "rpc" | "rpc-ui";
      approvalMode: "yolo";
      extensionDiscovery: "enabled" | "disabled";
      hasAppendedSystemPrompt: boolean;
    },
    private readonly directories: Map<string, DirectoryIdentity>,
    private readonly beforeLaunch: AbsenceRow[],
  ) {}

  static async create(launch: OmpRuntimeLaunch): Promise<OmpQualification> {
    if (process.platform !== "linux" || !process.getuid || !launch.env)
      throw new Error("Unsupported qualification platform");
    const environment = launchEnvironment(launch.env);
    const { home, agentDir, tmpDir } = environment;
    if (
      dirname(launch.cwd) !== home ||
      dirname(agentDir) !== home ||
      tmpDir !== join(home, "tmp") ||
      new Set([launch.cwd, agentDir, tmpDir]).size !== 3
    )
      throw new Error("Unsupported qualification directory topology");
    const directories = new Map<string, DirectoryIdentity>(
      [home, launch.cwd, agentDir, tmpDir].map((path) => [path, directoryIdentity(path)]),
    );
    freshDirectory(agentDir, false);
    freshDirectory(launch.cwd, true);
    const command = launch.argv[0];
    if (!command || command.includes("\0")) throw new Error("Qualification command is unavailable");
    if (
      !isAbsolute(command) &&
      (!launch.env.PATH || launch.env.PATH.length > 16384 || launch.env.PATH.split(":").length > 64)
    )
      throw new Error("Qualification executable search is unsupported");
    const resolved = isAbsolute(command)
      ? command
      : await findExecutableWithoutProbing(command, { path: launch.env.PATH, cwd: launch.cwd });
    if (!resolved) throw new Error("Qualification executable is unavailable");
    const executable = realpathSync(resolved);
    if (!lstatSync(executable).isFile())
      throw new Error("Qualification executable is not a regular file");
    const beforeLaunch = qualificationPaths(home, launch.cwd, agentDir, "beforeLaunch").map(
      (path) => ({ path, kind: pathKind(home, path) }),
    );
    if (beforeLaunch.some((row) => row.kind !== "absent"))
      throw new Error("Qualification contributor source is not absent");
    return new OmpQualification(
      { command, executable, cwd: launch.cwd, ...environment, ...launchFlags(launch.argv) },
      directories,
      beforeLaunch,
    );
  }

  stateReceived(state: OmpSessionState): void {
    this.checkDirectories();
    const { isStreaming, isCompacting, queuedMessageCount, hasPendingAsyncWork, isSettled, goal } =
      state;
    if (
      isStreaming !== false ||
      isCompacting !== false ||
      queuedMessageCount !== 0 ||
      hasPendingAsyncWork !== false ||
      isSettled !== true ||
      goal !== null
    )
      throw new Error("Qualification requires an observed fresh settled native state");
    const rows = this.absenceRows();
    if (rows.some((row) => row.kind !== "absent"))
      throw new Error("Qualification contributor source changed before state");
    const configuration = configurationRow(
      this.launch.home,
      join(this.launch.agentDir, "config.yml"),
    );
    if (configuration.kind !== "absent" && configuration.kind !== "file")
      throw new Error("Qualification configuration metadata is unavailable");
    this.state = {
      isStreaming,
      isCompacting,
      queuedMessageCount,
      hasPendingAsyncWork,
      isSettled,
      goal,
    };
    this.atState = rows;
    this.stateConfiguration = configuration;
    this.activity = this.emptyActivity();
    this.hostCommands.clear();
  }

  command(type: string): void {
    if (
      !this.state ||
      [
        "get_state",
        "get_messages",
        "get_available_models",
        "get_available_commands",
        "get_session_stats",
        "get_branch_messages",
        "set_subagent_subscription",
      ].includes(type)
    )
      return;
    this.hostCommands.set(type, (this.hostCommands.get(type) ?? 0) + 1);
  }

  prompt(message: string, selected: boolean): void {
    if (!this.state) return;
    this.activity.prompts++;
    if (selected && message.trimStart().startsWith("/"))
      throw new Error("Qualification requires an ordinary selected prompt");
    if (selected) {
      this.checkDirectories();
      const configuration = configurationRow(
        this.launch.home,
        join(this.launch.agentDir, "config.yml"),
      );
      if (
        this.absenceRows().some((row) => row.kind !== "absent") ||
        JSON.stringify(configuration) !== JSON.stringify(this.stateConfiguration)
      ) {
        throw new Error("Qualification sources changed before selected prompt");
      }
    }
  }

  ownerChanged(): void {
    if (this.state) this.activity.ownerChanges++;
  }

  event(type: string, selectedTool: boolean): void {
    if (!this.state) return;
    if (type === "agent_start") this.activity.agentStarts++;
    if (type === "tool_execution_start") {
      this.activity.toolStarts++;
      if (!selectedTool) this.activity.nonSelectedToolStarts++;
    }
    if (type === "process_exit") this.activity.processExits++;
    if (type.startsWith("goal_")) this.activity.goalEvents++;
    if (type === "extension_ui_request") this.activity.extensionUiRequests++;
    if (type === "compaction_start" || type === "session_switch" || type === "session_fork")
      this.activity.sessionTransitions++;
  }

  terminal(terminal: QualificationTerminal) {
    this.checkDirectories();
    if (!this.state || !this.stateConfiguration)
      throw new Error("Qualification state boundary is unavailable");
    return {
      recipe: OMP_QUALIFICATION_RECIPE,
      recipeSourceCommit: RECIPE_SOURCE_COMMIT,
      launch: { ...this.launch, profile: "default", session: "fresh" },
      absence: {
        beforeLaunch: this.beforeLaunch,
        atState: this.atState,
        atTerminal: this.absenceRows(),
      },
      configuration: {
        atState: this.stateConfiguration,
        atTerminal: configurationRow(this.launch.home, join(this.launch.agentDir, "config.yml")),
      },
      state: this.state,
      activity: {
        hostCommands: [...this.hostCommands]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([type, count]) => ({ type, count })),
        ...this.activity,
      },
      terminal,
    };
  }

  private absenceRows(): AbsenceRow[] {
    return qualificationPaths(
      this.launch.home,
      this.launch.cwd,
      this.launch.agentDir,
      "afterStartup",
    ).map((path) => ({ path, kind: pathKind(this.launch.home, path) }));
  }

  private checkDirectories(): void {
    for (const [path, identity] of this.directories) {
      const actual = directoryIdentity(path);
      if (actual.device !== identity.device || actual.inode !== identity.inode)
        throw new Error("Qualification directory identity changed");
    }
  }

  private emptyActivity(): Activity {
    return {
      agentStarts: 0,
      toolStarts: 0,
      nonSelectedToolStarts: 0,
      processExits: 0,
      goalEvents: 0,
      extensionUiRequests: 0,
      prompts: 0,
      ownerChanges: 0,
      sessionTransitions: 0,
    };
  }
}
