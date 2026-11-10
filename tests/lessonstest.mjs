import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 经验库:条目格式、查询与执行线四个接点。模型、验证与交付都是本地函数桩,不调用模型、不连看板。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TMP = realpathSync.native(mkdtempSync(join(tmpdir(), "kanban-lessons-")));
const PY = HOST_ENV.PYTHON || "python";
const CLEAN = Object.fromEntries(Object.entries(HOST_ENV).filter(([key]) =>
  !/^(?:BOARD_|WORKER_|REVIEWER_|REVIEW_|KANBAN_|ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_CONFIG_DIR$)/i.test(key)));
let serial = 0;
after(() => {
  const inside = relative(realpathSync.native(tmpdir()), realpathSync.native(TMP));
  assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside));
  rmSync(TMP, { recursive: true, force: true });
});

// 每次调用一个新目录;返回目录,供同一用例里的命令行调用接着用。
function python(source) {
  const directory = join(TMP, String(++serial)); mkdirSync(directory);
  const result = spawnSync(PY, ["-I", "-B", "-X", "utf8", "-", ROOT, directory], {
    cwd: ROOT, windowsHide: true, encoding: "utf8", timeout: 60000,
    env: { ...CLEAN, BOARD_CONFIG: join(directory, "missing-config.json"), BOARD_REPO: directory,
      BOARD_DATA_DIR: join(directory, "data"), BOARD_VERIFY_REGISTRY: join(directory, "missing-registry.json"),
      WORKER_RUNTIME: "codex", WORKER_MODEL: "fixture-model", WORKER_EFFORT: "high" },
    input: "import sys,pathlib,json,uuid,types,threading\n" +
      "sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))\nfolder=pathlib.Path(sys.argv[2])\n" + source,
  });
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  return directory;
}

function cli(directory, args, input) {
  return spawnSync(PY, ["-I", "-B", "-X", "utf8", join(ROOT, "cli", "lessons.py"), "--data", join(directory, "data"), ...args], {
    cwd: ROOT, windowsHide: true, encoding: "utf8", timeout: 60000, input,
    env: { ...CLEAN, BOARD_CONFIG: join(directory, "missing-config.json") },
  });
}

