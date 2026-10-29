import { describe, expect, it, vi } from 'vitest';
import type { OpenTarget } from './desktopWindow';
import { routeOpenTarget, type OpenTargetRouting } from './openTargetRouting';

function setup() {
  const calls: string[] = [];
  const routing: OpenTargetRouting = {
    syncTargets: vi.fn(async () => {
      calls.push('sync');
    }),
    prepare: vi.fn<OpenTargetRouting['prepare']>(async (target, create) => {
      calls.push(create ? 'reserve' : 'resolve');
      return create
        ? { action: 'create-window', windowLabel: 'window-target', target }
        : { action: 'open-current', target };
    }),
    activateCurrent: vi.fn(async () => {
      calls.push('activate');
    }),
    openCurrent: vi.fn(async () => {
      calls.push('open');
    }),
    createWindow: vi.fn(async () => {
      calls.push('create');
    }),
    isReusableInitialWindow: vi.fn(() => false),
    getBehavior: vi.fn<OpenTargetRouting['getBehavior']>(() => 'new-window'),
    requestChoice: vi.fn(async () => {
      calls.push('ask');
      return null;
    }),
    rememberBehavior: vi.fn(async () => {
      calls.push('remember');
    }),
  };
  return { routing, calls };
}

const targets: OpenTarget[] = [
  { kind: 'documents', paths: ['D:/test/target.md'] },
  { kind: 'documents', paths: ['D:/test/a.md', 'D:/test/b.txt', 'D:/test/c.json'] },
  { kind: 'folder', path: 'D:/test/folder' },
];

describe.each(targets)('$kind 激活时机', (target) => {
  it('新窗口创建完成前后都不激活旧窗口', async () => {
    const { routing, calls } = setup();
    let finish!: () => void;
    vi.mocked(routing.createWindow).mockImplementation(async () => {
      calls.push('create');
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      expect(routing.activateCurrent).not.toHaveBeenCalled();
    });
    const opening = routeOpenTarget(target, routing);
    await vi.waitFor(() => expect(routing.createWindow).toHaveBeenCalledOnce());
    expect(routing.activateCurrent).not.toHaveBeenCalled();
    finish();
    await opening;
    expect(calls).toEqual(['sync', 'resolve', 'reserve', 'create']);
    expect(routing.openCurrent).not.toHaveBeenCalled();
  });

  it('当前窗口先激活再执行文档操作', async () => {
    const { routing, calls } = setup();
    vi.mocked(routing.getBehavior).mockReturnValue('current-window');
    await routeOpenTarget(target, routing);
    expect(calls).toEqual(['sync', 'resolve', 'activate', 'open']);
  });

  it('初始空窗口仍优先复用', async () => {
    const { routing, calls } = setup();
    vi.mocked(routing.isReusableInitialWindow).mockReturnValue(true);
    await routeOpenTarget(target, routing);
    expect(calls).toEqual(['sync', 'resolve', 'activate', 'open']);
  });

  it('已有目标在其他窗口时不激活接收窗口', async () => {
    const { routing } = setup();
    vi.mocked(routing.prepare).mockResolvedValue({ action: 'handled' });
    await routeOpenTarget(target, routing);
    expect(routing.activateCurrent).not.toHaveBeenCalled();
    expect(routing.createWindow).not.toHaveBeenCalled();
  });

  it('已有目标在当前窗口时激活，只有文档需要定位标签', async () => {
    const { routing, calls } = setup();
    vi.mocked(routing.prepare).mockResolvedValue({ action: 'activate-current', target });
    await routeOpenTarget(target, routing);
    expect(calls).toEqual(target.kind === 'folder' ? ['sync', 'activate'] : ['sync', 'activate', 'open']);
    if (target.kind === 'folder') expect(routing.openCurrent).not.toHaveBeenCalled();
  });

  it('显示询问前激活，取消不打开也不创建窗口', async () => {
    const { routing, calls } = setup();
    vi.mocked(routing.getBehavior).mockReturnValue('ask-every-time');
    await routeOpenTarget(target, routing);
    expect(calls).toEqual(['sync', 'resolve', 'activate', 'ask']);
    expect(routing.rememberBehavior).not.toHaveBeenCalled();
  });

  it.each(['handled', 'activate-current'] as const)(
    '二次确认返回 %s 时保留已有目标处理',
    async (action) => {
      const { routing, calls } = setup();
      vi.mocked(routing.prepare)
        .mockResolvedValueOnce({ action: 'open-current', target })
        .mockResolvedValueOnce(action === 'handled' ? { action } : { action, target });
      await routeOpenTarget(target, routing);
      expect(routing.prepare).toHaveBeenCalledTimes(2);
      expect(calls).toEqual(
        action === 'handled' ? ['sync'] : ['sync', 'activate', ...(target.kind === 'folder' ? [] : ['open'])],
      );
      if (target.kind === 'folder') expect(routing.openCurrent).not.toHaveBeenCalled();
      expect(routing.createWindow).not.toHaveBeenCalled();
    },
  );

  it.each(['current-window', 'new-window'] as const)(
    '询问选择 %s 后不再次激活旧窗口',
    async (choice) => {
      const { routing, calls } = setup();
      vi.mocked(routing.getBehavior).mockReturnValue('ask-every-time');
      vi.mocked(routing.requestChoice).mockImplementation(async () => {
        calls.push('ask');
        return { choice, remember: true };
      });
      await routeOpenTarget(target, routing);
      expect(calls).toEqual([
        'sync',
        'resolve',
        'activate',
        'ask',
        'remember',
        ...(choice === 'current-window' ? ['open'] : ['reserve', 'create']),
      ]);
      expect(routing.rememberBehavior).toHaveBeenCalledWith(choice);
    },
  );
});

