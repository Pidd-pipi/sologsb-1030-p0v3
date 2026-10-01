import { useCallback, useEffect, useRef, useState } from 'react';
import { createInitialState } from './data';
import { bundleToSide } from './merge';
import type {
  ChecklistItem,
  ChecklistProject,
  ChecklistRevision,
  FlightStage,
  HandoffBundle,
  MergeInfo,
  MergeResolution,
  MergeSidePayload,
  MergeSource,
  WorkspaceState
} from './types';

const STORAGE_KEY = 'sologsb-1030-workspace-v1';
const DEVICE_ROLE_KEY = 'sologsb-1030-device-role';
const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const now = () => new Date().toISOString();

interface LegacyChecklistProject {
  id: string;
  name: string;
  aircraft: string;
  revision: number;
  status: ChecklistProject['status'];
  updatedAt: string;
  reviewNote: string;
  baseRevisionId?: string;
  mergeInfo?: ChecklistProject['mergeInfo'];
  stages: ChecklistProject['stages'];
  items: ChecklistProject['items'];
  revisions: ChecklistProject['revisions'];
}

interface LegacyWorkspaceState {
  schemaVersion?: number;
  selectedProjectId?: string;
  projects?: LegacyChecklistProject[];
}

/** v1 旧草稿升级：补齐底本与合并会话字段，升级后也能参与交接合并。 */
function migrate(raw: unknown): WorkspaceState | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as LegacyWorkspaceState;
  if (!Array.isArray(parsed.projects) || parsed.projects.length === 0) return null;
  // 已经是当前格式：原样保留（包括进行中的合并会话）。
  if (parsed.schemaVersion === 2 && Array.isArray((raw as WorkspaceState).mergeSessions)) {
    return raw as WorkspaceState;
  }
  const projects: ChecklistProject[] = parsed.projects.map((legacyProject) => {
    if (legacyProject.baseRevisionId !== undefined) return legacyProject as ChecklistProject;
    const latestFrozen = legacyProject.revisions.find((revision) => revision.status === 'frozen');
    return {
      ...legacyProject,
      baseRevisionId: latestFrozen?.id ?? '',
      mergeInfo: undefined
    };
  });
  return {
    schemaVersion: 2,
    selectedProjectId: parsed.selectedProjectId ?? projects[0].id,
    projects,
    mergeSessions: [],
    activeMergeSessionId: null
  };
}

function loadState(): WorkspaceState {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      const next = migrate(parsed);
      if (next) return next;
    }
  } catch {
    // Corrupted local draft falls back to the bundled operational checklist.
  }
  return createInitialState();
}

function updateSelected(state: WorkspaceState, mutator: (project: ChecklistProject) => void): WorkspaceState {
  const next = clone(state);
  const project = next.projects.find((entry) => entry.id === next.selectedProjectId);
  if (project) {
    mutator(project);
    project.updatedAt = now();
  }
  return next;
}

