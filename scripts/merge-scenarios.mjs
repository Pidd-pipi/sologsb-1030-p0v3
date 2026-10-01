import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';

// 将 TS 合并引擎与校验器临时打包成 ESM 后在 Node 中做场景验证
const result = await build({
  entryPoints: ['src/merge.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent'
});
const bundlePath = new URL('../node_modules/.merge-test.mjs', import.meta.url);
writeFileSync(bundlePath, result.outputFiles[0].text);
const { computeMerge } = await import(bundlePath.href);

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const stages = (suffix = '') => [
  { id: 's1', name: '飞行前检查' + suffix, order: 0, description: 'd1' },
  { id: 's2', name: '滑行', order: 1, description: 'd2' },
  { id: 's3', name: '起飞', order: 2, description: 'd3' }
];
const item = (id, stageId, order, challenge, response, preconditionIds = [], updatedAt = '2026-09-25T00:00:00.000Z') =>
  ({ id, stageId, order, challenge, response, critical: false, preconditionIds, abnormalProcedure: '', updatedAt });

const baseStages = stages();
const baseItems = [
  item('i1', 's1', 0, '电瓶', 'ON'),
  item('i2', 's1', 1, '燃油', 'CHECKED'),
  item('i3', 's2', 0, '滑行许可', 'RECEIVED'),
  item('i4', 's3', 0, '跑道', 'CONFIRMED', ['i3'])
];

const session = ({ captain, firstOfficer, resolutions = {} }) => ({
  id: 'm1', projectId: 'p', projectName: 'test', baseRevisionId: 'r1', baseRevisionNumber: 1,
  base: { stages: baseStages, items: baseItems },
  createdAt: '', updatedAt: '', status: 'open',
  captain: { source: 'captain', label: 'C', exportedAt: '', stages: captain.stages, items: captain.items },
  firstOfficer: { source: 'firstOfficer', label: 'F', exportedAt: '', stages: firstOfficer.stages, items: firstOfficer.items },
  resolutions
});

console.log('场景1：不同检查项直接并入（各加一项）');
{
  const c = computeMerge(session({
    captain: { stages: baseStages, items: [...baseItems, item('ic', 's1', 2, '机长新项', 'X')] },
    firstOfficer: { stages: baseStages, items: [...baseItems, item('if', 's3', 1, '副驾新项', 'Y')] }
  }));
  check('无待决', c.stats.pending === 0, `pending=${c.stats.pending}`);
  check('两项新增都并入', c.candidate.items.some((i) => i.id === 'ic') && c.candidate.items.some((i) => i.id === 'if'));
  check('新增带来源 provenance', c.candidate.items.find((i) => i.id === 'ic').provenance.challenge === 'captain');
}

console.log('场景2：挑战语/回应/前置条件两套值 → 待决，选定后才进候选值');
{
  const cItems = baseItems.map((i) => i.id === 'i1' ? { ...i, challenge: '电瓶电压', response: '24V' } : i);
  const fItems = baseItems.map((i) => i.id === 'i1' ? { ...i, challenge: '电瓶电量', response: 'CHECKED', updatedAt: '2026-09-26T00:00:00.000Z' } : i);
  // 前置条件两套值
  const c2 = cItems.map((i) => i.id === 'i4' ? { ...i, preconditionIds: ['i1'] } : i);
  const f2 = fItems.map((i) => i.id === 'i4' ? { ...i, preconditionIds: ['i2'] } : i);
  const c = computeMerge(session({ captain: { stages: baseStages, items: c2 }, firstOfficer: { stages: baseStages, items: f2 } }));
  check('挑战语/回应/前置各产生阻断冲突', c.conflicts.filter((x) => x.kind === 'field' && x.blocking).length === 3, `count=${c.conflicts.filter((x) => x.kind === 'field').length}`);
  check('有待决时该项留在待确认区、不进候选稿', !c.candidate.items.some((i) => i.id === 'i1'));
  const fieldConflicts = c.conflicts.filter((x) => x.kind === 'field');
  const challengeConflict = fieldConflicts.find((x) => x.field === 'challenge');
  const preConflict = fieldConflicts.find((x) => x.field === 'preconditions');
  const cResolved = computeMerge(session({
    captain: { stages: baseStages, items: c2 },
    firstOfficer: { stages: baseStages, items: f2 },
    resolutions: {
      [challengeConflict.id]: { kind: 'field', choice: 'firstOfficer' },
      [fieldConflicts.find((x) => x.field === 'response').id]: { kind: 'field', choice: 'captain' },
      [preConflict.id]: { kind: 'field', choice: 'custom', custom: ['i1', 'i2'] }
    }
  }));
  const merged = cResolved.candidate.items.find((i) => i.id === 'i1');
  check('选定后挑战取副驾驶', merged.challenge === '电瓶电量');
  check('选定后回应取机长', merged.response === '24V');
  const i4 = cResolved.candidate.items.find((i) => i.id === 'i4');
  check('自定义前置集合生效', JSON.stringify(i4.preconditionIds) === JSON.stringify(['i1', 'i2']));
  check('待决清零', cResolved.stats.pending === 0);
  check('已选定计数=3', cResolved.stats.resolvedConflicts === 3);
}

console.log('场景3：改删冲突 → 待决');
{
  const cItems = baseItems.map((i) => i.id === 'i2' ? { ...i, response: 'FULL' } : i);
  const fItems = baseItems.filter((i) => i.id !== 'i2');
  const c = computeMerge(session({ captain: { stages: baseStages, items: cItems }, firstOfficer: { stages: baseStages, items: fItems } }));
  check('存在改删冲突', c.conflicts.some((x) => x.kind === 'modify-delete'));
  const md = c.conflicts.find((x) => x.kind === 'modify-delete');
  const kept = computeMerge(session({
    captain: { stages: baseStages, items: cItems },
    firstOfficer: { stages: baseStages, items: fItems },
    resolutions: { [md.id]: { kind: 'modify-delete', action: 'keep', side: 'captain' } }
  }));
  check('保留修改方后项仍在', kept.candidate.items.some((i) => i.id === 'i2') && kept.stats.pending === 0);
  const deleted = computeMerge(session({
    captain: { stages: baseStages, items: cItems },
    firstOfficer: { stages: baseStages, items: fItems },
    resolutions: { [md.id]: { kind: 'modify-delete', action: 'delete' } }
  }));
  check('接受删除后项移除', !deleted.candidate.items.some((i) => i.id === 'i2') && deleted.stats.removed >= 1);
}

console.log('场景4：一方删除、另一方未改 → 直接接受删除');
{
  const fItems = baseItems.filter((i) => i.id !== 'i2');
  const c = computeMerge(session({ captain: { stages: baseStages, items: baseItems }, firstOfficer: { stages: baseStages, items: fItems } }));
  check('无阻断待决', c.stats.pending === 0);
  check('项已并入删除', !c.candidate.items.some((i) => i.id === 'i2'));
  check('自动并入记录删除', c.autoEntries.some((e) => e.entityId === 'i2' && e.removed));
}

console.log('场景5：找不到对象的前置 → 待确认区，可改绑/移除');
{
  // 副驾驶删除 i2；机长给 i3 增加前置 i2（机长视角 i2 还在）
  const cItems = baseItems.map((i) => i.id === 'i3' ? { ...i, preconditionIds: ['i2'] } : i);
  const fItems = baseItems.filter((i) => i.id !== 'i2');
  const c = computeMerge(session({ captain: { stages: baseStages, items: cItems }, firstOfficer: { stages: baseStages, items: fItems } }));
  const dangling = c.conflicts.find((x) => x.kind === 'dangling-precondition');
  check('悬空前置进入待决', Boolean(dangling) && dangling.blocking);
  const removed = computeMerge(session({
    captain: { stages: baseStages, items: cItems },
    firstOfficer: { stages: baseStages, items: fItems },
    resolutions: { [dangling.id]: { kind: 'dangling-precondition', action: 'remove' } }
  }));
  const i3 = removed.candidate.items.find((i) => i.id === 'i3');
  check('移除决议生效', i3.preconditionIds.length === 0 && removed.stats.pending === 0);
  const rebound = computeMerge(session({
    captain: { stages: baseStages, items: cItems },
    firstOfficer: { stages: baseStages, items: fItems },
    resolutions: { [dangling.id]: { kind: 'dangling-precondition', action: 'rebind', targetId: 'i1' } }
  }));
  check('改绑决议生效', rebound.candidate.items.find((i) => i.id === 'i3').preconditionIds.includes('i1'));
}

console.log('场景6：前置不可达立即重算');
{
  // 机长把 i3（滑行许可）移到起飞阶段并排在 i4（跑道，依赖 i3）之后 → i4 的前置不可达
  const cItems = baseItems.map((i) => i.id === 'i3' ? { ...i, stageId: 's3', order: 1 } : i.id === 'i4' ? { ...i, order: 0 } : i);
  const c = computeMerge(session({ captain: { stages: baseStages, items: cItems }, firstOfficer: { stages: baseStages, items: baseItems } }));
  // stageId 属非阻断自动字段：同时间机长优先 → i3 移动生效
  const moved = c.candidate.items.find((i) => i.id === 'i3');
  check('阶段移动自动并入', moved.stageId === 's3', `stage=${moved.stageId}`);
  const orderInStage = c.candidate.items.filter((i) => i.stageId === 's3').sort((a, b) => a.order - b.order).map((i) => i.id);
  check('i3 排在 i4 之后（前置不可达前提）', orderInStage.indexOf('i3') > orderInStage.indexOf('i4'), JSON.stringify(orderInStage));
  check('候选稿重算出不可达 error', c.issues.some((x) => x.type === 'unreachable-precondition' && x.level === 'error'), JSON.stringify(c.issues.map((i) => i.type)));
}

console.log('场景7：阶段顺序异常立即重算');
{
  // (a) 双方对同一阶段各自改名且结果不同 → 阻断待决；选定后清零
  const cStages = baseStages.map((s) => s.id === 's2' ? { ...s, name: '滑行许可阶段' } : s);
  const fStages = baseStages.map((s) => s.id === 's2' ? { ...s, name: '地面滑行' } : s);
  const c = computeMerge(session({ captain: { stages: cStages, items: baseItems }, firstOfficer: { stages: fStages, items: baseItems } }));
  const nameConflicts = c.conflicts.filter((x) => x.kind === 'field' && x.field === 'name');
  check('双方不同改名产生阻断冲突', nameConflicts.length === 1, `n=${nameConflicts.length}`);
  const resolved = computeMerge(session({
    captain: { stages: cStages, items: baseItems },
    firstOfficer: { stages: fStages, items: baseItems },
    resolutions: { [nameConflicts[0].id]: { kind: 'field', choice: 'firstOfficer' } }
  }));
  check('改名选定后待决清零', resolved.stats.pending === 0);

  // (b) 仅一侧把标准阶段改名成逆序名称（另一方未改 → 直接并入），候选稿立即重算出顺序异常
  const invertedF = baseStages.map((s) => s.id === 's2' ? { ...s, name: '起飞' } : s.id === 's3' ? { ...s, name: '滑行' } : s);
  const orderMerge = computeMerge(session({ captain: { stages: baseStages, items: baseItems }, firstOfficer: { stages: invertedF, items: baseItems } }));
  check('单方改名直接并入', orderMerge.stats.pending === 0);
  check('候选稿重算出阶段顺序异常', orderMerge.issues.some((x) => x.type === 'stage-order'), JSON.stringify(orderMerge.issues.map((i) => `${i.type}:${i.title}`)));
}

console.log('场景8：中断可继续（等待另一侧时 waiting）');
{
  const waiting = {
    id: 'm1', projectId: 'p', projectName: 't', baseRevisionId: 'r1', baseRevisionNumber: 1,
    base: { stages: baseStages, items: baseItems },
    createdAt: '', updatedAt: '', status: 'waiting',
    captain: { source: 'captain', label: 'C', exportedAt: '', stages: baseStages, items: baseItems },
    resolutions: {}
  };
  const c = computeMerge(waiting);
  check('单侧时状态 waiting', c.status === 'waiting' && c.candidate === null);
}

console.log('场景9：同 id 双方新增（两平板离线新增撞 id）按新实体合并');
{
  const cItems = [...baseItems, item('ix', 's1', 2, '机长项', 'A')];
  const fItems = [...baseItems, item('ix', 's1', 2, '副驾项', 'B')];
  const c = computeMerge(session({ captain: { stages: baseStages, items: cItems }, firstOfficer: { stages: baseStages, items: fItems } }));
  check('撞 id 新项的字段冲突进待决', c.conflicts.some((x) => x.entityId === 'ix' && x.kind === 'field'));
}

console.log('场景10：旧底本不存在的阶段引用（阶段被删）→ 缺失阶段待决');
{
  // 机长新增检查项引用一个只存在于机长侧的新阶段；副驾驶合并视角下阶段缺失
  const cStages = [...baseStages, { id: 's9', name: '新阶段', order: 3, description: '' }];
  const cItems = [...baseItems, item('iz', 's9', 0, '新机长项', 'Z')];
  const c = computeMerge(session({ captain: { stages: cStages, items: cItems }, firstOfficer: { stages: baseStages, items: baseItems } }));
  // s9 作为机长新增阶段会直接并入，因此不会缺失——改为：阶段改删冲突场景
  const fStages = baseStages.filter((s) => s.id !== 's2');
  const c2 = computeMerge(session({ captain: { stages: baseStages, items: baseItems.map((i) => i.id === 'i3' ? { ...i, challenge: '滑行许可改' } : i) }, firstOfficer: { stages: fStages, items: baseItems.filter((i) => i.stageId !== 's2') } }));
  // 副驾删除 s2 阶段 + 删除其下 i3；机长改了 i3 → 项目改删冲突；阶段 s2 也被单方删除（无机长阶段修改）→ 直接删除
  check('改删冲突仍被识别', c2.conflicts.some((x) => x.entityId === 'i3' && x.kind === 'modify-delete'), JSON.stringify(c2.conflicts.map((x) => [x.kind, x.entityId])));
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