describe.each(['current-window', 'new-window', 'ask-every-time'] as const)(
  '同目录拖放保留工作区（%s）',
  (behavior) => {
    const target: OpenTarget = { kind: 'folder', path: 'D:/test/folder' };

    it('保留已打开文档的未保存正文和脏状态', async () => {
      const { routing } = setup();
      const dirtyTab = { id: 'edited', markdown: '未保存的新内容', dirty: true };
      let tabs = [dirtyTab];
      vi.mocked(routing.getBehavior).mockReturnValue(behavior);
      vi.mocked(routing.prepare).mockResolvedValue({ action: 'activate-current', target });
      // 模拟打开回调恢复旧快照，确保同目录请求不会到达这个破坏性边界。
      vi.mocked(routing.openCurrent).mockImplementation(async () => {
        tabs = [{ id: 'edited', markdown: '磁盘旧内容', dirty: false }];
      });

      await routeOpenTarget(target, routing);

      expect(routing.activateCurrent).toHaveBeenCalledOnce();
      expect(routing.openCurrent).not.toHaveBeenCalled();
      expect(routing.requestChoice).not.toHaveBeenCalled();
      expect(routing.createWindow).not.toHaveBeenCalled();
      expect(tabs[0]).toBe(dirtyTab);
      expect(tabs[0]).toMatchObject({ markdown: '未保存的新内容', dirty: true });
    });

    it('保留尚未持久化的新建标签和当前活动标签', async () => {
      const { routing } = setup();
      const savedTab = { id: 'saved', nativePath: 'D:/test/folder/a.md', markdown: '已有文档' };
      const newTab = { id: 'new', nativePath: null, markdown: '新建文档内容' };
      const currentTabs = [savedTab, newTab];
      let tabs = currentTabs;
      let activeTabId = newTab.id;
      vi.mocked(routing.getBehavior).mockReturnValue(behavior);
      vi.mocked(routing.prepare).mockResolvedValue({ action: 'activate-current', target });
      vi.mocked(routing.openCurrent).mockImplementation(async () => {
        tabs = [savedTab];
        activeTabId = savedTab.id;
      });

      await routeOpenTarget(target, routing);

      expect(routing.activateCurrent).toHaveBeenCalledOnce();
      expect(routing.openCurrent).not.toHaveBeenCalled();
      expect(tabs).toBe(currentTabs);
      expect(tabs[1]).toBe(newTab);
      expect(activeTabId).toBe(newTab.id);
    });
  },
);

it('混合批次先定位当前窗口已打开文件，再处理剩余文件', async () => {
  const { routing, calls } = setup();
  const current: OpenTarget = { kind: 'documents', paths: ['D:/notes/b.md'] };
  const remaining: OpenTarget = { kind: 'documents', paths: ['D:/other/c.md'] };
  const batch: OpenTarget = { kind: 'documents', paths: ['D:/notes/b.md', 'D:/other/c.md'] };
  vi.mocked(routing.prepare).mockImplementation(async (target, create) => {
    calls.push(create ? 'reserve' : 'resolve');
    if (target === batch)
      return { action: 'activate-current', target: current, remainingTarget: remaining };
    return create
      ? { action: 'create-window', windowLabel: 'window-other', target }
      : { action: 'open-current', target };
  });
  await routeOpenTarget(batch, routing);
  expect(calls).toEqual([
    'sync',
    'resolve',
    'activate',
    'open',
    'sync',
    'resolve',
    'reserve',
    'create',
  ]);
  expect(routing.openCurrent).toHaveBeenCalledTimes(1);
  expect(routing.openCurrent).toHaveBeenCalledWith(current);
  expect(routing.createWindow).toHaveBeenCalledWith('window-other');
});


