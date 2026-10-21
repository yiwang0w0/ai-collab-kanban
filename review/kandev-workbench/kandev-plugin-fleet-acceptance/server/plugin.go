package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/kandev/kandev/pkg/pluginsdk"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type fleetPlugin struct {
	pluginsdk.UnimplementedPlugin
	mu       sync.Mutex
	runCheck func(context.Context, settings, deliveryInput) (deliveryCheck, error)
}

func (p *fleetPlugin) HandleAction(ctx context.Context, req *pluginsdk.PluginActionRequest) (*pluginsdk.PluginActionResponse, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if req == nil || req.Context.ActorID == "" || req.Context.TaskID == "" || req.Context.WorkspaceID == "" {
		return reply(403, map[string]any{"error": "缺少宿主确认的用户和任务身份"}), nil
	}
	if ctx.Err() != nil {
		return reply(503, map[string]any{"error": "操作已取消；未放行任务"}), nil
	}
	result, err := p.handle(ctx, req)
	if err != nil {
		var domain *actionFailure
		if errors.As(err, &domain) {
			return reply(domain.status, map[string]any{"error": domain.message}), nil
		}
		category := pluginsdk.ActionErrorUnavailable
		switch status.Code(err) {
		case codes.PermissionDenied:
			category = pluginsdk.ActionErrorPermissionDenied
		case codes.Unauthenticated:
			category = pluginsdk.ActionErrorUnauthenticated
		case codes.NotFound:
			category = pluginsdk.ActionErrorNotFound
		case codes.InvalidArgument:
			category = pluginsdk.ActionErrorInvalidArgument
		case codes.Aborted, codes.FailedPrecondition:
			category = pluginsdk.ActionErrorConflict
		}
		var categorized *pluginsdk.ActionError
		wrapped := pluginsdk.CategorizeActionError(category, err)
		if errors.As(wrapped, &categorized) {
			category = categorized.Code
		}
		return reply(pluginsdk.ActionErrorHTTPStatus(category), map[string]any{"error": "宿主拒绝或无法完成验收操作，请检查授权、版本与插件状态"}), nil
	}
	return reply(200, result), nil
}

type actionFailure struct {
	status  int
	message string
}

func (e *actionFailure) Error() string      { return e.message }
func refuse(code int, message string) error { return &actionFailure{code, message} }
func reply(code int, value any) *pluginsdk.PluginActionResponse {
	data, _ := json.Marshal(value)
	return &pluginsdk.PluginActionResponse{Status: code, Headers: map[string]string{"Content-Type": "application/json", "Cache-Control": "no-store"}, Body: data}
}

type current struct {
	task       pluginsdk.Task
	sessions   []pluginsdk.ExactSessionObservation
	gate       *pluginsdk.TaskCompletionGate
	capability *pluginsdk.CapabilityContext
}

func (p *fleetPlugin) handle(ctx context.Context, req *pluginsdk.PluginActionRequest) (map[string]any, error) {
	h := p.Host()
	if h == nil {
		return nil, refuse(503, "验收插件尚未连接宿主")
	}
	cfg, err := loadSettings(ctx, h)
	if err != nil {
		return nil, err
	}
	now, err := readCurrent(ctx, h, req.Context)
	if err != nil {
		return nil, err
	}
	switch req.ActionKey {
	case "status":
		pending, err := loadCandidate(ctx, h, req.Context.TaskID)
		if err != nil {
			return nil, err
		}
		return view(now, pending, cfg), nil
	case "submit":
		return p.submit(ctx, h, cfg, now, req)
	case "approve":
		return p.approve(ctx, h, cfg, now, req)
	case "reject":
		return p.reject(ctx, h, cfg, now, req)
	default:
		return nil, refuse(404, "未声明的验收动作")
	}
}

