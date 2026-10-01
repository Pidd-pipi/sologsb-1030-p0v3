export type WorkflowStatus = 'draft' | 'review' | 'frozen';
export type IssueLevel = 'error' | 'warning' | 'info';
export type IssueType = 'duplicate' | 'missing-response' | 'unreachable-precondition' | 'stage-order' | 'orphan-stage';

export type MergeSource = 'captain' | 'firstOfficer';
export type ProvenanceSource = MergeSource | 'reviewer' | 'both';
export type ItemMergeField = 'challenge' | 'response' | 'preconditions' | 'critical' | 'abnormalProcedure' | 'stageId';
export type StageMergeField = 'name' | 'description' | 'order';
export type MergeField = ItemMergeField | StageMergeField;

export interface FlightStage {
  id: string;
  name: string;
  order: number;
  description: string;
  provenance?: Partial<Record<StageMergeField, ProvenanceSource>>;
}

export interface ChecklistItem {
  id: string;
  stageId: string;
  order: number;
  challenge: string;
  response: string;
  critical: boolean;
  preconditionIds: string[];
  abnormalProcedure: string;
  updatedAt: string;
  provenance?: Partial<Record<ItemMergeField, ProvenanceSource>>;
}

export interface ChecklistRevision {
  id: string;
  revision: number;
  status: WorkflowStatus;
  createdAt: string;
  note: string;
  stages: FlightStage[];
  items: ChecklistItem[];
}

export interface MergeInfo {
  mergedAt: string;
  baseRevisionId: string;
  baseRevisionNumber: number;
  captainLabel: string;
  firstOfficerLabel: string;
  addedCount: number;
  removedCount: number;
  autoChangeCount: number;
  resolvedConflictCount: number;
  note: string;
}

export interface ChecklistProject {
  id: string;
  name: string;
  aircraft: string;
  revision: number;
  status: WorkflowStatus;
  updatedAt: string;
  reviewNote: string;
  /** 本轮修改共同出发的冻结底本；离线交接合并以此为三方合并的 base。 */
  baseRevisionId: string;
  /** 最近一次离线交接合并的摘要，用于复核稿溯源。 */
  mergeInfo?: MergeInfo;
  stages: FlightStage[];
  items: ChecklistItem[];
  revisions: ChecklistRevision[];
}

export interface WorkspaceState {
  schemaVersion: 2;
  selectedProjectId: string;
  projects: ChecklistProject[];
  mergeSessions: MergeSession[];
  activeMergeSessionId: string | null;
}

export interface ValidationIssue {
  id: string;
  type: IssueType;
  level: IssueLevel;
  stageId?: string;
  itemId?: string;
  title: string;
  detail: string;
}

export interface VersionOption {
  id: string;
  label: string;
}

export interface DiffEntry {
  type: 'added' | 'removed' | 'changed' | 'stage';
  key: string;
  stage: string;
  before: string;
  after: string;
}

/** 从平板导出的现场改动包，自带冻结底本快照，保证基地侧可完全离线做三方合并。 */
export interface HandoffBundle {
  kind: 'flight-checklist-handoff';
  formatVersion: 2;
  projectId: string;
  projectName: string;
  baseRevisionId: string;
  baseRevisionNumber: number;
  exportedAt: string;
  source: MergeSource;
  deviceLabel: string;
  base: {
    stages: FlightStage[];
    items: ChecklistItem[];
  };
  stages: FlightStage[];
  items: ChecklistItem[];
}

export type MergeSessionStatus = 'waiting' | 'open' | 'applied';

export interface MergeSidePayload {
  source: MergeSource;
  label: string;
  exportedAt: string;
  fileName?: string;
  stages: FlightStage[];
  items: ChecklistItem[];
}

export type MergeResolution =
  | { kind: 'field'; choice: MergeSource | 'custom'; custom?: string | string[] }
  | { kind: 'modify-delete'; action: 'keep' | 'delete'; side?: MergeSource }
  | { kind: 'missing-stage'; action: 'move' | 'delete'; stageId?: string }
  | { kind: 'dangling-precondition'; action: 'remove' | 'rebind'; targetId?: string };

/** 一次离线交接的合并会话：导入两侧后生成，持久化在浏览器中，中断后可继续。 */
export interface MergeSession {
  id: string;
  projectId: string;
  projectName: string;
  baseRevisionId: string;
  baseRevisionNumber: number;
  base: {
    stages: FlightStage[];
    items: ChecklistItem[];
  };
  createdAt: string;
  updatedAt: string;
  captain?: MergeSidePayload;
  firstOfficer?: MergeSidePayload;
  resolutions: Record<string, MergeResolution>;
  status: MergeSessionStatus;
  appliedAt?: string;
}

export type MergeConflictKind = 'field' | 'modify-delete' | 'missing-stage' | 'dangling-precondition' | 'waiting-ref';

export interface MergeConflictView {
  id: string;
  kind: MergeConflictKind;
  entity: 'item' | 'stage';
  entityId: string;
  label: string;
  subLabel?: string;
  field?: MergeField;
  raw?: { base?: unknown; captain?: unknown; firstOfficer?: unknown };
  present?: { captain: boolean; firstOfficer: boolean };
  survivorSide?: MergeSource;
  refId?: string;
  blocking: boolean;
  resolution?: MergeResolution;
}

export interface MergeAutoChange {
  field: MergeField | 'entity';
  source: ProvenanceSource | 'both' | 'base';
  from: string;
  to: string;
  note?: string;
}

export interface MergeAutoEntry {
  id: string;
  entity: 'item' | 'stage';
  entityId: string;
  label: string;
  addedBy?: MergeSource;
  removed?: boolean;
  changes: MergeAutoChange[];
}

export interface MergeStats {
  added: number;
  removed: number;
  autoChanges: number;
  pending: number;
  resolvedConflicts: number;
}

export interface MergeComputation {
  status: MergeSessionStatus;
  conflicts: MergeConflictView[];
  autoEntries: MergeAutoEntry[];
  candidate: { stages: FlightStage[]; items: ChecklistItem[] } | null;
  issues: ValidationIssue[];
  stats: MergeStats;
}