const directoryCandidate = {
  windowLabel: 'notes-window',
  folderPath: 'D:/notes',
  paths: ['D:/notes/b.md'],
};

it.each(['current-window', 'new-window'] as const)('目录候选不覆盖 %s 偏好', async (behavior) => {
  const { routing } = setup();
  const target: OpenTarget = { kind: 'documents', paths: directoryCandidate.paths };
  routing.openDirectory = vi.fn();
  vi.mocked(routing.getBehavior).mockReturnValue(behavior);
  vi.mocked(routing.prepare).mockImplementation(async (value, create) => create
    ? { action: 'create-window', target: value, windowLabel: 'new-window' }
    : { action: 'open-current', target: value, directoryWindows: [directoryCandidate] });
  await routeOpenTarget(target, routing);
  expect(routing.openDirectory).not.toHaveBeenCalled();
  expect(routing.requestChoice).not.toHaveBeenCalled();
  if (behavior === 'current-window') {
    expect(routing.openCurrent).toHaveBeenCalledWith(target);
    expect(routing.createWindow).not.toHaveBeenCalled();
  } else {
    expect(routing.createWindow).toHaveBeenCalledWith('new-window');
    expect(routing.openCurrent).not.toHaveBeenCalled();
  }
});

it('询问时传入目录候选，用户显式选择后才交给目录窗口', async () => {
  const { routing } = setup();
  const target: OpenTarget = { kind: 'documents', paths: directoryCandidate.paths };
  routing.openDirectory = vi.fn();
  vi.mocked(routing.getBehavior).mockReturnValue('ask-every-time');
  vi.mocked(routing.prepare).mockResolvedValue({
    action: 'open-current', target, directoryWindows: [directoryCandidate],
  });
  vi.mocked(routing.requestChoice).mockResolvedValue({
    choice: 'directory-window', windowLabel: directoryCandidate.windowLabel, remember: false,
  });
  await routeOpenTarget(target, routing);
  expect(routing.requestChoice).toHaveBeenCalledWith(target, [directoryCandidate]);
  expect(routing.openDirectory).toHaveBeenCalledTimes(1);
  expect(routing.openDirectory).toHaveBeenCalledWith(directoryCandidate);
  expect(routing.openCurrent).not.toHaveBeenCalled();
  expect(routing.createWindow).not.toHaveBeenCalled();
  expect(routing.rememberBehavior).not.toHaveBeenCalled();
});


describe('文档拖放固定接收窗口', () => {
  it.each(['new-window', 'ask-every-time'] as const)('忽略 %s 偏好且不修改偏好', async (behavior) => {
    const { routing } = setup();
    const target: OpenTarget = { kind: 'documents', paths: ['D:/notes/a.md', 'E:/other/b.json'] };
    vi.mocked(routing.getBehavior).mockReturnValue(behavior);
    await routeOpenTarget(target, routing, true);
    expect(routing.prepare).toHaveBeenCalledTimes(1);
    expect(routing.prepare).toHaveBeenCalledWith(target, false);
    expect(routing.openCurrent).toHaveBeenCalledWith(target);
    expect(routing.getBehavior).not.toHaveBeenCalled();
    expect(routing.requestChoice).not.toHaveBeenCalled();
    expect(routing.createWindow).not.toHaveBeenCalled();
    expect(routing.rememberBehavior).not.toHaveBeenCalled();
  });

  it('当前已有文件定位后，剩余文件仍在接收窗口打开', async () => {
    const { routing } = setup();
    const existing: OpenTarget = { kind: 'documents', paths: ['a.md'] };
    const remaining: OpenTarget = { kind: 'documents', paths: ['b.md'] };
    const target: OpenTarget = { kind: 'documents', paths: ['a.md', 'b.md'] };
    vi.mocked(routing.prepare)
      .mockResolvedValueOnce({ action: 'activate-current', target: existing, remainingTarget: remaining })
      .mockResolvedValueOnce({ action: 'open-current', target: remaining });
    await routeOpenTarget(target, routing, true);
    expect(vi.mocked(routing.openCurrent).mock.calls).toEqual([[existing], [remaining]]);
    expect(routing.getBehavior).not.toHaveBeenCalled();
    expect(routing.createWindow).not.toHaveBeenCalled();
  });

  it('已由其他窗口去重处理的文件不在接收窗口重复打开', async () => {
    const { routing } = setup();
    vi.mocked(routing.prepare).mockResolvedValue({ action: 'handled' });
    await routeOpenTarget({ kind: 'documents', paths: ['a.md'] }, routing, true);
    expect(routing.openCurrent).not.toHaveBeenCalled();
    expect(routing.createWindow).not.toHaveBeenCalled();
  });
});
