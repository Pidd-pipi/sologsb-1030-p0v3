import type {
  ChecklistItem,
  FlightStage,
  HandoffBundle,
  MergeAutoEntry,
  MergeComputation,
  MergeConflictView,
  MergeField,
  MergeResolution,
  MergeSession,
  MergeSidePayload,
  MergeSource,
  MergeStats,
  ProvenanceSource
} from './types';
import { validateProject } from './validation';

const now = () => new Date().toISOString();

export const SOURCE_META: Record<MergeSource, { short: string; label: string; color: 'blue' | 'cyan' }> = {
  captain: { short: '机', label: '机长平板', color: 'blue' },
  firstOfficer: { short: '副', label: '副驾驶平板', color: 'cyan' }
};

const OTHER: Record<MergeSource, MergeSource> = { captain: 'firstOfficer', firstOfficer: 'captain' };

export const FIELD_LABEL: Record<MergeField, string> = {
  challenge: '挑战语',
  response: '回应',
  preconditions: '前置条件',
  critical: '关键标记',
  abnormalProcedure: '异常处置',
  stageId: '所属阶段',
  name: '阶段名称',
  description: '阶段说明',
  order: '阶段顺序'
};

/** 检查项存储字段 → 合并界面展示字段。 */
const viewField = (field: string): MergeField => (field === 'preconditionIds' ? 'preconditions' : (field as MergeField));

const BLOCKING_ITEM_STORE_FIELDS = ['challenge', 'response', 'preconditionIds'] as const;
const AUTO_ITEM_STORE_FIELDS = ['critical', 'abnormalProcedure', 'stageId'] as const;
const ITEM_STORE_FIELDS = [...BLOCKING_ITEM_STORE_FIELDS, ...AUTO_ITEM_STORE_FIELDS] as const;
const BLOCKING_STAGE_STORE_FIELDS = ['name', 'description'] as const;
const STAGE_STORE_FIELDS = [...BLOCKING_STAGE_STORE_FIELDS] as const;