func loadSettings(ctx context.Context, h pluginsdk.Host) (settings, error) {
	values, err := h.GetConfig(ctx)
	if err != nil {
		return settings{}, err
	}
	data, _ := json.Marshal(values)
	var cfg settings
	if json.Unmarshal(data, &cfg) != nil || cfg.RepositoryID == "" || cfg.AcceptanceStepID == "" ||
		!filepath.IsAbs(cfg.NodePath) || !filepath.IsAbs(cfg.CheckerPath) || !filepath.IsAbs(cfg.RepositoryRoot) {
		return cfg, refuse(503, "请先配置绝对路径、试点仓库及人工验收步骤")
	}
	if cfg.ImplementationAgentID == "" || cfg.ReviewAgentID == "" {
		return cfg, refuse(503, "请指定宿主设置中的实现与审查运行时记录 ID")
	}
	if cfg.ImplementationAgentID == cfg.ReviewAgentID {
		return cfg, refuse(503, "实现与独立审查不能使用同一运行时")
	}
	return cfg, nil
}

func readCurrent(ctx context.Context, h pluginsdk.Host, scope pluginsdk.VerifiedActionContext) (current, error) {
	var out current
	exact, ok := pluginsdk.HostV2(h)
	if !ok {
		return out, refuse(503, "需要严格验收补丁版宿主")
	}
	capability, err := exact.GetCapabilityContext(ctx, scope.WorkspaceID)
	if err != nil {
		return out, err
	}
	if capability == nil || capability.InstallationID == "" || capability.WorkspaceID != scope.WorkspaceID {
		return out, refuse(503, "宿主授权上下文不可测")
	}
	out.capability = capability
	for _, method := range []string{"GetTaskExact", "ListSessionsExact", "ReadTaskCompletionGate"} {
		if err := allow(capability, method); err != nil {
			return out, err
		}
	}
	queries, ok := pluginsdk.HostExactQueries(h)
	if !ok {
		return out, refuse(503, "宿主缺少版本化任务读取接口")
	}
	observation, _, err := queries.GetTask(ctx, pluginsdk.ExactTaskGetQuery{RequestID: uuid.NewString(), WorkspaceID: scope.WorkspaceID, TaskID: scope.TaskID})
	if err != nil {
		return out, err
	}
	out.task = observation.Task
	if out.task.ID != scope.TaskID || out.task.WorkspaceID != scope.WorkspaceID || out.task.ResourceVersion == "" {
		return out, refuse(409, "宿主任务归属或版本已经改变")
	}
	page := pluginsdk.ExactReadPage{Limit: 100}
	for {
		result, err := queries.ListSessions(ctx, pluginsdk.ExactSessionQuery{RequestID: uuid.NewString(), WorkspaceID: scope.WorkspaceID, Filter: pluginsdk.SessionFilter{TaskIDs: []string{scope.TaskID}}, Page: page})
		if err != nil {
			return out, err
		}
		out.sessions = append(out.sessions, result.Items...)
		if len(out.sessions) > 1000 {
			return out, refuse(503, "会话过多，超出单机试点检查范围")
		}
		if !result.PageInfo.HasMore {
			break
		}
		if result.PageInfo.NextCursor == "" || result.PageInfo.NextCursor == page.Cursor {
			return out, refuse(503, "宿主会话分页不可测")
		}
		page.Cursor = result.PageInfo.NextCursor
		page.SnapshotVersion = result.PageInfo.SnapshotVersion
	}
	reader, ok := pluginsdk.HostTaskCompletionGateReader(h)
	if !ok {
		return out, refuse(503, "宿主缺少原生门禁读取补丁")
	}
	out.gate, err = reader.ReadTaskCompletionGate(ctx, pluginsdk.TaskCompletionGateRead{RequestID: uuid.NewString(), WorkspaceID: scope.WorkspaceID, TaskID: scope.TaskID})
	if err != nil {
		return out, err
	}
	if out.gate == nil || out.gate.TaskID != scope.TaskID || out.gate.WorkspaceID != scope.WorkspaceID {
		return out, refuse(503, "原生门禁不可测")
	}
	return out, nil
}

func allow(capability *pluginsdk.CapabilityContext, method string) error {
	for _, op := range capability.Operations {
		if op.Method == method {
			if !op.Supported {
				return refuse(503, "宿主不支持所需验收接口")
			}
			if !op.Authorized {
				return refuse(403, "请在工作区批准验收插件所需权限")
			}
			return nil
		}
	}
	return refuse(503, "宿主未提供所需验收接口")
}

