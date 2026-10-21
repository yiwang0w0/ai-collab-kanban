package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/models"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

// 这里只构造传输形状；真实领取及一次性许可由 runs/service 的原生夹具覆盖。
func poolStartShape(t *testing.T) *runsmodels.ClaimedRun {
	t.Helper()
	now := time.Now().UTC()
	release := runsmodels.PoolReleaseSnapshot{TaskID: "pool-capacity-task", WorkspaceID: "workspace", WorkflowID: "workflow",
		WorkflowStepID: "pool-step", EntryID: 1, AgentProfileID: "fixed-profile", ActorID: "human", ReleasedAt: now}
	key, err := release.DispatchKey()
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{"task_id": release.TaskID, "workflow_step_id": release.WorkflowStepID,
		"agent_profile_id": release.AgentProfileID, "pool_release": release})
	if err != nil {
		t.Fatal(err)
	}
	return &runsmodels.ClaimedRun{ClaimID: "claim", Run: &runsmodels.Run{ID: "run", Status: runsmodels.RunStatusClaimed,
		AgentProfileID: release.AgentProfileID, WorkspaceID: release.WorkspaceID, Reason: runsmodels.PoolDispatchReason,
		ActorKind: runsmodels.ActorKindUser, ActorID: release.ActorID, CoalescedCount: 1,
		ClaimedAt: &now, IdempotencyKey: &key, Payload: string(payload)}}
}

type poolCapacityGuard struct{ poolStartGuardFunc }

func (poolCapacityGuard) AdmitPoolClaimStart(context.Context, runsmodels.PoolClaimStart) error {
	return nil
}

// @covers AC-TASKS-AGENT-POOL-005.1
func TestPoolTaskStartCapacityRefusalDoesNotCreateAutomaticReplay(t *testing.T) {
	svc, repo := newServiceWithCeiling(t, 1)
	ctx := context.Background()
	claim := poolStartShape(t)
	if err := repo.CreateTask(ctx, &models.Task{ID: "pool-capacity-task", Title: "池容量", State: v1.TaskStateTODO}); err != nil {
		t.Fatal(err)
	}
	occupied := svc.sessionCeiling.admit(ctx, admissionRequest{taskID: "existing-start", origin: launchOriginAutomatic, seam: "startTask"})
	if !occupied.admitted {
		t.Fatal("正对照必须先占用原生容量")
	}
	t.Cleanup(func() { svc.sessionCeiling.release(occupied.reservationKey) })
	svc.SetPoolTaskStartGuard(poolCapacityGuard{poolStartGuardFunc(func(context.Context, string) error { return nil })})
	execution, err := svc.StartPoolTask(ctx, claim)
	if !errors.Is(err, runsmodels.ErrPoolTaskCapacityUnavailable) || execution != nil {
		t.Fatalf("池容量拒绝不能创建会被普通扫描器重播的启动: %+v %v", execution, err)
	}
	stored, readErr := repo.GetTask(ctx, "pool-capacity-task")
	if readErr != nil || stored.Metadata[models.MetaKeyDeferredLaunch] != nil || stored.State != v1.TaskStateTODO {
		t.Fatalf("池拒绝不能持久化普通自动重试或调度状态: %+v %v", stored, readErr)
	}
	sessions, readErr := repo.ListTaskSessions(ctx, "pool-capacity-task")
	if readErr != nil || len(sessions) != 0 {
		t.Fatalf("容量拒绝不能创建会话: %+v %v", sessions, readErr)
	}
	assertPoolAdmissionDrained(t, svc)
}

// @covers AC-TASKS-AGENT-POOL-001.1
func TestPoolTaskStartMissingClaimGuardFailsBeforeDependencies(t *testing.T) {
	for _, guard := range []PoolTaskStartGuard{nil, poolStartGuardFunc(func(context.Context, string) error {
		t.Fatal("不能把池启动降级成普通启动检查")
		return nil
	})} {
		svc := &Service{poolTaskStartGuard: guard}
		execution, err := svc.StartPoolTask(context.Background(), poolStartShape(t))
		if !errors.Is(err, runsmodels.ErrPoolAdmissionUnavailable) || execution != nil {
			t.Fatalf("没有领取签发能力时必须在读取任务前关闭入口: %+v %v", execution, err)
		}
		assertPoolAdmissionDrained(t, svc)
	}
}