function eq(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

const textValue = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

function withProvenance<T extends { id: string }>(entity: T, fields: readonly string[], source: ProvenanceSource): T {
  const provenance: Record<string, ProvenanceSource> = {};
  fields.forEach((field) => {
    provenance[field] = source;
  });
  return { ...structuredClone(entity), provenance };
}

/** 按“机长序列为锚、另一方相对位置插入”合并有序 id 序列；仅保留 all 中仍存在的 id。 */
function mergeSequences(captain: string[], fo: string[], all: Set<string>): string[] {
  const result: string[] = [];
  const used = new Set<string>();
  const cAnchor = captain.filter((id) => all.has(id));
  const foIndex = new Map(fo.map((id, index) => [id, index]));
  cAnchor.forEach((captainId) => {
    const foPos = foIndex.get(captainId);
    if (foPos !== undefined) {
      fo.slice(0, foPos).forEach((id) => {
        if (all.has(id) && !used.has(id) && !cAnchor.includes(id)) {
          result.push(id);
          used.add(id);
        }
      });
    }
    if (!used.has(captainId)) {
      result.push(captainId);
      used.add(captainId);
    }
  });
  fo.forEach((id) => {
    if (all.has(id) && !used.has(id)) {
      result.push(id);
      used.add(id);
    }
  });
  all.forEach((id) => {
    if (!used.has(id)) result.push(id);
  });
  return result;
}

interface GroupResult<T> {
  entities: Map<string, T>;
  conflicts: MergeConflictView[];
  resolvedConflicts: MergeConflictView[];
  autoEntries: Map<string, MergeAutoEntry>;
  modifyDeleteUnresolved: Set<string>;
  modifyDeleteResolvedDelete: Set<string>;
  pendingIds: Set<string>;
  addedBy: Map<string, MergeSource>;
  removedIds: Set<string>;
}

interface MergeGroupOptions<T> {
  entityName: 'item' | 'stage';
  base: T[];
  captain: T[];
  firstOfficer: T[];
  fields: readonly string[];
  blockingFields: readonly string[];
  conflictKey: (id: string, field: string) => string;
  label: (entity: T) => string;
  subLabel?: (field: string, baseValue: unknown) => string | undefined;
  updatedAt: (entity: T) => string;
  resolutions: Record<string, MergeResolution>;
  autoEntries: Map<string, MergeAutoEntry>;
}

function mergeGroup<T extends { id: string }>(options: MergeGroupOptions<T>): GroupResult<T> {
  const { entityName, base, captain, firstOfficer, fields, blockingFields, conflictKey, label, updatedAt, resolutions, autoEntries } = options;
  const baseMap = new Map(base.map((e) => [e.id, e]));
  const cMap = new Map(captain.map((e) => [e.id, e]));
  const fMap = new Map(firstOfficer.map((e) => [e.id, e]));
  const entities = new Map<string, T>();
  const conflicts: MergeConflictView[] = [];
  const resolvedConflicts: MergeConflictView[] = [];
  const modifyDeleteUnresolved = new Set<string>();
  const modifyDeleteResolvedDelete = new Set<string>();
  const pendingIds = new Set<string>();
  const addedBy = new Map<string, MergeSource>();
  const removedIds = new Set<string>();

  const ensureAuto = (id: string, fallbackLabel: string): MergeAutoEntry => {
    let entry = autoEntries.get(id);
    if (!entry) {
      entry = { id: `${entityName}:${id}`, entity: entityName, entityId: id, label: fallbackLabel, changes: [] };
      autoEntries.set(entry.id, entry);
    }
    return entry;
  };

  const allIds = new Set<string>([...baseMap.keys(), ...cMap.keys(), ...fMap.keys()]);

  for (const id of allIds) {
    const b = baseMap.get(id);
    const c = cMap.get(id);
    const f = fMap.get(id);
    const display = c ?? f ?? b!;
    const entryLabel = label(display);

    // —— 底本不存在：新增实体 ——
    if (!b) {
      if (c && f) {
        // 双方各自新建且 id 相同：按全新实体三方合并（底本视为空）
        const merged: Record<string, unknown> = { ...c, id };
        const provenance: Record<string, ProvenanceSource> = {};
        let pending = false;
        for (const field of fields) {
          const cVal = (c as Record<string, unknown>)[field];
          const fVal = (f as Record<string, unknown>)[field];
          if (eq(cVal, fVal)) {
            merged[field] = cVal;
            continue;
          }
          const key = conflictKey(id, field);
          const resolution = resolutions[key];
          const blocking = blockingFields.includes(field);
          if (resolution?.kind === 'field') {
            if (resolution.choice === 'custom' && resolution.custom !== undefined) {
              merged[field] = resolution.custom;
              provenance[field] = 'reviewer';
            } else if (resolution.choice === 'captain' || resolution.choice === 'firstOfficer') {
              const side = resolution.choice;
              merged[field] = side === 'captain' ? cVal : fVal;
              provenance[field] = side;
            }
            if (blocking) {
              resolvedConflicts.push({
                id: key, kind: 'field', entity: entityName, entityId: id, label: entryLabel,
                field: viewField(field), raw: { captain: cVal, firstOfficer: fVal },
                present: { captain: true, firstOfficer: true }, blocking: true, resolution
              });
            }
          } else if (blocking) {
            merged[field] = field === 'preconditionIds' ? [] : '';
            pending = true;
            conflicts.push({
              id: key,
              kind: 'field',
              entity: entityName,
              entityId: id,
              label: entryLabel,
              field: viewField(field),
              raw: { captain: cVal, firstOfficer: fVal },
              present: { captain: true, firstOfficer: true },
              blocking: true
            });
          } else {
            merged[field] = cVal;
            provenance[field] = 'captain';
            ensureAuto(id, entryLabel).changes.push({ field: viewField(field), source: 'captain', from: textValue(fVal), to: textValue(cVal), note: '双方新增冲突，采用机长值' });
          }
        }
        merged.provenance = provenance;
        entities.set(id, merged as T);
        if (pending) pendingIds.add(id);
        continue;
      }
      const source: MergeSource = c ? 'captain' : 'firstOfficer';
      const entity = withProvenance((c ?? f)!, fields, source);
      entities.set(id, entity);
      addedBy.set(id, source);
      ensureAuto(id, entryLabel).addedBy = source;
      continue;
    }

    // —— 删除情况 ——
    if (!c || !f) {
      const survivor: MergeSource | undefined = c ? 'captain' : f ? 'firstOfficer' : undefined;
      if (!survivor) {
        removedIds.add(id);
        ensureAuto(id, entryLabel).removed = true;
        continue;
      }
      const survivorEntity = (c ?? f)!;
      const survivorChanged = fields.some((field) => !eq((b as Record<string, unknown>)[field], (survivorEntity as Record<string, unknown>)[field]));
      const key = `${entityName}:${id}:modify-delete`;
      const resolution = resolutions[key];
      const otherSide = OTHER[survivor];

      if (resolution?.kind === 'modify-delete') {
        resolvedConflicts.push({
          id: key,
          kind: 'modify-delete',
          entity: entityName,
          entityId: id,
          label: entryLabel,
          present: { captain: Boolean(c), firstOfficer: Boolean(f) },
          survivorSide: survivor,
          blocking: true,
          resolution
        });
        if (resolution.action === 'delete') {
          modifyDeleteResolvedDelete.add(id);
          removedIds.add(id);
          ensureAuto(id, entryLabel).removed = true;
          continue;
        }
        const keepSide = resolution.side ?? survivor;
        const keptEntity = keepSide === survivor ? survivorEntity : (c ?? f)!;
        entities.set(id, withProvenance(keptEntity, fields, keepSide));
        continue;
      }

      if (!survivorChanged) {
        // 一方删除、另一方未改 → 直接接受删除
        removedIds.add(id);
        const auto = ensureAuto(id, entryLabel);
        auto.removed = true;
        auto.changes.push({ field: 'entity', source: otherSide, from: entryLabel, to: '已删除', note: `${SOURCE_META[otherSide].label}删除，另一方未改动` });
        continue;
      }

      // 改删冲突 → 待决项（候选稿中暂留存活方内容）
      modifyDeleteUnresolved.add(id);
      pendingIds.add(id);
      entities.set(id, structuredClone(survivorEntity));
      conflicts.push({
        id: key,
        kind: 'modify-delete',
        entity: entityName,
        entityId: id,
        label: entryLabel,
        present: { captain: Boolean(c), firstOfficer: Boolean(f) },
        survivorSide: survivor,
        blocking: true
      });
      continue;
    }

    // —— 三方都在：逐字段 3-way ——
    const merged: Record<string, unknown> = { ...structuredClone(c), id };
    const provenance: Record<string, ProvenanceSource> = {};
    let pending = false;
    for (const field of fields) {
      const bVal = (b as Record<string, unknown>)[field];
      const cVal = (c as Record<string, unknown>)[field];
      const fVal = (f as Record<string, unknown>)[field];
      if (eq(cVal, fVal)) {
        merged[field] = cVal;
        if (!eq(bVal, cVal)) provenance[field] = 'both';
        continue;
      }
      const cChanged = !eq(bVal, cVal);
      const fChanged = !eq(bVal, fVal);
      if (cChanged && !fChanged) {
        merged[field] = cVal;
        provenance[field] = 'captain';
        continue;
      }
      if (!cChanged && fChanged) {
        merged[field] = fVal;
        provenance[field] = 'firstOfficer';
        continue;
      }
      // 双方都改且结果不同
      const key = conflictKey(id, field);
      const resolution = resolutions[key];
      const blocking = blockingFields.includes(field);
      if (resolution?.kind === 'field') {
        if (resolution.choice === 'custom' && resolution.custom !== undefined) {
          merged[field] = resolution.custom;
          provenance[field] = 'reviewer';
        } else {
          const side: MergeSource = resolution.choice === 'firstOfficer' ? 'firstOfficer' : 'captain';
          merged[field] = side === 'captain' ? cVal : fVal;
          provenance[field] = side;
        }
        if (blocking) {
          resolvedConflicts.push({
            id: key, kind: 'field', entity: entityName, entityId: id, label: entryLabel,
            subLabel: options.subLabel?.(field, bVal), field: viewField(field),
            raw: { base: bVal, captain: cVal, firstOfficer: fVal },
            present: { captain: true, firstOfficer: true }, blocking: true, resolution
          });
        }
        continue;
      }
      if (blocking) {
        pending = true;
        merged[field] = field === 'preconditionIds' ? [] : (bVal ?? '');
        conflicts.push({
          id: key,
          kind: 'field',
          entity: entityName,
          entityId: id,
          label: entryLabel,
          subLabel: options.subLabel?.(field, bVal),
          field: viewField(field),
          raw: { base: bVal, captain: cVal, firstOfficer: fVal },
          present: { captain: true, firstOfficer: true },
          blocking: true
        });
      } else {
        // 非阻断字段（关键标记 / 异常处置 / 阶段归属）：按更新时间自动取新，同时间机长优先
        const cTime = Date.parse(updatedAt(c));
        const fTime = Date.parse(updatedAt(f));
        const winnerSide: MergeSource = fTime > cTime ? 'firstOfficer' : 'captain';
        const chosen = winnerSide === 'captain' ? cVal : fVal;
        merged[field] = chosen;
        provenance[field] = winnerSide;
        ensureAuto(id, entryLabel).changes.push({
          field: viewField(field),
          source: winnerSide,
          from: textValue(winnerSide === 'captain' ? fVal : cVal),
          to: textValue(chosen),
          note: '双方改动不同，按最近修改自动取值'
        });
      }
    }
    merged.provenance = provenance;
    entities.set(id, merged as T);
    if (pending) pendingIds.add(id);
  }

  return { entities, conflicts, resolvedConflicts, autoEntries, modifyDeleteUnresolved, modifyDeleteResolvedDelete, pendingIds, addedBy, removedIds };
}

export function computeMerge(session: MergeSession): MergeComputation {
  if (session.status === 'applied') {
    return { status: 'applied', conflicts: [], autoEntries: [], candidate: null, issues: [], stats: { added: 0, removed: 0, autoChanges: 0, pending: 0, resolvedConflicts: 0 } };
  }
  if (!session.captain || !session.firstOfficer) {
    return { status: 'waiting', conflicts: [], autoEntries: [], candidate: null, issues: [], stats: { added: 0, removed: 0, autoChanges: 0, pending: 0, resolvedConflicts: 0 } };
  }

  const captain = session.captain;
  const firstOfficer = session.firstOfficer;
  const resolutions = session.resolutions;
  const autoEntries = new Map<string, MergeAutoEntry>();

  const labelOfItem = (id: string): string => {
    const hit = [...session.base.items, ...captain.items, ...firstOfficer.items].find((entry) => entry.id === id);
    return hit?.challenge || id;
  };

  const stageGroup = mergeGroup<FlightStage>({
    entityName: 'stage',
    base: session.base.stages,
    captain: captain.stages,
    firstOfficer: firstOfficer.stages,
    fields: STAGE_STORE_FIELDS,
    blockingFields: BLOCKING_STAGE_STORE_FIELDS,
    conflictKey: (id, field) => `stage:${id}:field:${field}`,
    label: (stage) => stage.name || '未命名阶段',
    updatedAt: () => '1970-01-01T00:00:00.000Z',
    resolutions,
    autoEntries
  });

  const itemGroup = mergeGroup<ChecklistItem>({
    entityName: 'item',
    base: session.base.items,
    captain: captain.items,
    firstOfficer: firstOfficer.items,
    fields: ITEM_STORE_FIELDS,
    blockingFields: BLOCKING_ITEM_STORE_FIELDS,
    conflictKey: (id, field) => `item:${id}:field:${field === 'preconditionIds' ? 'preconditions' : field}`,
    label: (item) => item.challenge || '未命名检查项',
    subLabel: (field, baseValue) => {
      if (field !== 'preconditionIds') return undefined;
      const ids = Array.isArray(baseValue) ? (baseValue as string[]) : [];
      return ids.length ? `底本：${ids.map(labelOfItem).join('、')}` : '底本无前置条件';
    },
    updatedAt: (item) => item.updatedAt,
    resolutions,
    autoEntries
  });

  // —— 找不到对象 / 阶段缺失：实体合并后统一扫描 ——
  // 已解决的阻断冲突同样进入列表（带 resolution），供复核人回看或清除选择。
  const conflicts: MergeConflictView[] = [...stageGroup.conflicts, ...itemGroup.conflicts, ...stageGroup.resolvedConflicts, ...itemGroup.resolvedConflicts];

  const isStageMissing = (stageId: string): boolean =>
    !stageGroup.entities.has(stageId) || stageGroup.pendingIds.has(stageId);

  itemGroup.entities.forEach((item, id) => {
    if (isStageMissing(item.stageId)) {
      const key = `item:${id}:missing-stage`;
      if (!conflicts.some((c) => c.id === key)) {
        conflicts.push({
          id: key,
          kind: 'missing-stage',
          entity: 'item',
          entityId: id,
          label: item.challenge || '未命名检查项',
          subLabel: stageGroup.modifyDeleteUnresolved.has(item.stageId) ? '其所属阶段存在改删冲突，待阶段决定后自动重算' : '所属阶段在合并结果中找不到',
          blocking: true
        });
      }
    }
    item.preconditionIds.forEach((refId) => {
      if (refId === item.id) return;
      const key = `item:${id}:precondition:${refId}`;
      if (itemGroup.modifyDeleteUnresolved.has(refId)) {
        if (!conflicts.some((c) => c.id === key)) {
          conflicts.push({
            id: key,
            kind: 'waiting-ref',
            entity: 'item',
            entityId: id,
            label: item.challenge || '未命名检查项',
            subLabel: `前置“${labelOfItem(refId)}”存在改删冲突，待其决定后自动重算`,
            refId,
            blocking: false
          });
        }
      } else if (itemGroup.modifyDeleteResolvedDelete.has(refId) || !itemGroup.entities.has(refId)) {
        if (!conflicts.some((c) => c.id === key)) {
          conflicts.push({
            id: key,
            kind: 'dangling-precondition',
            entity: 'item',
            entityId: id,
            label: item.challenge || '未命名检查项',
            subLabel: `前置“${labelOfItem(refId)}”在合并结果中找不到`,
            refId,
            blocking: true
          });
        }
      }
    });
  });

  // —— 候选阶段：序列合并后重排 order（阶段顺序异常立即重算）——
  const allStageIds = new Set(stageGroup.entities.keys());
  const stageOrder = mergeSequences(
    captain.stages.slice().sort((a, b) => a.order - b.order).map((s) => s.id).filter((id) => allStageIds.has(id)),
    firstOfficer.stages.slice().sort((a, b) => a.order - b.order).map((s) => s.id).filter((id) => allStageIds.has(id)),
    allStageIds
  );
  const candidateStages: FlightStage[] = stageOrder
    .map((id, index) => {
      const stage = stageGroup.entities.get(id);
      if (!stage || stageGroup.pendingIds.has(id)) return undefined;
      return { ...structuredClone(stage), order: index };
    })
    .filter((s): s is FlightStage => Boolean(s));

  // —— 候选检查项：套用缺失阶段 / 悬空前置决议，按阶段序列合并并重排 order ——
  // 待决排除随决议即时重算：字段冲突、改删冲突、阶段缺失、悬空前置任一未解决即留在待确认区。
  const blockingByEntity = new Map<string, boolean>();
  conflicts.forEach((conflict) => {
    if (!conflict.blocking || resolutions[conflict.id]) return;
    blockingByEntity.set(conflict.entityId, true);
  });

  const candidateItemsRaw: ChecklistItem[] = [];
  itemGroup.entities.forEach((raw, id) => {
    if (itemGroup.pendingIds.has(id) || blockingByEntity.get(id)) return;

    const item = structuredClone(raw);
    const missingKey = `item:${id}:missing-stage`;
    const missingResolution = resolutions[missingKey];
    if (isStageMissing(item.stageId)) {
      if (missingResolution?.kind === 'missing-stage' && missingResolution.action === 'move' && missingResolution.stageId) {
        item.stageId = missingResolution.stageId;
      } else if (missingResolution?.kind === 'missing-stage' && missingResolution.action === 'delete') {
        const auto = autoEntries.get(`item:${id}`);
        if (auto) auto.removed = true;
        return;
      } else {
        return; // 未决：留在待确认区，不进候选稿
      }
    }

    const drops: string[] = [];
    const rebinds = new Map<string, string>();
    const unresolvedDangling: string[] = [];
    item.preconditionIds.forEach((refId) => {
      const key = `item:${id}:precondition:${refId}`;
      const resolution = resolutions[key];
      if (resolution?.kind === 'dangling-precondition') {
        if (resolution.action === 'remove') drops.push(refId);
        else if (resolution.action === 'rebind' && resolution.targetId && resolution.targetId !== item.id) rebinds.set(refId, resolution.targetId);
        else unresolvedDangling.push(refId);
      } else if (conflicts.some((conflict) => conflict.id === key && conflict.blocking)) {
        unresolvedDangling.push(refId);
      }
    });
    if (unresolvedDangling.length) return; // 悬空前置尚未选定：继续留在待确认区
    if (drops.length || rebinds.size) {
      item.preconditionIds = item.preconditionIds.flatMap((ref) => (drops.includes(ref) ? [] : [rebinds.get(ref) ?? ref]));
    }
    candidateItemsRaw.push(item);
  });

  // 序列必须按各自平板上的（阶段 order, 检查项 order）排序，不能直接用数组顺序。
  const cSeqByStage = new Map<string, string[]>();
  const fSeqByStage = new Map<string, string[]>();
  const finalStageById = new Map(candidateItemsRaw.map((item) => [item.id, item.stageId]));
  const buildSideSeq = (seq: Map<string, string[]>, sideItems: ChecklistItem[], sideStages: FlightStage[]) => {
    const stageOrder = new Map(sideStages.map((stage) => [stage.id, stage.order]));
    sideItems
      .slice()
      .sort((a, b) => (stageOrder.get(a.stageId) ?? 0) - (stageOrder.get(b.stageId) ?? 0) || a.order - b.order)
      .forEach((item) => {
        const finalStageId = finalStageById.get(item.id);
        if (finalStageId) seq.set(finalStageId, [...(seq.get(finalStageId) ?? []), item.id]);
      });
  };
  buildSideSeq(cSeqByStage, captain.items, captain.stages);
  buildSideSeq(fSeqByStage, firstOfficer.items, firstOfficer.stages);
  const candidateItems: ChecklistItem[] = [];
  for (const stage of candidateStages) {
    const inStage = new Set(candidateItemsRaw.filter((item) => item.stageId === stage.id).map((item) => item.id));
    const ordered = mergeSequences(cSeqByStage.get(stage.id) ?? [], fSeqByStage.get(stage.id) ?? [], inStage);
    ordered.forEach((id, index) => {
      const item = candidateItemsRaw.find((entry) => entry.id === id);
      if (item) candidateItems.push({ ...item, order: index });
    });
  }

  // —— 待决视图：挂上已选决议、排序 ——
  const sortedConflicts = conflicts
    .map((conflict) => (resolutions[conflict.id] ? { ...conflict, resolution: resolutions[conflict.id] } : conflict))
    .sort((a, b) => {
      if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.label.localeCompare(b.label, 'zh-CN');
    });
  const pending = sortedConflicts.filter((c) => c.blocking && !resolutions[c.id]).length;
  const resolvedConflicts = sortedConflicts.filter((c) => resolutions[c.id]).length;

  // —— 候选稿即时校验（前置条件改动后不可达提示、阶段顺序异常立即重算）——
  const issues = pending > 0 ? [] : validateProject({
    id: session.projectId,
    name: session.projectName,
    aircraft: '',
    revision: session.baseRevisionNumber,
    status: 'draft',
    updatedAt: now(),
    reviewNote: '',
    baseRevisionId: session.baseRevisionId,
    stages: candidateStages,
    items: candidateItems,
    revisions: []
  });

  const autoList = [...autoEntries.values()]
    .filter((entry) => entry.addedBy || entry.removed || entry.changes.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));

  let added = 0;
  let removed = 0;
  let autoChanges = 0;
  autoList.forEach((entry) => {
    if (entry.addedBy) added += 1;
    if (entry.removed) removed += 1;
    autoChanges += entry.changes.length;
  });
  const stats: MergeStats = { added, removed, autoChanges, pending, resolvedConflicts };

  return {
    status: 'open',
    conflicts: sortedConflicts,
    autoEntries: autoList,
    candidate: { stages: candidateStages, items: candidateItems },
    issues,
    stats
  };
}