func validateBinding(ctx context.Context, h pluginsdk.Host, cfg settings, now current, scope pluginsdk.VerifiedActionContext, reviewID string) (pluginsdk.ExactSessionObservation, pluginsdk.ExactSessionObservation, error) {
	var implementation, review pluginsdk.ExactSessionObservation
	if now.task.State == "COMPLETED" || now.task.WorkflowStepID != cfg.AcceptanceStepID {
		return implementation, review, refuse(409, "请先完成方案和独立审查，手动移至人工验收步骤")
	}
	if len(now.task.Repositories) != 1 || now.task.Repositories[0].RepositoryID != cfg.RepositoryID || scope.RepositoryID != cfg.RepositoryID || scope.HeadBranch == "" || scope.SessionID == "" || scope.SessionID == reviewID {
		return implementation, review, refuse(409, "试点要求单一仓库、宿主确认的实现分支和不同的审查会话")
	}
	for _, s := range now.sessions {
		if s.Session.TaskID != scope.TaskID {
			continue
		}
		if s.Session.ID == scope.SessionID {
			implementation = s
		}
		if s.Session.ID == reviewID {
			review = s
		}
	}
	if !settled(implementation) || !settled(review) {
		return implementation, review, refuse(409, "实现和审查会话必须存在且已停止执行")
	}
	profiles := map[string]string{}
	page := pluginsdk.Page{Limit: 200}
	for {
		items, info, err := h.AgentProfiles().List(ctx, page)
		if err != nil {
			return implementation, review, err
		}
		for _, profile := range items {
			profiles[profile.ID] = profile.AgentID
		}
		if info == nil || !info.HasMore {
			break
		}
		if len(profiles) > 1000 || info.NextCursor == "" || info.NextCursor == page.Cursor {
			return implementation, review, refuse(503, "运行时配置分页不可测")
		}
		page.Cursor = info.NextCursor
	}
	if profiles[implementation.Session.AgentProfileID] != cfg.ImplementationAgentID || profiles[review.Session.AgentProfileID] != cfg.ReviewAgentID {
		return implementation, review, refuse(409, "需要指定的 Claude 实现会话和 Codex 独立审查会话")
	}
	return implementation, review, nil
}

func settled(s pluginsdk.ExactSessionObservation) bool {
	return s.Session.ID != "" && s.ResourceVersion != "" && (s.Session.State == "WAITING_FOR_INPUT" || s.Session.State == "COMPLETED" || s.Session.State == "IDLE")
}

func setRequired(ctx context.Context, h pluginsdk.Host, now current, id, description string) (*pluginsdk.TaskCompletionGate, error) {
	if err := allow(now.capability, "SetTaskCompletionCriteriaExact"); err != nil {
		return nil, err
	}
	manager, ok := pluginsdk.HostTaskCompletionGates(h)
	if !ok {
		return nil, refuse(503, "宿主无法写入原生验收条件")
	}
	criteria := []pluginsdk.TaskCompletionCriterionInput{}
	for _, old := range now.gate.Criteria {
		if old.ID != criterionID {
			criteria = append(criteria, pluginsdk.TaskCompletionCriterionInput{ID: old.ID, Description: old.Description, EvidenceSubject: old.EvidenceSubject})
		}
	}
	criteria = append(criteria, pluginsdk.TaskCompletionCriterionInput{ID: criterionID, Description: description, EvidenceSubject: pluginsdk.TaskCompletionEvidenceSubject{Kind: "artifact_revision", ID: now.task.ID}})
	result, gate, err := manager.SetCriteria(ctx, pluginsdk.ExactTaskCompletionCriteria{RequestID: id, IdempotencyKey: "criteria:" + id, WorkspaceID: now.task.WorkspaceID, TaskID: now.task.ID, ExpectedTaskResourceVersion: now.task.ResourceVersion, ExpectedRevision: now.gate.Revision, ApprovalRevision: now.capability.ApprovalRevision, ManifestDigest: now.capability.ManifestDigest, Criteria: criteria})
	if err != nil {
		return nil, err
	}
	if err := commandOK(result); err != nil {
		return nil, err
	}
	if gate == nil {
		return nil, refuse(503, "宿主未返回验收条件")
	}
	return gate, nil
}

