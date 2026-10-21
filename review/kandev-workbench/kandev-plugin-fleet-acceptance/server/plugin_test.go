// 通过保留真实 JSON 状态往返行为的宿主替身验证动作及失败恢复；不调用模型。
package main

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/kandev/kandev/pkg/pluginsdk"
	"github.com/stretchr/testify/require"
)

// fakeHost is an in-memory pluginsdk.Host test double that actually stores
// state (unlike a call-recording spy), so tests can assert the
// get-then-increment-then-set round trip. SetState round-trips values through
// JSON, mirroring the real Host's protobuf Struct conversion: numbers always
// come back as float64, never the original Go numeric type — a fake that just
// stored the raw Go value would hide bugs like reading a JSON number as int.
// UnimplementedHostData satisfies the Host data API accessors this plugin
// doesn't use.
type fakeHost struct {
	queries       *testQueries
	gate          *pluginsdk.TaskCompletionGate
	capability    *pluginsdk.CapabilityContext
	lastCriteria  pluginsdk.ExactTaskCompletionCriteria
	lastEvidence  pluginsdk.ExactTaskCompletionEvidence
	verifications int

	pluginsdk.UnimplementedHostData
	mu     sync.Mutex
	state  map[string]map[string]any
	config map[string]any
}

func newFakeHost() *fakeHost {
	return &fakeHost{state: make(map[string]map[string]any)}
}

func stateKey(scope, scopeID, key string) string {
	return scope + "/" + scopeID + "/" + key
}

func (h *fakeHost) GetState(_ context.Context, scope, scopeID, key string) (map[string]any, bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	v, ok := h.state[stateKey(scope, scopeID, key)]
	return v, ok, nil
}

func (h *fakeHost) SetState(_ context.Context, scope, scopeID, key string, value map[string]any) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.state[stateKey(scope, scopeID, key)] = jsonRoundTrip(value)
	return nil
}

// jsonRoundTrip marshals v to JSON and back into map[string]any, so numeric
// values normalize to float64 exactly like structpb.Struct.AsMap() does on
// the real wire.
func jsonRoundTrip(v map[string]any) map[string]any {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		panic(err)
	}
	return out
}

func (h *fakeHost) DeleteState(context.Context, string, string, string) error { return nil }

func (h *fakeHost) ListState(context.Context, string, string) ([]pluginsdk.StateEntry, error) {
	return nil, nil
}

// GetConfig returns the operator-saved settings the real Host reads from
// kandev's plugin config store.
func (h *fakeHost) GetConfig(context.Context) (map[string]any, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.config == nil {
		return map[string]any{}, nil
	}
	return h.config, nil
}

func (h *fakeHost) RevealSecret(context.Context, string) (string, error) { return "", nil }

func (h *fakeHost) GetSecret(context.Context, string) (string, bool, error) {
	return "", false, nil
}
func (h *fakeHost) SetSecret(context.Context, string, string) error { return nil }
func (h *fakeHost) DeleteSecret(context.Context, string) error      { return nil }

func (h *fakeHost) EmitEvent(context.Context, string, map[string]any) error { return nil }

var _ pluginsdk.Host = (*fakeHost)(nil)

type testQueries struct {
	pluginsdk.ExactQueryManager
	task     pluginsdk.Task
	sessions []pluginsdk.ExactSessionObservation
}

