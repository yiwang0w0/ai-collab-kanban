// 设置页协作区(待你批准、执行者、锁表、交接、流水、批准令牌)的面板测试。
// 被测的是 core/panel.html 里两段:coord-copy(文案与纯函数)和 coord-view(画节点、两押、强制释放)。
// 节点模拟沿用 tests/panelsidetest.mjs 的做法:只造这一段实际用到的节点操作,不装浏览器。
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../core/panel.html", import.meta.url), "utf8");

function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `未找到面板测试边界：${start}`);
  return source.slice(a, b);
}
function declaration(name) {
  const a = source.indexOf(`function ${name}(`), b = source.indexOf("\n}", a);
  assert.ok(a >= 0 && b > a, `未找到面板函数：${name}`);
  return source.slice(a, b + 2);
}
const VIEW = section("// ── coord-view(tests/panelcoordtest.mjs)──", "// ── /coord-view ──");

const T0 = Date.parse("2026-11-10T06:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function fixture() {
  let clock = T0;
  const document = { activeElement: null, addEventListener() {} };
  const key = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.parent = null;
      this.hidden = false; this.disabled = false; this.value = ""; this.className = ""; this.id = "";
      this.text = ""; this.replacements = 0; this.style = {}; this.offsetWidth = 0;
      this.classList = {
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter((n) => !names.includes(n)).join(" "); },
        contains: (name) => this.className.split(/\s+/).includes(name),
      };
    }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map((e) => e.textContent ?? String(e)).join(""); }
    adopt(nodes) { for (const n of nodes) if (n instanceof Element) n.parent = this; }
    append(...nodes) { this.children.push(...nodes); this.adopt(nodes); }
    replaceChildren(...nodes) { this.replacements++; this.text = ""; for (const c of this.children) if (c instanceof Element) c.parent = null; this.children = nodes; this.adopt(nodes); }
    remove() { const list = this.parent?.children; if (list) list.splice(list.indexOf(this), 1); this.parent = null; }
    get isConnected() { for (let n = this; n; n = n.parent) if (n === root) return true; return false; }
    // 图标是固定标记,不带文案:这里只记下有没有插过。
    insertAdjacentHTML(_where, html) { this.icons = (this.icons || 0) + (/^<svg class="ic"/.test(html) ? 1 : 0); }
    addEventListener() {}
    setAttribute(name, value) {
      if (name === "id") this.id = String(value);
      else if (name.startsWith("data-")) this.dataset[key(name.slice(5))] = String(value);
      else this[name] = String(value);
    }
    focus() { document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = null; }
    scrollIntoView() {}
    contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
    closest(selector) { for (let n = this; n; n = n.parent) if (n.matches(selector)) return n; return null; }
    // 一段复合选择器:标签、#id、.类、[data-x]、[data-x="v"]。
    matchesOne(selector) {
      // 鼠标点出来的焦点不带焦点环:用例给节点标 mouseFocus 来造这种焦点。
      if (selector === ":focus-visible") return document.activeElement === this && !this.mouseFocus;
      const id =selector.match(/#([\w-]+)/)?.[1];
      if (id && this.id !== id) return false;
      const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
      for (const [, name, , value] of selector.matchAll(/\[data-([\w-]+)(?:=(["'])(.*?)\2)?\]/g))
        if (!(key(name) in this.dataset) || (value !== undefined && this.dataset[key(name)] !== value)) return false;
      return true;
    }
    // 逗号并列;空格 = 后代。
    matches(selector) {
      return selector.split(",").some((alt) => {
        const parts = alt.trim().split(/\s+/);
        if (!this.matchesOne(parts.pop())) return false;
        let up = this.parent;
        while (parts.length) {
          const want = parts.pop();
          while (up && !up.matchesOne(want)) up = up.parent;
          if (!up) return false;
          up = up.parent;
        }
        return true;
      });
    }
    querySelectorAll(selector) {
      const found = [];
      for (const child of this.children) if (child instanceof Element) {
        if (child.matches(selector)) found.push(child);
        found.push(...child.querySelectorAll(selector));
      }
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  document.createElement = (tag) => new Element(tag);
  const root = new Element("div"); root.id = "root";
  for (const [tag, id] of [["div", "approvals"], ["div", "coord"], ["p", "apt-remote"], ["div", "apt-list"]]) {
    const node = new Element(tag); node.id = id; node.className = tag === "div" && id !== "apt-list" ? "coord" : ""; root.append(node);
  }
  document.body = root;
  document.getElementById = (id) => root.querySelector("#" + id);
  document.querySelector = (selector) => root.querySelector(selector);
  document.querySelectorAll = (selector) => root.querySelectorAll(selector);
  const posts = [], gets = [], timers = [], alerts = [];
  // 服务端现在的锁表:默认就是面板手上那一份;用例要造「面板那份已经旧了」时单独给。读失败时给一句原因。
  let refreshes = 0, postFails = null, serverLocks = null, getFails = null;
  const context = vm.createContext({
    document, now: () => clock, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    alert: (text) => alerts.push(String(text)), REDUCED: { matches: true },
    icon: (name) => `<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`,
    localTime: (value) => String(value).slice(5, 16).replace("T", " "), lineLabel: (line) => "线·" + line,
    // 请求体是被测代码在 vm 里造的对象:转成本侧的普通对象再记,好做深比较。
    post: async (url, body) => { posts.push({ url, body: JSON.parse(JSON.stringify(body)) }); if (postFails) throw typeof postFails === "string" ? new Error(postFails) : postFails; return {}; },
    homeGet: async (path) => {
      gets.push(path);
      if (path === "/api/coord/locks") {
        if (getFails) throw new Error(getFails);
        return { locks: JSON.parse(JSON.stringify(serverLocks ?? JSON.parse(context.__locks()))) };
      }
      return { handoff: context.__handoff };
    },
    refresh: () => { refreshes++; },
    homeEl: (tag, text, cls) => {
      const node = new Element(tag);
      if (text !== undefined) node.textContent = text;
      if (cls) node.className = cls;
      return node;
    },
  });
  const copy = section("// ── display-copy(pure;tests/panelcopytest.mjs)──", "// ── /display-copy ──");
  const coordCopy = section("// ── coord-copy(pure;tests/panelcopytest.mjs)──", "// ── /coord-copy ──");
  // 这一段的状态是 let / const:给测试留一个读写口,不改被测代码。
  const hooks = `
function __set(patch){ if ("coord" in patch) coordData = patch.coord; if ("approvals" in patch) approvalData = patch.approvals; if ("tokens" in patch) aptData = patch.tokens; }
function __state(){ return JSON.stringify({ pending: [...coordPending], lockNote: coordLockNote, notes: [...apvNotes] }); }
function __locks(){ return JSON.stringify(coordData?.locks ?? []); }`;
  vm.runInContext([copy, coordCopy, declaration("armSwap"), declaration("disarmRestore"), VIEW, hooks].join("\n"), context);
  const box = (id) => document.getElementById(id);
  return { context, document, box, posts, gets, timers, alerts, root, set: (patch) => context.__set(patch), state: () => JSON.parse(context.__state()),
    refreshes: () => refreshes, failPosts: (message) => { postFails = message; }, setTime: (value) => { clock = value; },
    serverLocks: (list) => { serverLocks = list; }, failGets: (message) => { getFails = message; },
    // 把到时的两押复原跑掉(面板里是 4 秒)
    runTimers: () => { for (const t of timers.splice(0)) t.fn(); } };
}

const executor = (id, extra) => ({ id, name: "执行者 " + id, kind: "external", active: true, last_seen: iso(T0 - 2 * 60000), status: { current: "回归测试", done: [], next: ["跑测试", "写报告"] }, ...extra });
const lock = (extra) => ({ id: 7, resource: "device:test-phone", holder: "a", holder_name: "甲", purpose: "回归", started_at: iso(T0 - 90 * 60000),
  expected_end: iso(T0 - 60 * 60000), overdue: true, ...extra });
const coordData = (extra) => ({ executors: [executor("a")], locks: [lock()], journal: [], handoffs: [], external_lines: [], stale_min: 20, ...extra });
const request = (extra) => ({ id: "request:9:1", kind: "request", title: "ext-a 请求批准", summary: "重启共享设备上的应用", risk: "high",
  detail_ref: { type: "request", id: 9 }, created_at: iso(T0), expected_version: 1, actions: ["approve", "reject"], labels: { approve: "批准", reject: "拒绝" }, ...extra });
const lockApproval = (extra) => ({ id: "lock:7:1790000000000", kind: "lock", title: "device:test-phone", summary: "device:test-phone 已逾期:甲 · 回归",
  detail_ref: { type: "lock", id: 7, lock_id: 7, holder: "a", resource: "device:test-phone" }, created_at: iso(T0), expected_version: 1790000000000,
  actions: ["approve", "reject"], labels: { approve: "强制释放", reject: "保留" }, ...extra });
const taskApproval = (kind, id) => ({ id: `${kind}:${id}:3`, kind, title: `#${id} 一张卡`, summary: "交付摘要", detail_ref: { type: "task", id },
  created_at: iso(T0), expected_version: 3, actions: ["approve", "reject"], labels: { approve: "通过", reject: "打回" } });

test("同一份数据连调两次 renderCoord 不替换节点；只有心跳那一句随时间原位更新", () => {
  const f = fixture(), box = f.box("coord");
  f.set({ coord: coordData() });
  f.context.renderCoord();
  const first = [...box.children], seen = box.querySelector('[data-live="seen:a"]');
  assert.equal(box.replacements, 1);
  assert.equal(seen.textContent, "最后心跳 2 分钟前");
  f.context.renderCoord();
  f.set({ coord: coordData() });   // 另一份内容相同的数据(每次 refresh 都是新对象)
  f.context.renderCoord();
  assert.equal(box.replacements, 1, "签名没变不动 DOM");
  assert.ok(box.children.every((node, i) => node === first[i]));
  f.setTime(T0 + 3 * 60000);
  f.context.renderCoord();
  assert.equal(box.replacements, 1, "只有时间走了:不换节点");
  assert.equal(box.querySelector('[data-live="seen:a"]'), seen);
  assert.equal(seen.textContent, "最后心跳 5 分钟前", "心跳那一句原位更新");
  f.set({ coord: coordData({ locks: [] }) });
  f.context.renderCoord();
  assert.equal(box.replacements, 2, "数据变了、这块不忙:重画");
  assert.match(box.textContent, /资源锁 0没有被锁的资源。/);
  // 批准令牌的列表同理。
  const tokens = { remote: { enabled: true, listening: ["127.0.0.1:47830"], allow_ips: ["192.168.1.20"], errors: [] },
    tokens: [{ id: 1, label: "手机", created_at: iso(T0), last_used_at: iso(T0), active: true }, { id: 2, label: "旧", created_at: iso(T0), active: false }] };
  f.set({ tokens }); f.context.renderApt(); f.context.renderApt();
  assert.equal(f.box("apt-list").replacements, 1);
  assert.equal(f.box("apt-list").querySelectorAll("[data-apt-revoke]").length, 1, "只列有效的令牌");
  assert.equal(f.box("apt-remote").textContent, "远程入口：127.0.0.1:47830 · 允许来源 192.168.1.20");
});

test("按钮上膛后数据变化：节点仍在且保持上膛，复原后才重画", () => {
  const f = fixture(), box = f.box("approvals");
  f.set({ approvals: { approvals: [request()] } });
  f.context.renderApprovals();
  const approve = box.querySelector('[data-apv-decision="approve"]');
  assert.equal(approve.textContent, "批准");
  f.context.approvalPress(approve);
  assert.equal(approve.dataset.armed, "1");
  assert.equal(approve.textContent, "再按=确认批准", "上膛的字 = 再按=确认 + 原按钮文字");
  assert.equal(f.timers[0].ms, 4000);
  f.set({ approvals: { approvals: [request(), request({ id: "request:10:1", summary: "清理构建缓存" })] } });
  f.context.renderApprovals();
  assert.equal(box.replacements, 1, "这块里有上膛的按钮:不重画");
  assert.equal(box.querySelector('[data-apv-decision="approve"]'), approve);
  assert.equal(approve.dataset.armed, "1"); assert.ok(approve.classList.contains("armed"));
  assert.deepEqual(f.state().pending, ["approvals"], "记为待重画");
  assert.equal(f.posts.length, 0);
  f.runTimers();
  assert.equal(approve.dataset.armed, "", "4 秒不按复原");
  assert.equal(box.replacements, 2, "上膛消失后补画");
  assert.equal(box.querySelectorAll("[data-apv-row]").length, 2);
  assert.deepEqual(f.state().pending, []);
  // 焦点在这块里也一样:先不画,焦点离开后由 coordFlush 补上。
  const note = box.querySelector("[data-apv-note]"); note.focus();
  f.set({ approvals: { approvals: [] } });
  f.context.renderApprovals();
  assert.equal(box.replacements, 2); assert.deepEqual(f.state().pending, ["approvals"]);
  note.blur(); f.context.coordFlush();
  assert.equal(box.replacements, 3);
  assert.match(box.textContent, /待你批准 0没有要你批准的事项。/);
  // 鼠标点过按钮留下的焦点不算:点一下不再按,这块不会一直停在旧数据上。
  f.set({ approvals: { approvals: [request()] } }); f.context.renderApprovals();
  const clicked = box.querySelector('[data-apv-decision="reject"]'); clicked.mouseFocus = true; clicked.focus();
  f.set({ approvals: { approvals: [] } }); f.context.renderApprovals();
  assert.equal(box.replacements, 5, "鼠标留下的焦点不挡重画");
  assert.deepEqual(f.state().pending, []);
});

test("批准决定带备注：请求体含 note；逾期锁的强制释放没写理由不上膛、不发请求；写了一半的备注重画后还在", async () => {
  const f = fixture(), box = f.box("approvals");
  f.set({ approvals: { approvals: [lockApproval(), request()] } });
  f.context.renderApprovals();
  const [lockRow, reqRow] = box.querySelectorAll("[data-apv-row]");
  const release = lockRow.querySelector('[data-apv-decision="approve"]'), keep = lockRow.querySelector('[data-apv-decision="reject"]');
  const why = lockRow.querySelector("[data-apv-note]");
  assert.deepEqual([why.maxLength, why.required, why.placeholder], [200, true, "释放理由，必填"]);
  assert.deepEqual([reqRow.querySelector("[data-apv-note]").maxLength, reqRow.querySelector("[data-apv-note]").required], [500, false]);
  assert.deepEqual([release.disabled, release.title], [true, "先写释放理由"], "理由空着,强制释放不可按,悬停说明写先做什么");
  assert.equal(keep.disabled, false, "「保留」不要理由");
  await f.context.approvalPress(release);
  assert.deepEqual([release.dataset.armed, f.posts.length, f.timers.length], [undefined, 0, 0], "没写理由:不上膛、不发请求");
  assert.equal(f.document.activeElement, why, "焦点带到理由框");
  why.blur(); why.value = "  持有者已离开  "; f.context.approvalNoteInput(why);
  assert.deepEqual([release.disabled, release.title], [false, ""]);
  // 备注是草稿:数据变了重画,填回去。
  f.set({ approvals: { approvals: [lockApproval({ summary: "device:test-phone 已逾期:甲 · 回归 · 第二次提醒" }), request()] } });
  f.context.renderApprovals();
  assert.equal(box.replacements, 2);
  const again = box.querySelector("[data-apv-row]"), release2 = again.querySelector('[data-apv-decision="approve"]');
  assert.equal(again.querySelector("[data-apv-note]").value, "  持有者已离开  ");
  assert.equal(release2.disabled, false);
  await f.context.approvalPress(release2);
  assert.equal(release2.textContent, "再按=确认强制释放");
  await f.context.approvalPress(release2);
  assert.deepEqual(f.posts, [{ url: "/api/approvals/lock%3A7%3A1790000000000/decide",
    body: { decision: "approve", note: "持有者已离开", source: { client: "panel" }, expected_version: 1790000000000, lock_id: 7, holder: "a" } }], "强制释放带锁记录编号与持有者");
  assert.equal(f.refreshes(), 1);
  assert.deepEqual(f.state().notes, [], "决定发出后草稿清掉");
  // 执行者请求:备注可不填,拒绝也带 note 字段。
  const reject = box.querySelectorAll("[data-apv-row]")[1].querySelector('[data-apv-decision="reject"]');
  await f.context.approvalPress(reject); assert.equal(reject.textContent, "再按=确认拒绝");
  await f.context.approvalPress(reject);
  assert.deepEqual(f.posts[1], { url: "/api/approvals/request%3A9%3A1/decide", body: { decision: "reject", note: "", source: { client: "panel" }, expected_version: 1 } });
  // 吊销:两押,上膛的字写清会发生什么。
  f.set({ tokens: { remote: { enabled: true }, tokens: [{ id: 4, label: "手机", created_at: iso(T0), active: true }] } });
  f.context.renderApt();
  const revoke = f.box("apt-list").querySelector("[data-apt-revoke]");
  await f.context.approvalPress(revoke); assert.equal(revoke.textContent, "再按=确认吊销");
  await f.context.approvalPress(revoke);
  assert.deepEqual(f.posts[2], { url: "/api/approval-tokens/4/revoke", body: {} });
  // 决定接口报错:原话给人看,不吞。
  f.failPosts("这一项现在不能批准");
  f.set({ approvals: { approvals: [request({ id: "request:11:1" })] } }); f.context.renderApprovals();
  const b = box.querySelector('[data-apv-decision="approve"]');
  await f.context.approvalPress(b); await f.context.approvalPress(b);
  assert.deepEqual(f.alerts, ["操作失败:这一项现在不能批准"]);
});

test("任务类批准行只带人去侧栏：标题是按钮，只有「打开任务」，没有批准按钮；锁的标题指向锁表那一行", () => {
  const f = fixture(), box = f.box("approvals");
  f.set({ approvals: { approvals: [taskApproval("decision", 12), taskApproval("delivery", 13), taskApproval("release", 14), lockApproval(),
    { id: "version:upgrade:r2.0", kind: "version", title: "更新看板代码", summary: "从 r1 更新到 r2,随后重启看板", detail_ref: { type: "setup" },
      created_at: iso(T0), expected_version: "r2.0", actions: ["approve", "reject"], labels: { approve: "更新并重启", reject: "暂不更新" } }] } });
  f.context.renderApprovals();
  const rows = box.querySelectorAll("[data-apv-row]");
  assert.deepEqual(rows.map((r) => r.querySelector(".cr-lead").textContent), ["待裁定", "待验收", "放行确认", "逾期锁", "版本确认"]);
  for (const [i, id] of [[0, "12"], [1, "13"], [2, "14"]]) {
    const title = rows[i].querySelector(".cr-title"), acts = rows[i].querySelector(".cr-acts");
    assert.deepEqual([title.tagName, title.dataset.apvTask], ["BUTTON", id], "标题是按钮");
    assert.deepEqual(acts.children.map((b) => [b.textContent, b.dataset.apvTask, b.className]), [["打开任务", id, ""]], "只有「打开任务」,不是主按钮");
    assert.equal(rows[i].querySelectorAll("[data-apv]").length, 0, "不放批准按钮");
    assert.equal(rows[i].querySelector("[data-apv-note]"), null, "留言在侧栏里写");
  }
  assert.deepEqual([rows[3].querySelector(".cr-title").tagName, rows[3].querySelector(".cr-title").dataset.apvLock], ["BUTTON", "device:test-phone"]);
  assert.deepEqual(rows[3].querySelector(".cr-acts").children.map((b) => b.textContent), ["强制释放", "保留"]);
  assert.equal(rows[4].querySelector(".cr-title").tagName, "SPAN");
  assert.deepEqual(rows[4].querySelector(".cr-acts").children.map((b) => [b.textContent, b.dataset.apvVersion]), [["更新并重启", "r2.0"], ["暂不更新", "r2.0"]]);
  // 处理器:标题与「打开任务」开侧栏,锁的标题滚到锁表;按钮都带 data-*,由 document 上一个处理器接管。
  const handler = section("// 协作区的点击:", 'document.addEventListener("input"');
  assert.ok(handler.includes('if ((b = hit("button[data-apv], button[data-apt-revoke]"))) approvalPress(b);'));
  assert.ok(handler.includes("openSide({ id, uid: byId.get(id)?.task_uid || null, item: null });") && handler.includes("coordLockShow(b.dataset.apvLock)"));
  assert.ok(handler.includes('hit("button[data-lock-release]")') && handler.includes('hit("button[data-lock-confirm]")') && handler.includes('hit("button[data-lock-cancel]")'));
});

test("版本确认第一下展开确认说明与改动、不到时复原，第二下才发；强制释放遇 409 LOCK_CHANGED 写「这把锁已换人」不弹窗", async () => {
  const f = fixture(), box = f.box("approvals");
  const ver = { id: "version:bless:t.0", kind: "version", title: "确认当前版本", summary: "确认版本 abc", detail_ref: { type: "setup" }, created_at: iso(T0),
    expected_version: "t.0", actions: ["approve", "reject"], labels: { approve: "确认此版本", reject: "暂不确认" },
    confirm: "确认版本 abc\n\n上次确认 → 这次,改了什么:\n  a.js | 2 +-\n\n确认之后执行线才会用这个版本起跑。", changes: { prev: "p", files: 1, stat: ["a.js | 2 +-"], more: 0 } };
  f.set({ approvals: { approvals: [ver] } }); f.context.renderApprovals();
  const ok = box.querySelector('[data-apv-decision="approve"]');
  await f.context.approvalPress(ok);
  const rv = box.querySelector("[data-apv-review]");
  assert.deepEqual([ok.textContent, ok.dataset.armed, f.timers.length, f.posts.length, rv.querySelectorAll("pre").length], ["再按=确认确认此版本", "1", 0, 0, 1], "清单已在确认说明里:只放一块");
  assert.match(rv.textContent, /上次确认后改了 1 个文件确认版本 abc[\s\S]*a\.js \| 2 \+-[\s\S]*收起/);
  f.set({ approvals: { approvals: [] } }); f.context.renderApprovals();
  assert.equal(box.replacements, 1, "展开着不重画");
  f.context.approvalReviewClose(rv.querySelector("[data-apv-collapse]"));
  assert.deepEqual([ok.dataset.armed, box.replacements], ["", 2], "收起:复原并补画");
  f.set({ approvals: { approvals: [ver] } }); f.context.renderApprovals();
  const ok2 = box.querySelector('[data-apv-decision="approve"]');
  await f.context.approvalPress(ok2); await f.context.approvalPress(ok2);
  assert.deepEqual(f.posts.map((p) => [p.url, p.body.expected_version]), [["/api/approvals/version%3Abless%3At.0/decide", "t.0"]]);
  f.set({ approvals: { approvals: [lockApproval()] } }); f.context.renderApprovals();
  const why = box.querySelector("[data-apv-note]"); why.value = "持有者已离开"; f.context.approvalNoteInput(why);
  f.failPosts(Object.assign(new Error("锁已变化，没有释放"), { status: 409, body: { code: "LOCK_CHANGED" } }));
  const go = box.querySelector('[data-apv-decision="approve"]');
  await f.context.approvalPress(go); await f.context.approvalPress(go);
  assert.deepEqual([f.alerts, box.querySelector(".coord-note").textContent, f.refreshes()], [[], "device:test-phone：这把锁已换人，请重新核对", 2]);
});

test("锁表强制释放：理由为空时确认钮禁用；上膛写明资源与持有者；请求带 force 与理由", async () => {
  const f = fixture(), box = f.box("coord");
  f.set({ coord: coordData({ locks: [lock(), lock({ id: 8, resource: "repo:main", holder: "b", holder_name: "乙", overdue: false, expected_end: iso(T0 + 30 * 60000) })] }) });
  f.context.renderCoord();
  const rows = box.querySelectorAll(".lock-row");
  assert.deepEqual(rows.map((r) => [r.dataset.lock, r.dataset.tone, r.querySelector(".badge").textContent]),
    [["device:test-phone", "warn", "逾期"], ["repo:main", undefined, "持有中"]]);
  assert.deepEqual(rows.map((r) => r.querySelector("[data-lock-release]").textContent), ["强制释放", "强制释放"], "未逾期的锁也能放");
  const go = rows[1].querySelector("[data-lock-release]");
  f.context.coordLockOpen(go);
  const form = rows[1].querySelector("[data-lock-form]"), input = form.querySelector("[data-lock-reason]"), ok = form.querySelector("[data-lock-confirm]");
  assert.deepEqual([input.maxLength, input.required, go.hidden, f.document.activeElement === input], [200, true, true, true]);
  assert.equal(ok.disabled, true, "理由空着:确认钮不可按");
  await f.context.coordLockPress(ok);
  assert.deepEqual([ok.dataset.armed, f.posts.length], [undefined, 0]);
  input.value = "   "; f.context.coordLockReasonInput(input);
  assert.equal(ok.disabled, true, "只有空白也不算");
  input.value = "持有者说可以放"; f.context.coordLockReasonInput(input);
  assert.equal(ok.disabled, false);
  await f.context.coordLockPress(ok);
  assert.equal(ok.textContent, "再按=确认强制释放 repo:main，持有者 乙");
  assert.equal(ok.dataset.armed, "1");
  // 理由框开着:这块不重画,新数据先等着。
  f.set({ coord: coordData({ locks: [lock({ id: 8, resource: "repo:main", holder: "b", holder_name: "乙", overdue: false })] }) });
  f.context.renderCoord();
  assert.equal(box.replacements, 1); assert.deepEqual(f.state().pending, ["coord"]);
  assert.deepEqual(f.gets, [], "第一下只上膛，不读也不发");
  await f.context.coordLockPress(ok);
  assert.deepEqual(f.gets, ["/api/coord/locks"], "第二下提交前先重读一次锁表");
  assert.deepEqual(f.posts, [{ url: "/api/coord/locks/release", body: { resource: "repo:main", force: true, reason: "持有者说可以放" } }]);
  assert.equal(f.refreshes(), 1);
  assert.equal(box.querySelector("[data-lock-form]"), null, "发出后收起理由框");
  // 取消:收起,等着的重画补上。
  f.context.renderCoord();
  const go2 = box.querySelector("[data-lock-release]"); f.context.coordLockOpen(go2);
  f.document.activeElement.blur();
  f.set({ coord: coordData({ locks: [] }) }); f.context.renderCoord();
  assert.ok(box.querySelector("[data-lock-form]"), "理由框开着不重画");
  f.context.coordLockClose(box.querySelector("[data-lock-cancel]"));
  assert.equal(box.querySelector("[data-lock-form]"), null);
  assert.match(box.textContent, /资源锁 0/);
  // 服务端拒绝:原因写在理由框下面,理由还在。
  f.set({ coord: coordData() }); f.context.renderCoord();
  f.context.coordLockOpen(box.querySelector("[data-lock-release]"));
  const form3 = box.querySelector("[data-lock-form]"), ok3 = form3.querySelector("[data-lock-confirm]");
  form3.querySelector("[data-lock-reason]").value = "设备要重启"; f.context.coordLockReasonInput(form3.querySelector("[data-lock-reason]"));
  f.failPosts("资源 \"device:test-phone\" 当前没有被锁");
  await f.context.coordLockPress(ok3); await f.context.coordLockPress(ok3);
  assert.equal(form3.querySelector(".coord-note").textContent, "释放失败：资源 \"device:test-phone\" 当前没有被锁");
  assert.equal(form3.querySelector("[data-lock-reason]").value, "设备要重启");
  assert.equal(ok3.disabled, false);
});

test("持有者变化后第二下不发请求：中止并写「这把锁已换人，请重新核对」", async () => {
  const f = fixture(), box = f.box("coord");
  const arm = async () => {
    f.context.renderCoord();
    f.context.coordLockOpen(box.querySelector("[data-lock-release]"));
    const form = box.querySelector("[data-lock-form]"), input = form.querySelector("[data-lock-reason]"), ok = form.querySelector("[data-lock-confirm]");
    input.value = "持有者已离开"; f.context.coordLockReasonInput(input);
    await f.context.coordLockPress(ok);
    assert.equal(ok.dataset.armed, "1");
    return ok;
  };
  f.set({ coord: coordData() });
  let ok = await arm();
  assert.equal(ok.textContent, "再按=确认强制释放 device:test-phone，持有者 甲");
  // 上膛之后这把锁换了人:重画被理由框挡着,行里还写着「甲」。
  f.set({ coord: coordData({ locks: [lock({ id: 9, holder: "b", holder_name: "乙", overdue: false })] }) });
  f.context.renderCoord();
  assert.match(box.querySelector(".lock-row").textContent, /甲/);
  await f.context.coordLockPress(ok);
  assert.equal(f.posts.length, 0, "换人了:不发请求");
  assert.equal(f.refreshes(), 0);
  assert.equal(box.querySelector("[data-lock-form]"), null);
  assert.equal(box.querySelector(".coord-note").textContent, "device:test-phone：这把锁已换人，请重新核对");
  assert.match(box.querySelector(".lock-row").textContent, /乙/, "中止后立即重画,行里是现在的持有者");
  // 同一个持有者放了又锁:不是原来那一次。
  ok = await arm();
  f.set({ coord: coordData({ locks: [lock({ id: 10, holder: "b", holder_name: "乙" })] }) });
  await f.context.coordLockPress(ok);
  assert.equal(box.querySelector(".coord-note").textContent, "device:test-phone：这把锁已重新加锁，请重新核对");
  // 已经被放掉。
  ok = await arm();
  f.set({ coord: coordData({ locks: [] }) });
  await f.context.coordLockPress(ok);
  assert.equal(box.querySelector(".coord-note").textContent, "device:test-phone：这把锁已经释放");
  assert.equal(f.posts.length, 0);
  // 再开理由框,那一句清掉。
  f.set({ coord: coordData() }); f.context.renderCoord();
  f.context.coordLockOpen(box.querySelector("[data-lock-release]"));
  assert.equal(f.state().lockNote, "");
});

test("面板手上的锁表还没更新、服务端已经换人：第二下重读后中止，不发请求；锁表读不到也不发", async () => {
  const f = fixture(), box = f.box("coord");
  const arm = async () => {
    f.context.renderCoord();
    f.context.coordLockOpen(box.querySelector("[data-lock-release]"));
    const form = box.querySelector("[data-lock-form]"), input = form.querySelector("[data-lock-reason]"), ok = form.querySelector("[data-lock-confirm]");
    input.value = "持有者已离开"; f.context.coordLockReasonInput(input);
    await f.context.coordLockPress(ok);
    assert.equal(ok.dataset.armed, "1");
    return { form, ok };
  };
  // 面板这一份里持有者还是「甲」(实时连接断着,没有新数据进来);服务端那边这把锁已经换给「乙」。
  f.set({ coord: coordData() });
  let { ok } = await arm();
  f.serverLocks([lock({ id: 9, holder: "b", holder_name: "乙", overdue: false })]);
  await f.context.coordLockPress(ok);
  assert.deepEqual(f.gets, ["/api/coord/locks"]);
  assert.equal(f.posts.length, 0, "核对用的是刚读到的锁表：换人了不发请求");
  assert.equal(box.querySelector("[data-lock-form]"), null);
  assert.equal(box.querySelector(".coord-note").textContent, "device:test-phone：这把锁已换人，请重新核对");
  assert.match(box.querySelector(".lock-row").textContent, /乙/, "重画用刚读到的锁表，行里是现在的持有者");
  // 锁表读不到:不知道现在是谁持有,不发;原因写在理由框下面,理由还在,按钮恢复可按。
  f.serverLocks(null); f.set({ coord: coordData() });
  let form; ({ form, ok } = await arm());
  f.failGets("读取失败(503)");
  await f.context.coordLockPress(ok);
  assert.equal(f.posts.length, 0, "读不到锁表：不发请求");
  assert.equal(form.querySelector(".coord-note").textContent, "释放失败：读取失败(503)");
  assert.deepEqual([ok.disabled, form.querySelector("[data-lock-reason]").value, !!box.querySelector("[data-lock-form]")], [false, "持有者已离开", true]);
  // 读得到了:再按两下照常发出。
  f.failGets(null);
  await f.context.coordLockPress(ok); await f.context.coordLockPress(ok);
  assert.deepEqual(f.posts, [{ url: "/api/coord/locks/release", body: { resource: "device:test-phone", force: true, reason: "持有者已离开" } }]);
  // 读的这一下里理由框被收起(按了「取消」):不发。
  f.set({ coord: coordData() });
  ({ form, ok } = await arm());
  const pending = f.context.coordLockPress(ok);
  f.context.coordLockClose(form.querySelector("[data-lock-cancel]"));
  await pending;
  assert.equal(f.posts.length, 1, "理由框收起后不再发");
  // 按住回车的连发不算一下:一次长按不能走完两押。
  assert.ok(source.includes('if (e.key === "Enter"){ e.preventDefault(); if (e.repeat) return; const ok = form.querySelector("[data-lock-confirm]"); if (!ok.disabled) coordLockPress(ok); }'));
});

test("执行者卡、交接与流水：四种状态、长文本折叠、待接手用静色、角色名写成人话，字都按纯文本放", async () => {
  const f = fixture(), box = f.box("coord");
  const long = "正在把首页的状态条、用量和版本三处读数改成读得到才显示,顺手核对断开时只说一遍的那条告警".repeat(3);
  const handoff = { id: 3, executor: "d", reason: "heartbeat_stale", created_at: iso(T0), stop_seq: 1, ack: null,
    package: { executor: { id: "d", name: "<丁>", kind: "external" }, goal: "回归 <b>首页</b>", done: ["改了状态条"], next: ["跑测试", { omitted: true, see: "full_status.next[1]", chars: 400 }],
      journal: { recent_ids: [12, 13], last_id: 13 }, locks: [{ resource: "device:test-phone", purpose: "回归", overdue: true }] } };
  f.set({ coord: coordData({ external_lines: ["ext"], stale_min: 20,
    executors: [executor("a", { last_seen: null, status: { current: "", done: [], next: [] } }), executor("b", { name: "<乙>", status: { current: long, done: [], next: ["跑测试", "写报告"] } }),
      executor("c", { last_seen: iso(T0 - 16 * 60000), kind: "future_kind" }), executor("d", { active: false, last_seen: iso(T0 - 50 * 60000) })],
    locks: [lock({ holder: "d", holder_name: "<丁>" })], handoffs: [handoff, { id: 4, executor: "x", reason: "future_reason", created_at: null, package: {} }],
    journal: [{ id: 1, at: iso(T0), executor: "operator", kind: "lock.force_release", body: "强制释放 device:x:<理由>", artifacts: [] },
      { id: 2, at: iso(T0), executor: "system", kind: "sweep", body: "心跳中断", artifacts: [] },
      { id: 3, at: iso(T0), executor: "b", kind: "note", body: "提交了", artifacts: [{ type: "commit", value: "abc1234" }] }] }) });
  f.context.renderCoord();
  const cards = box.querySelectorAll(".coord-ex");
  assert.deepEqual(cards.map((c) => { const b = c.querySelector(".badge"); return [b.textContent, b.dataset.tone, b.icons]; }),
    [["已登记", "quiet", 1], ["活动", "ok", 1], ["活动", "warn", 1], ["已停止", "quiet", 1]]);
  assert.deepEqual(cards.map((c) => c.querySelector(".ex-meta").textContent),
    ["外部执行 · 还没有心跳", "外部执行 · 最后心跳 2 分钟前", "待核实 · 最后心跳 16 分钟前", "外部执行 · 最后心跳 50 分钟前"]);
  assert.equal(cards[2].querySelector(".badge").title, "超过 20 分钟没有心跳按停止处理");
  assert.equal(cards[0].querySelector(".ex-now").textContent, "当前 待核实", "空值不写「–」");
  const now = cards[1].querySelector(".ex-now");
  assert.deepEqual([now.textContent, now.title], ["当前 " + long, long], "「当前」一行,全文在 title;两行的限制由样式做");
  assert.match(source, /\.coord-ex \.ex-now\{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden\}/);
  const next = cards[1].querySelector("details.coord-fold");
  assert.deepEqual([next.open, next.querySelector("summary").textContent, next.querySelectorAll("li").map((li) => li.textContent)], [false, "下一步 2 项", ["跑测试", "写报告"]]);
  assert.equal(cards[0].querySelector("details"), null, "没有下一步就不出折叠");
  assert.equal(cards[1].querySelector(".hd").children[0].textContent, "<乙> b", "执行者名按纯文本放");
  assert.match(box.children[0].children[0].textContent, /^执行者 · 外部执行线：线·ext$/);
  // 交接行:原因、目标一行、仍持锁数;徽标「待接手」用静色;「查看交接包」默认折叠,没有「确认接手」按钮。
  const hands = box.querySelectorAll(".hand-row");
  assert.deepEqual(hands.map((r) => [r.querySelector(".cr-lead").textContent, r.querySelector(".cr-title").textContent, r.querySelector(".cr-sum").textContent, r.querySelector(".cr-use").textContent]),
    [["心跳中断", "#3 <丁>", "回归 <b>首页</b>", "仍持有 1 把锁"], ["待核实", "#4 x", "待核实", "不持锁"]]);
  assert.deepEqual(hands.map((r) => { const b = r.querySelector(".badge"); return [b.textContent, b.dataset.tone]; }), [["待接手", "quiet"], ["待接手", "quiet"]]);
  assert.deepEqual(hands.map((r) => r.querySelector(".cr-when").textContent), ["11-10 06:00", "待核实"]);
  const fold = hands[0].querySelector("details.cr-fold"), pack = fold.querySelector(".hand-pack");
  assert.deepEqual([fold.open, fold.querySelector("summary").textContent], [false, "查看交接包"]);
  assert.equal(box.querySelectorAll("button").filter((b) => /接手/.test(b.textContent)).length, 0, "不放「确认接手」按钮");
  assert.equal(f.gets.length, 0, "没点开不读");
  f.context.__handoff = { ...handoff, full_status: { current: "回归", done: ["改了状态条"], next: ["跑测试", "补 390 宽的截图"] } };
  await f.context.coordPackLoad(pack, 3);
  assert.deepEqual(f.gets, ["/api/coord/handoffs/3"]);
  assert.equal(pack.textContent, "已完成改了状态条下一步跑测试补 390 宽的截图交接时仍持有的锁device:test-phone · 回归 · 逾期最近流水编号 #12 #13接手方运行board.py handoff ack 3");
  const cmd = pack.querySelector("code");
  assert.deepEqual([cmd.textContent, cmd.className], ["board.py handoff ack 3", "coord-cmd"], "给接手方的命令用等宽");
  await f.context.coordPackLoad(pack, 3);
  assert.equal(f.gets.length, 1, "读到的交接包记住,不重读");
  // 最近流水整节默认收起;看板自己写的两种执行者写成角色名。
  const journal = box.children[3];
  assert.deepEqual([journal.tagName, journal.open, journal.querySelector("summary").textContent], ["DETAILS", false, "最近流水 3"]);
  assert.deepEqual(journal.querySelectorAll(".coord-j").map((r) => [r.children[1].textContent, r.children[1].className]), [["b", "mono"], ["看板", ""], ["操作员", ""]],
    "执行者编号用等宽,角色名不用");
  assert.equal(journal.querySelector(".arts").textContent, "commit:abc1234");
  // 空态:没有流水、没有执行者(命令用等宽)、协作状态读不到。
  f.set({ coord: coordData({ executors: [], locks: [], journal: [] }) }); f.context.renderCoord();
  assert.equal(box.children[3].textContent, "最近流水还没有流水。");
  const empty = box.children[0].querySelector(".set-empty");
  assert.equal(empty.textContent, "用 board.py exec register 登记第一个执行者。");
  assert.deepEqual([empty.querySelector("code").textContent, empty.querySelector("code").className], ["board.py exec register", "coord-cmd"]);
  f.set({ coord: null }); f.context.renderCoord();
  assert.equal(box.textContent, "协作状态暂时读不到，看板恢复后自动刷新。");
  // 远程入口关着:只写一句先做什么,不提示去生成令牌。
  f.set({ tokens: { remote: { enabled: false }, tokens: [] } }); f.context.renderApt();
  assert.equal(f.box("apt-remote").textContent, "远程入口已关闭。在配置里打开 remote_access。");
  assert.equal(f.box("apt-list").children.length, 0);
  f.set({ tokens: { remote: { enabled: true, listening: [], allow_ips: [] }, tokens: [] } }); f.context.renderApt();
  assert.equal(f.box("apt-list").textContent, "生成一个批准令牌，填进远程批准客户端。");
  // 这一段不拼 HTML:执行者与协调线写的字只走 textContent。
  const code = VIEW.split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n");   // 注释里提到 innerHTML 不算
  assert.ok(!code.includes("innerHTML") && !code.includes("esc("), "coord-view 不用 innerHTML");
  assert.deepEqual([...VIEW.matchAll(/insertAdjacentHTML\("afterbegin", ([^)]*\))/g)].map((m) => m[1]), ["icon(state.icon)"], "插进去的 HTML 只有固定图标");
});

test("结构钉：窄屏行的标题与按钮组占整行，各类行各有模板，令牌框可换行，保存判定含 #apt-new", () => {
  const style = source.slice(source.indexOf("<style>"), source.indexOf("</style>"));
  const a = style.indexOf("  /* 协作区:"), b = style.indexOf("  @media (max-width:620px){", a), end = style.indexOf("\n  }", b);
  assert.ok(a > 0 && b > a && end > b, "协作区样式块没找到");
  const wide = style.slice(a, b), narrow = style.slice(b, end);
  // ≤620px:种类和时间一行,其余各占整行;徽标不通栏。
  assert.ok(narrow.includes(".coord-row{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:none"));
  const full = narrow.match(/([^{}]*)\{grid-column:1\/-1\}/);
  assert.ok(full, "窄屏块里要有 grid-column:1/-1");
  for (const cell of [".coord-row > .cr-title", ".coord-row > .cr-sum", ".coord-row > .cr-use", ".coord-row > .cr-acts", ".coord-row > .cr-note"])
    assert.ok(full[1].includes(cell), cell + " 占整行");
  assert.ok(!full[1].includes(".cr-lead") && !full[1].includes(".cr-when"), "种类和时间留在同一行");
  assert.ok(narrow.includes(".apv-acts{gap:var(--sp-2)}"));
  assert.ok(wide.includes(".coord-row > .badge{justify-self:start}"), "徽标不再通栏");
  // 宽屏:批准、锁、交接、令牌各一套列,不共用原来的五列模板。
  for (const row of [".apv-row{grid-template-columns:10em minmax(0,1fr) minmax(13.5em,auto);grid-template-areas:\"lead title acts\" \"when sum acts\" \". facts acts\" \". note acts\" \". review review\"",
    ".lock-row{grid-template-columns:", ".hand-row{grid-template-columns:", ".apt-row{grid-template-columns:"])
    assert.ok(wide.includes(row), row);
  assert.ok(!/\.coord-row\{[^}]*grid-template-columns:[^}]*\}/.test(wide), "通用行不再带列模板");
  assert.ok(wide.includes(".coord-ex .hd .badge{flex:none;background:var(--panel)}"), "执行者卡的徽标用 --panel 做底：浅色下静色与警示色小字够 4.5:1");
  assert.ok(wide.includes(".apt-form .note.bad{color:var(--bad)}"));
  assert.match(wide, /\.apt-token\{[^}]*overflow-wrap:anywhere/);
  // 令牌:生成按钮是次按钮;显示框是文本块;收起后不再拦自动刷新。
  assert.match(source, /<button type="submit">生成批准令牌<\/button>/);
  assert.match(source, /<button type="button" id="apt-hide">收起<\/button>/);
  assert.ok(source.includes('|| !!document.querySelector("#apt-new:not([hidden]), #coord [data-lock-form]");'), "hasUnsavedInput 含 #apt-new 与展开中的理由");
  // 区块标题下不再有说明句。
  assert.match(source, /<h3 id="set-coord-h"><svg class="ic" aria-hidden="true"><use href="#i-board"\/><\/svg>协作<\/h3><\/div>/);
  // 每次 refresh 三块都调一遍;焦点离开时补画。
  assert.ok(source.includes("render(); renderRig(); renderCoord(); renderApprovals(); renderApt(); renderCtx();"));
  assert.ok(source.includes('document.getElementById(id).addEventListener("focusout", () => setTimeout(coordFlush, 0));'));
});