func commandOK(result *pluginsdk.CommandResult) error {
	if result == nil {
		return refuse(503, "宿主没有确认验收命令结果")
	}
	switch result.Status {
	case pluginsdk.CommandApplied, pluginsdk.CommandAlreadyApplied, pluginsdk.CommandNoChange:
		return nil
	case pluginsdk.CommandDenied:
		return refuse(403, "宿主拒绝验收权限")
	case pluginsdk.CommandConflict:
		return refuse(409, "任务、条件或管理权已经变化，请重新提交验收")
	default:
		return refuse(503, "验收命令未确认，请刷新原生门禁，勿视为通过")
	}
}

func (p *fleetPlugin) submit(ctx context.Context, h pluginsdk.Host, cfg settings, now current, req *pluginsdk.PluginActionRequest) (map[string]any, error) {
	var body struct {
		Result          string `json:"result"`
		ReviewSessionID string `json:"review_session_id"`
	}
	if len(req.Body) > 64*1024 || json.Unmarshal(req.Body, &body) != nil || strings.TrimSpace(body.Result) == "" {
		return nil, refuse(400, "请填写交付说明并选择审查会话")
	}
	implementation, review, err := validateBinding(ctx, h, cfg, now, req.Context, body.ReviewSessionID)
	if err != nil {
		return nil, err
	}
	id := uuid.NewString()
	gate, err := setRequired(ctx, h, now, id, "等待人工验收；候选 "+id)
	if err != nil {
		return nil, err
	}
	now.gate = gate
	span, _ := json.Marshal([]map[string]string{{"s": implementation.Session.StartedAt, "e": time.Now().UTC().Format(time.RFC3339Nano)}})
	pending := &candidate{Format: "fleet-acceptance/v1", ID: id, State: "checking", TaskID: now.task.ID, TaskResourceVersion: now.task.ResourceVersion, RepositoryID: cfg.RepositoryID, HeadBranch: req.Context.HeadBranch, ImplementationSessionID: implementation.Session.ID, ReviewSessionID: review.Session.ID, ImplementationResourceVersion: implementation.ResourceVersion, ReviewResourceVersion: review.ResourceVersion, Task: deliveryTask{Result: body.Result, WorkSpans: string(span)}, GateRevision: gate.Revision, SubmittedBy: req.Context.ActorID, SubmittedAt: time.Now().UTC()}
	if err := saveCandidate(ctx, h, pending); err != nil {
		return nil, err
	}
	check, err := p.check(ctx, cfg, pending, nil)
	if err != nil {
		return nil, err
	}
	pending.Check = check
	pending.State = "pending"
	if check.Status != "pass" {
		pending.State = "blocked"
	}
	if err := saveCandidate(ctx, h, pending); err != nil {
		return nil, err
	}
	return view(now, pending, cfg), nil
}