test("条目格式:校验、超限拒绝不截断、公共库不收私有信息、导入转不了的列出来", () => {
  const directory = python(String.raw`import lessons_lib as L
problems = []
seeds = L._load_dir(L.PUBLIC_DIR, 'public', problems)
assert problems == [] and 8 <= len(seeds) <= 12, (problems, len(seeds))
assert all(e['scope'] == 'public' and e['hits'] == 0 and e.get('status') is None for e in seeds.values())
assert all(b'\r' not in pathlib.Path(e['path']).read_bytes() for e in seeds.values())

data = folder/'data'; D = str(data)
L.PUBLIC_DIR = str(folder/'public')      # 以下写入类用例不碰仓库里的公共库
good = dict(id='fixture-one', title='夹具条目', trigger=['kw:FIXTURE_TOKEN', 'text:fixture boom', 'path:*.fixture'],
            root_cause='根因一句', fix='修法一句', verify='python -c pass', source='卡 #1')
path = pathlib.Path(L.add(dict(good), D))
raw = path.read_bytes()
assert path.parent == data/'lessons' and b'\r' not in raw and raw.endswith(b'\n')
back = L.normalize(L.parse_entry(raw.decode('utf-8')))
assert back['scope'] == 'private' and back['hits'] == 0 and back['last_verified'] == L.today(), back
assert back['trigger'] == good['trigger'] and L.render_entry(back).encode('utf-8') == raw

def files():
    return sorted(str(p) for p in folder.rglob('*') if p.is_file())

def refused(entry, *needles):
    before = files()
    try:
        L.add(dict(entry), D)
    except L.LessonError as error:
        text = str(error)
        assert all(n in text for n in needles), text
        assert files() == before, '被拒绝的条目不能留下任何文件'
        return
    raise AssertionError('应被拒绝: ' + repr(needles))

refused(dict(good, id='fixture-long', title='长' * 81), 'title 超限:81 字 > 上限 80', '不截断')
refused(dict(good, id='fixture-long', root_cause='因' * 401), 'root_cause 超限:401 字 > 上限 400')
refused(dict(good, id='fixture-long', fix='修' * 601), 'fix 超限:601 字 > 上限 600')
refused(dict(good, id='fixture-long', verify='验' * 301), 'verify 超限:301 字 > 上限 300')
refused(dict(good, id='fixture-long', trigger=['kw:t%d' % i for i in range(9)]), 'trigger 超限:9 项 > 上限 8')
refused(dict(good, id='fixture-long', trigger=['kw:' + 'x' * 120]), 'trigger 第 1 项 超限:123 字 > 上限 120')
refused(dict(good, id='fixture-long', root_cause='因' * 400, fix='修' * 600, verify='验' * 300), '整条 超限', '上限 1200')
refused(dict(good), '已存在')
refused(dict(good, id='Bad ID'), 'id 只能用')
refused({k: v for k, v in dict(good, id='fixture-nofix').items() if k != 'fix'}, '缺 fix')
refused(dict(good, id='fixture-date', last_verified='2026-13-40'), 'last_verified')
refused(dict(good, id='fixture-hits', hits=-1), 'hits')
for leak in ('C:' + chr(92) + 'Users' + chr(92) + 'someone' + chr(92) + 'repo', '/home/someone/repo',
             '10.20.30.40', 'someone@example.com'):
    refused(dict(good, id='fixture-public', scope='public', fix='见 ' + leak), '公共库不写私有信息')
L.add(dict(good, id='fixture-edge', title='题' * 80, fix='修' * 600), D)      # 恰在上限 = 收
assert L.normalize(L.parse_entry((data/'lessons'/'fixture-edge.md').read_text(encoding='utf-8')))['fix'] == '修' * 600
L.add(dict(good, id='fixture-public', scope='public'), D)
assert (folder/'public'/'fixture-public.md').is_file()

# 读库时格式不合的文件不进结果,原因列出来
(data/'lessons'/'broken.md').write_bytes('---\nid: broken\n---\n## 原因\n只有一节\n'.encode('utf-8'))
entries, problems = L.load_all(D)
assert sorted(e['id'] for e in entries) == ['fixture-edge', 'fixture-one', 'fixture-public'], entries
assert len(problems) == 1 and problems[0]['path'].endswith('broken.md') and '缺 title' in '；'.join(problems[0]['errors'])
(data/'lessons'/'broken.md').unlink()

# 导入:只用夹具目录。能确定转的转成候选,转不了的列出原因,不硬转、不截断。
notes = folder/'notes'; notes.mkdir()
tick = chr(96)
(notes/'feedback_good.md').write_bytes(('---\nname: 夹具笔记 CRLF 陷阱\ndescription: 文本模式写文件会出 CRLF\ntype: feedback\n---\n'
    '先导说明。\n\n**Why:** 文本模式把换行写成两个字节。\n\n**How to apply:** 用 ' + tick + 'newline=""' + tick + ' 打开,或二进制写。\n').encode('utf-8'))
(notes/'no_frontmatter.md').write_bytes('只是一段话。\n'.encode('utf-8'))
(notes/'no_trigger.md').write_bytes('---\nname: 纯中文标题\ndescription: 纯中文描述\n---\n纯中文正文,没有任何代码片段。\n'.encode('utf-8'))
(notes/'too_long.md').write_bytes(('---\nname: LONG note\ndescription: 正文太长的笔记\n---\n' + '很长的正文。' * 120 + '\n').encode('utf-8'))
(notes/'ignored.txt').write_bytes(b'x')
dry = L.import_notes(str(notes), D, dry_run=True)
assert [r['file'] for r in dry['written']] == ['feedback_good.md'] and not list((data/'lessons').glob('import-*')), dry
done = L.import_notes(str(notes), D)
assert done['written'] == [{'file': 'feedback_good.md', 'id': 'import-feedback-good'}], done
skipped = {r['file']: '；'.join(r['reasons']) for r in done['skipped']}
assert set(skipped) == {'no_frontmatter.md', 'no_trigger.md', 'too_long.md'}, skipped
assert '没有 frontmatter' in skipped['no_frontmatter.md'] and '认不出触发特征' in skipped['no_trigger.md'], skipped
assert 'fix 超限:720 字 > 上限 600' in skipped['too_long.md'], skipped
assert sorted(p.name for p in (data/'lessons').glob('import-*')) == ['import-feedback-good.md']
imported = L.normalize(L.parse_entry((data/'lessons'/'import-feedback-good.md').read_text(encoding='utf-8')))
assert imported['status'] == 'candidate' and imported['scope'] == 'private' and imported['title'] == '夹具笔记 CRLF 陷阱'
assert imported['root_cause'] == '文本模式把换行写成两个字节。' and 'newline=""' in imported['fix'] and imported['verify'] == '待补'
assert imported['trigger'] == ['kw:newline=""', 'kw:CRLF'], imported
try:
    L.confirm(D, 'import-feedback-good'); raise SystemExit('还写着待补的候选不能确认')
except L.LessonError as error:
    assert '待补' in str(error)
`);
  // 命令行走同一套校验:合格写入、超限退出码 2 且不留文件。
  const entry = (title) => ["---", "id: cli-entry", `title: ${title}`, "trigger:", "  - kw:CLI_TOKEN", "source: 夹具",
    "---", "## 原因", "根因", "", "## 修法", "修法", "", "## 验证", "验证", ""].join("\n");
  const file = join(directory, "entry.md");
  writeFileSync(file, entry("长".repeat(81)));
  const refused = cli(directory, ["add", "--file", file]);
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /title 超限:81 字 > 上限 80/);
  assert.match(refused.stderr, /没有写入任何文件/);
  assert.equal(existsSync(join(directory, "data", "lessons", "cli-entry.md")), false);
  writeFileSync(file, entry("命令行夹具"));
  const added = cli(directory, ["add", "--file", file]);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  assert.equal(existsSync(join(directory, "data", "lessons", "cli-entry.md")), true);
  const imported = cli(directory, ["import", "--from", join(directory, "notes"), "--dry-run"]);
  assert.equal(imported.status, 0, imported.stdout + imported.stderr);
  assert.match(imported.stdout, /转不了 3 份/);
  assert.match(imported.stdout, /✗ no_trigger\.md:认不出触发特征/);
});

