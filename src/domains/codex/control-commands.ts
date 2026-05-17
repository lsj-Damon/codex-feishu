import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync
} from 'node:fs';
import path from 'node:path';

export type CodexControlCommand =
  | { type: 'list_projects' }
  | { type: 'current_project' }
  | { type: 'switch_project'; projectName: string }
  | { type: 'create_project'; projectName: string }
  | { type: 'compact_context' }
  | { type: 'analyze_project' }
  | { type: 'normal_message' };

export interface WorkspaceProjectInfo {
  name: string;
  path: string;
}

export type WorkspaceProjectInspection =
  | {
      ok: true;
      project: WorkspaceProjectInfo;
    }
  | {
      ok: false;
      reason: 'not_found' | 'unsafe_name' | 'workspace_container';
      projectName: string;
      suggestions?: WorkspaceProjectInfo[];
    };

const REAL_PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts'
] as const;

const REAL_PROJECT_GLOBS = [/\.sln$/iu];
const MAX_CONTAINER_SUGGESTIONS = 6;
const MIN_CONTAINER_TOP_LEVEL_DIRS = 6;
const WORKSPACE_CONTAINER_DOC_MARKERS = new Set([
  'task_plan.md',
  'progress.md',
  'findings.md'
]);
const NON_PROJECT_DIRECTORY_NAMES = new Set([
  '.npm-cache',
  'analysis-reports',
  'analysis-reports-r2',
  'docs',
  'dist',
  'build',
  'node_modules',
  '.git'
]);

export function parseCodexControlCommand(text: string): CodexControlCommand {
  const normalized = text.trim();

  if (normalized === '项目列表') {
    return { type: 'list_projects' };
  }

  if (normalized === '当前项目') {
    return { type: 'current_project' };
  }

  if (normalized === '压缩上下文') {
    return { type: 'compact_context' };
  }

  if (normalized === '分析项目') {
    return { type: 'analyze_project' };
  }

  if (normalized.startsWith('切换项目 ')) {
    const projectName = normalized.slice('切换项目 '.length).trim();
    if (projectName.length > 0) {
      return { type: 'switch_project', projectName };
    }
  }

  if (normalized.startsWith('新建项目 ')) {
    const projectName = normalized.slice('新建项目 '.length).trim();
    if (projectName.length > 0) {
      return { type: 'create_project', projectName };
    }
  }

  return { type: 'normal_message' };
}

