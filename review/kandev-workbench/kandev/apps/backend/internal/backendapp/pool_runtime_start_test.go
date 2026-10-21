package backendapp

import (
	"context"
	"errors"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	taskmodels "github.com/kandev/kandev/internal/task/models"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-002.1
func TestPoolTaskStartUsesNativeClaimAndSessionWithoutInventingWorkEvidence(t *testing.T) {
	f := newPoolRuntimeFixture(t)
	starter, ok := any(f.orchestrator).(nativePoolTaskStarter)
	if !ok {
		t.Fatal("原生协调器缺少只供宿主领取使用的池启动入口")
	}
	ctx := context.Background()
	_, err := f.orchestrator.StartTask(ctx, f.task.ID, f.claim.AgentProfileID, "", "", "", "", "", false, false, nil)
	var busy *runsmodels.PoolTaskBusyError
	if !errors.As(err, &busy) || busy.RunID != f.claim.ID {
		t.Fatalf("同一主卡的普通启动必须先被真实队列拒绝: %v", err)
	}
	execution, err := starter.StartPoolTask(ctx, f.claim)
	if err != nil || execution == nil || execution.SessionID == "" {
		t.Fatalf("真实领取应复用原生启动并产生会话: %+v %v", execution, err)
	}
	launch := f.agentMgr.awaitLaunch(t)
	if launch.TaskID != f.task.ID || launch.SessionID != execution.SessionID || launch.AgentProfileID != f.claim.AgentProfileID ||
		launch.ExecutorType != string(taskmodels.ExecutorTypeWorktree) || !launch.StartAgent {
		t.Fatalf("模拟提供商必须接到固定原生 Profile 和 Worktree 请求: %+v", launch)
	}
	f.awaitTaskInProgress(ctx, t, f.task.ID)
	sessions, err := f.taskRepo.ListTaskSessions(ctx, f.task.ID)
	if err != nil || len(sessions) != 1 || sessions[0].AgentProfileID != f.claim.AgentProfileID {
		t.Fatalf("必须沿同一卡创建一份真实原生会话: %+v %v", sessions, err)
	}
	if repeated, err := starter.StartPoolTask(ctx, f.claim); err == nil || repeated != nil {
		t.Fatalf("不能用同一领取再次启动: %+v %v", repeated, err)
	}
	var intents, work int
	if err := f.db.Get(&intents, `SELECT COUNT(*) FROM run_events WHERE run_id = ? AND event_type = 'pool.launch-admitted.v1'`, f.claim.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Get(&work, `SELECT COUNT(*) FROM run_events WHERE run_id = ? AND event_type IN ('pool.work-observed.v1', 'pool.execution-bound.v1')`, f.claim.ID); err != nil || intents != 1 || work != 0 {
		t.Fatalf("启动返回本身不是可信工作活动: intents=%d receipts=%d err=%v", intents, work, err)
	}
	current, err := f.taskRepo.GetTask(ctx, f.task.ID)
	if err != nil || current.State == v1.TaskStateCompleted {
		t.Fatalf("启动许可不能完成主卡: %+v %v", current, err)
	}
	sessions, err = f.taskRepo.ListTaskSessions(ctx, f.task.ID)
	if err != nil || len(sessions) != 1 {
		t.Fatalf("重放不能补造第二份会话: %+v %v", sessions, err)
	}
}

// @covers AC-TASKS-AGENT-POOL-002.1
func TestPoolTaskStartAdmissionWriteFailureStopsBeforeSessionAndProvider(t *testing.T) {
	f := newPoolRuntimeFixture(t)
	starter, ok := any(f.orchestrator).(nativePoolTaskStarter)
	if !ok {
		t.Fatal("缺少宿主领取启动入口")
	}
	if _, err := f.db.Exec(`CREATE TRIGGER reject_runtime_pool_launch BEFORE INSERT ON run_events
		WHEN NEW.event_type = 'pool.launch-admitted.v1' BEGIN SELECT RAISE(ABORT, 'admission-test-write-failure'); END`); err != nil {
		t.Fatal(err)
	}
	if execution, err := starter.StartPoolTask(context.Background(), f.claim); err == nil || execution != nil {
		t.Fatalf("数据库许可没有提交时不能继续启动: %+v %v", execution, err)
	}
	select {
	case <-f.agentMgr.launched:
		t.Fatal("许可写入失败不能调用模拟提供商")
	default:
	}
	sessions, err := f.taskRepo.ListTaskSessions(context.Background(), f.task.ID)
	if err != nil || len(sessions) != 0 {
		t.Fatalf("失败不能创建会话: %+v %v", sessions, err)
	}
	current, err := f.taskRepo.GetTask(context.Background(), f.task.ID)
	if err != nil || current.State != v1.TaskStateTODO || !current.UpdatedAt.Equal(f.task.UpdatedAt) {
		t.Fatalf("准入失败应保留主卡状态及版本: %+v %v", current, err)
	}
}