export function useChecklistStore() {
  const [state, setState] = useState<WorkspaceState>(loadState);
  const past = useRef<WorkspaceState[]>([]);
  const future = useRef<WorkspaceState[]>([]);
  const [, forceHistoryState] = useState(0);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const commit = useCallback((mutator: (project: ChecklistProject) => void) => {
    setState((current) => {
      past.current = [...past.current.slice(-39), clone(current)];
      future.current = [];
      forceHistoryState((value) => value + 1);
      return updateSelected(current, (project) => {
        if (project.status !== 'draft') return;
        mutator(project);
      });
    });
  }, []);

  const directUpdate = useCallback((mutator: (project: ChecklistProject) => void) => {
    setState((current) => {
      past.current = [...past.current.slice(-39), clone(current)];
      future.current = [];
      forceHistoryState((value) => value + 1);
      return updateSelected(current, mutator);
    });
  }, []);

  const selectedProject = state.projects.find((project) => project.id === state.selectedProjectId) ?? state.projects[0];
  const activeMergeSession = state.mergeSessions.find((session) => session.id === state.activeMergeSessionId && session.projectId === selectedProject?.id) ?? null;

  const selectProject = useCallback((id: string) => {
    setState((current) => ({ ...current, selectedProjectId: id, activeMergeSessionId: current.mergeSessions.find((session) => session.projectId === id && session.status !== 'applied')?.id ?? null }));
  }, []);

  const addProject = useCallback(() => {
    const id = uid('project');
    setState((current) => {
      past.current = [...past.current.slice(-39), clone(current)];
      future.current = [];
      const next = clone(current);
      next.projects.push({
        id,
        name: 'Untitled checklist',
        aircraft: '新机型',
        revision: 1,
        status: 'draft',
        updatedAt: now(),
        reviewNote: '',
        baseRevisionId: '',
        stages: [{ id: uid('stage'), name: '飞行前检查', order: 0, description: '说明本阶段目标。' }],
        items: [],
        revisions: []
      });
      next.selectedProjectId = id;
      next.activeMergeSessionId = null;
      return next;
    });
  }, []);

  const updateProject = useCallback((patch: Partial<ChecklistProject>) => {
    commit((project) => {
      Object.assign(project, patch);
    });
  }, [commit]);

  const addStage = useCallback(() => {
    commit((project) => {
      project.stages.push({ id: uid('stage'), name: '新飞行阶段', order: project.stages.length, description: '描述阶段目标和适用条件。' });
    });
  }, [commit]);

  const updateStage = useCallback((stageId: string, patch: Partial<FlightStage>) => {
    commit((project) => {
      const stage = project.stages.find((entry) => entry.id === stageId);
      if (stage) Object.assign(stage, patch);
    });
  }, [commit]);

  const moveStage = useCallback((stageId: string, direction: -1 | 1) => {
    commit((project) => {
      project.stages.sort((a, b) => a.order - b.order);
      const index = project.stages.findIndex((entry) => entry.id === stageId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= project.stages.length) return;
      [project.stages[index], project.stages[target]] = [project.stages[target], project.stages[index]];
      project.stages.forEach((entry, order) => { entry.order = order; });
    });
  }, [commit]);

  const deleteStage = useCallback((stageId: string) => {
    commit((project) => {
      if (project.items.some((item) => item.stageId === stageId)) return;
      project.stages = project.stages.filter((stage) => stage.id !== stageId).sort((a, b) => a.order - b.order);
      project.stages.forEach((stage, order) => { stage.order = order; });
    });
  }, [commit]);

  const addItem = useCallback((stageId: string, challenge = '', response = '') => {
    const id = uid('item');
    commit((project) => {
      const stage = project.stages.find((entry) => entry.id === stageId);
      if (!stage) return;
      const order = project.items.filter((item) => item.stageId === stageId).length;
      project.items.push({ id, stageId, order, challenge, response, critical: false, preconditionIds: [], abnormalProcedure: '', updatedAt: now() });
    });
    return id;
  }, [commit]);

  const updateItem = useCallback((itemId: string, patch: Partial<ChecklistItem>) => {
    commit((project) => {
      const item = project.items.find((entry) => entry.id === itemId);
      if (item) Object.assign(item, patch, { updatedAt: now() });
    });
  }, [commit]);

  const deleteItem = useCallback((itemId: string) => {
    commit((project) => {
      project.items = project.items.filter((item) => item.id !== itemId);
      project.items.forEach((item) => { item.preconditionIds = item.preconditionIds.filter((id) => id !== itemId); });
      project.stages.forEach((stage) => {
        project.items.filter((item) => item.stageId === stage.id).sort((a, b) => a.order - b.order).forEach((item, order) => { item.order = order; });
      });
    });
  }, [commit]);

  const reorderItem = useCallback((sourceId: string, targetId: string, before = true) => {
    commit((project) => {
      const source = project.items.find((item) => item.id === sourceId);
      const target = project.items.find((item) => item.id === targetId);
      if (!source || !target || source.id === target.id) return;
      source.stageId = target.stageId;
      const siblings = project.items.filter((item) => item.stageId === target.stageId && item.id !== source.id).sort((a, b) => a.order - b.order);
      const targetIndex = siblings.findIndex((item) => item.id === target.id);
      siblings.splice(Math.max(0, targetIndex + (before ? 0 : 1)), 0, source);
      siblings.forEach((item, order) => { item.order = order; });
    });
  }, [commit]);

  const nudgeItem = useCallback((itemId: string, direction: -1 | 1) => {
    commit((project) => {
      const item = project.items.find((entry) => entry.id === itemId);
      if (!item) return;
      const siblings = project.items.filter((entry) => entry.stageId === item.stageId).sort((a, b) => a.order - b.order);
      const index = siblings.findIndex((entry) => entry.id === itemId);
      const target = index + direction;
      if (target < 0 || target >= siblings.length) return;
      [siblings[index], siblings[target]] = [siblings[target], siblings[index]];
      siblings.forEach((entry, order) => { entry.order = order; });
    });
  }, [commit]);

  const submitForReview = useCallback(() => {
    directUpdate((project) => {
      project.status = 'review';
      project.reviewNote = '';
    });
  }, [directUpdate]);

  const freezeRevision = useCallback((note: string) => {
    directUpdate((project) => {
      const version = project.revision;
      const snapshot: ChecklistRevision = {
        id: uid('revision'),
        revision: version,
        status: 'frozen',
        createdAt: now(),
        note: note.trim() || '复核通过并冻结',
        stages: clone(project.stages),
        items: clone(project.items)
      };
      project.revisions.unshift(snapshot);
      project.status = 'frozen';
      project.reviewNote = note.trim();
      project.baseRevisionId = snapshot.id;
    });
  }, [directUpdate]);

  const createRevision = useCallback(() => {
    directUpdate((project) => {
      project.revision += 1;
      project.status = 'draft';
      project.reviewNote = '';
      project.mergeInfo = undefined;
      project.updatedAt = now();
    });
  }, [directUpdate]);

  const undo = useCallback(() => {
    setState((current) => {
      const previous = past.current.pop();
      if (!previous) return current;
      future.current = [clone(current), ...future.current].slice(0, 40);
      forceHistoryState((value) => value + 1);
      return previous;
    });
  }, []);

  const redo = useCallback(() => {
    setState((current) => {
      const next = future.current.shift();
      if (!next) return current;
      past.current = [...past.current.slice(-39), clone(current)];
      forceHistoryState((value) => value + 1);
      return next;
    });
  }, []);

  const saveNow = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    setState((current) => updateSelected(current, () => undefined));
  }, [state]);

  // —— 离线交接 ——

  const getDeviceRole = useCallback((): MergeSource => {
    return localStorage.getItem(DEVICE_ROLE_KEY) === 'firstOfficer' ? 'firstOfficer' : 'captain';
  }, []);

  const setDeviceRole = useCallback((role: MergeSource) => {
    localStorage.setItem(DEVICE_ROLE_KEY, role);
    forceHistoryState((value) => value + 1);
  }, []);

  /** 导出当前平板的现场改动包：自带冻结底本快照，回基地后可完全离线做三方合并。 */
  const exportHandoff = useCallback((deviceLabel: string): HandoffBundle | null => {
    const project = selectedProject;
    if (!project) return null;
    const baseRevision = project.revisions.find((revision) => revision.id === project.baseRevisionId)
      ?? project.revisions.find((revision) => revision.status === 'frozen');
    const source = getDeviceRole();
    return {
      kind: 'flight-checklist-handoff',
      formatVersion: 2,
      projectId: project.id,
      projectName: project.name,
      baseRevisionId: baseRevision?.id ?? `working-r${project.revision}`,
      baseRevisionNumber: baseRevision?.revision ?? project.revision,
      exportedAt: now(),
      source,
      deviceLabel: deviceLabel.trim() || (source === 'captain' ? '机长平板' : '副驾驶平板'),
      base: {
        stages: clone(baseRevision?.stages ?? project.stages),
        items: clone(baseRevision?.items ?? project.items)
      },
      stages: clone(project.stages),
      items: clone(project.items)
    };
  }, [selectedProject, getDeviceRole]);

  const selectMergeSession = useCallback((sessionId: string | null) => {
    setState((current) => ({ ...current, activeMergeSessionId: sessionId }));
  }, []);

  /** 导入同伴改动包；若本机当前工作区就是另一方，则自动以本机内容作为另一侧开案。 */
  const importHandoff = useCallback((bundle: HandoffBundle, fileName?: string): { ok: boolean; reason?: string; resumed?: boolean } => {
    const project = selectedProject;
    if (!project) return { ok: false, reason: '当前没有可合并的检查单项目。' };
    if (bundle.projectId !== project.id) {
      return { ok: false, reason: `改动包属于“${bundle.projectName}”，与当前项目“${project.name}”不一致。` };
    }
    if (project.baseRevisionId && bundle.baseRevisionId && project.baseRevisionId !== bundle.baseRevisionId) {
      const baseRevision = project.revisions.find((revision) => revision.id === bundle.baseRevisionId);
      if (!baseRevision) {
        return { ok: false, reason: `底本不匹配：改动包基于 r${bundle.baseRevisionNumber}（${bundle.baseRevisionId}），本机项目未保存该冻结版本，无法离线三方合并。` };
      }
    }

    let resumed = false;
    let result: { ok: boolean; reason?: string; resumed?: boolean } = { ok: true };
    setState((current) => {
      const next = clone(current);
      const target = next.projects.find((entry) => entry.id === current.selectedProjectId);
      if (!target) return current;

      const side = bundleToSide(bundle);
      side.fileName = fileName;

      // 断点续接：同项目、同底本、同来源的未完成会话直接补入
      let session = next.mergeSessions.find(
        (entry) => entry.projectId === bundle.projectId
          && entry.baseRevisionId === bundle.baseRevisionId
          && entry.status !== 'applied'
      );
      if (session) {
        session[bundle.source] = side;
        session.updatedAt = now();
        resumed = true;
      } else {
        session = {
          id: uid('merge'),
          projectId: bundle.projectId,
          projectName: bundle.projectName,
          baseRevisionId: bundle.baseRevisionId,
          baseRevisionNumber: bundle.baseRevisionNumber,
          base: clone(bundle.base),
          createdAt: now(),
          updatedAt: now(),
          resolutions: {},
          status: 'waiting'
        };
        session[bundle.source] = side;

        // 若本机当前草稿就是同一底本出发，自动充当另一侧（机长/副驾驶各带平板回基地场景）
        const localSource: MergeSource = bundle.source === 'captain' ? 'firstOfficer' : 'captain';
        const localBaseId = target.baseRevisionId || `working-r${target.revision}`;
        if (localBaseId === bundle.baseRevisionId) {
          const localSide: MergeSidePayload = {
            source: localSource,
            label: localSource === 'captain' ? '本机（机长）' : '本机（副驾驶）',
            exportedAt: target.updatedAt,
            stages: clone(target.stages),
            items: clone(target.items)
          };
          session[localSource] = localSide;
        }
        next.mergeSessions.unshift(session);
      }
      session.status = session.captain && session.firstOfficer ? 'open' : 'waiting';
      next.activeMergeSessionId = session.id;
      result = { ok: true, resumed };
      return next;
    });
    return result;
  }, [selectedProject]);

  /** 基地场景：手动把本机当前草稿作为指定一侧加入会话。 */
  const promoteLocalAsSide = useCallback((source: MergeSource) => {
    setState((current) => {
      const session = current.mergeSessions.find((entry) => entry.id === current.activeMergeSessionId);
      const project = current.projects.find((entry) => entry.id === current.selectedProjectId);
      if (!session || !project || session.status === 'applied') return current;
      const next = clone(current);
      const target = next.mergeSessions.find((entry) => entry.id === session.id)!;
      target[source] = {
        source,
        label: source === 'captain' ? '本机（机长）' : '本机（副驾驶）',
        exportedAt: project.updatedAt,
        stages: clone(project.stages),
        items: clone(project.items)
      };
      target.status = target.captain && target.firstOfficer ? 'open' : 'waiting';
      target.updatedAt = now();
      return next;
    });
  }, []);

  const setMergeResolution = useCallback((conflictId: string, resolution: MergeResolution | null) => {
    setState((current) => {
      const session = current.mergeSessions.find((entry) => entry.id === current.activeMergeSessionId);
      if (!session || session.status === 'applied') return current;
      const next = clone(current);
      const target = next.mergeSessions.find((entry) => entry.id === session.id)!;
      if (resolution) target.resolutions[conflictId] = resolution;
      else delete target.resolutions[conflictId];
      target.updatedAt = now();
      return next;
    });
  }, []);

  const bulkResolve = useCallback((updates: Array<{ id: string; resolution: MergeResolution }>) => {
    setState((current) => {
      const session = current.mergeSessions.find((entry) => entry.id === current.activeMergeSessionId);
      if (!session || session.status === 'applied') return current;
      const next = clone(current);
      const target = next.mergeSessions.find((entry) => entry.id === session.id)!;
      updates.forEach(({ id, resolution }) => {
        target.resolutions[id] = resolution;
      });
      target.updatedAt = now();
      return next;
    });
  }, []);

  /** 待决项全部选定后，候选稿写入项目并直接进入复核稿（复核人定稿后才能冻结）。 */
  const applyMerge = useCallback((candidate: { stages: FlightStage[]; items: ChecklistItem[] }, stats: { added: number; removed: number; autoChanges: number; resolvedConflicts: number }): boolean => {
    let applied = false;
    setState((current) => {
      const session = current.mergeSessions.find((entry) => entry.id === current.activeMergeSessionId);
      if (!session || session.status !== 'open') return current;
      const actualProject = current.projects.find((entry) => entry.id === session.projectId) ?? current.projects.find((entry) => entry.id === current.selectedProjectId);
      if (!actualProject) return current;

      const next = clone(current);
      const targetSession = next.mergeSessions.find((entry) => entry.id === session.id)!;
      const targetProject = next.projects.find((entry) => entry.id === actualProject.id)!;

      targetProject.stages = clone(candidate.stages);
      targetProject.items = clone(candidate.items);
      targetProject.status = 'review';
      targetProject.reviewNote = `离线交接合并待复核：机长“${session.captain?.label ?? '—'}” × 副驾驶“${session.firstOfficer?.label ?? '—'}”，底本 r${session.baseRevisionNumber}。新增 ${stats.added}、删除 ${stats.removed}、自动并入 ${stats.autoChanges}、待决 ${stats.resolvedConflicts} 项已由复核人选定。`;
      const mergeInfo: MergeInfo = {
        mergedAt: now(),
        baseRevisionId: session.baseRevisionId,
        baseRevisionNumber: session.baseRevisionNumber,
        captainLabel: session.captain?.label ?? '',
        firstOfficerLabel: session.firstOfficer?.label ?? '',
        addedCount: stats.added,
        removedCount: stats.removed,
        autoChangeCount: stats.autoChanges,
        resolvedConflictCount: stats.resolvedConflicts,
        note: targetProject.reviewNote
      };
      targetProject.mergeInfo = mergeInfo;
      actualProject.updatedAt = now();
      targetSession.status = 'applied';
      targetSession.appliedAt = now();
      targetSession.updatedAt = now();
      next.selectedProjectId = actualProject.id;
      applied = true;
      return next;
    });
    return applied;
  }, []);

  const abandonMergeSession = useCallback((sessionId: string) => {
    setState((current) => {
      const next = clone(current);
      next.mergeSessions = next.mergeSessions.filter((session) => session.id !== sessionId);
      if (next.activeMergeSessionId === sessionId) next.activeMergeSessionId = null;
      return next;
    });
  }, []);

  return {
    state,
    selectedProject,
    activeMergeSession,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    selectProject,
    addProject,
    updateProject,
    addStage,
    updateStage,
    moveStage,
    deleteStage,
    addItem,
    updateItem,
    deleteItem,
    reorderItem,
    nudgeItem,
    submitForReview,
    freezeRevision,
    createRevision,
    undo,
    redo,
    saveNow,
    getDeviceRole,
    setDeviceRole,
    exportHandoff,
    importHandoff,
    promoteLocalAsSide,
    selectMergeSession,
    setMergeResolution,
    bulkResolve,
    applyMerge,
    abandonMergeSession
  };
}