func (q *testQueries) GetTask(context.Context, pluginsdk.ExactTaskGetQuery) (pluginsdk.ExactTaskObservation, pluginsdk.HostReadReceipt, error) {
	return pluginsdk.ExactTaskObservation{Task: q.task, ResourceVersion: q.task.ResourceVersion}, pluginsdk.HostReadReceipt{}, nil
}
func (q *testQueries) ListSessions(context.Context, pluginsdk.ExactSessionQuery) (pluginsdk.ExactSessionPage, error) {
	return pluginsdk.ExactSessionPage{Items: q.sessions}, nil
}
func (h *fakeHost) ExactQueries() pluginsdk.ExactQueryManager { return h.queries }
func (h *fakeHost) GetCapabilityContext(context.Context, string) (*pluginsdk.CapabilityContext, error) {
	return h.capability, nil
}
func (h *fakeHost) UpdateTaskExact(context.Context, pluginsdk.ExactTaskUpdate) (*pluginsdk.CommandResult, *pluginsdk.Task, error) {
	panic("不应修改任务")
}
func (h *fakeHost) ManagedAgentConversations() pluginsdk.ManagedAgentConversationManager { return nil }
func (h *fakeHost) ReadTaskCompletionGate(context.Context, pluginsdk.TaskCompletionGateRead) (*pluginsdk.TaskCompletionGate, error) {
	return h.gate, nil
}
func (h *fakeHost) TaskCompletionGates() pluginsdk.ExactTaskCompletionGateCommandManager { return h }
func (h *fakeHost) SetCriteria(_ context.Context, in pluginsdk.ExactTaskCompletionCriteria) (*pluginsdk.CommandResult, *pluginsdk.TaskCompletionGate, error) {
	h.lastCriteria = in
	h.gate = &pluginsdk.TaskCompletionGate{TaskID: in.TaskID, WorkspaceID: in.WorkspaceID, Revision: in.ExpectedRevision + 1, Blocked: true}
	for _, c := range in.Criteria {
		h.gate.Criteria = append(h.gate.Criteria, pluginsdk.TaskCompletionCriterion{ID: c.ID, Description: c.Description, EvidenceSubject: c.EvidenceSubject, CriterionRevision: 1})
	}
	return &pluginsdk.CommandResult{Status: pluginsdk.CommandApplied}, h.gate, nil
}
func (h *fakeHost) Verify(_ context.Context, in pluginsdk.ExactTaskCompletionEvidence) (*pluginsdk.CommandResult, *pluginsdk.TaskCompletionGate, error) {
	h.lastEvidence = in
	h.verifications++
	for i := range h.gate.Criteria {
		if h.gate.Criteria[i].ID == criterionID {
			h.gate.Criteria[i].Evidence = &in.Evidence
			h.gate.Criteria[i].VerifiedRevision = 1
			h.gate.Criteria[i].VerifierKind = "plugin"
			h.gate.Criteria[i].VerifierID = "plugin:fixture"
		}
	}
	h.gate.Blocked = false
	return &pluginsdk.CommandResult{Status: pluginsdk.CommandApplied}, h.gate, nil
}

type testProfiles struct{ pluginsdk.AgentProfileReader }

func (testProfiles) List(context.Context, pluginsdk.Page) ([]pluginsdk.AgentProfile, *pluginsdk.PageInfo, error) {
	return []pluginsdk.AgentProfile{{ID: "claude-profile", AgentID: "claude"}, {ID: "codex-profile", AgentID: "codex"}}, &pluginsdk.PageInfo{}, nil
}
func (h *fakeHost) AgentProfiles() pluginsdk.AgentProfileReader { return testProfiles{} }

