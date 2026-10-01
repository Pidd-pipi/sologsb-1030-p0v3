import { useCallback, useEffect, useRef, useState } from 'react';
import { createInitialState } from './data';
import { computeMerge } from './handover';
import type { ChecklistItem, ChecklistProject, ChecklistRevision, FlightStage, HandoverPackage, HandoverSide, MergeSession, WorkspaceState } from './types';

const STORAGE_KEY = 'sologsb-1030-workspace-v1';
const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const now = () => new Date().toISOString();

function loadState(): WorkspaceState {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed: { schemaVersion?: number } & Partial<Omit<WorkspaceState, 'schemaVersion'>> = JSON.parse(saved);
      // 旧草稿升级：v1 → v2 仅新增交接会话存储，原有项目与冻结版本不变
      if (parsed.schemaVersion === 1) {
        parsed.schemaVersion = 2;
        parsed.handoverSessions = {};
      }
      if (parsed.schemaVersion === 2 && Array.isArray(parsed.projects) && parsed.projects.length) {
        return parsed as WorkspaceState;
      }
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

  const selectProject = useCallback((id: string) => {
    setState((current) => ({ ...current, selectedProjectId: id }));
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
        stages: [{ id: uid('stage'), name: '飞行前检查', order: 0, description: '说明本阶段目标。' }],
        items: [],
        revisions: []
      });
      next.selectedProjectId = id;
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
    });
  }, [directUpdate]);

  const createRevision = useCallback(() => {
    directUpdate((project) => {
      project.revision += 1;
      project.status = 'draft';
      project.reviewNote = '';
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

  // ---------- 离线交接合并 ----------

  const startHandover = useCallback((baseRevisionId: string) => {
    setState((current) => {
      const next = clone(current);
      const project = next.projects.find((entry) => entry.id === next.selectedProjectId);
      const base = project?.revisions.find((entry) => entry.id === baseRevisionId);
      if (!project || !base) return current;
      next.handoverSessions[project.id] = {
        id: uid('merge'),
        projectId: project.id,
        startedAt: now(),
        updatedAt: now(),
        baseRevision: base.revision,
        baseSnapshot: { stages: clone(base.stages), items: clone(base.items) },
        captain: null,
        firstOfficer: null,
        decisions: {},
        unresolvedActions: {},
        status: 'in-progress'
      };
      return next;
    });
  }, []);

  const setHandoverSide = useCallback((side: HandoverSide, pkg: HandoverPackage) => {
    setState((current) => {
      const next = clone(current);
      const session = next.handoverSessions[next.selectedProjectId];
      if (!session) return current;
      if (side === 'captain') session.captain = pkg;
      else session.firstOfficer = pkg;
      session.updatedAt = now();
      return next;
    });
  }, []);

  const useCurrentAsHandoverSide = useCallback((side: HandoverSide, author: string) => {
    setState((current) => {
      const next = clone(current);
      const project = next.projects.find((entry) => entry.id === next.selectedProjectId);
      const session = next.handoverSessions[next.selectedProjectId];
      if (!project || !session) return current;
      session[side === 'captain' ? 'captain' : 'firstOfficer'] = {
        schemaVersion: 2,
        kind: 'flightline-handover',
        projectId: project.id,
        projectName: project.name,
        baseRevision: session.baseRevision,
        baseSnapshot: clone(session.baseSnapshot),
        side,
        author: author.trim() || (side === 'captain' ? '机长' : '副驾驶'),
        exportedAt: now(),
        stages: clone(project.stages),
        items: clone(project.items)
      };
      session.updatedAt = now();
      return next;
    });
  }, []);

  const resolveHandoverConflict = useCallback((conflictId: string, side: HandoverSide) => {
    setState((current) => {
      const next = clone(current);
      const session = next.handoverSessions[next.selectedProjectId];
      if (!session) return current;
      session.decisions[conflictId] = side;
      session.updatedAt = now();
      return next;
    });
  }, []);

  const resolveHandoverItem = useCallback((itemId: string, action: MergeSession['unresolvedActions'][string]) => {
    setState((current) => {
      const next = clone(current);
      const session = next.handoverSessions[next.selectedProjectId];
      if (!session) return current;
      session.unresolvedActions[itemId] = action;
      session.updatedAt = now();
      return next;
    });
  }, []);

  const applyHandover = useCallback(() => {
    setState((current) => {
      const next = clone(current);
      const project = next.projects.find((entry) => entry.id === next.selectedProjectId);
      const session = next.handoverSessions[next.selectedProjectId];
      if (!project || !session) return current;
      const result = computeMerge(session, project);
      if (result.conflicts.length > 0 || result.unresolved.length > 0) return current;
      past.current = [...past.current.slice(-39), clone(current)];
      future.current = [];
      forceHistoryState((value) => value + 1);
      project.stages = result.stages;
      project.items = result.items;
      project.revision += 1;
      project.status = 'draft';
      project.reviewNote = '';
      project.updatedAt = now();
      session.status = 'applied';
      session.updatedAt = now();
      return next;
    });
  }, []);

  const discardHandover = useCallback(() => {
    setState((current) => {
      const next = clone(current);
      delete next.handoverSessions[next.selectedProjectId];
      return next;
    });
  }, []);

  const createTabletProject = useCallback((baseRevisionId: string) => {
    setState((current) => {
      const next = clone(current);
      const project = next.projects.find((entry) => entry.id === next.selectedProjectId);
      const base = project?.revisions.find((entry) => entry.id === baseRevisionId);
      if (!project || !base) return current;
      const id = uid('project');
      next.projects.push({
        id,
        name: `${project.name} · 平板副本`,
        aircraft: project.aircraft,
        revision: base.revision,
        status: 'draft',
        updatedAt: now(),
        reviewNote: '',
        stages: clone(base.stages),
        items: clone(base.items),
        revisions: [clone(base)]
      });
      next.selectedProjectId = id;
      return next;
    });
  }, []);

  const activeHandover = state.handoverSessions[state.selectedProjectId];

  return {
    state,
    selectedProject,
    activeHandover,
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
    startHandover,
    setHandoverSide,
    useCurrentAsHandoverSide,
    resolveHandoverConflict,
    resolveHandoverItem,
    applyHandover,
    discardHandover,
    createTabletProject
  };
}
