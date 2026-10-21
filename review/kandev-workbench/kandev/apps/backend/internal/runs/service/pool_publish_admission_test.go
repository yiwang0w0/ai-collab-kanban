package service_test

import (
	"context"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/steptelemetry"
	taskmodels "github.com/kandev/kandev/internal/task/models"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

func (f *poolPublishFixture) reenterPool(t *testing.T) int64 {
	t.Helper()
	ctx := context.Background()
	f.task.WorkflowStepID = "pool-backlog"
	if err := f.tasks.UpdateTask(ctx, f.task); err != nil {
		t.Fatal(err)
	}
	ctx = authn.WithIdentity(ctx, authn.Identity{UserID: "pool-human", SessionID: "browser-session", Role: authn.RoleAdmin})
	ctx = steptelemetry.WithAttribution(ctx, steptelemetry.Attribution{
		Trigger: steptelemetry.TriggerManualMove, ActorKind: steptelemetry.ActorHuman, ActorID: "pool-human"})
	ctx = taskmodels.WithPoolReleaseIntent(ctx, taskmodels.PoolReleaseIntent{
		TaskID: f.task.ID, WorkspaceID: f.task.WorkspaceID, WorkflowID: f.task.WorkflowID, StepID: f.step.ID,
		ExpectedResourceVersion: f.task.UpdatedAt.UTC().Format(time.RFC3339Nano), ConfirmCLIQuota: true,
		ExpectedAgentProfileID: f.step.AgentProfileID, ExpectedStepVersion: f.step.UpdatedAt.UTC().Format(time.RFC3339Nano),
	})
	f.task.WorkflowStepID = f.step.ID
	if err := f.tasks.UpdateTask(ctx, f.task); err != nil {
		t.Fatal(err)
	}
	var entryID int64
	if err := f.runs.Reader().Get(&entryID, `SELECT MAX(id) FROM task_step_transitions WHERE task_id = ?`, f.task.ID); err != nil {
		t.Fatal(err)
	}
	return entryID
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.3
func TestPoolDispatchPublicationRejectsAnotherActiveRunForSameTask(t *testing.T) {
	for _, claimed := range []bool{false, true} {
		t.Run(map[bool]string{false: "queued", true: "claimed"}[claimed], func(t *testing.T) {
			f := newPoolPublishFixture(t)
			ctx := context.Background()
			_, first, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
			if err != nil || first == nil {
				t.Fatalf("正对照应先入队: %+v %v", first, err)
			}
			if claimed {
				claim, err := f.runs.ClaimNextEligibleRunWithClaim(ctx)
				if err != nil || claim == nil || claim.ID != first.ID {
					t.Fatalf("应领取第一份运行: %+v %v", claim, err)
				}
			}
			<-f.svc.SubscribeSignal()
			seedAgentProfile(t, f.runs.Writer(), "pool-other-cli")
			f.step.AgentProfileID = "pool-other-cli"
			if err := f.workflows.UpdateStep(ctx, f.step); err != nil {
				t.Fatal(err)
			}
			f.seedTerminalPoolRun(t, first.ID)
			entryID := f.reenterPool(t)
			// 独立验证发布边界能拒绝旧版存量，不能依靠新提交门禁掩盖此检查。
			status := "queued"
			if claimed {
				status = "claimed"
			}
			if _, err := f.runs.Writer().Exec(`UPDATE runs SET status = ?, finished_at = NULL WHERE id = ?`, status, first.ID); err != nil {
				t.Fatal(err)
			}
			outcome, second, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, entryID)
			if err == nil || second != nil || outcome != "" {
				t.Fatalf("旧运行未释放时换 Profile 或重新进入不能重复派发: %s %+v %v", outcome, second, err)
			}
			var count int
			if err := f.runs.Reader().Get(&count, `SELECT COUNT(*) FROM runs`); err != nil || count != 1 {
				t.Fatalf("拒绝不能增加运行: %d %v", count, err)
			}
			select {
			case <-f.svc.SubscribeSignal():
				t.Fatal("冲突不能唤醒第二次执行")
			default:
			}
			if !claimed {
				f.seedTerminalPoolRun(t, first.ID)
				if outcome, next, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, entryID); err != nil || next == nil || next.ID == first.ID || outcome != "queued" {
					t.Fatalf("夹具旧运行已终结后，新阶段才可派发: %s %+v %v", outcome, next, err)
				}
			}
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-001.2
func TestPoolDispatchPublicationRechecksNativeDependencies(t *testing.T) {
	cases := []struct {
		name     string
		state    v1.TaskState
		missing  bool
		archived bool
		allowed  bool
	}{
		{name: "missing", missing: true},
		{name: "pending", state: v1.TaskStateTODO},
		{name: "failed", state: v1.TaskStateFailed},
		{name: "cancelled", state: v1.TaskStateCancelled},
		{name: "archived_completed", state: v1.TaskStateCompleted, archived: true},
		{name: "completed", state: v1.TaskStateCompleted, allowed: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newPoolPublishFixture(t)
			ctx := context.Background()
			if !tc.missing {
				blocker := &taskmodels.Task{ID: "pool-native-blocker", WorkspaceID: f.task.WorkspaceID, WorkflowID: f.task.WorkflowID,
					WorkflowStepID: "pool-backlog", Title: "前置任务", State: tc.state, Priority: "medium"}
				if err := f.tasks.CreateTask(ctx, blocker); err != nil {
					t.Fatal(err)
				}
				if tc.archived {
					if err := f.tasks.ArchiveTask(ctx, blocker.ID); err != nil {
						t.Fatal(err)
					}
				}
			}
			if _, err := f.runs.Writer().Exec(`INSERT INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`, f.task.ID, "pool-native-blocker", time.Now().UTC()); err != nil {
				t.Fatal(err)
			}
			outcome, run, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
			if tc.allowed {
				if err != nil || run == nil || outcome != "queued" {
					t.Fatalf("原生已完成前置应允许派发: %s %+v %v", outcome, run, err)
				}
			} else if err == nil || run != nil || outcome != "" {
				t.Fatalf("不能把前置未完成、缺失或已归档解释为无依赖: %s %+v %v", outcome, run, err)
			}
			var edges int
			if err := f.runs.Reader().Get(&edges, `SELECT COUNT(*) FROM task_blockers WHERE task_id = ?`, f.task.ID); err != nil || edges != 1 {
				t.Fatalf("读取资格不得删除依赖边: %d %v", edges, err)
			}
		})
	}
}