func pluginFixture(t *testing.T) (*fleetPlugin, *fakeHost, pluginsdk.VerifiedActionContext) {
	t.Helper()
	h := newFakeHost()
	root := t.TempDir()
	h.config = map[string]any{"node_path": root + "/node.exe", "checker_path": root + "/check.mjs", "repository_root": root, "repository_id": "repo", "acceptance_step_id": "acceptance", "implementation_agent_id": "claude", "review_agent_id": "codex"}
	h.queries = &testQueries{task: pluginsdk.Task{ID: "task", WorkspaceID: "workspace", ResourceVersion: "version-1", WorkflowStepID: "acceptance", Repositories: []pluginsdk.TaskRepository{{RepositoryID: "repo"}}}, sessions: []pluginsdk.ExactSessionObservation{
		{Session: pluginsdk.Session{ID: "implementation", TaskID: "task", AgentProfileID: "claude-profile", State: "WAITING_FOR_INPUT", StartedAt: "2026-10-15T10:00:00Z"}, ResourceVersion: "implementation-1"},
		{Session: pluginsdk.Session{ID: "review", TaskID: "task", AgentProfileID: "codex-profile", State: "WAITING_FOR_INPUT", StartedAt: "2026-10-15T10:01:00Z"}, ResourceVersion: "review-1"},
	}}
	h.gate = &pluginsdk.TaskCompletionGate{TaskID: "task", WorkspaceID: "workspace"}
	h.capability = &pluginsdk.CapabilityContext{InstallationID: "fixture", WorkspaceID: "workspace", ApprovalRevision: 1, ManifestDigest: "digest", Operations: []pluginsdk.CapabilityOperation{{Method: "GetTaskExact", Supported: true, Authorized: true}, {Method: "ListSessionsExact", Supported: true, Authorized: true}, {Method: "ReadTaskCompletionGate", Supported: true, Authorized: true}, {Method: "SetTaskCompletionCriteriaExact", Supported: true, Authorized: true}, {Method: "VerifyTaskCompletionCriterionExact", Supported: true, Authorized: true}}}
	p := &fleetPlugin{runCheck: func(context.Context, settings, deliveryInput) (deliveryCheck, error) {
		return deliveryCheck{Format: "ai-fleet-delivery-check/v1", Status: "pass", Head: "commit", Fingerprint: "sha256:fixture", RulesVersion: "sha256:rules"}, nil
	}}
	p.SetHost(h)
	return p, h, pluginsdk.VerifiedActionContext{ActorID: "human", WorkspaceID: "workspace", TaskID: "task", RepositoryID: "repo", SessionID: "implementation", HeadBranch: "task/fixture"}
}

func action(t *testing.T, p *fleetPlugin, ctx pluginsdk.VerifiedActionContext, key string, body map[string]any) (int32, map[string]any) {
	t.Helper()
	data, _ := json.Marshal(body)
	response, err := p.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{ActionKey: key, Context: ctx, Body: data})
	require.NoError(t, err)
	require.NotNil(t, response)
	var out map[string]any
	require.NoError(t, json.Unmarshal(response.Body, &out))
	return int32(response.Status), out
}

func submit(t *testing.T, p *fleetPlugin, ctx pluginsdk.VerifiedActionContext) string {
	t.Helper()
	code, out := action(t, p, ctx, "submit", map[string]any{"result": "src/app.js", "review_session_id": "review"})
	require.Equal(t, int32(200), code, out)
	return out["candidate"].(map[string]any)["id"].(string)
}

func TestPluginSubmitApproveAndCanonicalReceipt(t *testing.T) {
	p, h, ctx := pluginFixture(t)
	id := submit(t, p, ctx)
	require.True(t, h.gate.Blocked)
	code, _ := action(t, p, ctx, "approve", map[string]any{"candidate_id": id, "actor_id": "forged"})
	require.Equal(t, int32(200), code)
	var receipt candidate
	require.NoError(t, json.Unmarshal([]byte(h.lastEvidence.Evidence.Summary), &receipt))
	require.Equal(t, "human", receipt.ActorID)
	require.Equal(t, "version-1", receipt.TaskResourceVersion)
	require.Equal(t, "review", receipt.ReviewSessionID)
	require.False(t, receipt.AcceptedAt.IsZero())
	code, _ = action(t, p, ctx, "approve", map[string]any{"candidate_id": id})
	require.Equal(t, int32(200), code)
	require.Equal(t, 1, h.verifications)
}

func TestPluginRejectsStaleTaskAndSameFamilyReview(t *testing.T) {
	p, h, ctx := pluginFixture(t)
	id := submit(t, p, ctx)
	h.queries.task.ResourceVersion = "version-2"
	code, _ := action(t, p, ctx, "approve", map[string]any{"candidate_id": id})
	require.Equal(t, int32(409), code)
	require.Equal(t, 0, h.verifications)
	h.queries.sessions[1].Session.AgentProfileID = "claude-profile"
	code, _ = action(t, p, ctx, "submit", map[string]any{"result": "src/app.js", "review_session_id": "review"})
	require.Equal(t, int32(409), code)
}