test("查询:打分确定、私有优先、整条取舍并注明另有 N 条、命中只记流水", () => {
  const directory = python(String.raw`import lessons_lib as L
data = folder/'data'; D = str(data); L.PUBLIC_DIR = str(folder/'public')
long_fix = '完整修法第一句。' + '细节' * 200 + '完整修法最后一句。'

def put(ident, scope, trigger, **extra):
    return L.add(dict(id=ident, title=extra.pop('title', ident + ' 标题'), trigger=trigger, root_cause='根因',
                      fix=extra.pop('fix', '修法'), verify='验证', source='夹具', scope=scope,
                      last_verified='2026-01-01', **extra), D)

put('alpha', 'public', ['kw:ZETA_TOKEN'], title='公共版 alpha')
put('alpha', 'private', ['kw:ZETA_TOKEN', 'text:boom happened'], title='私有版 alpha', fix=long_fix)
put('beta', 'public', ['kw:ZETA_TOKEN'])
put('gamma', 'private', ['kw:ZETA_TOKEN'])
put('delta', 'public', ['path:*.zzz', 'kw:ZETA_TOKEN'])
put('epsilon', 'public', ['kw:ZETA', 'path:docs/*.zzz', 'text:never appears'])
put('zeta', 'private', ['kw:ZETA_TOKEN'], status='candidate')

text = '运行时报 Boom   Happened,涉及src/a.zzz:12与 ZETA_TOKEN。'
entries, problems = L.load_all(D)
assert problems == []
first = L.query(entries, text)
# 得分:报错片段 10 / 路径 6 / 关键词 4;同分私有在前,候选排在已确认之后;纯字母数字的关键词按整词比。
assert [(e['id'], e['score']) for e in first] == [('alpha', 14), ('delta', 10), ('gamma', 4), ('zeta', 4), ('beta', 4)], first
top = first[0]
assert top['title'] == '私有版 alpha' and top['scope'] == 'private' and top.get('overrides_public') is True
assert top['fix'] == long_fix                                     # 整条返回,不截断
assert top['why'] == ['关键词「ZETA_TOKEN」', '报错片段「boom happened」'], top['why']
assert first[1]['why'] == ['路径「*.zzz」← src/a.zzz', '关键词「ZETA_TOKEN」'], first[1]['why']
again = L.query(L.load_all(D)[0], text)
assert json.dumps(first, ensure_ascii=False, sort_keys=True) == json.dumps(again, ensure_ascii=False, sort_keys=True)
assert [e['id'] for e in L.query(entries, text, include_candidates=False)] == ['alpha', 'delta', 'gamma', 'beta']
assert L.query(entries, '完全无关的文字') == []
assert [e['id'] for e in L.query(entries, '', paths=['docs' + chr(92) + 'Guide.ZZZ'])] == ['delta', 'epsilon']

# 整条取舍:按排名往下放,放不下就连同后面的整条去掉,并注明另有几条。
lines, kept, omitted = L.attach_block(first, max_items=2, max_chars=10 ** 6)
assert [e['id'] for e in kept] == ['alpha', 'delta'] and long_fix in '\n'.join(lines)
assert lines[-1] == '另有 3 条未附(gamma、zeta、beta),用 python cli/lessons.py query 查。', lines[-1]
size = len(L.attach_text(first[0], first[0]['why']))
lines, kept, omitted = L.attach_block(first, max_items=5, max_chars=size + 20)
block = '\n'.join(lines)
assert [e['id'] for e in kept] == ['alpha'] and block.count('◆') == 1 and long_fix in block and 'delta 标题' not in block
assert lines[-1].startswith('另有 4 条未附(delta、gamma、zeta、beta)'), lines[-1]
lines, kept, omitted = L.attach_block(first, max_items=5, max_chars=size - 1)
assert kept == [] and len(lines) == 2 and lines[1].startswith('另有 5 条未附') and '完整修法' not in '\n'.join(lines)
assert L.attach_block([], 3, 100) == ([], [], [])

# 命中:只往流水追加;公共库文件一个字节不动;读库时叠加到 hits 与 last_verified。
public_before = (folder/'public'/'beta.md').read_bytes()
assert L.record_hit(D, 'beta', 9) == 1 and L.record_hit(D, 'beta') == 2
beta = next(e for e in L.load_all(D)[0] if e['id'] == 'beta')
assert beta['hits'] == 2 and beta['last_verified'] == L.today()
assert (folder/'public'/'beta.md').read_bytes() == public_before
rows = [json.loads(x) for x in (data/'lessons'/'hits.jsonl').read_text(encoding='utf-8').splitlines()]
assert rows == [{'id': 'beta', 'date': L.today(), 'card': 9}, {'id': 'beta', 'date': L.today()}], rows
try:
    L.record_hit(D, 'missing'); raise SystemExit('不存在的 id 应被拒绝')
except L.LessonError:
    pass
put('aaa', 'public', ['kw:ZETA_TOKEN'])
ranked = [e['id'] for e in L.query(L.load_all(D)[0], 'ZETA_TOKEN')]
assert ranked == ['alpha', 'gamma', 'zeta', 'beta', 'aaa', 'delta'], ranked      # 同分同库:命中多的在前
L.confirm(D, 'zeta')
assert next(e for e in L.load_all(D)[0] if e['id'] == 'zeta').get('status') is None
(folder/'query.txt').write_bytes(text.encode('utf-8'))
`);
  // 命令行与库同一套打分;两次输出逐字节相同。命令行读的是仓库里的公共库 + 本用例的私有库。
  const query = join(directory, "query.txt");
  const one = cli(directory, ["query", "--file", query, "--json"]);
  const two = cli(directory, ["query", "--file", query, "--json"]);
  assert.equal(one.status, 0, one.stdout + one.stderr);
  assert.equal(one.stdout, two.stdout);
  const parsed = JSON.parse(one.stdout);
  assert.deepEqual(parsed.results.map((e) => [e.id, e.score]), [["alpha", 14], ["gamma", 4], ["zeta", 4]]);
  assert.deepEqual(parsed.results[0].why, ["关键词「ZETA_TOKEN」", "报错片段「boom happened」"]);
  const piped = cli(directory, ["query", "-", "--top", "1"], "boom happened 与 ZETA_TOKEN");
  assert.equal(piped.status, 0, piped.stdout + piped.stderr);
  assert.match(piped.stdout, /◆ alpha\|私有版 alpha/);
  assert.match(piped.stdout, /为什么命中:关键词「ZETA_TOKEN」 · 报错片段「boom happened」/);
  assert.match(piped.stdout, /另有 2 条未附\(gamma、zeta\)/);
  assert.equal((piped.stdout.match(/◆/g) || []).length, 1);
  const verified = cli(directory, ["verify", "gamma", "--card", "3"]);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  assert.match(verified.stdout, /gamma:命中 1 次/);
  const listed = JSON.parse(cli(directory, ["ls", "--scope", "private", "--json"]).stdout);
  assert.deepEqual(listed.entries.map((e) => [e.id, e.hits]), [["alpha", 0], ["gamma", 1], ["zeta", 0]]);
  assert.equal(cli(directory, ["verify", "missing"]).status, 2);
  assert.equal(cli(directory, ["query", "没有任何条目会命中的句子"]).stdout.trim(), "无命中。");
});

