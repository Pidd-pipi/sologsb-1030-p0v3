import type {
  ChecklistItem,
  ChecklistProject,
  CleanEntry,
  FlightStage,
  HandoverPackage,
  HandoverSide,
  MergeConflict,
  MergeResult,
  MergeSession,
  UnresolvedItem
} from './types';
import { validateProject } from './validation';

export const HANDOVER_KIND = 'flightline-handover';
export const HANDOVER_SCHEMA_VERSION = 2;

const clone = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();

export const sideLabel = (side: HandoverSide): string => (side === 'captain' ? '机长' : '副驾驶');

// ---------- 交接包读写 ----------

export function buildHandoverPackage(
  project: ChecklistProject,
  baseRevisionId: string,
  side: HandoverSide,
  author: string
): HandoverPackage {
  const base = project.revisions.find((revision) => revision.id === baseRevisionId);
  if (!base) throw new Error('未找到作为底本的冻结版本');
  return {
    schemaVersion: HANDOVER_SCHEMA_VERSION,
    kind: HANDOVER_KIND,
    projectId: project.id,
    projectName: project.name,
    baseRevision: base.revision,
    baseSnapshot: { stages: clone(base.stages), items: clone(base.items) },
    side,
    author: author.trim() || sideLabel(side),
    exportedAt: now(),
    stages: clone(project.stages),
    items: clone(project.items)
  };
}

export function parseHandoverPackage(text: string): HandoverPackage {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('交接包文件无法解析（不是有效的 JSON）');
  }
  if (raw.kind !== HANDOVER_KIND) throw new Error('不是 Flightline 交接包文件（缺少 flightline-handover 标记）');
  if (raw.schemaVersion === 1) {
    // 旧草稿/旧包升级后仍可合并：结构一致，仅版本号不同
    raw.schemaVersion = HANDOVER_SCHEMA_VERSION;
  } else if (raw.schemaVersion !== HANDOVER_SCHEMA_VERSION) {
    throw new Error(`交接包版本不受支持（schemaVersion ${String(raw.schemaVersion)}）`);
  }
  const pkg = raw as unknown as HandoverPackage;
  if (!pkg.baseSnapshot || !Array.isArray(pkg.stages) || !Array.isArray(pkg.items)) {
    throw new Error('交接包内容不完整');
  }
  if (pkg.side !== 'captain' && pkg.side !== 'first-officer') {
    throw new Error('交接包缺少有效的来源（机长 / 副驾驶）');
  }
  return pkg;
}