export function validateBundle(data: unknown): { ok: true; bundle: HandoffBundle } | { ok: false; reason: string } {
  if (!data || typeof data !== 'object') return { ok: false, reason: '文件不是有效的 JSON。' };
  const bundle = data as Partial<HandoffBundle>;
  if (bundle.kind !== 'flight-checklist-handoff' || bundle.formatVersion !== 2) {
    return { ok: false, reason: '文件不是飞行检查单现场改动包（.fchk.json）。' };
  }
  if (!bundle.projectId || !bundle.baseRevisionId || !bundle.base || !Array.isArray(bundle.stages) || !Array.isArray(bundle.items)) {
    return { ok: false, reason: '改动包缺少底本或改动数据，无法离线合并。' };
  }
  if (bundle.source !== 'captain' && bundle.source !== 'firstOfficer') {
    return { ok: false, reason: '改动包缺少改动来源（机长 / 副驾驶）。' };
  }
  return { ok: true, bundle: bundle as HandoffBundle };
}

export function bundleToSide(bundle: HandoffBundle): MergeSidePayload {
  return {
    source: bundle.source,
    label: bundle.deviceLabel || SOURCE_META[bundle.source].label,
    exportedAt: bundle.exportedAt,
    fileName: undefined,
    stages: bundle.stages,
    items: bundle.items
  };
}

export function formatValue(field: MergeField, value: unknown, labelOf: (id: string) => string): string {
  if (field === 'critical') return value ? '关键' : '普通';
  if (field === 'preconditions') {
    const ids = Array.isArray(value) ? (value as string[]) : [];
    return ids.length ? ids.map(labelOf).join('、') : '（无）';
  }
  const text = textValue(value).trim();
  return text || '（空）';
}