func (p *fleetPlugin) approve(ctx context.Context, h pluginsdk.Host, cfg settings, now current, req *pluginsdk.PluginActionRequest) (map[string]any, error) {
	var body struct {
		CandidateID string `json:"candidate_id"`
	}
	if json.Unmarshal(req.Body, &body) != nil {
		return nil, refuse(400, "候选编号无效")
	}
	pending, err := loadCandidate(ctx, h, now.task.ID)
	if err != nil {
		return nil, err
	}
	if pending == nil || pending.ID != body.CandidateID {
		return nil, refuse(409, "请先提交当前版本的验收候选")
	}
	if receipt, ok := nativeApprovedCandidate(now, pending); ok {
		return view(now, receipt, cfg), nil
	}
	if pending.State != "pending" && pending.State != "approval_intent" {
		return nil, refuse(409, "该候选尚未检查通过或已被驳回")
	}
	implementation, review, err := validateBinding(ctx, h, cfg, now, req.Context, pending.ReviewSessionID)
	if err != nil {
		return nil, err
	}
	if pending.TaskResourceVersion != now.task.ResourceVersion || pending.GateRevision != now.gate.Revision || pending.HeadBranch != req.Context.HeadBranch || pending.RepositoryID != req.Context.RepositoryID || pending.ImplementationSessionID != implementation.Session.ID || pending.ImplementationResourceVersion != implementation.ResourceVersion || pending.ReviewResourceVersion != review.ResourceVersion {
		return nil, refuse(409, "任务、分支、条件或会话已改变，请重新提交验收")
	}
	if err := allow(now.capability, "VerifyTaskCompletionCriterionExact"); err != nil {
		return nil, err
	}
	check, err := p.check(ctx, cfg, pending, &pending.Check)
	if err != nil {
		return nil, err
	}
	if check.Status != "pass" || check.Head != pending.Check.Head || check.Fingerprint != pending.Check.Fingerprint || check.RulesVersion != pending.Check.RulesVersion {
		return nil, refuse(409, "交付内容或规则已改变，请重新提交验收")
	}
	if pending.ActorID != "" && pending.ActorID != req.Context.ActorID {
		return nil, refuse(409, "已有另一位操作者提交验收决定，请刷新原生历史")
	}
	if pending.AcceptedAt.IsZero() {
		pending.ActorID = req.Context.ActorID
		pending.AcceptedAt = time.Now().UTC()
		pending.State = "approval_intent"
		if err := saveCandidate(ctx, h, pending); err != nil {
			return nil, err
		}
	}
	manager, ok := pluginsdk.HostTaskCompletionGates(h)
	if !ok {
		return nil, refuse(503, "原生验收写入接口不可用")
	}
	receipt := *pending
	receipt.State = "approved"
	summary, _ := json.Marshal(receipt)
	result, gate, err := manager.Verify(ctx, pluginsdk.ExactTaskCompletionEvidence{RequestID: pending.ID, IdempotencyKey: "approve:" + pending.ID, WorkspaceID: now.task.WorkspaceID, TaskID: now.task.ID, CriterionID: criterionID, ExpectedTaskResourceVersion: now.task.ResourceVersion, ExpectedRevision: now.gate.Revision, ApprovalRevision: now.capability.ApprovalRevision, ManifestDigest: now.capability.ManifestDigest, Evidence: pluginsdk.TaskCompletionEvidence{Subject: pluginsdk.TaskCompletionEvidenceSubject{Kind: "artifact_revision", ID: now.task.ID, Revision: pending.Check.Fingerprint}, Summary: string(summary), Reference: pending.ID}})
	if err != nil {
		return nil, err
	}
	if err := commandOK(result); err != nil {
		return nil, err
	}
	if gate == nil {
		return nil, refuse(503, "原生验收结果不可测")
	}
	pending.State = "approved"
	now.gate = gate
	if err := saveCandidate(ctx, h, pending); err != nil {
		return nil, err
	}
	return view(now, pending, cfg), nil
}

func (p *fleetPlugin) reject(ctx context.Context, h pluginsdk.Host, cfg settings, now current, req *pluginsdk.PluginActionRequest) (map[string]any, error) {
	var body struct {
		Reason string `json:"reason"`
	}
	if json.Unmarshal(req.Body, &body) != nil || strings.TrimSpace(body.Reason) == "" || len(body.Reason) > 1024 {
		return nil, refuse(400, "驳回必须填写原因（最多 1024 字节）")
	}
	id := uuid.NewString()
	gate, err := setRequired(ctx, h, now, id, "人工驳回："+body.Reason+"；决定 "+id)
	if err != nil {
		return nil, err
	}
	pending := &candidate{Format: "fleet-acceptance/v1", ID: id, TaskID: now.task.ID, State: "rejected", Reason: body.Reason, ActorID: req.Context.ActorID, GateRevision: gate.Revision, SubmittedAt: time.Now().UTC()}
	if err := saveCandidate(ctx, h, pending); err != nil {
		return nil, err
	}
	now.gate = gate
	return view(now, pending, cfg), nil
}

