package service_test

import (
	"context"
	"encoding/json"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	taskmodels "github.com/kandev/kandev/internal/task/models"
)

type poolExecutionAllocator interface {
	BindPoolExecution(context.Context, runsmodels.PoolClaimStart, runsmodels.PoolExecutionIdentity) (*runsmodels.RunEvent, error)
}

func allocatedPoolFixture(t *testing.T) (poolPublishFixture, runsmodels.PoolClaimStart, runsmodels.PoolExecutionIdentity) {
	t.Helper()
	f, claim := claimedPoolFixture(t)
	request := poolClaimRequest(t, claim)
	ctx := context.Background()
	if err := f.svc.AdmitPoolClaimStart(ctx, request); err != nil {
		t.Fatal(err)
	}
	identity := runsmodels.PoolExecutionIdentity{RunID: claim.ID, ClaimID: claim.ClaimID, TaskID: f.task.ID,
		AgentProfileID: claim.AgentProfileID, ExecutionProfileID: claim.AgentProfileID, SessionID: "allocated-session",
		ExecutionID: "allocated-execution", TurnID: "allocated-turn", PromptGeneration: 1}
	if err := f.tasks.CreateTaskSession(ctx, &taskmodels.TaskSession{ID: identity.SessionID, TaskID: identity.TaskID,
		AgentProfileID: identity.AgentProfileID, ExecutionProfileID: identity.ExecutionProfileID,
		ExecutorID: taskmodels.ExecutorIDWorktree, State: taskmodels.TaskSessionStateCreated}); err != nil {
		t.Fatal(err)
	}
	if err := f.tasks.CreateTurn(ctx, &taskmodels.Turn{ID: identity.TurnID, TaskSessionID: identity.SessionID,
		TaskID: identity.TaskID, ExecutionProfileID: identity.ExecutionProfileID}); err != nil {
		t.Fatal(err)
	}
	if err := f.tasks.UpsertExecutorRunning(ctx, &taskmodels.ExecutorRunning{ID: "allocated-runtime", SessionID: identity.SessionID,
		TaskID: identity.TaskID, ExecutionProfileID: identity.ExecutionProfileID, ExecutorID: taskmodels.ExecutorIDWorktree,
		AgentExecutionID: identity.ExecutionID, Status: taskmodels.ExecutorRunningStatusStarting}); err != nil {
		t.Fatal(err)
	}
	return f, request, identity
}

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-002.2
func TestPoolExecutionAllocationBindsNativeScopeBeforeWorkWithoutInventingOperation(t *testing.T) {
	f, request, identity := allocatedPoolFixture(t)
	allocator, ok := any(f.svc).(poolExecutionAllocator)
	if !ok {
		t.Fatal("缺少真实执行分配时的持久原生领取关联")
	}
	ctx := context.Background()
	event, err := allocator.BindPoolExecution(ctx, request, identity)
	if err != nil || event == nil || event.EventType != "pool.execution-allocated.v1" {
		t.Fatalf("真实分配应绑定同卡会话和执行，不冒充开工: event=%+v err=%v", event, err)
	}
	var allocation struct {
		runsmodels.PoolExecutionIdentity
		AgentType string `json:"agent_type"`
	}
	if err := json.Unmarshal([]byte(event.Payload), &allocation); err != nil || allocation.PoolExecutionIdentity != identity || allocation.AgentType != "claude-acp" {
		t.Fatalf("只能保存实际宿主身份与原生代理类型，不伪造 operation: %+v %v", allocation, err)
	}
	replay, err := allocator.BindPoolExecution(ctx, request, identity)
	if err != nil || replay == nil || replay.Seq != event.Seq || !replay.CreatedAt.Equal(event.CreatedAt) {
		t.Fatalf("同一分配重放应返回原时刻与事件: %+v %v", replay, err)
	}
	current, err := f.runs.GetRunByID(ctx, request.RunID)
	if err != nil || current.SessionID != identity.SessionID || current.Status != runsmodels.RunStatusClaimed || current.FinishedAt != nil {
		t.Fatalf("分配只能关联会话，不能完成运行: %+v %v", current, err)
	}
	events, err := f.runs.ListRunEvents(ctx, request.RunID, -1, 10)
	if err != nil || len(events) != 2 || events[0].EventType != runsmodels.PoolLaunchAdmitted {
		t.Fatalf("只能有启动意图和分配记录，不得补造工作回执: %+v %v", events, err)
	}
}