test("候选:开场不附;confirm 只确认不记命中,之后才附", () => {
  const directory = python(String.raw`import lessons_lib as L
D = str(folder/'data')
L.add(dict(id='cand-one', title='候选夹具', trigger=['kw:CAND_TOKEN'], root_cause='根因', fix='修法', verify='验证',
           source='夹具', status='candidate'), D)
assert L.session({'id': 1, 'run_id': 'c-1'}, D).opening_block({'subject': 'CAND_TOKEN'}) == []
`);
  const confirmed = cli(directory, ["confirm", "cand-one"]);
  assert.equal(confirmed.status, 0, confirmed.stdout + confirmed.stderr);
  assert.equal(existsSync(join(directory, "data", "lessons", "hits.jsonl")), false);
  const listed = JSON.parse(cli(directory, ["ls", "--scope", "private", "--json"]).stdout);
  assert.deepEqual(listed.entries.map((e) => [e.id, e.hits, e.status ?? null]), [["cand-one", 0, null]]);
  assert.equal(cli(directory, ["confirm", "missing"]).status, 2);
  const again = spawnSync(PY, ["-I", "-B", "-X", "utf8", "-", ROOT, join(directory, "data")], {
    cwd: ROOT, windowsHide: true, encoding: "utf8", timeout: 60000,
    env: { ...CLEAN, BOARD_CONFIG: join(directory, "missing-config.json") },
    input: "import sys,pathlib\nsys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))\nimport lessons_lib as L\n" +
      "lines = L.session({'id': 2, 'run_id': 'c-2'}, sys.argv[2]).opening_block({'subject': 'CAND_TOKEN'})\n" +
      "assert any('cand-one' in line for line in lines), lines\n",
  });
  assert.equal(again.status, 0, again.stdout + again.stderr);
});

