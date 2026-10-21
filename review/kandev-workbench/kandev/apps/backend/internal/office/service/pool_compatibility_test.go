package service_test

import (
	"context"
	"testing"

	settingsmodels "github.com/kandev/kandev/internal/agent/settings/models"
	settingsstore "github.com/kandev/kandev/internal/agent/settings/store"
	"github.com/kandev/kandev/internal/common/logger"
	"github.com/kandev/kandev/internal/office/models"
	"github.com/kandev/kandev/internal/office/service"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
)

// 此测试记录适配前的能力缺口，不是任务池可用性验收。
// @covers AC-TASKS-AGENT-POOL-001.2
func TestPoolDispatchCompatibilityBaseline(t *testing.T) {
	for _, officeProfile := range []bool{false, true} {
		name := "ordinary_cli_not_visible_to_office_processor"
		if officeProfile {
			name = "office_profile_reaches_native_starter"
		}
		t.Run(name, func(t *testing.T) {
			starter := &mockTaskStarter{}
			svc := newTestService(t, service.ServiceOptions{TaskStarter: starter})
			ctx := context.Background()
			runs := svc.RepoForTest().RunsRepository()
			profiles, _, err := settingsstore.Provide(runs.Writer(), runs.Reader(), nil)
			if err != nil {
				t.Fatal(err)
			}
			cli := &settingsmodels.Agent{ID: "claude-native", Name: "claude-native"}
			if err := profiles.CreateAgent(ctx, cli); err != nil {
				t.Fatal(err)
			}
			profile := &settingsmodels.AgentProfile{ID: "fixed-cli", AgentID: cli.ID, Name: "fixed-cli",
				AgentDisplayName: "fixed-cli", Model: "mock-only", MaxConcurrentSessions: 1,
				ExecutorPreference: `{"type":"worktree"}`}
			if officeProfile {
				profile.WorkspaceID = "ws-1"
				profile.Role = models.AgentRoleWorker
				profile.Status = models.AgentStatusIdle
				if err := svc.CreateAgentInstance(ctx, profile); err != nil {
					t.Fatal(err)
				}
			} else if err := profiles.CreateAgentProfile(ctx, profile); err != nil {
				t.Fatal(err)
			}
			insertTestTask(t, svc, "pool-preflight-task", "ws-1")
			queue := runsservice.New(runs, nil, logger.Default(), nil)
			svc.SetRunsService(queue)
			outcome, run, err := queue.QueueRunAndReturn(ctx, runsservice.QueueRunRequest{
				AgentProfileID: profile.ID, TaskID: "pool-preflight-task", Reason: "explicit_workflow_queue",
				IdempotencyKey: "pool-compatibility-preflight", SkipCoalesce: true,
				ActorKind: runsmodels.ActorKindUser, ActorID: "authenticated-preflight-human",
			})
			if err != nil || outcome != runsservice.QueueOutcomeQueued || run == nil {
				t.Fatalf("原生入队失败: %s %+v %v", outcome, run, err)
			}
			service.RunSchedulerTick(svc, ctx)
			current, err := runs.GetRunByID(ctx, run.ID)
			if err != nil {
				t.Fatal(err)
			}
			wantCalls, wantStatus := 0, "cancelled"
			if officeProfile {
				wantCalls, wantStatus = 1, "claimed"
			}
			if starter.callCount() != wantCalls || string(current.Status) != wantStatus {
				t.Fatalf("消费者基线不符: starter=%d status=%s，期望 starter=%d status=%s",
					starter.callCount(), current.Status, wantCalls, wantStatus)
			}
			t.Logf("实际消费者结果: ordinary=%t queued=true starter_calls=%d run_status=%s cancel_reason=%v",
				!officeProfile, starter.callCount(), current.Status, current.CancelReason)
		})
	}
}
