import { useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  Flex,
  Grid,
  Heading,
  Select,
  Separator,
  Text,
  TextField
} from '@radix-ui/themes';
import {
  buildHandoverPackage,
  computeMerge,
  downloadHandoverPackage,
  formatFieldValue,
  parseHandoverPackage,
  sideLabel
} from './handover';
import type {
  ChecklistProject,
  HandoverPackage,
  HandoverSide,
  MergeConflict,
  MergeSession,
  UnresolvedItem
} from './types';

interface HandoverTabProps {
  project: ChecklistProject;
  session: MergeSession | undefined;
  onStart: (baseRevisionId: string) => void;
  onImport: (side: HandoverSide, pkg: HandoverPackage) => void;
  onUseCurrent: (side: HandoverSide, author: string) => void;
  onResolveConflict: (conflictId: string, side: HandoverSide) => void;
  onResolveItem: (itemId: string, action: { stageId?: string; removedPreconditionIds?: string[]; deleted?: boolean }) => void;
  onApply: () => void;
  onDiscard: () => void;
  onCreateTabletProject: (baseRevisionId: string) => void;
}

const conflictKindLabel: Record<MergeConflict['kind'], string> = {
  'item-field': '检查项冲突',
  'item-delete': '删除 / 修改冲突',
  'stage-field': '阶段冲突',
  'stage-delete': '阶段删除冲突',
  'stage-order': '阶段顺序冲突',
  'item-order': '排列顺序冲突'
};

