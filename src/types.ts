export type WorkflowStatus = 'draft' | 'review' | 'frozen';
export type IssueLevel = 'error' | 'warning' | 'info';
export type IssueType = 'duplicate' | 'missing-response' | 'unreachable-precondition' | 'stage-order' | 'orphan-stage';

export interface FlightStage {
  id: string;
  name: string;
  order: number;
  description: string;
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

export interface ChecklistProject {
  id: string;
  name: string;
  aircraft: string;
  revision: number;
  status: WorkflowStatus;
  updatedAt: string;
  reviewNote: string;
  stages: FlightStage[];
  items: ChecklistItem[];
  revisions: ChecklistRevision[];
}

export interface WorkspaceState {
  schemaVersion: 2;
  selectedProjectId: string;
  projects: ChecklistProject[];
  handoverSessions: Record<string, MergeSession>;
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

// 离线交接合并：机长与副驾驶各持平板，回基地导入交接包后做三地合并
export type HandoverSide = 'captain' | 'first-officer';

export interface HandoverPackage {
  schemaVersion: 2;
  kind: 'flightline-handover';
  projectId: string;
  projectName: string;
  baseRevision: number;
  baseSnapshot: { stages: FlightStage[]; items: ChecklistItem[] };
  side: HandoverSide;
  author: string;
  exportedAt: string;
  stages: FlightStage[];
  items: ChecklistItem[];
}

export type ConflictField =
  | 'challenge'
  | 'response'
  | 'preconditionIds'
  | 'stageId'
  | 'critical'
  | 'abnormalProcedure'
  | 'name'
  | 'description';

export interface MergeConflict {
  id: string;
  kind: 'item-field' | 'item-delete' | 'stage-field' | 'stage-delete' | 'stage-order' | 'item-order';
  itemId?: string;
  stageId?: string;
  field?: ConflictField;
  title: string;
  baseValue: unknown;
  captainValue: unknown;
  firstOfficerValue: unknown;
  captainLabel: string;
  firstOfficerLabel: string;
}

export interface UnresolvedItem {
  itemId: string;
  challenge: string;
  missingStage: boolean;
  missingStageId?: string;
  missingPreconditionIds: string[];
}

export interface CleanEntry {
  id: string;
  kind: 'item-added' | 'item-removed' | 'item-changed' | 'stage-added' | 'stage-removed' | 'stage-changed' | 'order';
  source: HandoverSide | 'both';
  text: string;
}

export interface MergeSession {
  id: string;
  projectId: string;
  startedAt: string;
  updatedAt: string;
  baseRevision: number;
  baseSnapshot: { stages: FlightStage[]; items: ChecklistItem[] };
  captain: HandoverPackage | null;
  firstOfficer: HandoverPackage | null;
  decisions: Record<string, HandoverSide>;
  unresolvedActions: Record<string, { stageId?: string; removedPreconditionIds?: string[]; deleted?: boolean }>;
  status: 'in-progress' | 'applied';
}

export interface MergeResult {
  stages: FlightStage[];
  items: ChecklistItem[];
  conflicts: MergeConflict[];
  unresolved: UnresolvedItem[];
  clean: CleanEntry[];
  issues: ValidationIssue[];
  captainChanged: number;
  firstOfficerChanged: number;
}
