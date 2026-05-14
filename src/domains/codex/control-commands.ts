import path from 'node:path';
import { mkdirSync, readdirSync, statSync } from 'node:fs';

export type CodexControlCommand =
  | { type: 'list_projects' }
  | { type: 'current_project' }
  | { type: 'switch_project'; projectName: string }
  | { type: 'create_project'; projectName: string }
  | { type: 'normal_message' };

export interface WorkspaceProjectInfo {
  name: string;
  path: string;
}

export function parseCodexControlCommand(text: string): CodexControlCommand {
  const normalized = text.trim();

  if (normalized === '项目列表') {
    return { type: 'list_projects' };
  }

  if (normalized === '当前项目') {
    return { type: 'current_project' };
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

export function listWorkspaceProjects(workspaceRoot: string): WorkspaceProjectInfo[] {
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
  if (!isSafeProjectName(projectName)) {
    return null;
  }

  const projectPath = path.join(workspaceRoot, projectName);
  if (!isFirstLevelProject(workspaceRoot, projectPath)) {
    return null;
  }

  try {
    if (!statSync(projectPath).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    name: projectName,
    path: projectPath
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

function isSafeProjectName(projectName: string): boolean {
  if (!projectName) {
    return false;
  }

  return !/[\\/]/u.test(projectName) && !projectName.includes('..');
}

function isFirstLevelProject(workspaceRoot: string, projectPath: string): boolean {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedProject = path.resolve(projectPath);

  if (!resolvedProject.startsWith(resolvedRoot + path.sep)) {
    return false;
  }

  const relative = path.relative(resolvedRoot, resolvedProject);
  return relative.length > 0 && !relative.includes(path.sep);
}