export function downloadHandoverPackage(pkg: HandoverPackage) {
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `交接包-${pkg.side === 'captain' ? '机长' : '副驾驶'}-r${pkg.baseRevision}-${pkg.exportedAt.slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ---------- 字段展示 ----------

export const ITEM_FIELD_KEYS = ['challenge', 'response', 'preconditionIds', 'stageId', 'critical', 'abnormalProcedure'] as const;
export const STAGE_FIELD_KEYS = ['name', 'description'] as const;

export function fieldLabel(field: string): string {
  switch (field) {
    case 'challenge': return '挑战语';
    case 'response': return '预期回应';
    case 'preconditionIds': return '前置条件';
    case 'stageId': return '所属阶段';
    case 'critical': return '关键标记';
    case 'abnormalProcedure': return '异常处置';
    case 'name': return '阶段名称';
    case 'description': return '阶段说明';
    default: return field;
  }
}

export function formatFieldValue(
  field: string,
  value: unknown,
  stages: { id: string; name: string }[],
  items: { id: string; challenge: string }[]
): string {
  if (field === 'preconditionIds' && Array.isArray(value)) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const labels = value.map((id) => byId.get(String(id))?.challenge ?? `未知项（${String(id).slice(-4)}）`);
    return labels.length ? labels.join('、') : '（无）';
  }
  if (field === 'stageId') {
    return stages.find((stage) => stage.id === String(value))?.name ?? `未知阶段（${String(value).slice(-4)}）`;
  }
  if (field === 'critical') return value ? '是' : '否';
  if (Array.isArray(value)) return value.length ? value.join('、') : '（无）';
  const text = String(value ?? '');
  return text.trim() ? text : '（空）';
}

// ---------- 三地合并 ----------

function valueEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// 泛型字段赋值：避免对「联合键」直接写入时 TS 把目标推断为 never
function assignStageField<K extends 'name' | 'description'>(stage: FlightStage, field: K, value: FlightStage[K]) {
  stage[field] = value;
}

function assignItemField<K extends (typeof ITEM_FIELD_KEYS)[number]>(item: ChecklistItem, field: K, value: ChecklistItem[K]) {
  item[field] = value;
}

function mergeStageFields(
  merged: FlightStage,
  b: FlightStage,
  c: FlightStage | null | undefined,
  f: FlightStage | null | undefined,
  decisions: Record<string, HandoverSide>,
  conflicts: MergeConflict[]
): void {
  for (const field of STAGE_FIELD_KEYS) {
    const bv = b[field];
    const cv = c?.[field];
    const fv = f?.[field];
    const capChanged = c !== null && c !== undefined && !valueEqual(cv, bv);
    const foChanged = f !== null && f !== undefined && !valueEqual(fv, bv);
    if (capChanged && foChanged) {
      if (valueEqual(cv, fv)) {
        assignStageField(merged, field, cv!);
      } else {
        const decision = decisions[`${b.id}:${field}`];
        if (decision === 'captain') assignStageField(merged, field, cv!);
        else if (decision === 'first-officer') assignStageField(merged, field, fv!);
        else {
          conflicts.push({
            id: `${b.id}:${field}`,
            kind: 'stage-field',
            stageId: b.id,
            field,
            title: `阶段「${b.name}」的${fieldLabel(field)}有两套值`,
            baseValue: bv,
            captainValue: cv,
            firstOfficerValue: fv,
            captainLabel: `机长：${formatFieldValue(field, cv, c ? [c] : [], [])}`,
            firstOfficerLabel: `副驾驶：${formatFieldValue(field, fv, f ? [f] : [], [])}`
          });
        }
      }
    } else if (capChanged) {
      assignStageField(merged, field, cv!);
    } else if (foChanged) {
      assignStageField(merged, field, fv!);
    }
  }
}

function sequenceOfStages(stages: FlightStage[]): string[] {
  return stages.slice().sort((a, b) => a.order - b.order).map((stage) => stage.id);
}

function sequenceOfItems(stages: FlightStage[], items: ChecklistItem[]): string[] {
  return stages.slice().sort((a, b) => a.order - b.order)
    .flatMap((stage) => items.filter((item) => item.stageId === stage.id).sort((a, b) => a.order - b.order).map((item) => item.id));
}

function relativeOrder(seq: string[], common: Set<string>): string[] {
  return seq.filter((id) => common.has(id));
}

function orderChanged(base: string[], side: string[], common: Set<string>): boolean {
  const b = relativeOrder(base, common);
  const s = relativeOrder(side, common);
  return b.length === s.length && b.some((id, index) => id !== s[index]);
}

export function computeMerge(session: MergeSession, project: ChecklistProject): MergeResult {
  const base = session.baseSnapshot;
  const cap = session.captain;
  const fo = session.firstOfficer;
  const decisions = session.decisions;
  const actions = session.unresolvedActions;

  const baseStageById = new Map(base.stages.map((stage) => [stage.id, stage]));
  // 某一方未导入（null）时视为「未改动」，回退到底本，而不是删除全部内容
  const capStageById = new Map((cap?.stages ?? base.stages).map((stage) => [stage.id, stage]));
  const foStageById = new Map((fo?.stages ?? base.stages).map((stage) => [stage.id, stage]));
  const baseItemById = new Map(base.items.map((item) => [item.id, item]));
  const capItemById = new Map((cap?.items ?? base.items).map((item) => [item.id, item]));
  const foItemById = new Map((fo?.items ?? base.items).map((item) => [item.id, item]));

  const knownItemIds = new Set([...baseItemById.keys(), ...capItemById.keys(), ...foItemById.keys()]);
  const conflicts: MergeConflict[] = [];

  const itemContext = { stages: base.stages, items: [...base.items, ...(cap?.items ?? []), ...(fo?.items ?? [])] };
  const formatItemValue = (field: string, value: unknown) => formatFieldValue(field, value, itemContext.stages, itemContext.items);

  // ----- 阶段：存在性 + 字段级合并 -----
  const mergedStageById = new Map<string, FlightStage>();
  for (const id of new Set([...baseStageById.keys(), ...capStageById.keys(), ...foStageById.keys()])) {
    const b = baseStageById.get(id);
    const c = capStageById.get(id);
    const f = foStageById.get(id);

    if (!b) {
      if (c && f) {
        if (STAGE_FIELD_KEYS.every((field) => valueEqual(c[field], f[field]))) {
          mergedStageById.set(id, clone(c));
        } else {
          for (const field of STAGE_FIELD_KEYS) {
            if (!valueEqual(c[field], f[field])) {
              conflicts.push({
                id: `${id}:${field}`,
                kind: 'stage-field',
                stageId: id,
                field,
                title: `新增阶段「${c.name || f.name}」的${fieldLabel(field)}有两套值`,
                baseValue: undefined,
                captainValue: c[field],
                firstOfficerValue: f[field],
                captainLabel: `机长：${formatFieldValue(field, c[field], [c], [])}`,
                firstOfficerLabel: `副驾驶：${formatFieldValue(field, f[field], [f], [])}`
              });
            }
          }
          mergedStageById.set(id, clone(c));
        }
      } else if (c) {
        mergedStageById.set(id, clone(c));
      } else if (f) {
        mergedStageById.set(id, clone(f));
      }
      continue;
    }

    if (!c && !f) continue; // 双方均删除

    if (!c || !f) {
      const deletingSide: HandoverSide = !c ? 'captain' : 'first-officer';
      const keepingSide: HandoverSide = !c ? 'first-officer' : 'captain';
      const kept = (c ?? f)!;
      const unchanged = STAGE_FIELD_KEYS.every((field) => valueEqual(kept[field], b[field]));
      const referenced = [...(cap?.items ?? []), ...(fo?.items ?? [])].some((item) => item.stageId === id);
      const decision = decisions[`stage-delete:${id}`];
      if (unchanged && !referenced) continue; // 干净删除
      if (decision === deletingSide) continue;
      if (decision === keepingSide) {
        const merged = clone(b);
        mergeStageFields(merged, b, kept, null, decisions, conflicts);
        mergedStageById.set(id, merged);
        continue;
      }
      conflicts.push({
        id: `stage-delete:${id}`,
        kind: 'stage-delete',
        stageId: id,
        title: `阶段「${b.name}」一方删除、一方保留`,
        baseValue: b.name,
        captainValue: c ? c.name : '__deleted__',
        firstOfficerValue: f ? f.name : '__deleted__',
        captainLabel: c ? `保留阶段：${c.name}` : '删除该阶段',
        firstOfficerLabel: f ? `保留阶段：${f.name}` : '删除该阶段'
      });
      // 未选定前暂定沿用底本，避免检查项提前进入待确认区
      mergedStageById.set(id, clone(b));
      continue;
    }

    const merged = clone(b);
    mergeStageFields(merged, b, c, f, decisions, conflicts);
    mergedStageById.set(id, merged);
  }

  // ----- 检查项：字段级合并（挑战语 / 回应 / 前置条件等） -----
  const mergedItemById = new Map<string, ChecklistItem>();
  for (const id of knownItemIds) {
    const b = baseItemById.get(id);
    const c = capItemById.get(id);
    const f = foItemById.get(id);

    if (!b) {
      if (c && f) {
        if (ITEM_FIELD_KEYS.every((field) => valueEqual(c[field], f[field]))) {
          mergedItemById.set(id, clone(c));
        } else {
          for (const field of ITEM_FIELD_KEYS) {
            if (!valueEqual(c[field], f[field])) {
              conflicts.push({
                id: `${id}:${field}`,
                kind: 'item-field',
                itemId: id,
                field,
                title: `新增检查项「${c.challenge || f.challenge || '未命名'}」的${fieldLabel(field)}有两套值`,
                baseValue: undefined,
                captainValue: c[field],
                firstOfficerValue: f[field],
                captainLabel: `机长：${formatItemValue(field, c[field])}`,
                firstOfficerLabel: `副驾驶：${formatItemValue(field, f[field])}`
              });
            }
          }
          mergedItemById.set(id, clone(c));
        }
      } else if (c) {
        mergedItemById.set(id, clone(c));
      } else if (f) {
        mergedItemById.set(id, clone(f));
      }
      continue;
    }

    if (!c && !f) continue; // 双方均删除

    if (!c || !f) {
      const deletingSide: HandoverSide = !c ? 'captain' : 'first-officer';
      const keepingSide: HandoverSide = !c ? 'first-officer' : 'captain';
      const kept = (c ?? f)!;
      const unchanged = ITEM_FIELD_KEYS.every((field) => valueEqual(kept[field], b[field]));
      const decision = decisions[`item-delete:${id}`];
      if (unchanged) continue; // 干净删除
      if (decision === deletingSide) continue;
      if (decision === keepingSide) {
        mergedItemById.set(id, clone(kept));
        continue;
      }
      conflicts.push({
        id: `item-delete:${id}`,
        kind: 'item-delete',
        itemId: id,
        title: `检查项「${b.challenge}」一方删除、一方修改`,
        baseValue: b.challenge,
        captainValue: c ? c.challenge : '__deleted__',
        firstOfficerValue: f ? f.challenge : '__deleted__',
        captainLabel: c ? `保留并修改：${c.challenge || '未命名'}` : '删除该检查项',
        firstOfficerLabel: f ? `保留并修改：${f.challenge || '未命名'}` : '删除该检查项'
      });
      // 未选定前不进复核稿
      continue;
    }

    const merged = clone(b);
    let pending = false;
    for (const field of ITEM_FIELD_KEYS) {
      const bv = b[field];
      const cv = c[field];
      const fv = f[field];
      const capChanged = !valueEqual(cv, bv);
      const foChanged = !valueEqual(fv, bv);
      if (capChanged && foChanged) {
        if (valueEqual(cv, fv)) {
          assignItemField(merged, field, cv);
        } else {
          const decision = decisions[`${id}:${field}`];
          if (decision === 'captain') assignItemField(merged, field, cv);
          else if (decision === 'first-officer') assignItemField(merged, field, fv);
          else {
            conflicts.push({
              id: `${id}:${field}`,
              kind: 'item-field',
              itemId: id,
              field,
              title: `检查项「${c.challenge || f.challenge || '未命名'}」的${fieldLabel(field)}有两套值`,
              baseValue: bv,
              captainValue: cv,
              firstOfficerValue: fv,
              captainLabel: `机长：${formatItemValue(field, cv)}`,
              firstOfficerLabel: `副驾驶：${formatItemValue(field, fv)}`
            });
            pending = true;
          }
        }
      } else if (capChanged) {
        assignItemField(merged, field, cv);
      } else if (foChanged) {
        assignItemField(merged, field, fv);
      }
    }
    if (!pending) mergedItemById.set(id, merged);
  }

  // ----- 顺序合并：换阶段后阶段顺序异常立即重算 -----
  const baseStageSeq = sequenceOfStages(base.stages);
  const capStageSeq = sequenceOfStages(cap?.stages ?? []);
  const foStageSeq = sequenceOfStages(fo?.stages ?? []);
  const baseItemSeq = sequenceOfItems(base.stages, base.items);
  const capItemSeq = sequenceOfItems(cap?.stages ?? [], cap?.items ?? []);
  const foItemSeq = sequenceOfItems(fo?.stages ?? [], fo?.items ?? []);

  const mergedStageIds = [...mergedStageById.keys()];
  const commonStageIds = new Set(mergedStageIds);
  const capStageOrderChanged = cap !== null && orderChanged(baseStageSeq, capStageSeq, commonStageIds);
  const foStageOrderChanged = fo !== null && orderChanged(baseStageSeq, foStageSeq, commonStageIds);
  const stageOrderConflictPending = capStageOrderChanged && foStageOrderChanged
    && relativeOrder(capStageSeq, commonStageIds).join('|') !== relativeOrder(foStageSeq, commonStageIds).join('|')
    && !decisions['stage-order'];

  let orderedStageIds: string[];
  if (capStageOrderChanged && foStageOrderChanged) {
    const capRel = relativeOrder(capStageSeq, commonStageIds);
    const foRel = relativeOrder(foStageSeq, commonStageIds);
    if (capRel.join('|') === foRel.join('|')) {
      orderedStageIds = capRel;
    } else {
      const decision = decisions['stage-order'];
      if (decision === 'captain') orderedStageIds = capRel;
      else if (decision === 'first-officer') orderedStageIds = foRel;
      else {
        conflicts.push({
          id: 'stage-order',
          kind: 'stage-order',
          title: '飞行阶段顺序有两套排法',
          baseValue: relativeOrder(baseStageSeq, commonStageIds).map((id) => mergedStageById.get(id)?.name ?? id).join(' → '),
          captainValue: capRel.map((id) => mergedStageById.get(id)?.name ?? id).join(' → '),
          firstOfficerValue: foRel.map((id) => mergedStageById.get(id)?.name ?? id).join(' → '),
          captainLabel: capRel.map((id) => mergedStageById.get(id)?.name ?? id).join(' → '),
          firstOfficerLabel: foRel.map((id) => mergedStageById.get(id)?.name ?? id).join(' → ')
        });
        orderedStageIds = relativeOrder(baseStageSeq, commonStageIds);
      }
    }
  } else if (capStageOrderChanged) {
    orderedStageIds = relativeOrder(capStageSeq, commonStageIds);
  } else if (foStageOrderChanged) {
    orderedStageIds = relativeOrder(foStageSeq, commonStageIds);
  } else {
    orderedStageIds = relativeOrder(baseStageSeq, commonStageIds);
  }
  for (const id of mergedStageIds) {
    if (!orderedStageIds.includes(id)) orderedStageIds.push(id);
  }
  const mergedStages: FlightStage[] = orderedStageIds.map((id, index) => ({ ...mergedStageById.get(id)!, order: index }));

  const mergedItemIds = [...mergedItemById.keys()];
  const commonItemIds = new Set(mergedItemIds);
  const capItemOrderChanged = cap !== null && orderChanged(baseItemSeq, capItemSeq, commonItemIds);
  const foItemOrderChanged = fo !== null && orderChanged(baseItemSeq, foItemSeq, commonItemIds);
  const itemOrderConflictPending = capItemOrderChanged && foItemOrderChanged
    && relativeOrder(capItemSeq, commonItemIds).join('|') !== relativeOrder(foItemSeq, commonItemIds).join('|')
    && !decisions['item-order'];

  let orderedItemIds: string[];
  if (capItemOrderChanged && foItemOrderChanged) {
    const capRel = relativeOrder(capItemSeq, commonItemIds);
    const foRel = relativeOrder(foItemSeq, commonItemIds);
    if (capRel.join('|') === foRel.join('|')) {
      orderedItemIds = capRel;
    } else {
      const decision = decisions['item-order'];
      if (decision === 'captain') orderedItemIds = capRel;
      else if (decision === 'first-officer') orderedItemIds = foRel;
      else {
        conflicts.push({
          id: 'item-order',
          kind: 'item-order',
          title: '检查项排列顺序有两套排法',
          baseValue: '',
          captainValue: '',
          firstOfficerValue: '',
          captainLabel: capRel.map((id) => mergedItemById.get(id)?.challenge || '未命名').join(' → '),
          firstOfficerLabel: foRel.map((id) => mergedItemById.get(id)?.challenge || '未命名').join(' → ')
        });
        orderedItemIds = relativeOrder(baseItemSeq, commonItemIds);
      }
    }
  } else if (capItemOrderChanged) {
    orderedItemIds = relativeOrder(capItemSeq, commonItemIds);
  } else if (foItemOrderChanged) {
    orderedItemIds = relativeOrder(foItemSeq, commonItemIds);
  } else {
    orderedItemIds = relativeOrder(baseItemSeq, commonItemIds);
  }
  for (const id of mergedItemIds) {
    if (!orderedItemIds.includes(id)) orderedItemIds.push(id);
  }

  // ----- 待确认区：找不到对象的检查项 -----
  const mergedStageIdSet = new Set(mergedStages.map((stage) => stage.id));
  // 悬空判定以「并入草稿的检查项」为准：被干净删除的项不再是可引用对象；
  // 待决项暂不在草稿中，引用它们的检查项会留在待确认区，待决定后重算。
  const draftItemIds = new Set(mergedItemById.keys());
  const unresolved: UnresolvedItem[] = [];
  for (const item of mergedItemById.values()) {
    const missingStage = !mergedStageIdSet.has(item.stageId);
    const missingPreconditionIds = item.preconditionIds.filter((id) => !draftItemIds.has(id));
    if (missingStage || missingPreconditionIds.length) {
      unresolved.push({
        itemId: item.id,
        challenge: item.challenge,
        missingStage,
        missingStageId: missingStage ? item.stageId : undefined,
        missingPreconditionIds
      });
    }
  }

  // 应用待确认处理：重新挂载阶段 / 移除悬空前置条件 / 删除
  const finalItems: ChecklistItem[] = [];
  for (const id of orderedItemIds) {
    const item = mergedItemById.get(id);
    if (!item) continue;
    const action = actions[id];
    const unresolvedEntry = unresolved.find((entry) => entry.itemId === id);
    if (unresolvedEntry) {
      if (action?.deleted) continue; // 已删除
      if (!action) continue; // 未处理：留在待确认区
      const fixed = clone(item);
      if (action.stageId) fixed.stageId = action.stageId;
      if (action.removedPreconditionIds?.length) {
        const removed = new Set(action.removedPreconditionIds);
        fixed.preconditionIds = fixed.preconditionIds.filter((preconditionId) => !removed.has(preconditionId));
      }
      const stillMissingStage = !mergedStageIdSet.has(fixed.stageId);
      const stillMissingPrecondition = fixed.preconditionIds.some((preconditionId) => !draftItemIds.has(preconditionId));
      if (stillMissingStage || stillMissingPrecondition) continue;
      finalItems.push(fixed);
    } else if (!action?.deleted) {
      finalItems.push(item);
    }
  }
  finalItems.forEach((item) => {
    const siblings = finalItems.filter((other) => other.stageId === item.stageId);
    item.order = siblings.indexOf(item);
  });

  // 待确认区最终状态：仍未进稿且未删除的项
  const finalItemIds = new Set(finalItems.map((item) => item.id));
  const finalUnresolved = unresolved.filter((entry) => !finalItemIds.has(entry.itemId) && actions[entry.itemId]?.deleted !== true);

  // ----- 已并入清单 -----
  const clean: MergeResult['clean'] = [];
  const sourceLabel = (source: CleanEntry['source']): string => (source === 'both' ? '双方' : sideLabel(source));
  const finalItemById = new Map(finalItems.map((item) => [item.id, item]));
  for (const id of knownItemIds) {
    const b = baseItemById.get(id);
    const finalItem = finalItemById.get(id);
    const c = capItemById.get(id);
    const f = foItemById.get(id);
    if (!b && finalItem) {
      const source: CleanEntry['source'] = c && f ? 'both' : c ? 'captain' : 'first-officer';
      clean.push({ id, kind: 'item-added', source, text: `${sourceLabel(source)}新增「${finalItem.challenge || '未命名'}」` });
    } else if (b && !finalItem) {
      const source: CleanEntry['source'] = c && f ? 'both' : !c ? 'captain' : 'first-officer';
      clean.push({ id, kind: 'item-removed', source, text: `${sourceLabel(source)}删除「${b.challenge}」` });
    } else if (b && finalItem) {
      const changedFields = ITEM_FIELD_KEYS.filter((field) => !valueEqual(finalItem[field], b[field]));
      if (changedFields.length) {
        const capVersion = c !== undefined && ITEM_FIELD_KEYS.every((field) => valueEqual(c[field], finalItem[field]));
        const foVersion = f !== undefined && ITEM_FIELD_KEYS.every((field) => valueEqual(f[field], finalItem[field]));
        const source: CleanEntry['source'] = capVersion && foVersion ? 'both' : capVersion ? 'captain' : foVersion ? 'first-officer' : 'both';
        clean.push({ id, kind: 'item-changed', source, text: `${sourceLabel(source)}修改「${finalItem.challenge || '未命名'}」的${changedFields.map(fieldLabel).join('、')}` });
      }
    }
  }
  for (const id of new Set([...baseStageById.keys(), ...capStageById.keys(), ...foStageById.keys()])) {
    const b = baseStageById.get(id);
    const finalStage = mergedStages.find((stage) => stage.id === id);
    const c = capStageById.get(id);
    const f = foStageById.get(id);
    if (!b && finalStage) {
      const source: CleanEntry['source'] = c && f ? 'both' : c ? 'captain' : 'first-officer';
      clean.push({ id, kind: 'stage-added', source, text: `${sourceLabel(source)}新增阶段「${finalStage.name}」` });
    } else if (b && !finalStage) {
      const source: CleanEntry['source'] = c && f ? 'both' : !c ? 'captain' : 'first-officer';
      clean.push({ id, kind: 'stage-removed', source, text: `${sourceLabel(source)}删除阶段「${b.name}」` });
    } else if (b && finalStage) {
      const changedFields = STAGE_FIELD_KEYS.filter((field) => !valueEqual(finalStage[field], b[field]));
      if (changedFields.length) {
        const capVersion = c !== undefined && STAGE_FIELD_KEYS.every((field) => valueEqual(c[field], finalStage[field]));
        const foVersion = f !== undefined && STAGE_FIELD_KEYS.every((field) => valueEqual(f[field], finalStage[field]));
        const source: CleanEntry['source'] = capVersion && foVersion ? 'both' : capVersion ? 'captain' : foVersion ? 'first-officer' : 'both';
        clean.push({ id, kind: 'stage-changed', source, text: `${sourceLabel(source)}修改阶段「${finalStage.name}」的${changedFields.map(fieldLabel).join('、')}` });
      }
    }
  }
  if ((capStageOrderChanged || foStageOrderChanged) && !stageOrderConflictPending) {
    const source: CleanEntry['source'] = capStageOrderChanged && foStageOrderChanged ? 'both' : capStageOrderChanged ? 'captain' : 'first-officer';
    clean.push({ id: 'stage-order', kind: 'order', source, text: `${sourceLabel(source)}调整了飞行阶段先后顺序` });
  }
  if ((capItemOrderChanged || foItemOrderChanged) && !itemOrderConflictPending) {
    const source: CleanEntry['source'] = capItemOrderChanged && foItemOrderChanged ? 'both' : capItemOrderChanged ? 'captain' : 'first-officer';
    clean.push({ id: 'item-order', kind: 'order', source, text: `${sourceLabel(source)}调整了检查项排列顺序` });
  }

  // ----- 立即重算：换阶段 / 改前置条件后的可达性与阶段顺序 -----
  const issues = validateProject({ ...project, stages: mergedStages, items: finalItems });

  const countChanges = (sideStages: FlightStage[], sideItems: ChecklistItem[]): number => {
    let count = 0;
    for (const item of sideItems) {
      const b = baseItemById.get(item.id);
      if (!b) count += 1;
      else if (ITEM_FIELD_KEYS.some((field) => !valueEqual(item[field], b[field]))) count += 1;
    }
    for (const stage of sideStages) {
      const b = baseStageById.get(stage.id);
      if (!b) count += 1;
      else if (STAGE_FIELD_KEYS.some((field) => !valueEqual(stage[field], b[field]))) count += 1;
    }
    return count;
  };

  return {
    stages: mergedStages,
    items: finalItems,
    conflicts,
    unresolved: finalUnresolved,
    clean,
    issues,
    captainChanged: cap ? countChanges(cap.stages, cap.items) : 0,
    firstOfficerChanged: fo ? countChanges(fo.stages, fo.items) : 0
  };
}
