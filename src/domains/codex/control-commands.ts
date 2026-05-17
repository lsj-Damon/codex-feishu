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
  displayName: string;
}

export type WorkspaceProjectInspection =
  | {
      ok: true;
      project: WorkspaceProjectInfo;
      matchKind: 'direct' | 'nested_path' | 'unique_leaf';
    }
  | {
      ok: false;
      reason: 'not_found' | 'unsafe_name' | 'workspace_container' | 'ambiguous_name';
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
      path: path.join(workspaceRoot, entry.name),
      displayName: entry.name
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'en'));
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
  const normalizedProjectName = normalizeProjectName(projectName);
  if (!normalizedProjectName || !isSafeProjectName(normalizedProjectName)) {
    return {
      ok: false,
      reason: 'unsafe_name',
      projectName
    };
  }

  const directMatch = inspectDirectProject(workspaceRoot, normalizedProjectName);
  if (directMatch) {
    return directMatch;
  }

  const nestedPathMatch = inspectNestedProjectPath(
    workspaceRoot,
    normalizedProjectName
  );
  if (nestedPathMatch) {
    return nestedPathMatch;
  }

  const leafMatches = findNestedLeafMatches(workspaceRoot, normalizedProjectName);
  if (leafMatches.length === 1) {
    const uniqueLeafMatch = leafMatches[0];
    if (!uniqueLeafMatch) {
      return {
        ok: false,
        reason: 'not_found',
        projectName
      };
    }

    return {
      ok: true,
      project: uniqueLeafMatch,
      matchKind: 'unique_leaf'
    };
  }

  if (leafMatches.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous_name',
      projectName,
      suggestions: leafMatches
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'en'))
        .slice(0, MAX_CONTAINER_SUGGESTIONS)
    };
  }

  return {
    ok: false,
    reason: 'not_found',
    projectName
  };
}

export function createWorkspaceProject(
  workspaceRoot: string,
  projectName: string
): WorkspaceProjectInfo | null {
  const normalizedProjectName = normalizeProjectName(projectName);
  if (!normalizedProjectName || !isSafeProjectName(normalizedProjectName)) {
    return null;
  }

  const projectPath = path.join(workspaceRoot, normalizedProjectName);
  if (!isFirstLevelProject(workspaceRoot, projectPath)) {
    return null;
  }

  mkdirSync(projectPath, { recursive: true });
  if (!statSync(projectPath).isDirectory()) {
    return null;
  }

  return {
    name: normalizedProjectName,
    path: projectPath,
    displayName: normalizedProjectName
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

function inspectDirectProject(
  workspaceRoot: string,
  normalizedProjectName: string
): WorkspaceProjectInspection | null {
  const projectPath = path.join(workspaceRoot, normalizedProjectName);
  if (!isFirstLevelProject(workspaceRoot, projectPath)) {
    return null;
  }

  let stats;
  try {
    stats = statSync(projectPath);
  } catch {
    return null;
  }

  if (!stats.isDirectory()) {
    return null;
  }

  if (isWorkspaceContainerProject(projectPath)) {
    return {
      ok: false,
      reason: 'workspace_container',
      projectName: normalizedProjectName,
      suggestions: findChildProjectSuggestions(projectPath)
    };
  }

  return {
    ok: true,
    project: {
      name: normalizedProjectName,
      path: projectPath,
      displayName: normalizedProjectName
    },
    matchKind: 'direct'
  };
}

function inspectNestedProjectPath(
  workspaceRoot: string,
  normalizedProjectName: string
): WorkspaceProjectInspection | null {
  if (!normalizedProjectName.includes('/')) {
    return null;
  }

  const projectPath = path.join(
    workspaceRoot,
    ...normalizedProjectName.split('/')
  );
  if (!isSafeNestedProjectPath(workspaceRoot, projectPath)) {
    return {
      ok: false,
      reason: 'unsafe_name',
      projectName: normalizedProjectName
    };
  }

  let stats;
  try {
    stats = statSync(projectPath);
  } catch {
    return {
      ok: false,
      reason: 'not_found',
      projectName: normalizedProjectName
    };
  }

  if (!stats.isDirectory()) {
    return {
      ok: false,
      reason: 'not_found',
      projectName: normalizedProjectName
    };
  }

  if (isWorkspaceContainerProject(projectPath)) {
    return {
      ok: false,
      reason: 'workspace_container',
      projectName: normalizedProjectName,
      suggestions: findChildProjectSuggestions(projectPath)
    };
  }

  return {
    ok: true,
    project: {
      name: path.basename(projectPath),
      path: projectPath,
      displayName: normalizedProjectName
    },
    matchKind: 'nested_path'
  };
}

function findNestedLeafMatches(
  workspaceRoot: string,
  leafName: string
): WorkspaceProjectInfo[] {
  const results: WorkspaceProjectInfo[] = [];
  const queue = listWorkspaceProjects(workspaceRoot).map((project) => project.path);

  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (!currentPath) {
      continue;
    }

    const childNames = readdirSafe(currentPath);
    for (const childName of childNames) {
      const childPath = path.join(currentPath, childName);
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

      if (NON_PROJECT_DIRECTORY_NAMES.has(childName.toLowerCase())) {
        continue;
      }

      if (childName === leafName && !isWorkspaceContainerProject(childPath)) {
        results.push({
          name: childName,
          path: childPath,
          displayName: toWorkspaceRelativeDisplayName(workspaceRoot, childPath)
        });
      }

      if (isWorkspaceContainerProject(childPath)) {
        queue.push(childPath);
      }
    }
  }

  return results;
}

function normalizeProjectName(projectName: string): string {
  const trimmed = projectName.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed.replaceAll('\\', '/');
}

function isSafeProjectName(projectName: string): boolean {
  if (!projectName) {
    return false;
  }

  return !projectName.includes('..');
}

function isSafeNestedProjectPath(
  workspaceRoot: string,
  projectPath: string
): boolean {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedProject = path.resolve(projectPath);
  return (
    resolvedProject === resolvedRoot ||
    resolvedProject.startsWith(resolvedRoot + path.sep)
  );
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
  const workspaceRoot = findWorkspaceRootForProject(projectPath);
  return findChildProjectCandidates(projectPath)
    .sort((a, b) => {
      const aProject = hasRealProjectMarkers(a.path) ? 1 : 0;
      const bProject = hasRealProjectMarkers(b.path) ? 1 : 0;
      if (aProject !== bProject) {
        return bProject - aProject;
      }

      return a.displayName.localeCompare(b.displayName, 'en');
    })
    .slice(0, MAX_CONTAINER_SUGGESTIONS)
    .map((candidate) => ({
      ...candidate,
      displayName: workspaceRoot
        ? toWorkspaceRelativeDisplayName(workspaceRoot, candidate.path)
        : candidate.displayName
    }));
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
      path: childPath,
      displayName: childName
    });
  }

  return results;
}

function findWorkspaceRootForProject(projectPath: string): string | null {
  const parts = path.resolve(projectPath).split(path.sep);
  if (parts.length < 2) {
    return null;
  }

  return parts.slice(0, Math.max(parts.length - 2, 1)).join(path.sep);
}

function toWorkspaceRelativeDisplayName(
  workspaceRoot: string,
  projectPath: string
): string {
  return path
    .relative(workspaceRoot, projectPath)
    .replaceAll('\\', '/');
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