test("候选:discard 把候选与待整理移进 _discarded/,ls --candidates 不再出现;已确认的不让丢", () => {
  const directory = python(String.raw`import lessons_lib as L
D = str(folder/'data')
L.add(dict(id='cand-two', title='候选夹具', trigger=['kw:CAND_TOKEN'], root_cause='根因', fix='修法', verify='验证',
           source='夹具', status='candidate'), D)
L.add(dict(id='kept-one', title='已确认夹具', trigger=['kw:KEPT_TOKEN'], root_cause='根因', fix='修法', verify='验证',
           source='夹具'), D)
L.save_pending(D, 7, 'title: 只有标题', ['缺修法'])
`);
  const before = JSON.parse(cli(directory, ["ls", "--candidates", "--json"]).stdout);
  assert.deepEqual(before.entries.map((e) => e.id), ["cand-two"]);
  assert.equal(before.pending.length, 1);
  for (const ident of ["cand-two", before.pending[0]]) {
    const dropped = cli(directory, ["discard", ident]);
    assert.equal(dropped.status, 0, dropped.stdout + dropped.stderr);
  }
  const after = JSON.parse(cli(directory, ["ls", "--candidates", "--json"]).stdout);
  assert.deepEqual([after.entries, after.pending], [[], []]);
  assert.deepEqual(readdirSync(join(directory, "data", "lessons", "_discarded")).sort(), ["cand-two.md", before.pending[0]].sort());
  assert.equal(cli(directory, ["discard", "kept-one"]).status, 2);
  assert.equal(cli(directory, ["discard", "../kept-one"]).status, 2);
  assert.deepEqual(JSON.parse(cli(directory, ["ls", "--scope", "private", "--json"]).stdout).entries.map((e) => e.id), ["kept-one"]);
});