export default function HandoverTab({
  project,
  session,
  onStart,
  onImport,
  onUseCurrent,
  onResolveConflict,
  onResolveItem,
  onApply,
  onDiscard,
  onCreateTabletProject
}: HandoverTabProps) {
  const frozenRevisions = project.revisions.filter((revision) => revision.status === 'frozen');
  const [baseRevisionId, setBaseRevisionId] = useState(frozenRevisions[0]?.id ?? project.revisions[0]?.id ?? '');
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSide, setExportSide] = useState<HandoverSide>('captain');
  const [exportAuthor, setExportAuthor] = useState('');
  const [exportBaseId, setExportBaseId] = useState(frozenRevisions[0]?.id ?? '');
  const [importSide, setImportSide] = useState<HandoverSide>('captain');
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const result = useMemo(() => (session ? computeMerge(session, project) : null), [session, project]);

  function handleExport() {
    try {
      const pkg = buildHandoverPackage(project, exportBaseId, exportSide, exportAuthor);
      downloadHandoverPackage(pkg);
      setExportOpen(false);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '交接包导出失败');
    }
  }

  function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !session) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const pkg = parseHandoverPackage(String(reader.result));
        if (pkg.baseRevision !== session.baseRevision) {
          setError(`底本版本不一致：交接包基于 r${pkg.baseRevision}，本次交接底本为 r${session.baseRevision}。两边必须以同一冻结版本为底本。`);
          return;
        }
        if (pkg.projectId !== project.id) {
          setError(`交接包来自其他检查单项目（${pkg.projectName}），仍可并入当前项目，请确认来源无误。`);
        } else {
          setError('');
        }
        onImport(importSide, pkg);
      } catch (err) {
        setError(err instanceof Error ? err.message : '交接包导入失败');
      }
    };
    reader.readAsText(file);
  }

  // ---------- 无进行中交接：发起 ----------
  if (!session || session.status === 'applied') {
    return (
      <div className="content-page handover-page">
        <Heading size="7">离线交接合并</Heading>
        <Text color="gray" as="p">
          机长与副驾驶各带平板修改检查单，回基地导入交接包后自动合并：只在一侧改动的检查项直接并入；挑战语、回应或前置条件出现两套值时先列待决项，复核人选定后才进复核稿；换阶段或改前置条件后立即重算阶段顺序与可达性，找不到对象的检查项留在待确认区。交接进度自动保存，中断后可随时继续。
        </Text>

        {session?.status === 'applied' && (
          <Callout.Root color="green" mb="4">
            <Callout.Text>上次交接的内容已并入 r{project.revision} 编辑草稿，可继续走提交复核 → 冻结流程。</Callout.Text>
          </Callout.Root>
        )}

        <Card className="handover-start-card">
          <div className="handover-step">
            <Badge size="2">1</Badge>
            <div>
              <Heading size="4">选择共同底本</Heading>
              <Text size="1" color="gray">两边必须以同一冻结版本为底本；平板副本与交接包都将携带该底本快照。</Text>
              <Select.Root value={baseRevisionId} onValueChange={setBaseRevisionId}>
                <Select.Trigger style={{ minWidth: 320, marginTop: 8 }} />
                <Select.Content position="popper">
                  {project.revisions.map((revision) => (
                    <Select.Item key={revision.id} value={revision.id}>
                      r{revision.revision} · {revision.status === 'frozen' ? '已冻结' : revision.status === 'review' ? '复核中' : '编辑中'} · {revision.note || '无说明'}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </div>
          </div>
          <Separator my="4" />
          <div className="handover-step">
            <Badge size="2">2</Badge>
            <div>
              <Heading size="4">发起交接</Heading>
              <Text size="1" color="gray">以选中的冻结版本为底本建立合并会话，进度保存在本机浏览器。</Text>
              <Flex gap="2" mt="2" wrap="wrap">
                <Button onClick={() => onStart(baseRevisionId)} disabled={!frozenRevisions.some((revision) => revision.id === baseRevisionId)}>
                  开始交接
                </Button>
                <Button variant="soft" onClick={() => { setExportBaseId(baseRevisionId); setExportOpen(true); }}>
                  导出本机为交接包
                </Button>
                <Button variant="soft" onClick={() => onCreateTabletProject(baseRevisionId)} disabled={!frozenRevisions.some((revision) => revision.id === baseRevisionId)}>
                  从底本创建平板副本
                </Button>
              </Flex>
            </div>
          </div>
        </Card>

        <Dialog.Root open={exportOpen} onOpenChange={setExportOpen}>
          <Dialog.Content maxWidth="460px">
            <Dialog.Title>导出交接包</Dialog.Title>
            <Dialog.Description size="2" color="gray">把本机当前检查单内容作为一方平板导出，底本为双方共同的冻结版本。</Dialog.Description>
            <div className="dialog-form">
              <label>
                <span>来源</span>
                <Select.Root value={exportSide} onValueChange={(value) => setExportSide(value as HandoverSide)}>
                  <Select.Trigger />
                  <Select.Content position="popper">
                    <Select.Item value="captain">机长</Select.Item>
                    <Select.Item value="first-officer">副驾驶</Select.Item>
                  </Select.Content>
                </Select.Root>
              </label>
              <label>
                <span>使用人</span>
                <TextField.Root value={exportAuthor} onChange={(event) => setExportAuthor(event.target.value)} placeholder="机长 / 副驾驶姓名" />
              </label>
              <label>
                <span>共同底本</span>
                <Select.Root value={exportBaseId} onValueChange={setExportBaseId}>
                  <Select.Trigger />
                  <Select.Content position="popper">
                    {frozenRevisions.map((revision) => (
                      <Select.Item key={revision.id} value={revision.id}>r{revision.revision} · {revision.note || '冻结版本'}</Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </label>
            </div>
            <Flex justify="end" gap="2" mt="4">
              <Dialog.Close><Button variant="soft">取消</Button></Dialog.Close>
              <Button onClick={handleExport}>导出交接包文件</Button>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
      </div>
    );
  }

  // ---------- 交接进行中 ----------
  const canApply = result !== null && result.conflicts.length === 0 && result.unresolved.length === 0
    && (session.captain !== null || session.firstOfficer !== null);

  return (
    <div className="content-page handover-page">
      <Heading size="7">离线交接合并</Heading>
      <Callout.Root color="blue" mb="4">
        <Callout.Text>交接进行中 · 底本 r{session.baseRevision} · 进度自动保存，中断后可随时继续；待决项选定后立即重算校验。</Callout.Text>
      </Callout.Root>

      {error && <Callout.Root color="red" mb="4"><Callout.Text>{error}</Callout.Text></Callout.Root>}

      <input ref={fileRef} type="file" accept="application/json,.json" className="visual-hidden" onChange={handleFile} />

      <Grid columns="2" gap="3" mb="4">
        <SideCard
          side="captain"
          pkg={session.captain}
          baseRevision={session.baseRevision}
          changedCount={result?.captainChanged ?? 0}
          onImport={() => { setImportSide('captain'); fileRef.current?.click(); }}
          onUseCurrent={() => onUseCurrent('captain', exportAuthor)}
        />
        <SideCard
          side="first-officer"
          pkg={session.firstOfficer}
          baseRevision={session.baseRevision}
          changedCount={result?.firstOfficerChanged ?? 0}
          onImport={() => { setImportSide('first-officer'); fileRef.current?.click(); }}
          onUseCurrent={() => onUseCurrent('first-officer', exportAuthor)}
        />
      </Grid>

      {result && (
        <>
          <MergeSection title="待决项" count={result.conflicts.length} tone="amber" hint="双方改动不一致，复核人选定后才进复核稿">
            {result.conflicts.length === 0
              ? <Text size="1" color="gray">没有待决项，双方改动均可直接并入。</Text>
              : result.conflicts.map((conflict) => (
                <ConflictCard
                  key={conflict.id}
                  conflict={conflict}
                  decided={session.decisions[conflict.id]}
                  stages={result.stages}
                  items={result.items}
                  onResolve={(side) => onResolveConflict(conflict.id, side)}
                />
              ))}
          </MergeSection>

          <MergeSection title="待确认区" count={result.unresolved.length} tone="red" hint="找不到对象的检查项：重新挂载、移除悬空前置条件或删除">
            {result.unresolved.length === 0
              ? <Text size="1" color="gray">没有找不到对象的检查项。</Text>
              : result.unresolved.map((item) => (
                <UnresolvedCard
                  key={item.itemId}
                  item={item}
                  stages={result.stages}
                  action={session.unresolvedActions[item.itemId]}
                  onResolve={(action) => onResolveItem(item.itemId, action)}
                />
              ))}
          </MergeSection>

          <MergeSection title="已并入" count={result.clean.length} tone="green" hint="单侧改动直接并入，双方改动一致也直接并入">
            {result.clean.length === 0
              ? <Text size="1" color="gray">两侧内容与底本一致，没有需要并入的改动。</Text>
              : (
                <div className="clean-list">
                  {result.clean.map((entry) => (
                    <div key={`${entry.kind}-${entry.id}`} className="clean-row">
                      <Badge color={entry.source === 'both' ? 'green' : entry.source === 'captain' ? 'blue' : 'purple'} size="1">
                        {entry.source === 'both' ? '双方一致' : sideLabel(entry.source)}
                      </Badge>
                      <Text size="1">{entry.text}</Text>
                    </div>
                  ))}
                </div>
              )}
          </MergeSection>

          <MergeSection
            title="校验提示（换阶段 / 改前置条件后立即重算）"
            count={result.issues.length}
            tone={result.issues.some((issue) => issue.level === 'error') ? 'red' : result.issues.length ? 'amber' : 'green'}
            hint="并入草稿后的实时结构校验"
          >
            {result.issues.length === 0
              ? <Callout.Root color="green"><Callout.Text>并入后的检查单通过全部结构与顺序校验。</Callout.Text></Callout.Root>
              : (
                <div className="issue-list">
                  {result.issues.map((issue) => (
                    <div key={issue.id} className={`issue-card ${issue.level}`}>
                      <Badge color={issue.level === 'error' ? 'red' : issue.level === 'warning' ? 'amber' : 'blue'} size="1">
                        {issue.level === 'error' ? '阻断' : issue.level === 'warning' ? '警告' : '提示'}
                      </Badge>
                      <span><strong>{issue.title}</strong><small>{issue.detail}</small></span>
                    </div>
                  ))}
                </div>
              )}
          </MergeSection>

          <Card className="merge-footer">
            <Flex justify="between" align="center" wrap="wrap" gap="2">
              <Text size="1" color="gray">
                已并入 {result.clean.length} 项 · 待决 {result.conflicts.length} 项 · 待确认 {result.unresolved.length} 项 · 校验 {result.issues.length} 条
                {!canApply && '（待决项与待确认项全部处理后才能并入复核稿）'}
              </Text>
              <Flex gap="2">
                <Button variant="soft" color="red" onClick={() => { if (window.confirm('放弃本次交接？已导入的平板包与处理进度将被清除。')) onDiscard(); }}>
                  放弃本次交接
                </Button>
                <Button color="green" disabled={!canApply} onClick={onApply}>
                  并入复核稿（创建 r{project.revision + 1} 编辑草稿）
                </Button>
              </Flex>
            </Flex>
          </Card>
        </>
      )}
    </div>
  );
}

function MergeSection({ title, count, tone, hint, children }: {
  title: string;
  count: number;
  tone: 'red' | 'amber' | 'green' | 'blue';
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="merge-section">
      <Flex justify="between" align="center" mb="2">
        <Flex align="center" gap="2">
          <Heading size="4">{title}</Heading>
          <Badge color={tone} size="1">{count}</Badge>
        </Flex>
        <Text size="1" color="gray">{hint}</Text>
      </Flex>
      {children}
    </Card>
  );
}

function SideCard({ side, pkg, baseRevision, changedCount, onImport, onUseCurrent }: {
  side: HandoverSide;
  pkg: HandoverPackage | null;
  baseRevision: number;
  changedCount: number;
  onImport: () => void;
  onUseCurrent: () => void;
}) {
  return (
    <Card className="side-card">
      <Flex justify="between" align="center" mb="2">
        <Heading size="4">{sideLabel(side)}平板</Heading>
        <Badge color={pkg ? 'green' : 'gray'} size="1">{pkg ? '已导入' : '未导入'}</Badge>
      </Flex>
      {pkg ? (
        <div className="side-meta">
          <Text size="1" color="gray">使用人：{pkg.author} · 导出时间：{new Date(pkg.exportedAt).toLocaleString('zh-CN')}</Text>
          <Text size="1" color="gray">检查项 {pkg.items.length} 个 · 阶段 {pkg.stages.length} 个 · 改动 {changedCount} 处</Text>
          <Text size="1" color={pkg.baseRevision === baseRevision ? 'gray' : 'red'}>
            底本：r{pkg.baseRevision}{pkg.baseRevision === baseRevision ? '（与本次交接一致）' : '（不一致！）'}
          </Text>
          <Button size="1" variant="soft" onClick={onImport}>重新导入交接包</Button>
        </div>
      ) : (
        <Flex gap="2" wrap="wrap">
          <Button size="1" onClick={onImport}>导入交接包文件</Button>
          <Button size="1" variant="soft" onClick={onUseCurrent}>使用本机当前内容</Button>
        </Flex>
      )}
    </Card>
  );
}

function ConflictCard({ conflict, decided, stages, items, onResolve }: {
  conflict: MergeConflict;
  decided?: HandoverSide;
  stages: { id: string; name: string }[];
  items: { id: string; challenge: string }[];
  onResolve: (side: HandoverSide) => void;
}) {
  const isSequence = conflict.kind === 'stage-order' || conflict.kind === 'item-order';
  return (
    <Card className="conflict-card">
      <Flex justify="between" align="center" mb="2">
        <Badge color="amber" size="1">{conflictKindLabel[conflict.kind]}</Badge>
        <Text size="1" color="gray">{conflict.title}</Text>
      </Flex>
      {conflict.baseValue !== undefined && conflict.kind !== 'item-delete' && conflict.kind !== 'stage-delete' && (
        <Text size="1" color="gray" as="p" mb="2">
          底本：{isSequence
            ? String(conflict.baseValue || '—')
            : formatFieldValue(conflict.field ?? 'challenge', conflict.baseValue, stages, items)}
        </Text>
      )}
      <Grid columns="2" gap="2">
        {(['captain', 'first-officer'] as HandoverSide[]).map((side) => {
          const selected = decided === side;
          return (
            <button key={side} className={`conflict-option ${selected ? 'selected' : ''}`} onClick={() => onResolve(side)}>
              <Flex justify="between" align="center" mb="1">
                <Badge color={side === 'captain' ? 'blue' : 'purple'} size="1">{sideLabel(side)}</Badge>
                {selected && <Badge color="green" size="1">已选定</Badge>}
              </Flex>
              {isSequence ? (
                <span className="conflict-sequence">{side === 'captain' ? conflict.captainLabel : conflict.firstOfficerLabel}</span>
              ) : conflict.kind === 'item-delete' || conflict.kind === 'stage-delete' ? (
                <span className="conflict-sequence">{side === 'captain' ? conflict.captainLabel : conflict.firstOfficerLabel}</span>
              ) : (
                <span className="conflict-value">
                  {formatFieldValue(conflict.field ?? 'challenge', side === 'captain' ? conflict.captainValue : conflict.firstOfficerValue, stages, items)}
                </span>
              )}
            </button>
          );
        })}
      </Grid>
    </Card>
  );
}

function UnresolvedCard({ item, stages, action, onResolve }: {
  item: UnresolvedItem;
  stages: { id: string; name: string }[];
  action?: { stageId?: string; removedPreconditionIds?: string[]; deleted?: boolean };
  onResolve: (action: { stageId?: string; removedPreconditionIds?: string[]; deleted?: boolean }) => void;
}) {
  const [stageId, setStageId] = useState(action?.stageId ?? '');
  return (
    <Card className="unresolved-card">
      <Flex justify="between" align="center" mb="2">
        <Badge color="red" size="1">待确认</Badge>
        <strong>{item.challenge || '未命名检查项'}</strong>
      </Flex>
      {item.missingStage && (
        <div className="unresolved-row">
          <Text size="1">原阶段在合并后找不到，重新挂载到：</Text>
          <Select.Root
            value={stageId || undefined}
            onValueChange={(value) => {
              setStageId(value);
              onResolve({ stageId: value, removedPreconditionIds: action?.removedPreconditionIds });
            }}
          >
            <Select.Trigger style={{ minWidth: 200 }} />
            <Select.Content position="popper">
              {stages.map((stage) => <Select.Item key={stage.id} value={stage.id}>{stage.name}</Select.Item>)}
            </Select.Content>
          </Select.Root>
        </div>
      )}
      {item.missingPreconditionIds.map((preconditionId) => {
        const removed = action?.removedPreconditionIds?.includes(preconditionId);
        return (
          <div key={preconditionId} className="unresolved-row">
            <Text size="1">前置条件引用了找不到的对象（{preconditionId.slice(-6)}）{removed ? ' · 已移除' : ''}</Text>
            <Button
              size="1"
              variant="soft"
              color={removed ? 'gray' : 'red'}
              disabled={removed}
              onClick={() => onResolve({
                stageId: action?.stageId,
                removedPreconditionIds: [...(action?.removedPreconditionIds ?? []), preconditionId]
              })}
            >
              {removed ? '已移除' : '移除该前置条件'}
            </Button>
          </div>
        );
      })}
      <Flex justify="end" mt="2">
        <Button size="1" variant="soft" color="red" onClick={() => onResolve({ deleted: true })}>
          删除该检查项
        </Button>
      </Flex>
    </Card>
  );
}