func (p *fleetPlugin) check(ctx context.Context, cfg settings, pending *candidate, expected *deliveryCheck) (deliveryCheck, error) {
	input := deliveryInput{Format: "ai-fleet-delivery-input/v1", RepoRoot: cfg.RepositoryRoot, HeadBranch: pending.HeadBranch, Task: pending.Task, Expected: expected}
	if p.runCheck != nil {
		return p.runCheck(ctx, cfg, input)
	}
	return runDeliveryCheck(ctx, cfg, input)
}

func loadCandidate(ctx context.Context, h pluginsdk.Host, taskID string) (*candidate, error) {
	value, found, err := h.GetState(ctx, "task", taskID, "candidate")
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	data, err := json.Marshal(value)
	if err != nil || len(data) > 256*1024 {
		return nil, refuse(503, "候选记录不可测，请查看原生门禁并重新提交")
	}
	var pending candidate
	if json.Unmarshal(data, &pending) != nil || pending.Format != "fleet-acceptance/v1" || pending.TaskID != taskID || pending.ID == "" {
		return nil, refuse(503, "候选记录损坏，未放行任务")
	}
	return &pending, nil
}

func saveCandidate(ctx context.Context, h pluginsdk.Host, pending *candidate) error {
	data, err := json.Marshal(pending)
	if err != nil || len(data) > 256*1024 {
		return refuse(503, "候选过大，未放行任务")
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	return h.SetState(ctx, "task", pending.TaskID, "candidate", value)
}

// 原生门禁是通过记录的唯一依据。响应丢失时只读恢复，不重新发送验收命令。
func nativeApprovedCandidate(now current, pending *candidate) (*candidate, bool) {
	if pending == nil {
		return nil, false
	}
	for _, item := range now.gate.Criteria {
		if item.ID != criterionID || item.Evidence == nil || item.Evidence.Reference != pending.ID ||
			item.CriterionRevision < 1 || item.VerifiedRevision != item.CriterionRevision ||
			item.VerifierKind != "plugin" || item.VerifierID != "plugin:"+now.capability.InstallationID ||
			item.Evidence.Subject.Kind != "artifact_revision" || item.Evidence.Subject.ID != now.task.ID {
			continue
		}
		var receipt candidate
		if json.Unmarshal([]byte(item.Evidence.Summary), &receipt) == nil && receipt.Format == "fleet-acceptance/v1" &&
			receipt.ID == pending.ID && receipt.TaskID == now.task.ID && receipt.State == "approved" &&
			receipt.ActorID != "" && !receipt.AcceptedAt.IsZero() && receipt.Check.Fingerprint == item.Evidence.Subject.Revision {
			return &receipt, true
		}
	}
	return nil, false
}

func view(now current, pending *candidate, cfg settings) map[string]any {
	if receipt, ok := nativeApprovedCandidate(now, pending); ok {
		pending = receipt
	} else if pending != nil && pending.State == "approved" {
		copy := *pending
		copy.State = "blocked"
		copy.Reason = "原生通过记录已变化，请重新提交验收"
		pending = &copy
	}
	sessions := []map[string]string{}
	for _, s := range now.sessions {
		sessions = append(sessions, map[string]string{"id": s.Session.ID, "profile_id": s.Session.AgentProfileID, "profile_name": s.Session.AgentProfileName, "state": s.Session.State, "model": s.Session.Model})
	}
	criteria := []map[string]any{}
	for _, c := range now.gate.Criteria {
		item := map[string]any{"id": c.ID, "description": c.Description, "verified": c.Evidence != nil && c.CriterionRevision == c.VerifiedRevision}
		if c.Evidence != nil {
			item["receipt"] = c.Evidence.Summary
			item["reference"] = c.Evidence.Reference
		}
		criteria = append(criteria, item)
	}
	return map[string]any{"candidate": pending, "gate": map[string]any{"blocked": now.gate.Blocked, "revision": now.gate.Revision, "criteria": criteria}, "sessions": sessions, "repository_id": cfg.RepositoryID, "installation_id": now.capability.InstallationID, "task_version": now.task.ResourceVersion, "acceptance_step_id": cfg.AcceptanceStepID}
}

var _ pluginsdk.ActionHandler = (*fleetPlugin)(nil)
