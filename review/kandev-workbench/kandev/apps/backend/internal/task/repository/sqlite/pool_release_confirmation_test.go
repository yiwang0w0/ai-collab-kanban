package sqlite_test

import (
	"context"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/steptelemetry"
	"github.com/kandev/kandev/internal/task/models"
)

func confirmedPoolMoveContext(task *models.Task, targetStep string) context.Context {
	ctx := authn.WithIdentity(context.Background(), authn.Identity{UserID: "pool-human", SessionID: "authenticated-browser", Role: authn.RoleMember})
	ctx = steptelemetry.WithAttribution(ctx, steptelemetry.Attribution{Trigger: steptelemetry.TriggerManualMove,
		ActorKind: steptelemetry.ActorHuman, ActorID: "pool-human"})
	return models.WithPoolReleaseIntent(ctx, models.PoolReleaseIntent{
		TaskID: task.ID, WorkspaceID: task.WorkspaceID, WorkflowID: task.WorkflowID, StepID: targetStep,
		ExpectedResourceVersion: task.UpdatedAt.UTC().Format(time.RFC3339Nano), ConfirmCLIQuota: true,
		ExpectedAgentProfileID: "fixed-profile", ExpectedStepVersion: poolStepFixtureVersion,
	})
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-002.1
func TestPoolDispatchExplicitBrowserReleaseRecordsNativeActor(t *testing.T) {
	repo, original, target := poolAdmissionFixture(t, true)
	ctx := confirmedPoolMoveContext(original, target)
	candidate := *original
	candidate.WorkflowStepID = target
	if err := repo.UpdateTask(ctx, &candidate); err != nil {
		t.Fatalf("当前版本的明确真人确认应可提交: %v", err)
	}
	var actorKind, actorID, trigger string
	var occurred time.Time
	if err := repo.db.QueryRow(`SELECT actor_kind, actor_id, trigger, occurred_at FROM task_step_transitions
		WHERE task_id = ? AND to_workflow_step_id = ?`, original.ID, target).Scan(&actorKind, &actorID, &trigger, &occurred); err != nil {
		t.Fatal(err)
	}
	if actorKind != "human" || actorID != "pool-human" || !occurred.Equal(candidate.UpdatedAt) {
		t.Fatalf("派发必须沿用真实原生账本: kind=%s actor=%s occurred=%s task=%s", actorKind, actorID, occurred, candidate.UpdatedAt)
	}
	if trigger != "pool_release_v1" {
		t.Fatalf("账本不能把普通真人移动冒充明确入池确认: %s", trigger)
	}
}

// @covers AC-TASKS-AGENT-POOL-001.2 AC-TASKS-AGENT-POOL-005.4
func TestPoolDispatchReleaseRejectsFalseAuthorityOrStaleVersion(t *testing.T) {
	cases := []struct {
		name string
		edit func(context.Context, *models.PoolReleaseIntent) context.Context
	}{
		{"synthetic", func(ctx context.Context, _ *models.PoolReleaseIntent) context.Context {
			return authn.WithIdentity(ctx, authn.Identity{UserID: "pool-human", SessionID: "browser", Synthetic: true})
		}},
		{"scoped_agent_without_browser", func(ctx context.Context, _ *models.PoolReleaseIntent) context.Context {
			return authn.WithIdentity(ctx, authn.Identity{UserID: "pool-human", Role: authn.RoleAdmin})
		}},
		{"token_not_human_confirmation", func(ctx context.Context, _ *models.PoolReleaseIntent) context.Context {
			return authn.WithIdentity(ctx, authn.Identity{UserID: "pool-human", TokenID: "pat", Role: authn.RoleAdmin})
		}},
		{"agent_attribution", func(ctx context.Context, _ *models.PoolReleaseIntent) context.Context {
			return steptelemetry.WithAttribution(ctx, steptelemetry.Attribution{Trigger: steptelemetry.TriggerMCPMove, ActorKind: steptelemetry.ActorAgent, ActorID: "agent-session", SessionID: "agent-session"})
		}},
		{"system_attribution", func(ctx context.Context, _ *models.PoolReleaseIntent) context.Context {
			return steptelemetry.WithAttribution(ctx, steptelemetry.Attribution{Trigger: steptelemetry.TriggerEngineTransition, ActorKind: steptelemetry.ActorSystem})
		}},
		{"different_actor", func(ctx context.Context, _ *models.PoolReleaseIntent) context.Context {
			return steptelemetry.WithAttribution(ctx, steptelemetry.Attribution{Trigger: steptelemetry.TriggerManualMove, ActorKind: steptelemetry.ActorHuman, ActorID: "someone-else"})
		}},
		{"unconfirmed_quota", func(ctx context.Context, i *models.PoolReleaseIntent) context.Context {
			i.ConfirmCLIQuota = false
			return ctx
		}},
		{"different_task", func(ctx context.Context, i *models.PoolReleaseIntent) context.Context {
			i.TaskID = "other-task"
			return ctx
		}},
		{"different_workspace", func(ctx context.Context, i *models.PoolReleaseIntent) context.Context {
			i.WorkspaceID = "other-workspace"
			return ctx
		}},
		{"different_workflow", func(ctx context.Context, i *models.PoolReleaseIntent) context.Context {
			i.WorkflowID = "other-workflow"
			return ctx
		}},
		{"different_step", func(ctx context.Context, i *models.PoolReleaseIntent) context.Context {
			i.StepID = "other-step"
			return ctx
		}},
		{"missing_version", func(ctx context.Context, i *models.PoolReleaseIntent) context.Context {
			i.ExpectedResourceVersion = ""
			return ctx
		}},
		{"invalid_version", func(ctx context.Context, i *models.PoolReleaseIntent) context.Context {
			i.ExpectedResourceVersion = "old"
			return ctx
		}},
		{"stale_version", func(ctx context.Context, i *models.PoolReleaseIntent) context.Context {
			i.ExpectedResourceVersion = "2000-01-01T00:00:00Z"
			return ctx
		}},
		{"existing_task_is_not_creation", func(ctx context.Context, i *models.PoolReleaseIntent) context.Context {
			i.Creating = true
			i.ExpectedResourceVersion = ""
			return ctx
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo, original, target := poolAdmissionFixture(t, true)
			ctx := confirmedPoolMoveContext(original, target)
			intent := models.PoolReleaseIntent{TaskID: original.ID, WorkspaceID: original.WorkspaceID,
				WorkflowID: original.WorkflowID, StepID: target, ConfirmCLIQuota: true,
				ExpectedResourceVersion: original.UpdatedAt.UTC().Format(time.RFC3339Nano)}
			intent.ExpectedAgentProfileID = "fixed-profile"
			intent.ExpectedStepVersion = poolStepFixtureVersion
			ctx = tc.edit(ctx, &intent)
			ctx = models.WithPoolReleaseIntent(ctx, intent)
			candidate := *original
			candidate.WorkflowStepID = target
			if err := repo.UpdateTask(ctx, &candidate); err == nil {
				t.Fatal("无效的池确认仍被提交")
			}
			stored, err := repo.GetTask(context.Background(), original.ID)
			if err != nil || stored.WorkflowStepID != original.WorkflowStepID || !stored.UpdatedAt.Equal(original.UpdatedAt) {
				t.Fatalf("拒绝必须回滚任务及版本: %+v %v", stored, err)
			}
		})
	}
}

func TestPoolDispatchExplicitCreationRequiresCreationIntent(t *testing.T) {
	repo, original, target := poolAdmissionFixture(t, true)
	candidate := *original
	candidate.ID = "created-pool-task"
	candidate.WorkflowStepID = target
	ctx := confirmedPoolMoveContext(original, target)
	ctx = models.WithPoolReleaseIntent(ctx, models.PoolReleaseIntent{TaskID: candidate.ID,
		WorkspaceID: candidate.WorkspaceID, WorkflowID: candidate.WorkflowID, StepID: target,
		Creating: true, ConfirmCLIQuota: true, ExpectedAgentProfileID: "fixed-profile", ExpectedStepVersion: poolStepFixtureVersion})
	if err := repo.CreateTask(ctx, &candidate); err != nil {
		t.Fatalf("明确真人创建确认应可提交: %v", err)
	}
	if stored, err := repo.GetTask(ctx, candidate.ID); err != nil || stored.WorkflowStepID != target {
		t.Fatalf("获准创建没有到达池阶段: %+v %v", stored, err)
	}
}

func TestPoolDispatchRejectsConfigurationChangedAfterConfirmation(t *testing.T) {
	repo, original, target := poolAdmissionFixture(t, true)
	ctx := confirmedPoolMoveContext(original, target)
	if _, err := repo.db.Exec(`UPDATE workflow_steps SET agent_profile_id = 'different-agent', updated_at = ? WHERE id = ?`, original.UpdatedAt.Add(time.Second), target); err != nil {
		t.Fatal(err)
	}
	candidate := *original
	candidate.WorkflowStepID = target
	if err := repo.UpdateTask(ctx, &candidate); err == nil {
		t.Fatal("确认后配置变化仍然被静默接受")
	}
	stored, err := repo.GetTask(context.Background(), original.ID)
	if err != nil || stored.WorkflowStepID != original.WorkflowStepID {
		t.Fatalf("配置冲突后没有回滚: %+v %v", stored, err)
	}
}
