// 使用宿主的 React、任务面板和动作中继；不启动服务、不读取私有 store。
const drafts = new Map();
const activeRequests = new Set();

function makePanel(host) {
  const h = host.jsx;
  return function AcceptancePanel({ taskId, sessionId, presentation }) {
    const { useState, useEffect, useRef } = host.React;
    const [view, setView] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [confirmed, setConfirmed] = useState(false);
    const [draft, setDraft] = useState(() => drafts.get(taskId) || { result: '', implementation: sessionId || '', review: '', reason: '' });
    const currentTask = useRef(taskId);
    const generation = useRef(0);
    const mounted = useRef(false);
    const requests = useRef(new Set());
    const [coarse, setCoarse] = useState(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
    const touch = presentation === 'mobile' || coarse;
    const controlStyle = { height: touch ? 48 : 28, minHeight: touch ? 48 : 28, fontSize: touch ? 16 : 14 };
    const fieldStyle = { ...controlStyle, width: '100%', border: '1px solid var(--border)', borderRadius: 6, padding: '0 8px', background: 'var(--background)', color: 'inherit' };

    const edit = (key, value) => {
      const next = { ...draft, [key]: value };
      drafts.set(taskId, next);
      setDraft(next);
      setConfirmed(false);
    };

    const run = async (key, body = {}, initial = false) => {
      const controller = new AbortController();
      activeRequests.add(controller);
      requests.current.add(controller);
      const request = ++generation.current;
      setBusy(true);
      setError('');
      try {
        const candidate = view?.candidate;
        const envelope = { taskId, body };
        if (key === 'submit' || key === 'approve') {
          envelope.repositoryId = view.repository_id;
          envelope.sessionId = key === 'approve' ? candidate.implementation_session_id : draft.implementation;
        }
        const result = await host.api.invokeAction(key, envelope, { signal: controller.signal });
        if (!mounted.current || currentTask.current !== taskId || request !== generation.current) return;
        setView(result);
        if (initial && result.candidate?.task?.result && !drafts.get(taskId)?.result) {
          const next = { ...draft, result: result.candidate.task.result, implementation: result.candidate.implementation_session_id, review: result.candidate.review_session_id };
          drafts.set(taskId, next); setDraft(next);
        }
        setConfirmed(false);
      } catch (failure) {
        if (!controller.signal.aborted && mounted.current && currentTask.current === taskId && request === generation.current) {
          setError(failure?.message || '验收操作失败，任务保持阻塞。请刷新后重试。');
        }
      } finally {
        activeRequests.delete(controller);
        requests.current.delete(controller);
        if (mounted.current && currentTask.current === taskId && request === generation.current) setBusy(false);
      }
    };

    useEffect(() => {
      mounted.current = true;
      currentTask.current = taskId;
      setView(null); setError(''); setConfirmed(false);
      setDraft(drafts.get(taskId) || { result: '', implementation: sessionId || '', review: '', reason: '' });
      void run('status', {}, true);
      return () => { mounted.current = false; ++generation.current; for (const request of requests.current) request.abort(); requests.current.clear(); };
    }, [taskId]);
    useEffect(() => {
      if (typeof matchMedia !== 'function') return;
      const query = matchMedia('(pointer: coarse)');
      const update = () => setCoarse(query.matches);
      query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
    }, []);

    const candidate = view?.candidate;
    const sessionOptions = (view?.sessions || []).map(s => h('option', { key: s.id, value: s.id }, `${s.profile_name || s.model || s.profile_id} · ${s.id.slice(0, 8)} · ${s.state}`));
    const select = (key, label) => h('label', { style: { display: 'grid', gap: 6 } }, label,
      h('select', { 'data-testid': `fleet-${key}`, value: draft[key], onChange: e => edit(key, e.target.value), style: fieldStyle }, h('option', { value: '' }, '请选择会话'), ...sessionOptions));
    const button = (id, label, onClick, disabled, variant = 'outline') => h(host.ui.Button, { 'data-testid': id, type: 'button', onClick, disabled: busy || disabled, variant, style: controlStyle }, label);
    const states = { checking: '正在检查', pending: '等待人工验收', approval_intent: '验收决定待确认', approved: '已记录人工通过', blocked: '交付检查未通过', rejected: '已驳回，需重新提交' };

    return h('section', { 'data-testid': 'fleet-acceptance-panel', style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
      h('header', { style: { padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 } },
        h('h2', { style: { fontWeight: 600 } }, '交付验收'),
        h('p', { role: 'status', 'data-testid': 'fleet-state', style: { fontSize: 13 } }, candidate ? states[candidate.state] || '状态不可测' : '尚无验收候选')),
      h('div', { style: { minHeight: 0, flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: 16, display: 'flex', flexDirection: 'column', gap: 16, overflowWrap: 'anywhere' } },
        error && h('p', { role: 'alert', 'data-testid': 'fleet-error', style: { color: 'var(--destructive)' } }, error),
        h('p', { style: { fontSize: 13 } }, '先完成方案和 Codex 独立审查，再手动移至人工验收。通过记录不免除 Done 时的实时复核。'),
        h('label', { style: { display: 'grid', gap: 6 } }, '交付说明（点名已提交的产物路径）',
          h('textarea', { 'data-testid': 'fleet-result', value: draft.result, onChange: e => edit('result', e.target.value), rows: 4, style: { ...fieldStyle, height: 'auto', minHeight: 96, padding: 8, resize: 'vertical' } })),
        select('implementation', 'Claude 实现会话'), select('review', 'Codex 审查会话'),
        candidate?.check?.head && h('div', { 'data-testid': 'fleet-candidate', style: { fontSize: 13 } },
          h('p', null, `候选提交：${candidate.check.head}`),
          h('p', null, `候选编号：${candidate.id}`),
          h('ul', null, ...(candidate.check.artifacts || []).map(a => h('li', { key: a.path }, `${a.path} · ${a.sha256 || '文件不存在'}`)))),
        ...(candidate?.check?.violations || []).map((v, i) => h('p', { key: i, role: 'alert' }, v.message)),
        candidate?.reason && h('p', null, `驳回原因：${candidate.reason}`),
        h('label', { 'data-testid': 'fleet-confirm-label', style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: touch ? 48 : 28 } },
          h('input', { 'data-testid': 'fleet-confirm', type: 'checkbox', checked: confirmed, onChange: e => setConfirmed(e.target.checked) }),
          '我已核对独立审查与此候选提交的交付物'),
        h('label', { style: { display: 'grid', gap: 6 } }, '驳回原因', h('textarea', { 'data-testid': 'fleet-reason', value: draft.reason, onChange: e => edit('reason', e.target.value), rows: 2, style: { ...fieldStyle, height: 'auto', minHeight: 64, padding: 8 } })),
        h('details', null, h('summary', null, '原生门禁记录'), ...(view?.gate?.criteria || []).map(c => h('div', { key: c.id, style: { paddingTop: 8 } }, h('p', null, c.description), c.receipt && h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 } }, c.receipt))))),
      h('footer', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, padding: '12px 16px', paddingBottom: 'max(12px, env(safe-area-inset-bottom))', borderTop: '1px solid var(--border)', flexShrink: 0 } },
        button('fleet-refresh', '刷新', () => run('status'), false),
        button('fleet-submit', '检查并提交', () => run('submit', { result: draft.result, review_session_id: draft.review }), !view || !draft.result.trim() || !draft.implementation || !draft.review),
        button('fleet-approve', '人工通过', () => run('approve', { candidate_id: candidate.id, confirm: true }), !confirmed || !candidate || !['pending', 'approval_intent'].includes(candidate.state), 'default'),
        button('fleet-reject', '驳回', () => run('reject', { reason: draft.reason }), !view || !draft.reason.trim())));
  };
}

window.registerKandevPlugin('kandev-plugin-fleet-acceptance', {
  initialize(registry, host) {
    registry.registerTaskPanel({ id: 'fleet-acceptance', title: '交付验收', icon: 'puzzle', mobileEnabled: true, Component: makePanel(host) });
  },
  destroy() {
    for (const controller of activeRequests) controller.abort();
    activeRequests.clear(); drafts.clear();
  },
});