export function listWorkspaceProjects(
  workspaceRoot: string
): WorkspaceProjectInfo[] {
  mkdirSync(workspaceRoot, { recursive: true });

  return readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(workspaceRoot, entry.name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export function resolveWorkspaceProject(
  workspaceRoot: string,
  projectName: string
): WorkspaceProjectInfo | null {
  const inspection = inspectWorkspaceProject(workspaceRoot, projectName);
  if (!inspection.ok) {
    return null;
  }

  return inspection.project;
}

export function inspectWorkspaceProject(
  workspaceRoot: string,
  projectName: string
): WorkspaceProjectInspection {
  if (!isSafeProjectName(projectName)) {
    return {
      ok: false,
      reason: 'unsafe_name',
      projectName
    };
  }

  const projectPath = path.join(workspaceRoot, projectName);
  if (!isFirstLevelProject(workspaceRoot, projectPath)) {
    return {
      ok: false,
      reason: 'unsafe_name',
      projectName
    };
  }

  let stats;
  try {
    stats = statSync(projectPath);
  } catch {
    return {
      ok: false,
      reason: 'not_found',
      projectName
    };
  }

  if (!stats.isDirectory()) {
    return {
      ok: false,
      reason: 'not_found',
      projectName
    };
  }

  const project: WorkspaceProjectInfo = {
    name: projectName,
    path: projectPath
  };

  if (isWorkspaceContainerProject(projectPath)) {
    return {
      ok: false,
      reason: 'workspace_container',
      projectName,
      suggestions: findChildProjectSuggestions(projectPath)
    };
  }

  return {
    ok: true,
    project
  };
}

export function createWorkspaceProject(
  workspaceRoot: string,
  projectName: string
): WorkspaceProjectInfo | null {
  if (!isSafeProjectName(projectName)) {
    return null;
  }

  const projectPath = path.join(workspaceRoot, projectName);
  if (!isFirstLevelProject(workspaceRoot, projectPath)) {
    return null;
  }

  mkdirSync(projectPath, { recursive: true });
  if (!statSync(projectPath).isDirectory()) {
    return null;
  }

  return {
    name: projectName,
    path: projectPath
  };
}

export function isRunnableProjectPath(projectPath: string): boolean {
  if (!existsSync(projectPath)) {
    return false;
  }

  try {
    if (!statSync(projectPath).isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  return !isWorkspaceContainerProject(projectPath);
}

export function describeWorkspaceContainerProject(
  projectPath: string
): { name: string; suggestions: WorkspaceProjectInfo[] } | null {
  if (!isWorkspaceContainerProject(projectPath)) {
    return null;
  }

  return {
    name: path.basename(projectPath),
    suggestions: findChildProjectSuggestions(projectPath)
  };
}

function isSafeProjectName(projectName: string): boolean {
  if (!projectName) {
    return false;
  }

  return !/[\\/]/u.test(projectName) && !projectName.includes('..');
}

function isFirstLevelProject(
  workspaceRoot: string,
  projectPath: string
): boolean {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedProject = path.resolve(projectPath);

  if (!resolvedProject.startsWith(resolvedRoot + path.sep)) {
    return false;
  }

  const relative = path.relative(resolvedRoot, resolvedProject);
  return relative.length > 0 && !relative.includes(path.sep);
}

function isWorkspaceContainerProject(projectPath: string): boolean {
  if (hasRealProjectMarkers(projectPath)) {
    return false;
  }

  const entries = readdirSafe(projectPath);
  const directoryNames = entries.filter((entry) =>
    isDirectChildDirectory(projectPath, entry)
  );
  const workspaceDocCount = entries.filter((entry) =>
    WORKSPACE_CONTAINER_DOC_MARKERS.has(entry.toLowerCase())
  ).length;

  return (
    directoryNames.length >= MIN_CONTAINER_TOP_LEVEL_DIRS ||
    (directoryNames.length >= 3 && workspaceDocCount >= 2)
  );
}

function findChildProjectSuggestions(projectPath: string): WorkspaceProjectInfo[] {
  return findChildProjectCandidates(projectPath)
    .sort((a, b) => {
      const aProject = hasRealProjectMarkers(a.path) ? 1 : 0;
      const bProject = hasRealProjectMarkers(b.path) ? 1 : 0;
      if (aProject !== bProject) {
        return bProject - aProject;
      }

      return a.name.localeCompare(b.name, 'en');
    })
    .slice(0, MAX_CONTAINER_SUGGESTIONS);
}

function findChildProjectCandidates(projectPath: string): WorkspaceProjectInfo[] {
  const children = readdirSafe(projectPath);
  const results: WorkspaceProjectInfo[] = [];

  for (const childName of children) {
    if (NON_PROJECT_DIRECTORY_NAMES.has(childName.toLowerCase())) {
      continue;
    }

    const childPath = path.join(projectPath, childName);
    let stats;
    try {
      stats = statSync(childPath);
    } catch {
      continue;
    }

    if (!stats.isDirectory()) {
      continue;
    }

    if (childName.startsWith('.')) {
      continue;
    }

    results.push({
      name: childName,
      path: childPath
    });
  }

  return results;
}

function isDirectChildDirectory(projectPath: string, entryName: string): boolean {
  if (entryName.startsWith('.')) {
    return false;
  }

  const childPath = path.join(projectPath, entryName);
  try {
    return statSync(childPath).isDirectory();
  } catch {
    return false;
  }
}

function hasRealProjectMarkers(projectPath: string): boolean {
  const entries = readdirSafe(projectPath);
  if (entries.length === 0) {
    return false;
  }

  for (const marker of REAL_PROJECT_MARKERS) {
    if (entries.includes(marker)) {
      return true;
    }
  }

  return entries.some((entry) =>
    REAL_PROJECT_GLOBS.some((pattern) => pattern.test(entry))
  );
}

function readdirSafe(projectPath: string): string[] {
  try {
    return readdirSync(projectPath);
  } catch {
    return [];
  }
}
