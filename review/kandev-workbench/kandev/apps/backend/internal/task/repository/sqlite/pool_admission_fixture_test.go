package sqlite_test

import (
	"context"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"

	settingsstore "github.com/kandev/kandev/internal/agent/settings/store"
	officesqlite "github.com/kandev/kandev/internal/office/repository/sqlite"
	"github.com/kandev/kandev/internal/task/models"
	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
	"github.com/kandev/kandev/internal/testutil"
	wfmodels "github.com/kandev/kandev/internal/workflow/models"
	workflowrepo "github.com/kandev/kandev/internal/workflow/repository"
	"github.com/kandev/kandev/internal/worktree"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

type poolAdmissionRepository struct {
	*tasksqlite.Repository
	db *sqlx.DB
}

func initializePoolAdmissionStores(database *sqlx.DB) error {
	if _, _, err := settingsstore.Provide(database, database, nil); err != nil {
		return err
	}
	if _, err := tasksqlite.NewWithDB(database, database, nil); err != nil {
		return err
	}
	if _, err := worktree.NewSQLiteStore(database, database); err != nil {
		return err
	}
	if _, err := officesqlite.NewWithDB(database, database, nil); err != nil {
		return err
	}
	_, err := workflowrepo.NewWithDB(database, database, nil)
	return err
}

var poolAdmissionTemplate = testutil.NewSQLiteTemplate(initializePoolAdmissionStores)

func newPoolAdmissionRepository(t *testing.T) *poolAdmissionRepository {
	t.Helper()
	database, _ := poolAdmissionTemplate.Open(t)
	return &poolAdmissionRepository{Repository: tasksqlite.NewWithInitializedDB(database, database, nil), db: database}
}

func newPoolAdmissionRepositoryWithDB(database *sqlx.DB) (*poolAdmissionRepository, error) {
	if err := initializePoolAdmissionStores(database); err != nil {
		return nil, err
	}
	return &poolAdmissionRepository{Repository: tasksqlite.NewWithInitializedDB(database, database, nil), db: database}, nil
}

func seedPoolAdmissionRows(t *testing.T, repo *poolAdmissionRepository, taskID string) *models.Task {
	t.Helper()
	ctx := context.Background()
	if err := repo.CreateWorkspace(ctx, &models.Workspace{ID: "workspace-workflow-change", Name: "池准入"}); err != nil {
		t.Fatal(err)
	}
	steps, err := workflowrepo.NewWithDB(repo.db, repo.db, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"source", "target"} {
		workflowID := "workflow-change-" + suffix
		if err := repo.CreateWorkflow(ctx, &models.Workflow{ID: workflowID, WorkspaceID: "workspace-workflow-change", Name: suffix}); err != nil {
			t.Fatal(err)
		}
		if err := steps.CreateStep(ctx, &wfmodels.WorkflowStep{ID: workflowID + "-step", WorkflowID: workflowID, Name: suffix, AllowManualMove: true}); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC()
	if _, err := repo.db.Exec(repo.db.Rebind(`INSERT INTO agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`), "pool-fixture-agent", "claude-acp", now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.db.Exec(repo.db.Rebind(`INSERT INTO agent_profiles (id, agent_id, name, agent_display_name, enabled, auto_fallback, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`), "fixed-profile", "pool-fixture-agent", "固定配置", "Claude", 1, 0, now, now); err != nil {
		t.Fatal(err)
	}
	task := &models.Task{ID: taskID, WorkspaceID: "workspace-workflow-change", WorkflowID: "workflow-change-source",
		WorkflowStepID: "workflow-change-source-step", Title: "Original title", Description: "Original description", Priority: "medium",
		State:    v1.TaskStateTODO,
		Metadata: map[string]any{"sentinel": "keep", models.MetaKeyExecutorID: models.ExecutorIDWorktree}}
	if err := repo.CreateTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	return task
}
