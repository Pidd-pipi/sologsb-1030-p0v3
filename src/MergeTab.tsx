import { useMemo, useRef, useState } from 'react';
import { Badge, Button, Callout, Card, Dialog, Flex, Grid, Heading, ScrollArea, Select, Tabs, Text, TextArea, TextField, Tooltip } from '@radix-ui/themes';
import { computeMerge, FIELD_LABEL, formatValue, SOURCE_META, validateBundle } from './merge';
import type { useChecklistStore } from './store';
import type {
  ChecklistProject,
  MergeConflictView,
  MergeResolution,
  MergeSession,
  MergeSource,
  ValidationIssue
} from './types';

type Store = ReturnType<typeof useChecklistStore>;

interface MergeTabProps {
  project: ChecklistProject;
  store: Store;
  onApplied: () => void;
}

const issueColor = { error: 'red', warning: 'amber', info: 'blue' } as const;

function download(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function sideChip(side: MergeSource | undefined, label?: string) {
  if (!side) return <Badge color="gray" variant="soft">待导入</Badge>;
  return <Badge color={SOURCE_META[side].color} variant="soft">● {SOURCE_META[side].label}{label ? ` · ${label}` : ''}</Badge>;
}

export function MergeTab({ project, store, onApplied }: MergeTabProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [deviceLabel, setDeviceLabel] = useState('');
  const [mergeTab, setMergeTab] = useState<'handoff' | 'resolve' | 'sessions'>('handoff');
  const [importMessage, setImportMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  const [customPreconditions, setCustomPreconditions] = useState<Record<string, string[]>>({});
  const [confirmApply, setConfirmApply] = useState(false);

  const role = store.getDeviceRole();
  const session = store.activeMergeSession;
  const computation = useMemo(() => (session ? computeMerge(session) : null), [session]);

  const sessionsForProject = store.state.mergeSessions.filter((entry) => entry.projectId === project.id);

  const labelOfItem = (id: string): string => {
    if (!session) return id;
    const hit = [...session.base.items, ...(session.captain?.items ?? []), ...(session.firstOfficer?.items ?? [])].find((entry) => entry.id === id);
    return hit?.challenge || id;
  };

  function handleExport() {
    const bundle = store.exportHandoff(deviceLabel);
    if (!bundle) return;
    const safeName = project.name.replace(/[^\p{L}\p{N}-]+/gu, '-');
    download(`${safeName}-r${bundle.baseRevisionNumber}-${bundle.source === 'captain' ? 'captain' : 'fo'}.fchk.json`, JSON.stringify(bundle, null, 2));
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      try {
        const parsed: unknown = JSON.parse(await file.text());
        const check = validateBundle(parsed);
        if (!check.ok) {
          setImportMessage({ ok: false, text: `${file.name}：${check.reason}` });
          continue;
        }
        const result = store.importHandoff(check.bundle, file.name);
        if (!result.ok) {
          setImportMessage({ ok: false, text: `${file.name}：${result.reason}` });
          continue;
        }
        setImportMessage({ ok: true, text: `${file.name} 导入成功${result.resumed ? '，已续接到未完成的交接会话' : ''}。` });
        setMergeTab('resolve');
      } catch {
        setImportMessage({ ok: false, text: `${file.name}：文件不是有效的 JSON。` });
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  function bulkChoose(side: MergeSource) {
    if (!computation || !session) return;
    const updates: Array<{ id: string; resolution: MergeResolution }> = [];
    computation.conflicts.forEach((conflict) => {
      if (conflict.kind === 'field') updates.push({ id: conflict.id, resolution: { kind: 'field', choice: side } });
      if (conflict.kind === 'modify-delete') updates.push({ id: conflict.id, resolution: { kind: 'modify-delete', action: 'keep', side } });
    });
    store.bulkResolve(updates);
  }

  function doApply() {
    if (!computation?.candidate || computation.stats.pending > 0) return;
    const blockingErrors = computation.issues.filter((issue) => issue.level === 'error').length;
    if (blockingErrors > 0) return;
    store.applyMerge(computation.candidate, computation.stats);
    setConfirmApply(false);
    onApplied();
  }

  return (
    <div className="content-page merge-page">
      <Flex justify="between" align="start" wrap="wrap" gap="3">
        <div>
          <Heading size="7">离线交接合并</Heading>
          <Text color="gray" as="p">以同一冻结版本为底本，机长与副驾驶的平板改动三方合并；冲突进入待决区，复核人选定后才进复核稿。</Text>
        </div>
        <Flex gap="2" align="center">
          <Text size="1" color="gray">本机身份</Text>
          <Select.Root value={role} onValueChange={(value) => store.setDeviceRole(value as MergeSource)}>
            <Select.Trigger variant="soft" />
            <Select.Content position="popper">
              <Select.Item value="captain">机长平板</Select.Item>
              <Select.Item value="firstOfficer">副驾驶平板</Select.Item>
            </Select.Content>
          </Select.Root>
        </Flex>
      </Flex>

      <Tabs.Root value={mergeTab} onValueChange={(value) => setMergeTab(value as typeof mergeTab)}>
        <Tabs.List mt="4">
          <Tabs.Trigger value="handoff">导出 / 导入</Tabs.Trigger>
          <Tabs.Trigger value="resolve">
            待决与候选稿 {session && session.status === 'open' && computation && computation.stats.pending > 0
              ? <Badge color="red" variant="solid" ml="2">{computation.stats.pending}</Badge>
              : session ? <Badge variant="soft" ml="2">{sessionsForOpenLabel(session)}</Badge> : null}
          </Tabs.Trigger>
          <Tabs.Trigger value="sessions">交接会话 ({sessionsForProject.length})</Tabs.Trigger>
        </Tabs.List>

        {/* —— 导出 / 导入 —— */}
        <Tabs.Content value="handoff">
          <Grid columns="2" gap="4" mt="4">
            <Card className="handoff-card">
              <Heading size="4" mb="2">① 导出本机现场改动包</Heading>
              <Text size="2" color="gray" as="p">
                改动包内嵌冻结底本快照与来源标记，回基地后即使离线也能做三方合并。当前底本：
                <Badge variant="soft" mx="2">r{project.revisions.find((r) => r.id === project.baseRevisionId)?.revision ?? project.revision} · {project.baseRevisionId ? '冻结版本' : '当前工作稿'}</Badge>
              </Text>
              <label className="merge-field"><span>设备标签（便于溯源）</span>
                <TextField.Root value={deviceLabel} onChange={(event) => setDeviceLabel(event.target.value)} placeholder={role === 'captain' ? '如：机长平板 B-1028 左座' : '如：副驾驶平板 B-1028 右座'} />
              </label>
              <Button mt="3" onClick={handleExport} disabled={project.status === 'frozen'}>导出 .fchk.json 改动包</Button>
              {project.status === 'frozen' && <Text size="1" color="amber" as="p" mt="2">项目已冻结，请先创建修订再导出改动包。</Text>}
            </Card>

            <Card className="handoff-card">
              <Heading size="4" mb="2">② 导入同伴改动包</Heading>
              <Text size="2" color="gray" as="p">选择机长或副驾驶导出的改动包。若本机草稿源自同一冻结底本，会自动作为另一侧开案；也可稍后在待决页手动补入另一侧。</Text>
              <input ref={fileRef} type="file" accept=".json,application/json" multiple className="merge-file" onChange={(event) => handleFiles(event.target.files)} />
              <Button mt="3" variant="soft" onClick={() => fileRef.current?.click()}>选择改动包…</Button>
              {importMessage && (
                <Callout.Root mt="3" color={importMessage.ok ? 'green' : 'red'}>
                  <Callout.Text>{importMessage.text}</Callout.Text>
                </Callout.Root>
              )}
            </Card>
          </Grid>

          {project.mergeInfo && (
            <Card mt="4" className="merge-summary-card">
              <Heading size="3" mb="2">最近一次合并溯源</Heading>
              <Text size="2" as="p">
                {new Date(project.mergeInfo.mergedAt).toLocaleString('zh-CN')} 合并 · 底本 r{project.mergeInfo.baseRevisionNumber}
                {' · '}机长：{project.mergeInfo.captainLabel || '—'}；副驾驶：{project.mergeInfo.firstOfficerLabel || '—'}
              </Text>
              <Text size="2" color="gray" as="p">新增 {project.mergeInfo.addedCount} · 删除 {project.mergeInfo.removedCount} · 自动并入 {project.mergeInfo.autoChangeCount} · 复核人选定 {project.mergeInfo.resolvedConflictCount} 项冲突</Text>
            </Card>
          )}
        </Tabs.Content>

        {/* —— 待决与候选稿 —— */}
        <Tabs.Content value="resolve">
          {!session ? (
            <div className="empty-page" style={{ marginTop: 24 }}>
              <strong>暂无进行中的交接会话</strong>
              <span>先在“导出 / 导入”页导入机长或副驾驶的改动包；中断的会话可在“交接会话”页继续。</span>
            </div>
          ) : (
            <SessionPanel
              session={session}
              computation={computation!}
              store={store}
              labelOfItem={labelOfItem}
              customTexts={customTexts}
              setCustomTexts={setCustomTexts}
              customPreconditions={customPreconditions}
              setCustomPreconditions={setCustomPreconditions}
              onBulk={bulkChoose}
              onApply={() => setConfirmApply(true)}
            />
          )}
        </Tabs.Content>

        {/* —— 会话列表（断点续接）—— */}
        <Tabs.Content value="sessions">
          <div className="session-list">
            {sessionsForProject.length === 0 && (
              <div className="empty-page" style={{ marginTop: 24 }}>
                <strong>还没有交接会话</strong>
                <span>导入第一个改动包后自动创建；会话随浏览器本地保存，交接中断后可随时继续。</span>
              </div>
            )}
            {sessionsForProject.map((entry) => {
              const comp = computeMerge(entry);
              return (
                <Card key={entry.id} className="session-card">
                  <Flex justify="between" align="center" wrap="wrap" gap="2">
                    <div>
                      <Flex gap="2" align="center" mb="1">
                        <Heading size="3">{entry.status === 'applied' ? '已完成合并' : comp.status === 'waiting' ? '等待另一侧' : '合并进行中'}</Heading>
                        <Badge color={entry.status === 'applied' ? 'green' : comp.status === 'waiting' ? 'gray' : 'amber'} variant="soft">底本 r{entry.baseRevisionNumber}</Badge>
                        {comp.status === 'open' && comp.stats.pending > 0 && <Badge color="red">{comp.stats.pending} 待决</Badge>}
                      </Flex>
                      <Flex gap="3" wrap="wrap">
                        {sideChip('captain', entry.captain?.label)}
                        <Text size="1" color="gray">×</Text>
                        {sideChip('firstOfficer', entry.firstOfficer?.label)}
                      </Flex>
                      <Text size="1" color="gray" as="p">更新于 {new Date(entry.updatedAt).toLocaleString('zh-CN')}{entry.appliedAt ? ` · 已并入 ${new Date(entry.appliedAt).toLocaleString('zh-CN')}` : ''}</Text>
                    </div>
                    <Flex gap="2">
                      {entry.status !== 'applied' && <Button variant="soft" onClick={() => { store.selectMergeSession(entry.id); setMergeTab('resolve'); }}>{comp.status === 'waiting' ? '继续 / 补另一侧' : '继续处理'}</Button>}
                      {entry.status !== 'applied' && <Button color="red" variant="ghost" onClick={() => { if (window.confirm('放弃该交接会话？已做的待决选择会丢失。')) store.abandonMergeSession(entry.id); }}>放弃</Button>}
                    </Flex>
                  </Flex>
                </Card>
              );
            })}
          </div>
        </Tabs.Content>
      </Tabs.Root>

      <Dialog.Root open={confirmApply} onOpenChange={setConfirmApply}>
        <Dialog.Content maxWidth="520px">
          <Dialog.Title>候选稿进入复核</Dialog.Title>
          <Dialog.Description size="2" color="gray">
            待决项已全部选定。写入后项目将进入“复核中”，编辑内容锁定，复核人确认无误后再冻结。
            {computation?.issues.some((i) => i.level === 'warning') ? ' 仍有警告级提示，建议在复核稿中确认。' : ''}
          </Dialog.Description>
          <Flex gap="3" justify="end" mt="4">
            <Dialog.Close><Button variant="soft">再看看</Button></Dialog.Close>
            <Button color="amber" onClick={doApply}>写入并进入复核稿</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}

function sessionsForOpenLabel(session: MergeSession): string {
  if (session.status === 'applied') return '已并入';
  if (!session.captain || !session.firstOfficer) return '等待中';
  return '处理中';
}

interface SessionPanelProps {
  session: MergeSession;
  computation: ReturnType<typeof computeMerge>;
  store: Store;
  labelOfItem: (id: string) => string;
  customTexts: Record<string, string>;
  setCustomTexts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  customPreconditions: Record<string, string[]>;
  setCustomPreconditions: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  onBulk: (side: MergeSource) => void;
  onApply: () => void;
}

function SessionPanel({ session, computation, store, labelOfItem, customTexts, setCustomTexts, customPreconditions, setCustomPreconditions, onBulk, onApply }: SessionPanelProps) {
  const [previewTab, setPreviewTab] = useState<'pending' | 'auto' | 'candidate' | 'issues'>('pending');
  const hasErrors = computation.issues.some((issue) => issue.level === 'error');

  return (
    <div className="session-panel">
      <Card mt="4" className="session-head-card">
        <Flex justify="between" align="center" wrap="wrap" gap="3">
          <div>
            <Flex gap="2" align="center" wrap="wrap">
              <Heading size="4">三方合并</Heading>
              <Badge variant="soft">共同底本 r{session.baseRevisionNumber}</Badge>
            </Flex>
            <Flex gap="3" mt="2" wrap="wrap">
              {sideChip('captain', session.captain?.label)}
              <Text size="2" color="gray">{session.captain ? new Date(session.captain.exportedAt).toLocaleString('zh-CN') : '尚未导入'}</Text>
              <Text size="2" color="gray">×</Text>
              {sideChip('firstOfficer', session.firstOfficer?.label)}
              <Text size="2" color="gray">{session.firstOfficer ? new Date(session.firstOfficer.exportedAt).toLocaleString('zh-CN') : '尚未导入'}</Text>
            </Flex>
          </div>
          {computation.status === 'open' && (
            <Flex gap="2" wrap="wrap">
              <Button size="2" variant="soft" onClick={() => onBulk('captain')}>全部取机长值</Button>
              <Button size="2" variant="soft" onClick={() => onBulk('firstOfficer')}>全部取副驾驶值</Button>
            </Flex>
          )}
        </Flex>
      </Card>

      {computation.status === 'waiting' && (
        <Card mt="4">
          <Heading size="4" mb="2">等待另一侧改动</Heading>
          <Text size="2" color="gray" as="p">导入另一侧的改动包，或把本机当前草稿作为另一侧加入：</Text>
          <Flex gap="2" mt="3" wrap="wrap">
            <Button variant="soft" disabled={Boolean(session.captain)} onClick={() => store.promoteLocalAsSide('captain')}>以本机草稿充当机长侧</Button>
            <Button variant="soft" disabled={Boolean(session.firstOfficer)} onClick={() => store.promoteLocalAsSide('firstOfficer')}>以本机草稿充当副驾驶侧</Button>
          </Flex>
        </Card>
      )}

      {computation.status === 'open' && (
        <>
          <Flex gap="2" mt="4" wrap="wrap" align="center">
          <SummaryStat label="直接并入新增" value={computation.stats.added} color="green" />
          <SummaryStat label="直接并入删除" value={computation.stats.removed} color="red" />
          <SummaryStat label="自动取值" value={computation.stats.autoChanges} color="blue" />
          <SummaryStat label="待决未处理" value={computation.stats.pending} color={computation.stats.pending ? 'red' : 'gray'} />
          <SummaryStat label="已选定" value={computation.stats.resolvedConflicts} color="amber" />
          <div style={{ marginLeft: 'auto' }}>
            <Button color="amber" disabled={computation.stats.pending > 0 || hasErrors} onClick={onApply}>
              {computation.stats.pending > 0 ? `还有 ${computation.stats.pending} 项待决` : hasErrors ? '候选稿存在阻断问题' : '候选稿进复核稿'}
            </Button>
          </div>
        </Flex>

        <Tabs.Root value={previewTab} onValueChange={(value) => setPreviewTab(value as typeof previewTab)}>
          <Tabs.List mt="3">
            <Tabs.Trigger value="pending">待决 / 待确认 {computation.conflicts.some((c) => c.blocking && !c.resolution) && <Badge color="red" variant="solid" ml="1">{computation.stats.pending}</Badge>}</Tabs.Trigger>
            <Tabs.Trigger value="auto">直接并入 ({computation.autoEntries.length})</Tabs.Trigger>
            <Tabs.Trigger value="candidate">候选稿预览 ({computation.candidate?.items.length ?? 0})</Tabs.Trigger>
            <Tabs.Trigger value="issues">即时校验 ({computation.issues.length})</Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="pending">
            <ScrollArea style={{ maxHeight: '56vh' }} mt="3">
              <div className="conflict-list">
                {computation.conflicts.length === 0 && (
                  <Callout.Root color="green" mt="2"><Callout.Text>没有任何冲突，所有改动均可直接并入，可直接进复核稿。</Callout.Text></Callout.Root>
                )}
                {computation.conflicts.map((conflict) => (
                  <ConflictCard
                    key={conflict.id}
                    conflict={conflict}
                    session={session}
                    store={store}
                    labelOfItem={labelOfItem}
                    customTexts={customTexts}
                    setCustomTexts={setCustomTexts}
                    customPreconditions={customPreconditions}
                    setCustomPreconditions={setCustomPreconditions}
                  />
                ))}
              </div>
            </ScrollArea>
          </Tabs.Content>

          <Tabs.Content value="auto">
            <div className="auto-list">
              {computation.autoEntries.map((entry) => (
                <Card key={entry.id} className="auto-card">
                  <Flex gap="2" align="center" wrap="wrap">
                    {entry.addedBy && <Badge color="green">新增 · {SOURCE_META[entry.addedBy].short}</Badge>}
                    {entry.removed && <Badge color="red">删除</Badge>}
                    <strong>{entry.label}</strong>
                    <Text size="1" color="gray">{entry.entity === 'stage' ? '阶段' : '检查项'}</Text>
                  </Flex>
                  {entry.changes.map((change, index) => {
                    const fieldLabel = change.field === 'entity' ? '实体' : (FIELD_LABEL[change.field] ?? '实体');
                    return (
                      <Text key={index} size="1" as="p" color="gray" mt="1">
                        {fieldLabel}：{change.note ?? `采用${change.source === 'captain' ? '机长' : change.source === 'firstOfficer' ? '副驾驶' : change.source === 'both' ? '双方一致' : '底本'}值`}
                        {change.from !== change.to && <>（{change.from || '空'} → {change.to || '空'}）</>}
                      </Text>
                    );
                  })}
                </Card>
              ))}
            </div>
          </Tabs.Content>

          <Tabs.Content value="candidate">
            <Card mt="3">
              <CandidatePreview candidate={computation.candidate} />
            </Card>
          </Tabs.Content>

          <Tabs.Content value="issues">
            <div className="issue-merge-list">
              {computation.issues.length === 0
                ? <Callout.Root color="green" mt="3"><Callout.Text>候选稿通过即时校验：阶段顺序与前置条件可达性均正常。</Callout.Text></Callout.Root>
                : computation.issues.map((issue) => <IssueRow key={issue.id} issue={issue} candidate={computation.candidate!} />)}
            </div>
            <Text size="1" color="gray" as="p" mt="2">前置条件改动后不可达提示、阶段顺序异常在此随候选稿即时重算。</Text>
          </Tabs.Content>
        </Tabs.Root>
        </>
      )}
    </div>
  );
}

function SummaryStat({ label, value, color }: { label: string; value: number; color: 'green' | 'red' | 'blue' | 'amber' | 'gray' }) {
  return (
    <Card className="summary-stat">
      <Text size="1" color="gray">{label}</Text>
      <div><Badge color={color} size="3">{value}</Badge></div>
    </Card>
  );
}

interface ConflictCardProps {
  conflict: MergeConflictView;
  session: MergeSession;
  store: Store;
  labelOfItem: (id: string) => string;
  customTexts: Record<string, string>;
  setCustomTexts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  customPreconditions: Record<string, string[]>;
  setCustomPreconditions: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
}

function ConflictCard({ conflict, session, store, labelOfItem, customTexts, setCustomTexts, customPreconditions, setCustomPreconditions }: ConflictCardProps) {
  const resolution = conflict.resolution;
  const set = (next: MergeResolution | null) => store.setMergeResolution(conflict.id, next);
  const kindMeta: Record<MergeConflictView['kind'], { title: string; color: 'red' | 'amber' | 'blue' | 'gray' }> = {
    field: { title: '两套值待决', color: 'amber' },
    'modify-delete': { title: '改 / 删冲突', color: 'red' },
    'missing-stage': { title: '阶段找不到', color: 'red' },
    'dangling-precondition': { title: '前置找不到对象', color: 'red' },
    'waiting-ref': { title: '等待关联决定', color: 'blue' }
  };
  const meta = kindMeta[conflict.kind];

  return (
    <Card className={`conflict-card ${resolution ? 'resolved' : ''} ${!conflict.blocking ? 'nonblocking' : ''}`}>
      <Flex justify="between" align="center" gap="2" wrap="wrap">
        <Flex gap="2" align="center" wrap="wrap">
          <Badge color={meta.color}>{meta.title}</Badge>
          {!conflict.blocking && <Badge variant="soft" color="gray">待确认区 · 不阻断</Badge>}
          <strong>{conflict.label}</strong>
          {conflict.field && <Text size="1" color="gray">（{FIELD_LABEL[conflict.field]}）</Text>}
        </Flex>
        {resolution && <Badge color="green">已选定</Badge>}
      </Flex>
      {conflict.subLabel && <Text size="1" color="gray" as="p" mt="1">{conflict.subLabel}</Text>}

      <div className="conflict-body">
        {conflict.kind === 'field' && conflict.field && (
          <FieldConflict
            conflict={conflict}
            session={session}
            labelOfItem={labelOfItem}
            resolution={resolution}
            set={set}
            customText={customTexts[conflict.id] ?? ''}
            setCustomText={(value) => setCustomTexts((prev) => ({ ...prev, [conflict.id]: value }))}
            customPreconditionSelection={customPreconditions[conflict.id] ?? null}
            setCustomPreconditionSelection={(ids) => setCustomPreconditions((prev) => ({ ...prev, [conflict.id]: ids }))}
          />
        )}

        {conflict.kind === 'modify-delete' && (
          <div>
            <Text size="2" as="p" mb="2">
              {conflict.present?.captain ? '机长' : '副驾驶'}删除了该{conflict.entity === 'stage' ? '阶段' : '检查项'}，
              而{conflict.present?.captain ? '副驾驶' : '机长'}对其做了修改。
            </Text>
            <Flex gap="2" wrap="wrap">
              <Button size="1" color="red" variant={resolution?.kind === 'modify-delete' && resolution.action === 'delete' ? 'solid' : 'soft'} onClick={() => set({ kind: 'modify-delete', action: 'delete' })}>接受删除</Button>
              <Button size="1" variant={resolution?.kind === 'modify-delete' && resolution.action === 'keep' && (resolution.side ?? conflict.survivorSide) === conflict.survivorSide ? 'solid' : 'soft'}
                onClick={() => set({ kind: 'modify-delete', action: 'keep', side: conflict.survivorSide })}>
                保留修改方（{conflict.survivorSide === 'captain' ? '副驾驶' : '机长'}已删）
              </Button>
            </Flex>
          </div>
        )}

        {conflict.kind === 'missing-stage' && (
          <MissingStageConflict conflict={conflict} session={session} resolution={resolution} set={set} />
        )}

        {conflict.kind === 'dangling-precondition' && (
          <DanglingConflict conflict={conflict} session={session} labelOfItem={labelOfItem} resolution={resolution} set={set} />
        )}

        {conflict.kind === 'waiting-ref' && (
          <Callout.Root color="blue" mt="2"><Callout.Text>该引用的去留取决于另一项改删冲突的结论，系统会在对方决定后自动重算，无需手动处理。</Callout.Text></Callout.Root>
        )}
      </div>
    </Card>
  );
}

function chooseButton(active: boolean, onClick: () => void, text: string) {
  return <Button size="1" variant={active ? 'solid' : 'soft'} onClick={onClick}>{text}</Button>;
}

interface FieldConflictProps {
  conflict: MergeConflictView;
  session: MergeSession;
  labelOfItem: (id: string) => string;
  resolution?: MergeResolution;
  set: (next: MergeResolution | null) => void;
  customText: string;
  setCustomText: (value: string) => void;
  customPreconditionSelection: string[] | null;
  setCustomPreconditionSelection: (ids: string[]) => void;
}

function FieldConflict({ conflict, session, labelOfItem, resolution, set, customText, setCustomText, customPreconditionSelection, setCustomPreconditionSelection }: FieldConflictProps) {
  const field = conflict.field!;
  const isPrecondition = field === 'preconditions';
  const raw = conflict.raw ?? {};
  const renderValue = (value: unknown) => formatValue(field, value, labelOfItem);
  // 已保存的复核人自定义集合优先；否则在首次勾选前不预填（null 表示尚未开始自定义）。
  const customPreconditionList = customPreconditionSelection
    ?? (resolution?.kind === 'field' && resolution.choice === 'custom' && Array.isArray(resolution.custom) ? resolution.custom as string[] : []);

  const allItemOptions = useMemo(() => {
    const seen = new Map<string, string>();
    [...session.base.items, ...(session.captain?.items ?? []), ...(session.firstOfficer?.items ?? [])].forEach((item) => {
      if (item.id !== conflict.entityId && !seen.has(item.id)) seen.set(item.id, item.challenge || item.id);
    });
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [session, conflict.entityId]);

  return (
    <div>
      <Grid columns={{ initial: '1', sm: '3' }} gap="2" mt="2">
        <div className="value-box">
          <Text size="1" weight="bold" color="gray">共同底本</Text>
          <pre>{renderValue(raw.base)}</pre>
        </div>
        <div className={`value-box source-captain ${resolution?.kind === 'field' && resolution.choice === 'captain' ? 'picked' : ''}`}>
          <Text size="1" weight="bold">机长平板</Text>
          <pre>{renderValue(raw.captain)}</pre>
        </div>
        <div className={`value-box source-fo ${resolution?.kind === 'field' && resolution.choice === 'firstOfficer' ? 'picked' : ''}`}>
          <Text size="1" weight="bold">副驾驶平板</Text>
          <pre>{renderValue(raw.firstOfficer)}</pre>
        </div>
      </Grid>
      <Flex gap="2" mt="2" wrap="wrap">
        {chooseButton(resolution?.kind === 'field' && resolution.choice === 'captain', () => set({ kind: 'field', choice: 'captain' }), '采用机长值')}
        {chooseButton(resolution?.kind === 'field' && resolution.choice === 'firstOfficer', () => set({ kind: 'field', choice: 'firstOfficer' }), '采用副驾驶值')}
        {resolution && <Button size="1" variant="ghost" onClick={() => set(null)}>清除选择</Button>}
      </Flex>

      {isPrecondition ? (
        <div className="custom-preconditions">
          <Text size="1" weight="bold" as="p" mt="3">或由复核人自定义前置集合：</Text>
          <div className="custom-precondition-grid">
            {allItemOptions.map((option) => {
              const checked = customPreconditionList.includes(option.id);
              return (
                <label key={option.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const next = checked ? customPreconditionList.filter((id) => id !== option.id) : [...customPreconditionList, option.id];
                      setCustomPreconditionSelection(next);
                      set({ kind: 'field', choice: 'custom', custom: next });
                    }}
                  />
                  <span>{option.name}</span>
                </label>
              );
            })}
          </div>
        </div>
      ) : (
        <Flex gap="2" mt="3" align="end">
          <label className="custom-text">
            <span>或由复核人给定新值</span>
            {field === 'challenge' || field === 'response' ? (
              <TextField.Root
                value={customText}
                onChange={(event) => {
                  setCustomText(event.target.value);
                  set({ kind: 'field', choice: 'custom', custom: event.target.value });
                }}
                placeholder="复核人定稿值"
              />
            ) : (
              <TextArea
                value={customText}
                onChange={(event) => {
                  setCustomText(event.target.value);
                  set({ kind: 'field', choice: 'custom', custom: event.target.value });
                }}
                placeholder="复核人定稿值"
              />
            )}
          </label>
        </Flex>
      )}
    </div>
  );
}

function MissingStageConflict({ session, resolution, set }: { conflict: MergeConflictView; session: MergeSession; resolution?: MergeResolution; set: (r: MergeResolution | null) => void }) {
  const stageOptions = useMemo(() => {
    // 候选阶段：两侧并集中仍存在的阶段
    const ids = new Set<string>();
    session.captain?.stages.forEach((s) => ids.add(s.id));
    session.firstOfficer?.stages.forEach((s) => ids.add(s.id));
    const names = new Map<string, string>();
    [...(session.captain?.stages ?? []), ...(session.firstOfficer?.stages ?? [])].forEach((s) => names.set(s.id, s.name));
    return [...ids].map((id) => ({ id, name: names.get(id) ?? id }));
  }, [session]);

  const selected = resolution?.kind === 'missing-stage' ? resolution.stageId : undefined;
  return (
    <div>
      <Text size="2" as="p" mb="2">该检查项的所属阶段在合并结果中找不到。请选择要并入的阶段，或删除该检查项：</Text>
      <Flex gap="2" wrap="wrap">
        <Select.Root
          value={selected ?? ''}
          onValueChange={(stageId) => set({ kind: 'missing-stage', action: 'move', stageId })}
        >
          <Select.Trigger variant={selected ? 'classic' : 'soft'} placeholder="选择并入阶段" />
          <Select.Content position="popper">
            {stageOptions.map((stage) => <Select.Item key={stage.id} value={stage.id}>{stage.name}</Select.Item>)}
          </Select.Content>
        </Select.Root>
        <Button size="1" color="red" variant={resolution?.kind === 'missing-stage' && resolution.action === 'delete' ? 'solid' : 'soft'} onClick={() => set({ kind: 'missing-stage', action: 'delete' })}>删除该检查项</Button>
        {resolution && <Button size="1" variant="ghost" onClick={() => set(null)}>清除选择</Button>}
      </Flex>
    </div>
  );
}

function DanglingConflict({ conflict, session, labelOfItem, resolution, set }: { conflict: MergeConflictView; session: MergeSession; labelOfItem: (id: string) => string; resolution?: MergeResolution; set: (r: MergeResolution | null) => void }) {
  const options = useMemo(() => {
    const ids = new Set<string>();
    [...(session.captain?.items ?? []), ...(session.firstOfficer?.items ?? [])].forEach((item) => {
      if (item.id !== conflict.entityId) ids.add(item.id);
    });
    return [...ids].map((id) => ({ id, name: labelOfItem(id) }));
  }, [session, conflict.entityId, labelOfItem]);
  const target = resolution?.kind === 'dangling-precondition' && resolution.action === 'rebind' ? resolution.targetId : undefined;

  return (
    <div>
      <Text size="2" as="p" mb="2">前置条件“{conflict.refId ? labelOfItem(conflict.refId) : '未知'}”在合并结果中找不到。可改绑到其他检查项，或移除该前置条件：</Text>
      <Flex gap="2" wrap="wrap">
        <Select.Root value={target ?? ''} onValueChange={(targetId) => set({ kind: 'dangling-precondition', action: 'rebind', targetId })}>
          <Select.Trigger variant={target ? 'classic' : 'soft'} placeholder="改绑到…" />
          <Select.Content position="popper">
            {options.map((option) => <Select.Item key={option.id} value={option.id}>{option.name}</Select.Item>)}
          </Select.Content>
        </Select.Root>
        <Button size="1" color="red" variant={resolution?.kind === 'dangling-precondition' && resolution.action === 'remove' ? 'solid' : 'soft'} onClick={() => set({ kind: 'dangling-precondition', action: 'remove' })}>移除该前置条件</Button>
        {resolution && <Button size="1" variant="ghost" onClick={() => set(null)}>清除选择</Button>}
      </Flex>
    </div>
  );
}

function CandidatePreview({ candidate }: { candidate: { stages: MergeSession['base']['stages']; items: MergeSession['base']['items'] } | null }) {
  if (!candidate) return <Text color="gray">尚无候选稿。</Text>;
  const stages = [...candidate.stages].sort((a, b) => a.order - b.order);
  return (
    <div className="candidate-preview">
      {stages.map((stage) => (
        <section key={stage.id}>
          <Heading size="3" mb="1">{stage.name}</Heading>
          {candidate.items.filter((item) => item.stageId === stage.id).sort((a, b) => a.order - b.order).map((item) => (
            <Flex key={item.id} gap="2" align="center" py="1" className="candidate-row">
              {item.critical && <Badge color="red" size="1">关键</Badge>}
              <Text size="2">{item.challenge || '未命名检查项'}</Text>
              <Text size="1" color="gray">→</Text>
              <Text size="2" weight="bold">{item.response || '（空回应）'}</Text>
              <ProvenanceBadges item={item} />
            </Flex>
          ))}
        </section>
      ))}
    </div>
  );
}

function ProvenanceBadges({ item }: { item: { provenance?: Record<string, MergeSource | 'reviewer' | 'both'> } }) {
  const entries = Object.entries(item.provenance ?? {});
  return (
    <Flex gap="1" style={{ marginLeft: 'auto' }}>
      {entries.map(([field, source]) => {
        if (source === 'both') return null;
        const label = FIELD_LABEL[field as keyof typeof FIELD_LABEL] ?? field;
        return (
          <Tooltip key={field} content={`${label} 来自${source === 'captain' ? '机长平板' : source === 'firstOfficer' ? '副驾驶平板' : '复核人定稿'}`}>
            <Badge size="1" color={source === 'captain' ? 'blue' : source === 'firstOfficer' ? 'cyan' : 'amber'} variant="soft">
              {label}·{source === 'captain' ? '机' : source === 'firstOfficer' ? '副' : '复'}
            </Badge>
          </Tooltip>
        );
      })}
    </Flex>
  );
}

// Radix Themes Tooltip 由顶部统一导入。

function IssueRow({ issue, candidate }: { issue: ValidationIssue; candidate: { stages: MergeSession['base']['stages']; items: MergeSession['base']['items'] } }) {
  const stage = candidate.stages.find((s) => s.id === issue.stageId);
  const item = candidate.items.find((i) => i.id === issue.itemId);
  return (
    <Card className={`issue-merge-card ${issue.level}`} mt="2">
      <Flex gap="2" align="center">
        <Badge color={issueColor[issue.level]}>{issue.level === 'error' ? '阻断' : issue.level === 'warning' ? '警告' : '提示'}</Badge>
        <strong>{issue.title}</strong>
        <Text size="1" color="gray">{stage?.name}{item ? ` · ${item.challenge}` : ''}</Text>
      </Flex>
      <Text size="1" color="gray" as="p" mt="1">{issue.detail}</Text>
    </Card>
  );
}
