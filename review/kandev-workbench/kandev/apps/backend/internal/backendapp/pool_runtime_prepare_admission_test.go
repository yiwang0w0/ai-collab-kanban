package backendapp

import (
	"context"
	"errors"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	taskmodels "github.com/kandev/kandev/internal/task/models"
)

// @covers AC-TASKS-AGENT-POOL-001.1
func TestPoolClaimRejectsPrepareBeforeCreatingSessionAndKeepsNativeControl(t *testing.T) {
	f := newPoolRuntimeFixture(t)
	ctx := context.Background()
	prepare := func() (string, error) {
		return f.orchestrator.PrepareTaskSession(ctx, f.task.ID, f.claim.AgentProfileID, taskmodels.ExecutorIDWorktree, "", "", false)
	}
	id, err := prepare()
	var busy *runsmodels.PoolTaskBusyError
	if !errors.As(err, &busy) || busy.RunID != f.claim.ID || id != "" {
		t.Fatalf("已领取的同卡不能再准备一份并行会话: id=%s err=%v", id, err)
	}
	sessions, err := f.taskRepo.ListTaskSessions(ctx, f.task.ID)
	if err != nil || len(sessions) != 0 {
		t.Fatalf("被拒绝的准备不能留下会话: %+v %v", sessions, err)
	}
	current, err := f.taskRepo.GetTask(ctx, f.task.ID)
	if err != nil || !current.UpdatedAt.Equal(f.task.UpdatedAt) {
		t.Fatalf("被拒绝的准备不能改变主卡版本: %+v %v", current, err)
	}
	// 只构造未启动存量的终结夹具，不能把此操作当作实际停止／人工恢复证明。
	result, err := f.db.ExecContext(ctx, `UPDATE runs SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status = 'claimed'`, f.claim.ID)
	if err != nil {
		t.Fatal(err)
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		t.Fatalf("不能准备测试夹具的无占用正对照: count=%d err=%v", count, err)
	}
	id, err = prepare()
	if err != nil || id == "" {
		t.Fatalf("无池占用时应保留真实原生准备能力: id=%s err=%v", id, err)
	}
	sessions, err = f.taskRepo.ListTaskSessions(ctx, f.task.ID)
	if err != nil || len(sessions) != 1 || sessions[0].ID != id || sessions[0].State != taskmodels.TaskSessionStateCreated {
		t.Fatalf("正对照必须创建真实原生会话: %+v %v", sessions, err)
	}
	select {
	case <-f.agentMgr.launched:
		t.Fatal("仅准备会话不应调用模拟提供商")
	default:
	}
}
