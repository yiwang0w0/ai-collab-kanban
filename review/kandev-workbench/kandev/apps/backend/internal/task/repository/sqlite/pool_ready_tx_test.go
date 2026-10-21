package sqlite_test

import (
	"context"
	"testing"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runssqlite "github.com/kandev/kandev/internal/runs/repository/sqlite"
	"github.com/kandev/kandev/internal/task/models"
)

func TestPoolDispatchNativeCommitRechecksEligibility(t *testing.T) {
	cases := []struct {
		name string
		seed func(*testing.T, *poolAdmissionRepository, *models.Task)
	}{
		{"missing_dependency", func(t *testing.T, repo *poolAdmissionRepository, task *models.Task) {
			if _, err := repo.db.Exec(`INSERT INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`, task.ID, "missing-predecessor", time.Now().UTC()); err != nil {
				t.Fatal(err)
			}
		}},
		{"starting_session", func(t *testing.T, repo *poolAdmissionRepository, task *models.Task) {
			seedPoolSession(t, repo, task, models.TaskSessionStateStarting)
		}},
		{"running_session", func(t *testing.T, repo *poolAdmissionRepository, task *models.Task) {
			seedPoolSession(t, repo, task, models.TaskSessionStateRunning)
		}},
		{"unknown_session", func(t *testing.T, repo *poolAdmissionRepository, task *models.Task) {
			seedPoolSession(t, repo, task, models.TaskSessionState("UNKNOWN"))
		}},
		{"unfinished_turn", func(t *testing.T, repo *poolAdmissionRepository, task *models.Task) {
			session := seedPoolSession(t, repo, task, models.TaskSessionStateWaitingForInput)
			if err := repo.CreateTurn(context.Background(), &models.Turn{ID: "pool-unfinished-turn", TaskSessionID: session.ID, TaskID: task.ID, StartedAt: time.Now().UTC()}); err != nil {
				t.Fatal(err)
			}
		}},
		{"active_pool_run", func(t *testing.T, repo *poolAdmissionRepository, task *models.Task) {
			key := runsmodels.PoolDispatchKeyPrefix + "previous-stage"
			runs := runssqlite.NewWithDB(repo.db, repo.db)
			if err := runs.CreateRun(context.Background(), &runsmodels.Run{ID: "pool-previous-run", AgentProfileID: "fixed-profile",
				WorkspaceID: task.WorkspaceID, Status: runsmodels.RunStatusQueued, IdempotencyKey: &key, Payload: `{"task_id":"` + task.ID + `"}`}); err != nil {
				t.Fatal(err)
			}
		}},
		{"profile_changed_to_api", func(t *testing.T, repo *poolAdmissionRepository, _ *models.Task) {
			if _, err := repo.db.Exec(`UPDATE agent_profiles SET provider_kind = 'openai_compatible' WHERE id = 'fixed-profile'`); err != nil {
				t.Fatal(err)
			}
		}},
		{"disabled_profile", func(t *testing.T, repo *poolAdmissionRepository, _ *models.Task) {
			if _, err := repo.db.Exec(`UPDATE agent_profiles SET enabled = 0 WHERE id = 'fixed-profile'`); err != nil {
				t.Fatal(err)
			}
		}},
		{"executor_changed_to_local", func(t *testing.T, repo *poolAdmissionRepository, task *models.Task) {
			task.Metadata[models.MetaKeyExecutorID] = models.ExecutorIDLocal
			if err := repo.UpdateTask(context.Background(), task); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo, original, target := poolAdmissionFixture(t, true)
			tc.seed(t, repo, original)
			current, err := repo.GetTask(context.Background(), original.ID)
			if err != nil {
				t.Fatal(err)
			}
			candidate := *current
			candidate.WorkflowStepID = target
			var before int
			if err := repo.db.Get(&before, `SELECT COUNT(*) FROM task_step_transitions WHERE task_id = ?`, current.ID); err != nil {
				t.Fatal(err)
			}
			if err := repo.UpdateTask(confirmedPoolMoveContext(current, target), &candidate); err == nil {
				t.Fatal("即使确认有效，原生提交也必须重查资格和占用")
			}
			stored, err := repo.GetTask(context.Background(), current.ID)
			if err != nil || stored.WorkflowStepID != current.WorkflowStepID || !stored.UpdatedAt.Equal(current.UpdatedAt) {
				t.Fatalf("拒绝应回滚阶段与版本: %+v %v", stored, err)
			}
			var after int
			if err := repo.db.Get(&after, `SELECT COUNT(*) FROM task_step_transitions WHERE task_id = ?`, current.ID); err != nil || after != before {
				t.Fatalf("拒绝不得写批准账本: %d -> %d, %v", before, after, err)
			}
		})
	}
}

func seedPoolSession(t *testing.T, repo *poolAdmissionRepository, task *models.Task, state models.TaskSessionState) *models.TaskSession {
	t.Helper()
	session := &models.TaskSession{ID: "pool-native-existing-session", TaskID: task.ID, State: state, AgentProfileID: "fixed-profile"}
	if err := repo.CreateTaskSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	return session
}

func TestPoolDispatchNativeCommitAllowsSettledWaitingSession(t *testing.T) {
	repo, original, target := poolAdmissionFixture(t, true)
	seedPoolSession(t, repo, original, models.TaskSessionStateWaitingForInput)
	current, err := repo.GetTask(context.Background(), original.ID)
	if err != nil {
		t.Fatal(err)
	}
	candidate := *current
	candidate.WorkflowStepID = target
	if err := repo.UpdateTask(confirmedPoolMoveContext(current, target), &candidate); err != nil {
		t.Fatalf("原生已等待输入、没有未完回合的会话不是仍在工作的证据: %v", err)
	}
}
