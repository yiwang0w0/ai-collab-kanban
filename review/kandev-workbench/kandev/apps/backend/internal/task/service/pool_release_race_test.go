package service

import (
	"context"
	"testing"

	settingsmodels "github.com/kandev/kandev/internal/agent/settings/models"
	"github.com/kandev/kandev/internal/task/models"
)

type poolCompatibilityFunc func(context.Context, *settingsmodels.AgentProfile, *models.Executor, *models.ExecutorProfile) error

func (f poolCompatibilityFunc) ValidateAgentProfileForExecutor(ctx context.Context, profile *settingsmodels.AgentProfile, executor *models.Executor, preset *models.ExecutorProfile) error {
	return f(ctx, profile, executor, preset)
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.2
func TestPoolDispatchNativeMoveRechecksChangesAfterServicePreflight(t *testing.T) {
	for _, change := range []string{"profile", "session"} {
		t.Run(change, func(t *testing.T) {
			f := newPoolMoveFixture(t)
			f.svc.agentProfileExecutorValidator = poolCompatibilityFunc(func(ctx context.Context, _ *settingsmodels.AgentProfile, _ *models.Executor, _ *models.ExecutorProfile) error {
				if change == "profile" {
					_, err := f.database.Exec(`UPDATE agent_profiles SET enabled = 0 WHERE id = 'pool-native-cli'`)
					return err
				}
				return f.repo.CreateTaskSession(ctx, &models.TaskSession{ID: "competing-native-start", TaskID: f.task.ID,
					AgentProfileID: "pool-native-cli", State: models.TaskSessionStateStarting})
			})
			result, err := f.svc.MoveTaskWithOptions(f.ctx, f.task.ID, f.task.WorkflowID, f.step.ID, 0, f.opts)
			if err == nil || result != nil {
				t.Fatalf("检查后变化仍须在原生提交拒绝: result_present=%t err=%v", result != nil, err)
			}
			stored, err := f.repo.GetTask(context.Background(), f.task.ID)
			if err != nil || stored.WorkflowStepID != f.task.WorkflowStepID || !stored.UpdatedAt.Equal(f.task.UpdatedAt) {
				t.Fatalf("竞争拒绝不能改变原卡与版本: %+v %v", stored, err)
			}
		})
	}
}
