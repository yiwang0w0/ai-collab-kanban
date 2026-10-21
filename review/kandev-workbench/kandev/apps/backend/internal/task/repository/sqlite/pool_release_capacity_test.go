package sqlite_test

import (
	"context"
	"testing"

	"github.com/kandev/kandev/internal/task/models"
)

func confirmedPoolCreationContext(source *models.Task, taskID, stepID string) context.Context {
	return models.WithPoolReleaseIntent(confirmedPoolMoveContext(source, stepID), models.PoolReleaseIntent{
		TaskID: taskID, WorkspaceID: source.WorkspaceID, WorkflowID: source.WorkflowID,
		StepID: stepID, Creating: true, ConfirmCLIQuota: true,
		ExpectedAgentProfileID: "fixed-profile", ExpectedStepVersion: poolStepFixtureVersion,
	})
}

// @covers AC-TASKS-AGENT-POOL-001.2
func TestPoolDispatchWIPOverflowCannotCommitUnlaunchableRelease(t *testing.T) {
	repo, original, target := poolAdmissionFixture(t, true)
	occupant := *original
	occupant.ID = "pool-occupant"
	occupant.WorkflowStepID = target
	if err := repo.CreateTask(confirmedPoolCreationContext(original, occupant.ID, target), &occupant); err != nil {
		t.Fatal(err)
	}
	queued := *original
	queued.ID = "pool-overflow"
	queued.WorkflowStepID = target
	ctx := confirmedPoolCreationContext(original, queued.ID, target)
	if err := repo.CreateTaskWithWorkflowStepAdmission(ctx, &queued, target, 1, "", 0); err == nil {
		t.Fatal("WIP 未准入时不得提交不能派发的池发布")
	}
	if _, err := repo.GetTask(context.Background(), queued.ID); err == nil {
		t.Fatal("被拒绝的新任务仍被写入")
	}
	var count int
	if err := repo.db.Get(&count, `SELECT COUNT(*) FROM task_step_transitions WHERE task_id = ?`, queued.ID); err != nil || count != 0 {
		t.Fatalf("被拒绝的发布仍留下阶段账本: %d %v", count, err)
	}
}

func TestPoolDispatchEphemeralTaskCannotBeReleased(t *testing.T) {
	repo, original, target := poolAdmissionFixture(t, true)
	task := *original
	task.ID = "ephemeral-pool-task"
	task.WorkflowStepID = target
	task.IsEphemeral = true
	if err := repo.CreateTask(confirmedPoolCreationContext(original, task.ID, target), &task); err == nil {
		t.Fatal("临时聊天任务不属于任务池白名单")
	}
}