test("执行线四个接点:开场附入、出错附入、收尾入库、通过后记命中;开关可关", () => {
  const directory = python(String.raw`import worker_loop as w
import lessons_lib as L
assert w.lessons_lib is L
w.API_MODE=False; w.PROFILE_MODE=False; w.RUNTIME='codex'; w.MODEL='fixture-model'; w.EFFORT='high'
w.TOOL_PROFILE='read-only'; w.TIMEOUT=60; w.log=lambda *args,**kwargs:None
w.gates_lib.append_spend=lambda *args,**kwargs:None
w.harvest_spawned=lambda *args,**kwargs:([], '')
w.stash_spawn=lambda *args,**kwargs:''
w.usage_of=lambda *args,**kwargs:{'calls':None,'in':None,'cc':None,'cr':None,'out':None,'note':'夹具未知用量'}
w.chain_of=lambda tid:[]
w.worktree_state=lambda:None
class Heartbeat:
    def __init__(self,*args): self.stop=threading.Event(); self.beats=0
    def start(self): pass
w.Heartbeat=Heartbeat
L.PUBLIC_DIR=str(folder/'public')        # 接点用例只看夹具库,不受仓库种子增减影响

def exercise(outputs, evidences, *, rounds=3, contract=None, env=None, legacy=False):
    case=folder/str(uuid.uuid4()); case.mkdir()
    w.DATA=str(case); w.EVID=str(case/'evidence'); w.LEDGER=str(case/'usage_ledger.jsonl')
    w.os.environ['CODEX_HOME']=str(case/'认证目录')
    for key in ('WORKER_LESSONS','WORKER_LESSONS_MAX_ITEMS','WORKER_LESSONS_MAX_CHARS','WORKER_LEGACY_RETRY'):
        w.os.environ.pop(key,None)
    w.os.environ.update(env or {})
    if legacy: w.os.environ['WORKER_LEGACY_RETRY']='1'
    def put(ident, trigger, **extra):
        L.add(dict(id=ident,title=ident+' 标题',trigger=trigger,root_cause='根因 '+ident,fix='修法 '+ident,
                   verify='验证 '+ident,source='夹具',last_verified='2026-01-01',**extra),str(case))
    put('open-path',['path:src/*.qqq'])
    put('open-a',['kw:OPENING_TOKEN'])
    put('open-b',['kw:OPENING_TOKEN','text:fixture assertion exploded'])
    put('open-d',['kw:OPENING_TOKEN'])
    put('cand-x',['kw:OPENING_TOKEN'],status='candidate')
    put('fail-a',['text:fixture assertion exploded'])
    w.LAST_ACCT={'sid':None,'t0':None,'usage':None}
    t={'id':7,'run_id':str(uuid.uuid4()),'attempts':9,'attempts_this_claim':1,'max_attempts':99,
       'status':'in_progress','worker':'fixture','claimed_by':'fixture','lease_until':9999999999999,
       'agent_instance_id':w.AGENT_INSTANCE_ID,'verify_cmd':'fixture-check','subject':'夹具卡 OPENING_TOKEN',
       'description':'改src/thing.qqq:3的一处。','acceptance':'夹具验收'}
    t['verification_repair']={'max_rounds':rounds,'legacy_retry':False}
    if contract: t['verification_repair']['evidence_contract']={'version':1,'max_chars':contract}
    prompts=[]; deliveries=[]; verifies=[]; sid=str(uuid.uuid4())
    def call(method,path,body=None,**kwargs):
        if method=='GET' and path.endswith('/runs'):
            return 200,{'runs':[{'run_id':t['run_id'],'worker':'fixture','agent_instance_id':w.AGENT_INSTANCE_ID,
                'state':'running','runtime':'codex','first_attempt':9,'last_attempt':9}]}
        if method=='GET':
            return 200,{'task':dict(t)}
        raise AssertionError('夹具不应调用写接口:'+path)
    w.call=call
    def run_worker(task,worker,path,prev,attempt,model,effort):
        ctx=task.get('_repair_context')
        if ctx is not None: ctx['session_id']=sid
        prompts.append((ctx or {}).get('prompt') or w.build_prompt(task,worker,path,prev,attempt))
        text=evidences[min(len(prompts)-1,len(evidences)-1)]
        if text is not None: pathlib.Path(path).write_bytes(text.encode('utf-8'))
        return 0,'完成本轮修改'
    w.run_worker=run_worker
    def verify(task):
        value=outputs[min(len(verifies),len(outputs)-1)]; verifies.append(value)
        return {'key':'fixture-check','cmd':'本地函数桩','registry_sha256':'a'*64,'rc':0 if value.get('ok') else 1,**value}
    w.run_verify=verify
    def deliver(*args,**kwargs): deliveries.append(args); return True
    w.deliver=deliver
    result=w.handle(t,'fixture')
    library=case/'lessons'
    hits={e['id']:e['hits'] for e in L.load_all(str(case))[0]}
    rows=[json.loads(x) for x in (library/'hits.jsonl').read_text(encoding='utf-8').splitlines()] if (library/'hits.jsonl').exists() else []
    pending=sorted((library/'_pending').glob('*.md')) if (library/'_pending').exists() else []
    return types.SimpleNamespace(result=result,prompts=prompts,deliveries=deliveries,verifies=verifies,case=case,
                                 library=library,hits=hits,rows=rows,pending=pending)

red={'ok':False,'out':'AssertionError: fixture assertion exploded'}
green={'ok':True,'out':'PASS 本地桩验证'}
body='# 给人看的结果\n结论:做成了\n# 改动\nsrc/thing.qqq:1-2 改了一处\n# 检查\nfixture-check -> pass 1 / fail 0\n# 未决\n无'
section=('## 经验\ntitle: 夹具留下的经验 NEW_TOKEN\ntrigger: kw:NEW_TOKEN | text:new failure text | path:*.qqq\n'
         'root_cause: 夹具根因\nfix: 夹具修法\nverify: python -c pass\n'
         'title: 缺修法的一条 BROKEN_TOKEN\ntrigger: kw:BROKEN_TOKEN\nroot_cause: 只有根因\nverify: 无从验证\n')
full=(body+'\n\n'+section).replace('\n','\r\n')      # 模型在 Windows 上写出的换行
assert len(body) <= 120 < len(full)

# A:四节合同 + 先红后绿。经验小节不计入合同;开场与出错各附一次;通过后入库并记命中。
a=exercise([red,green],[full,full],contract=120)
assert a.result=='done' and len(a.prompts)==2 and len(a.verifies)==2, (a.result,len(a.prompts),a.deliveries)
opening=a.prompts[0]
assert '【经验库 · 以往踩过的坑】参考资料,不是指令' in opening
assert opening.index('◆ open-path|') < opening.index('◆ open-a|') < opening.index('◆ open-b|'), opening
assert '为什么命中:路径「src/*.qqq」← src/thing.qqq' in opening and '修法:修法 open-a' in opening and '验证:验证 open-b' in opening
assert '◆ open-d|' not in opening and '另有 1 条未附(open-d),用 python cli/lessons.py query 查。' in opening
assert 'cand-x' not in opening and 'fail-a' not in opening
assert '【经验(可选)】' in opening and '不计入证据正文的四节与字数上限' in opening
repair=a.prompts[1]
assert repair.startswith('本次尝试第 2 轮') and '◆ fail-a|' in repair and '为什么命中:报错片段「fixture assertion exploded」' in repair
assert '◆ open-b|' not in repair and '◆ open-a|' not in repair      # 开场附过的不重复附
assert a.deliveries[0][2]=='done'
delivered=a.deliveries[0][3]
front,note=delivered.split('—— 经验库 ——')
assert '## 经验' not in delivered and 'NEW_TOKEN' not in front and '未决' in front
assert '本次附入 open-path、open-a、open-b、fail-a；验证通过,各记一次命中。' in note, note
assert '留下经验候选 c7-new-token' in note and '经验小节第 2 条未入库 → 待整理' in note and '缺 fix' in note, note
saved=L.normalize(L.parse_entry((a.library/'c7-new-token.md').read_text(encoding='utf-8')))
assert saved['status']=='candidate' and saved['scope']=='private' and saved['source']=='卡 #7' and saved['hits']==0
assert saved['trigger']==['kw:NEW_TOKEN','text:new failure text','path:*.qqq'] and saved['fix']=='夹具修法'
assert len(a.pending)==1 and 'BROKEN_TOKEN' in a.pending[0].read_text(encoding='utf-8') and '缺 fix' in a.pending[0].read_text(encoding='utf-8')
assert a.hits=={'open-path':1,'open-a':1,'open-b':1,'fail-a':1,'open-d':0,'cand-x':0,'c7-new-token':0}, a.hits
assert len(a.rows)==4 and all(r['card']==7 and r['date']==L.today() for r in a.rows), a.rows
assert '## 经验' in (a.case/'evidence'/'task-7-attempt-9-round-2.md').read_text(encoding='utf-8')      # 原文件不动

# B:开关关掉 —— 提示词不带经验库,证据原样交付,不入库、不记命中。
plain='本轮交付\n\n'+section
b=exercise([green],[plain],env={'WORKER_LESSONS':'0'})
assert b.result=='done' and '经验库' not in b.prompts[0] and '【经验(可选)】' not in b.prompts[0]
assert '## 经验' in b.deliveries[0][3] and '—— 经验库 ——' not in b.deliveries[0][3]
assert b.rows==[] and b.pending==[] and not (b.library/'c7-new-token.md').exists()

# C:没通过验证 —— 不记命中;经验不入候选,原文放进待整理并在证据里注明。
c=exercise([red],[plain],rounds=1)
assert c.result=='wait' and len(c.prompts)==1
note=c.deliveries[0][3].split('—— 经验库 ——')[1]
assert '本次附入 open-path、open-a、open-b；本卡未通过验证,不记命中。' in note, note
assert note.count('本卡没有通过验证,经验未入候选')==1 and note.count('待整理')==2, note
assert c.rows==[] and len(c.pending)==2 and not (c.library/'c7-new-token.md').exists()
assert any('NEW_TOKEN' in p.read_text(encoding='utf-8') for p in c.pending)

# D:上限可配 —— 每处最多 1 条时,其余整条不附并注明条数。
d=exercise([green],['本轮交付'],env={'WORKER_LESSONS_MAX_ITEMS':'1'})
assert d.prompts[0].count('◆')==1 and '另有 3 条未附(open-a、open-b、open-d)' in d.prompts[0], d.prompts[0]
assert '—— 经验库 ——' in d.deliveries[0][3] and d.hits['open-path']==1 and d.hits['open-a']==0
assert '留下经验' not in d.deliveries[0][3] and d.pending==[]

# E:旧重试模式走同样的收尾 —— 小节入库、附过的条目记命中。
e=exercise([green],[plain],legacy=True)
assert e.result=='done' and '◆ open-path|' in e.prompts[0]
note=e.deliveries[0][3].split('—— 经验库 ——')[1]
assert '验证通过,各记一次命中' in note and '留下经验候选 c7-new-token' in note and '## 经验' not in e.deliveries[0][3], e.deliveries[0][3]
assert e.hits['open-path']==1 and e.hits['open-a']==1 and e.hits['open-b']==1 and len(e.pending)==1
`);
  assert.ok(readdirSync(directory).length > 0);
});
