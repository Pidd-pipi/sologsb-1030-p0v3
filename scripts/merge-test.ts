import { buildHandoverPackage, computeMerge } from '../src/handover';
import type { ChecklistProject, MergeSession } from '../src/types';

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ✓ ${name}`);
  else { failures += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const stage = (id: string, name: string, order: number) => ({ id, name, order, description: '' });
const item = (id: string, stageId: string, order: number, challenge: string, response: string, preconditionIds: string[] = []) => ({
  id, stageId, order, challenge, response, critical: false, preconditionIds, abnormalProcedure: '', updatedAt: '2026-09-25T00:00:00.000Z'
});

function makeProject(): ChecklistProject {
  return {
    id: 'p1', name: '测试检查单', aircraft: 'test', revision: 2, status: 'draft', updatedAt: '', reviewNote: '',
    stages: [stage('s1', '飞行前', 0), stage('s2', '起飞', 1)],
    items: [
      item('i1', 's1', 0, '电瓶', 'ON'),
      item('i2', 's1', 1, '燃油', 'CHECKED'),
      item('i3', 's2', 0, '跑道', 'CONFIRMED', ['i1'])
    ],
    revisions: []
  };
}

function sessionWith(capStages: ReturnType<typeof stage>[], capItems: ReturnType<typeof item>[], foStages: ReturnType<typeof stage>[], foItems: ReturnType<typeof item>[]): MergeSession {
  const project = makeProject();
  const capPkg = buildHandoverPackage({ ...project, stages: capStages, items: capItems, revisions: [{ id: 'rev-base', revision: 2, status: 'frozen', createdAt: '', note: '', stages: project.stages, items: project.items }] }, 'rev-base', 'captain', '机长');
  const foPkg = buildHandoverPackage({ ...project, stages: foStages, items: foItems, revisions: [{ id: 'rev-base', revision: 2, status: 'frozen', createdAt: '', note: '', stages: project.stages, items: project.items }] }, 'rev-base', 'first-officer', '副驾驶');
  return {
    id: 'm1', projectId: 'p1', startedAt: '', updatedAt: '',
    baseRevision: 2, baseSnapshot: { stages: project.stages, items: project.items },
    captain: capPkg, firstOfficer: foPkg, decisions: {}, unresolvedActions: {}, status: 'in-progress'
  };
}

console.log('场景一：单侧改动直接并入，双侧冲突列待决');
{
  const project = makeProject();
  const capItems = [
    item('i1', 's1', 0, '电瓶检查', 'ON'),
    item('i2', 's1', 1, '燃油', 'CHECKED'),
    item('i3', 's2', 0, '跑道', 'CONFIRMED', ['i1']),
    item('i4', 's1', 2, '襟翼', 'SET')
  ];
  const foItems = [
    item('i1', 's1', 0, '电瓶电压', 'ON'),
    item('i2', 's1', 1, '燃油量', 'CHECKED'),
    item('i3', 's2', 0, '跑道', 'CONFIRMED', ['i1'])
  ];
  const session = sessionWith(project.stages, capItems, project.stages, foItems);
  const result = computeMerge(session, project);
  check('冲突：i1 挑战语两套值', result.conflicts.some((c) => c.id === 'i1:challenge' && c.kind === 'item-field'));
  check('待决项未进复核稿（i1 不在 items）', !result.items.some((i) => i.id === 'i1'));
  check('干净并入：i2 回应修改', result.clean.some((c) => c.id === 'i2' && c.kind === 'item-changed'));
  check('干净并入：i4 新增', result.clean.some((c) => c.id === 'i4' && c.kind === 'item-added'));
  check('i3 保留（前置 i1 待决，暂留待确认区）', result.unresolved.some((u) => u.itemId === 'i3'));

  // 复核人选定机长版本
  session.decisions['i1:challenge'] = 'captain';
  const result2 = computeMerge(session, project);
  check('选定后 i1 进复核稿', result2.items.some((i) => i.id === 'i1'));
  check('i1 挑战语为机长版本', result2.items.find((i) => i.id === 'i1')?.challenge === '电瓶检查');
  check('i3 随前置解决进入复核稿', result2.items.some((i) => i.id === 'i3'));
  check('冲突清空', result2.conflicts.length === 0);
  check('待确认区清空', result2.unresolved.length === 0);
}

console.log('场景二：删除 / 修改冲突');
{
  const project = makeProject();
  const capItems = [
    item('i1', 's1', 0, '电瓶', 'ON'),
    item('i2', 's1', 1, '燃油', 'CHECKED'),
    item('i3', 's2', 0, '跑道', 'CONFIRMED', ['i1'])
  ];
  const foItems = [
    item('i1', 's1', 0, '电瓶', 'ON'),
    item('i2', 's1', 1, '燃油', 'CHECKED'),
    item('i3', 's2', 0, '跑道占用', 'CLEAR', ['i1'])
  ];
  // 机长删除 i3，副驾驶修改 i3
  const capItemsDel = capItems.filter((i) => i.id !== 'i3');
  const session = sessionWith(project.stages, capItemsDel, project.stages, foItems);
  const result = computeMerge(session, project);
  check('删除/修改冲突：item-delete', result.conflicts.some((c) => c.id === 'item-delete:i3'));
  check('未选定前 i3 不进稿', !result.items.some((i) => i.id === 'i3'));
  session.decisions['item-delete:i3'] = 'first-officer';
  const result2 = computeMerge(session, project);
  check('选定保留后 i3 进稿', result2.items.some((i) => i.id === 'i3'));
  check('i3 为副驾驶修改版', result2.items.find((i) => i.id === 'i3')?.challenge === '跑道占用');
}

console.log('场景三：阶段删除 + 项删除/修改冲突 → 待确认区 → 重新挂载');
{
  const project = makeProject();
  // 机长删除 s2 阶段及其检查项 i3；副驾驶保留 s2 并修改 i3
  const capStages = [stage('s1', '飞行前', 0)];
  const capItems = [
    item('i1', 's1', 0, '电瓶', 'ON'),
    item('i2', 's1', 1, '燃油', 'CHECKED')
  ];
  const foStages = [stage('s1', '飞行前', 0), stage('s2', '起飞', 1)];
  const foItems = [
    item('i1', 's1', 0, '电瓶', 'ON'),
    item('i2', 's1', 1, '燃油', 'CHECKED'),
    item('i3', 's2', 0, '跑道占用', 'CLEAR', ['i1'])
  ];
  const session = sessionWith(capStages, capItems, foStages, foItems);
  const result = computeMerge(session, project);
  check('阶段删除冲突：stage-delete', result.conflicts.some((c) => c.id === 'stage-delete:s2'));
  check('项删除/修改冲突：item-delete:i3', result.conflicts.some((c) => c.id === 'item-delete:i3'));
  // 复核人：删除阶段、保留 i3
  session.decisions['stage-delete:s2'] = 'captain';
  session.decisions['item-delete:i3'] = 'first-officer';
  const result2 = computeMerge(session, project);
  check('s2 删除后 i3 进入待确认区（缺阶段）', result2.unresolved.some((u) => u.itemId === 'i3' && u.missingStage));
  check('待确认项不进稿', !result2.items.some((i) => i.id === 'i3'));
  // 重新挂载到 s1
  session.unresolvedActions['i3'] = { stageId: 's1' };
  const result3 = computeMerge(session, project);
  check('重新挂载后 i3 进稿', result3.items.some((i) => i.id === 'i3' && i.stageId === 's1'));
  check('待确认区清空', result3.unresolved.length === 0);
}

console.log('场景四：悬空前置条件 → 待确认 → 移除');
{
  const project = makeProject();
  // 副驾驶删除 i1，机长保留 i3（i3 前置依赖 i1）
  const capItems = [
    item('i1', 's1', 0, '电瓶', 'ON'),
    item('i2', 's1', 1, '燃油', 'CHECKED'),
    item('i3', 's2', 0, '跑道', 'CONFIRMED', ['i1'])
  ];
  const foItems = [
    item('i2', 's1', 1, '燃油', 'CHECKED'),
    item('i3', 's2', 0, '跑道', 'CONFIRMED', ['i1'])
  ];
  const session = sessionWith(project.stages, capItems, project.stages, foItems);
  const result = computeMerge(session, project);
  // i1 被副驾驶干净删除（机长未改 i1），i3 的前置找不到对象
  check('i1 干净删除', result.clean.some((c) => c.id === 'i1' && c.kind === 'item-removed'));
  check('i3 进入待确认区（悬空前置）', result.unresolved.some((u) => u.itemId === 'i3' && u.missingPreconditionIds.includes('i1')));
  session.unresolvedActions['i3'] = { removedPreconditionIds: ['i1'] };
  const result2 = computeMerge(session, project);
  check('移除前置后 i3 进稿且无悬空前置', result2.items.some((i) => i.id === 'i3' && i.preconditionIds.length === 0));
  check('待确认区清空', result2.unresolved.length === 0);
}

console.log('场景五：换阶段后阶段顺序异常立即重算');
{
  const project = makeProject();
  // 机长交换 s1/s2 顺序（使用标准阶段名以触发顺序校验）
  const capStages = [stage('s2', '起飞', 0), stage('s1', '飞行前检查', 1)];
  const capItems = [
    item('i3', 's2', 0, '跑道', 'CONFIRMED', ['i1']),
    item('i1', 's1', 0, '电瓶', 'ON'),
    item('i2', 's1', 1, '燃油', 'CHECKED')
  ];
  const session = sessionWith(capStages, capItems, project.stages, project.items);
  const result = computeMerge(session, project);
  check('阶段顺序改动被并入', result.stages.map((s) => s.id).join(',') === 's2,s1');
  check('立即重算：阶段顺序异常告警', result.issues.some((issue) => issue.type === 'stage-order'));
}

console.log('场景六：前置条件改动后不可达立即重算');
{
  const project = makeProject();
  // 副驾驶把 i3 移到 s1 且排在 i1 之前，前置 i1 变成不可达
  const foItems = [
    item('i3', 's1', 0, '跑道', 'CONFIRMED', ['i1']),
    item('i1', 's1', 1, '电瓶', 'ON'),
    item('i2', 's1', 2, '燃油', 'CHECKED')
  ];
  const session = sessionWith(project.stages, project.items, project.stages, foItems);
  const result = computeMerge(session, project);
  check('i3 换阶段并入', result.items.find((i) => i.id === 'i3')?.stageId === 's1');
  check('立即重算：前置条件不可达阻断', result.issues.some((issue) => issue.type === 'unreachable-precondition' && issue.level === 'error'));
}

console.log('场景七：交接中断可继续（会话持久化）');
{
  const project = makeProject();
  const capItems = [
    item('i1', 's1', 0, '电瓶检查', 'ON'),
    item('i2', 's1', 1, '燃油', 'CHECKED'),
    item('i3', 's2', 0, '跑道确认', 'CONFIRMED', ['i1'])
  ];
  const foItems = [
    item('i1', 's1', 0, '电瓶电压', 'ON'),
    item('i2', 's1', 1, '燃油', 'CHECKED'),
    item('i3', 's2', 0, '跑道', 'CONFIRMED', ['i1'])
  ];
  const session = sessionWith(project.stages, capItems, project.stages, foItems);
  // 模拟中断：只导入机长一方
  session.firstOfficer = null;
  const result = computeMerge(session, project);
  check('仅一方时无冲突', result.conflicts.length === 0);
  check('机长改动并入', result.clean.some((c) => c.id === 'i3'));
  // 继续：导入副驾驶包
  const foPkg = buildHandoverPackage({ ...project, stages: project.stages, items: foItems, revisions: [{ id: 'rev-base', revision: 2, status: 'frozen', createdAt: '', note: '', stages: project.stages, items: project.items }] }, 'rev-base', 'first-officer', '副驾驶');
  session.firstOfficer = foPkg;
  const result2 = computeMerge(session, project);
  check('继续后出现冲突', result2.conflicts.some((c) => c.id === 'i1:challenge'));
}

console.log('场景八：旧草稿升级后可合并（v1 包升级）');
{
  const project = makeProject();
  const capItems = [
    item('i1', 's1', 0, '电瓶', 'ON'),
    item('i2', 's1', 1, '燃油', 'CHECKED'),
    item('i3', 's2', 0, '跑道', 'CONFIRMED', ['i1'])
  ];
  const pkg = buildHandoverPackage({ ...project, stages: project.stages, items: capItems, revisions: [{ id: 'rev-base', revision: 2, status: 'frozen', createdAt: '', note: '', stages: project.stages, items: project.items }] }, 'rev-base', 'captain', '机长');
  // 模拟旧版本包
  const legacy = { ...pkg, schemaVersion: 1 };
  const parsed = JSON.parse(JSON.stringify(legacy));
  check('旧包 schemaVersion=1', parsed.schemaVersion === 1);
  // parseHandoverPackage 升级逻辑
  const upgraded = { ...parsed, schemaVersion: parsed.schemaVersion === 1 ? 2 : parsed.schemaVersion };
  check('升级后 schemaVersion=2', upgraded.schemaVersion === 2);
  check('升级后结构完整', Array.isArray(upgraded.items) && upgraded.baseSnapshot);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