func TestPluginRejectKeepsGateClosedAndRequiresNewCandidate(t *testing.T) {
	p, h, ctx := pluginFixture(t)
	id := submit(t, p, ctx)
	code, _ := action(t, p, ctx, "reject", map[string]any{"reason": "审查仍有缺口"})
	require.Equal(t, int32(200), code)
	require.True(t, h.gate.Blocked)
	code, _ = action(t, p, ctx, "approve", map[string]any{"candidate_id": id})
	require.Equal(t, int32(409), code)
}

func TestPluginFailsClosedForMissingConfigContextAndGrant(t *testing.T) {
	p, h, ctx := pluginFixture(t)
	ctx.ActorID = ""
	code, _ := action(t, p, ctx, "submit", nil)
	require.Equal(t, int32(403), code)
	ctx.ActorID = "human"
	delete(h.config, "node_path")
	code, _ = action(t, p, ctx, "submit", nil)
	require.Equal(t, int32(503), code)
	p, h, ctx = pluginFixture(t)
	h.capability.Operations[3].Authorized = false
	code, _ = action(t, p, ctx, "submit", map[string]any{"result": "src/app.js", "review_session_id": "review"})
	require.Equal(t, int32(403), code)
}

func TestPluginRestoresApprovalFromNativeEvidenceNotCache(t *testing.T) {
	p, h, ctx := pluginFixture(t)
	id := submit(t, p, ctx)
	code, _ := action(t, p, ctx, "approve", map[string]any{"candidate_id": id})
	require.Equal(t, int32(200), code)
	// 模拟原生写入已成功，但保存本地成功状态前响应丢失。
	pending, err := loadCandidate(context.Background(), h, "task")
	require.NoError(t, err)
	pending.State = "approval_intent"
	require.NoError(t, saveCandidate(context.Background(), h, pending))
	code, out := action(t, p, ctx, "status", nil)
	require.Equal(t, int32(200), code)
	require.Equal(t, "approved", out["candidate"].(map[string]any)["state"])
	require.Equal(t, 1, h.verifications, "恢复不得重复写入原生验收")
	// 反向检查：原生证据被改变后，不得把缓存成功显示为当前通过。
	pending.State = "approved"
	require.NoError(t, saveCandidate(context.Background(), h, pending))
	h.gate.Criteria[0].Evidence = nil
	_, out = action(t, p, ctx, "status", nil)
	require.Equal(t, "blocked", out["candidate"].(map[string]any)["state"])
}

func TestPluginFailedRecheckInvalidatesOldProofAndPreservesOtherCriteria(t *testing.T) {
	p, h, ctx := pluginFixture(t)
	h.gate.Criteria = []pluginsdk.TaskCompletionCriterion{{ID: "native-other", Description: "保留原生检查", EvidenceSubject: pluginsdk.TaskCompletionEvidenceSubject{Kind: "task_revision", ID: "task"}}}
	id := submit(t, p, ctx)
	require.Len(t, h.lastCriteria.Criteria, 2)
	require.Equal(t, "native-other", h.lastCriteria.Criteria[0].ID)
	code, _ := action(t, p, ctx, "approve", map[string]any{"candidate_id": id})
	require.Equal(t, int32(200), code)
	p.runCheck = func(context.Context, settings, deliveryInput) (deliveryCheck, error) {
		return deliveryCheck{Format: "ai-fleet-delivery-check/v1", Status: "unmeasurable"}, nil
	}
	code, out := action(t, p, ctx, "submit", map[string]any{"result": "src/app.js", "review_session_id": "review"})
	require.Equal(t, int32(200), code)
	require.Equal(t, "blocked", out["candidate"].(map[string]any)["state"])
	require.True(t, h.gate.Blocked)
	id = out["candidate"].(map[string]any)["id"].(string)
	code, _ = action(t, p, ctx, "approve", map[string]any{"candidate_id": id})
	require.Equal(t, int32(409), code)
	require.Equal(t, 1, h.verifications)
}
