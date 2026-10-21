package sqlite_test

import (
	"context"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/task/models"
)

const poolStepFixtureVersion = "2026-01-01T00:00:00Z"

func poolAdmissionFixture(t *testing.T, pool bool) (*poolAdmissionRepository, *models.Task, string) {
	t.Helper()
	repo := newPoolAdmissionRepository(t)
	task := seedPoolAdmissionRows(t, repo, "pool-admission-task")
	stepID := "workflow-change-target-step"
	events := `{}`
	if pool {
		events = `{"on_enter":[{"type":"queue_run","config":{"pool_version":1}}]}`
	}
	stepVersion, err := time.Parse(time.RFC3339Nano, poolStepFixtureVersion)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.db.Exec(`UPDATE workflow_steps SET workflow_id = ?, agent_profile_id = 'fixed-profile', events = ?, updated_at = ? WHERE id = ?`, task.WorkflowID, events, stepVersion, stepID); err != nil {
		t.Fatal(err)
	}
	return repo, task, stepID
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.2 AC-TASKS-AGENT-POOL-005.4
func TestPoolDispatchRequiresReleaseAtNativeTransitionBoundaries(t *testing.T) {
	cases := []struct {
		name   string
		create bool
		write  func(context.Context, *poolAdmissionRepository, *models.Task, string) error
	}{
		{"full_update", false, func(ctx context.Context, r *poolAdmissionRepository, task *models.Task, _ string) error {
			return r.UpdateTask(ctx, task)
		}},
		{"partial_update", false, func(ctx context.Context, r *poolAdmissionRepository, task *models.Task, _ string) error {
			_, err := r.UpdateTaskFieldsWithParentAdmission(ctx, task.ID, models.TaskFieldUpdate{WorkflowStepID: &task.WorkflowStepID}, nil)
			return err
		}},
		{"workflow_attach", false, func(ctx context.Context, r *poolAdmissionRepository, task *models.Task, _ string) error {
			return r.AddTaskToWorkflow(ctx, task.ID, task.WorkflowID, task.WorkflowStepID, 0)
		}},
		{"capacity_update", false, func(ctx context.Context, r *poolAdmissionRepository, task *models.Task, _ string) error {
			return r.UpdateTaskIfWorkflowStepHasCapacity(ctx, task, task.WorkflowStepID, task.ID, 1)
		}},
		{"admission_update", false, func(ctx context.Context, r *poolAdmissionRepository, task *models.Task, source string) error {
			_, err := r.UpdateTaskWithWorkflowStepAdmission(ctx, task, source, task.WorkflowStepID, 1)
			return err
		}},
		{"queue_promotion", false, func(ctx context.Context, r *poolAdmissionRepository, task *models.Task, source string) error {
			_, err := r.PromoteQueuedTaskIfWorkflowStepHasCapacity(ctx, task, source, task.WorkflowStepID, 1)
			return err
		}},
		{"create", true, func(ctx context.Context, r *poolAdmissionRepository, task *models.Task, _ string) error {
			return r.CreateTask(ctx, task)
		}},
		{"admission_create", true, func(ctx context.Context, r *poolAdmissionRepository, task *models.Task, _ string) error {
			return r.CreateTaskWithWorkflowStepAdmission(ctx, task, task.WorkflowStepID, 1, "", 0)
		}},
	}
	for _, tc := range cases {
		for _, pool := range []bool{false, true} {
			name := tc.name + "/ordinary"
			if pool {
				name = tc.name + "/pool"
			}
			t.Run(name, func(t *testing.T) {
				repo, original, target := poolAdmissionFixture(t, pool)
				candidate := *original
				candidate.WorkflowStepID = target
				if tc.create {
					candidate.ID = "new-pool-task"
				}
				ctx := authn.WithIdentity(context.Background(), authn.Identity{UserID: "human", SessionID: "browser-session", Role: authn.RoleAdmin})
				err := tc.write(ctx, repo, &candidate, original.WorkflowStepID)
				if pool {
					if err == nil {
						t.Fatal("没有明确真人发布确认仍然提交了池阶段")
					}
					stored, readErr := repo.GetTask(ctx, original.ID)
					if readErr != nil || stored.WorkflowStepID != original.WorkflowStepID || !stored.UpdatedAt.Equal(original.UpdatedAt) {
						t.Fatalf("拒绝后必须完整回滚: %+v, %v", stored, readErr)
					}
					var count int
					if readErr := repo.db.Get(&count, `SELECT COUNT(*) FROM task_step_transitions WHERE to_workflow_step_id = ?`, target); readErr != nil || count != 0 {
						t.Fatalf("拒绝后不得写派发阶段账本: %d %v", count, readErr)
					}
				} else if err != nil {
					t.Fatalf("普通流程正对照失败: %v", err)
				} else if stored, err := repo.GetTask(ctx, candidate.ID); err != nil || stored.WorkflowStepID != target {
					t.Fatalf("普通写入没有到达目标: %+v %v", stored, err)
				}
			})
		}
	}
}
